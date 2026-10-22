import { unlink } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFileText } from "./exec.ts";
import { clip } from "./text.ts";
import { relabelDiff, stashHeadVersion, summarizeDiff } from "./diff-core.ts";

export function registerDiffFiles(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "diff_files",
		label: "Diff files",
		description:
			"Unified diff of two files, or of one file against its committed HEAD version (pass only `a`). Prints a hunk/± summary first, then the diff. Uses `git diff --no-index` with a `diff -u` fallback.",
		promptSnippet: "Unified diff: two files, or working copy vs HEAD",
		promptGuidelines: [
			"Use diff_files instead of reading both files in full or piping `git diff` output through the shell.",
			"Pass only `a` to see what changed in a file since its last commit.",
		],
		parameters: Type.Object({
			a: Type.String({ description: "First file; with `b` omitted this is the working copy compared against HEAD" }),
			b: Type.Optional(Type.String({ description: "Second file (omit to compare `a` with its HEAD version)" })),
			context: Type.Optional(Type.Number({ description: "Context lines per hunk (default 3, max 50)" })),
			ignore_whitespace: Type.Optional(Type.Boolean({ description: "Ignore whitespace-only changes (default false)" })),
			max_chars: Type.Optional(Type.Number({ description: "Output budget (default 20000)" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const resolve = (input: string) => (path.isAbsolute(input) ? input : path.resolve(cwd, input));
			const after = resolve(params.a);
			const contextLines = Math.max(0, Math.min(50, Math.floor(params.context ?? 3)));
			const maxChars = Math.max(2000, Math.floor(params.max_chars ?? 20_000));
			const beforeLabel = params.b ?? "HEAD";

			let before = params.b ? resolve(params.b) : "";
			let tempPath: string | undefined;
			if (!params.b) {
				try {
					const stashed = await stashHeadVersion(after);
					tempPath = stashed.tempPath;
					before = stashed.tempPath;
				} catch (error) {
					return { content: [{ type: "text" as const, text: `${params.a}: ${error instanceof Error ? error.message : String(error)}` }], details: { error: "no-head" } };
				}
			}

			const flags = params.ignore_whitespace ? ["--ignore-all-space"] : [];
			let run = await execFileText("git", ["diff", "--no-index", "--no-color", `--unified=${contextLines}`, ...flags, "--", before, after], 60_000);
			if (run.code > 1 && /not recognized|not found|No such file/i.test(run.stderr)) {
				run = await execFileText("diff", [...(params.ignore_whitespace ? ["-w"] : []), `-U${contextLines}`, before, after], 60_000);
			}
			if (tempPath) await unlink(tempPath).catch(() => undefined);

			const label = `${params.a} vs ${beforeLabel}`;
			if (run.code > 1) {
				return { content: [{ type: "text" as const, text: `${label}: diff failed (exit ${run.code}) ${run.stderr.trim()}` }], details: { error: "diff-failed" } };
			}
			const raw = relabelDiff(run.stdout.replace(/\r\n/g, "\n"), beforeLabel, params.a);
			if (run.code === 0 && !raw.trim()) {
				return { content: [{ type: "text" as const, text: `${label}: no differences.` }], details: { hunks: 0, added: 0, removed: 0 } };
			}

			const stats = summarizeDiff(raw);
			const clipped = clip(raw, maxChars);
			const header = `${label} — ${stats.hunks} hunk(s), +${stats.added} -${stats.removed}${clipped.truncated ? `, diff is ${clipped.originalChars} chars (showing ${maxChars})` : ""}`;
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${clipped.text}` }],
				details: { ...stats, truncated: clipped.truncated },
			};
		},
	});
}
