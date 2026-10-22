import { readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileText } from "./exec.ts";
import { clip } from "./text.ts";
import { lineCount, relabelDiff, shortHash, stashHeadVersion, summarizeDiff } from "./diff-core.ts";

async function writeTemp(prefix: string, content: string): Promise<string> {
	const file = path.join(os.tmpdir(), `pi-ops-diff-${prefix}-${process.pid}-${Date.now()}.txt`);
	await writeFile(file, content, "utf8");
	return file;
}

export function registerDiffFiles(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "diff_files",
		label: "Diff files",
		description:
			"Unified diff of two files, of one file against its committed HEAD version (pass only `a`), or of a file against proposed replacement content (`a` + `content`, i.e. preview a write before performing it). Prints a hunk/± summary first, then the diff, with sha256/line-count identity so an unchanged file is reported instead of guessed at. Uses `git diff --no-index` with a `diff -u` fallback; read-only.",
		promptSnippet: "Unified diff: two files, working copy vs HEAD, or proposed content",
		promptGuidelines: [
			"Use diff_files instead of reading both files in full or piping `git diff` output through the shell.",
			"Pass only `a` to see what changed in a file since its last commit.",
			"Pass `a` + `content` to preview an edit before writing it — cheaper and safer than writing and re-reading.",
		],
		parameters: Type.Object({
			a: Type.String({ description: "First file; with `b` and `content` omitted this is the working copy compared against HEAD" }),
			b: Type.Optional(Type.String({ description: "Second file (omit to compare `a` with its HEAD version)" })),
			content: Type.Optional(Type.String({ description: "Proposed new content for `a` — previews the diff a write would make (mutually exclusive with `b`)" })),
			context: Type.Optional(Type.Number({ description: "Context lines per hunk (default 3, max 50)" })),
			ignore_whitespace: Type.Optional(Type.Boolean({ description: "Ignore whitespace-only changes (default false)" })),
			ignore_eol: Type.Optional(Type.Boolean({ description: "Ignore CRLF/LF-only differences (default false)" })),
			max_chars: Type.Optional(Type.Number({ description: "Output budget (default 20000)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const resolve = (input: string) => (path.isAbsolute(input) ? input : path.resolve(cwd, input));
			const after = resolve(params.a);
			const contextLines = Math.max(0, Math.min(50, Math.floor(params.context ?? 3)));
			const maxChars = Math.max(2000, Math.floor(params.max_chars ?? 20_000));
			const previewing = params.content !== undefined;
			if (previewing && params.b !== undefined) {
				return { content: [{ type: "text" as const, text: "diff_files: pass either `b` or `content`, not both." }], details: { error: "ambiguous-input" } };
			}
			const beforeLabel = previewing ? "proposed" : (params.b ?? "HEAD");

			const tempPaths: string[] = [];
			let before: string;
			let afterPath: string;
			let identity: string | undefined;
			try {
				if (previewing) {
					// Diff the on-disk file against a temp copy of the proposed content: same shape as
					// a real write, so the preview cannot drift from what the write would do.
					before = after;
					afterPath = await writeTemp("proposed", params.content!);
					tempPaths.push(afterPath);
					const current = await readFile(after, "utf8").catch(() => "");
					identity = `sha ${shortHash(current)}→${shortHash(params.content!)} (${lineCount(current)}→${lineCount(params.content!)} lines)`;
				} else if (params.b) {
					before = resolve(params.b);
					afterPath = after;
				} else {
					const stashed = await stashHeadVersion(after);
					tempPaths.push(stashed.tempPath);
					before = stashed.tempPath;
					afterPath = after;
				}
			} catch (error) {
				return { content: [{ type: "text" as const, text: `${params.a}: ${error instanceof Error ? error.message : String(error)}` }], details: { error: "no-head" } };
			}

			const flags = [
				...(params.ignore_whitespace ? ["--ignore-all-space"] : []),
				...(params.ignore_eol ? ["--ignore-cr-at-eol"] : []),
			];
			let run = await execFileText("git", ["diff", "--no-index", "--no-color", `--unified=${contextLines}`, ...flags, "--", before, afterPath], 60_000);
			if (run.code > 1 && /not recognized|not found|No such file/i.test(run.stderr)) {
				run = await execFileText("diff", [...(params.ignore_whitespace ? ["-w"] : []), `-U${contextLines}`, before, afterPath], 60_000);
			}
			await Promise.all(tempPaths.map((file) => unlink(file).catch(() => undefined)));

			const label = `${params.a} vs ${beforeLabel}`;
			// git diff names the on-disk file first and the temp/baseline second; in preview mode that
			// means a/ is the CURRENT file and b/ is the PROPOSED content, so the labels must follow
			// the argument order or the `-`/`+` lines read backwards.
			const labels: [string, string] = previewing ? [params.a, beforeLabel] : [beforeLabel, params.a];
			if (run.code > 1) {
				return { content: [{ type: "text" as const, text: `${label}: diff failed (exit ${run.code}) ${run.stderr.trim()}` }], details: { error: "diff-failed" } };
			}
			const raw = relabelDiff(run.stdout.replace(/\r\n/g, "\n"), ...labels);
			if (run.code === 0 && !raw.trim()) {
				return { content: [{ type: "text" as const, text: `${label}: no differences${identity ? ` (${identity})` : ""}.` }], details: { hunks: 0, added: 0, removed: 0 } };
			}

			const stats = summarizeDiff(raw);
			const clipped = clip(raw, maxChars);
			const header = `${label}${identity ? ` [${identity}]` : ""} — ${stats.hunks} hunk(s), +${stats.added} -${stats.removed}${clipped.truncated ? `, diff is ${clipped.originalChars} chars (showing ${maxChars})` : ""}`;
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${clipped.text}` }],
				details: { ...stats, truncated: clipped.truncated },
			};
		},
	});
}
