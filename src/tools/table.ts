import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip } from "./text.ts";
import { decodeText, pageTable, parseDelimited, renderTable } from "./table-core.ts";

const DEFAULT_ROWS = 200;
const MAX_ROWS_PER_CALL = 1000;
const MAX_TABLE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_CHARS = 40_000;

export function registerReadTable(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_table",
		label: "Read CSV/TSV",
		description:
			"Read a .csv/.tsv file as rows: BOM-aware decoding (UTF-8, UTF-16LE/BE), RFC 4180 quoting with embedded newlines, optional header row, and row paging (offset/limit, default 1/200, max 1000). Excel exports here are often UTF-16 or ANSI, so undecodable bytes are reported instead of silently mangled.",
		promptSnippet: "Read CSV/TSV rows with header and paging",
		promptGuidelines: [
			"Use read_table for CSV/TSV instead of `Get-Content` or `cat`: it handles BOMs, quoting, and paging.",
			"ANSI/GBK files cannot be decoded here — if the tool reports replacement characters, re-export as UTF-8 CSV or read it through `powershell -Command \"Get-Content -Encoding Default\"`.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .csv/.tsv file" }),
			format: Type.Optional(Type.String({ description: 'Delimiter: "csv" (default), "tsv", or one literal character' })),
			has_header: Type.Optional(Type.Boolean({ description: "Treat the first record as column names (default true)" })),
			offset: Type.Optional(Type.Number({ description: "First data row, 1-based, header excluded (default 1)" })),
			limit: Type.Optional(Type.Number({ description: `Rows to return, 1-${MAX_ROWS_PER_CALL} (default ${DEFAULT_ROWS})` })),
			max_chars: Type.Optional(Type.Number({ description: `Output budget (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const resolved = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
			const maxChars = Math.max(2000, Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS));

			let buffer: Buffer;
			try {
				const info = await stat(resolved);
				if (info.isDirectory()) {
					return { content: [{ type: "text" as const, text: `${params.path}: is a directory — use ls or find.` }], details: { error: "EISDIR" } };
				}
				if (info.size > MAX_TABLE_BYTES) {
					return {
						content: [{ type: "text" as const, text: `${params.path}: ${(info.size / 1024 / 1024).toFixed(1)} MiB exceeds the ${MAX_TABLE_BYTES / 1024 / 1024} MiB table limit.` }],
						details: { error: "too-large", bytes: info.size },
					};
				}
				buffer = await readFile(resolved);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "ERROR";
				return { content: [{ type: "text" as const, text: `${params.path}: ${code === "ENOENT" ? "NOT FOUND" : `read failed (${code})`}` }], details: { error: code } };
			}

			const decoded = decodeText(buffer);
			const format = (params.format ?? "").toLowerCase();
			const delimiter = format === "tsv" || (!format && /\.tsv$/i.test(resolved)) ? "\t" : format && format !== "csv" ? params.format! : ",";
			const records = parseDelimited(decoded.text, delimiter);
			if (!records.length) {
				return { content: [{ type: "text" as const, text: `${params.path}: no records (empty file or header only).` }], details: { total: 0 } };
			}

			const page = pageTable(records, params.has_header !== false, params.offset ?? 1, Math.min(MAX_ROWS_PER_CALL, params.limit ?? DEFAULT_ROWS));
			const body = renderTable(page);
			const clipped = clip(body, maxChars);
			const rangeLabel = page.rows.length ? `rows ${page.rows[0].row}–${page.rows[page.rows.length - 1].row}` : "no rows";
			const header = [
				`${params.path} — table, ${rangeLabel} of ${page.total} data rows${page.nextOffset ? `, nextOffset ${page.nextOffset}` : ""}`,
				`encoding ${decoded.encoding}${decoded.hadBom ? " (BOM)" : ""}, delimiter ${JSON.stringify(delimiter)}, ${page.columns ? `${page.columns.length} columns` : "no header"}`,
			].join(" | ");

			const warnings: string[] = [];
			if (decoded.replacementRatio > 0.002) {
				warnings.push(`[warn] ${(decoded.replacementRatio * 100).toFixed(1)}% of characters failed to decode as ${decoded.encoding} — the file is probably ANSI/GBK. Re-export as UTF-8 or read it via powershell \`Get-Content -Encoding Default\`.`);
			}
			if (decoded.text.includes("\u0000")) warnings.push("[warn] NUL bytes present — this may be a binary or UTF-16 file without a BOM.");

			const parts = [header, "", clipped.text, ...(warnings.length ? ["", ...warnings] : [])];
			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
				details: {
					total: page.total,
					offset: page.offset,
					rows: page.rows.length,
					nextOffset: page.nextOffset,
					columns: page.columns?.length ?? 0,
					encoding: decoded.encoding,
					truncated: clipped.truncated,
				},
			};
		},
	});
}
