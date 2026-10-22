import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const DEFAULT_LINE_LIMIT = 400;
const DEFAULT_FILE_BYTES = 150_000;
const DEFAULT_TOTAL_CHARS = 90_000;
const MAX_PATHS = 30;

function looksBinary(buffer: Buffer): boolean {
	const probe = buffer.subarray(0, 8000);
	for (const byte of probe) if (byte === 0) return true;
	return false;
}

/**
 * Read several files in one call with line numbers and a shared character budget.
 * Replaces the `cat a; cat b; cat c` pattern that costs one round trip per file.
 */
export function registerReadMany(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_many",
		label: "Read many files",
		description:
			"Read multiple files in a single call. Returns line-numbered contents, skips binaries, reports missing files and directories, and stops when the total budget is spent. Use instead of chaining cat/head per file.",
		promptSnippet: "Read several files at once (line-numbered, budgeted)",
		promptGuidelines: [
			"Use read_many when you need more than one file; it costs one call instead of one per file.",
			"read_many stops at a total character budget and says which files it skipped — request the rest with a narrower offset/limit instead of re-reading everything.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), { description: `Files to read (${MAX_PATHS} max), absolute or relative to cwd` }),
			offset: Type.Optional(Type.Number({ description: "First line to return, 1-based (applies to every file)" })),
			limit: Type.Optional(Type.Number({ description: `Max lines per file (default ${DEFAULT_LINE_LIMIT})` })),
			max_bytes: Type.Optional(Type.Number({ description: `Max bytes per file (default ${DEFAULT_FILE_BYTES})` })),
			total_chars: Type.Optional(Type.Number({ description: `Total output budget in characters (default ${DEFAULT_TOTAL_CHARS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const requested = (params.paths ?? []).slice(0, MAX_PATHS);
			const offset = Math.max(1, Math.floor(params.offset ?? 1));
			const limit = Math.max(1, Math.floor(params.limit ?? DEFAULT_LINE_LIMIT));
			const maxBytes = Math.max(1000, Math.floor(params.max_bytes ?? DEFAULT_FILE_BYTES));
			const totalChars = Math.max(2000, Math.floor(params.total_chars ?? DEFAULT_TOTAL_CHARS));

			const chunks: string[] = [];
			let used = 0;
			const skipped: string[] = [];

			for (const [index, raw] of requested.entries()) {
				const display = raw;
				const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
				let header: string;
				let body = "";
				try {
					const info = await stat(resolved);
					if (info.isDirectory()) {
						header = `### ${display} :: directory (use the ls or find tool)`;
					} else if (info.size > maxBytes) {
						const full = await readFile(resolved);
						if (looksBinary(full)) {
							header = `### ${display} :: binary, skipped (${info.size} bytes)`;
						} else {
							const lines = full.toString("utf8").split(/\r?\n/);
							const from = offset;
							const to = Math.min(lines.length, from + limit - 1);
							header = `### ${display} :: lines ${from}-${to} of ${lines.length} (file is ${info.size} bytes, capped)`;
							body = lines.slice(from - 1, to).join("\n");
						}
					} else {
						const buffer = await readFile(resolved);
						if (looksBinary(buffer)) {
							header = `### ${display} :: binary, skipped (${buffer.length} bytes)`;
						} else {
							const lines = buffer.toString("utf8").split(/\r?\n/);
							const from = offset;
							const to = Math.min(lines.length, from + limit - 1);
							const truncated = from > 1 || to < lines.length;
							header = `### ${display} :: lines ${from}-${to} of ${lines.length}${truncated ? " (truncated)" : ""}`;
							body = lines.slice(from - 1, to).join("\n");
						}
					}
				} catch (error) {
					const code = (error as NodeJS.ErrnoException).code ?? "ERROR";
					header = `### ${display} :: ${code === "ENOENT" ? "NOT FOUND" : `failed (${code})`}`;
				}

				const block = body ? `${header}\n${body}` : header;
				const remaining = totalChars - used;
				if (block.length > remaining) {
					if (remaining > 200) chunks.push(`${block.slice(0, remaining)}\n... [budget reached mid-file]`);
					skipped.push(...requested.slice(index).map((p) => p));
					break;
				}
				chunks.push(block);
				used += block.length + 1;
			}

			const footer = skipped.length ? `\n\n[budget exhausted: ${skipped.length} file(s) not read — ${skipped.join(", ")}]` : "";
			return {
				content: [{ type: "text" as const, text: `${chunks.join("\n\n")}${footer}` }],
				details: { files: requested.length, read: chunks.length, chars: used },
			};
		},
	});
}
