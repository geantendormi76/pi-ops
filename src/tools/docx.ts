import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip } from "./text.ts";
import { DOCX_DEFAULT_PARAGRAPHS, DOCX_MAX_PARAGRAPHS_PER_CALL, docxXmlToText, paginateBlocks, readZipEntries } from "./docx-core.ts";

const DEFAULT_MAX_CHARS = 40_000;
const MAX_DOCX_BYTES = 64 * 1024 * 1024;

export function registerReadDocx(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_docx",
		label: "Read Word document",
		description:
			"Extract the text of a .docx/.docm/.dotx file (paragraphs, tables as `cell | cell`, tabs and line breaks) without Word or LibreOffice. Read-only, no network, no external binaries: it unzips word/document.xml in-process. Paged by paragraph block with offset/limit (default 1/200, max 1000) and reports the next offset.",
		promptSnippet: "Extract text from a Word .docx file",
		promptGuidelines: [
			"Use read_docx instead of asking the user to paste document contents; it reads locally and cheaply.",
			"Legacy binary .doc files are not supported — ask for .docx or a LibreOffice/Word conversion.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .docx file (absolute or relative to cwd)" }),
			offset: Type.Optional(Type.Number({ description: "First paragraph block, 1-based (default 1)" })),
			limit: Type.Optional(Type.Number({ description: `Paragraph blocks to show, 1-${DOCX_MAX_PARAGRAPHS_PER_CALL} (default ${DOCX_DEFAULT_PARAGRAPHS})` })),
			include_headers: Type.Optional(Type.Boolean({ description: "Also append header/footer text (default false)" })),
			max_chars: Type.Optional(Type.Number({ description: `Output budget (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const resolved = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
			const maxChars = Math.max(2000, Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS));

			if (/\.doc$/i.test(resolved)) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${params.path}: legacy binary .doc is not supported. Convert with \`powershell\` + Word COM (\`$w = New-Object -ComObject Word.Application\`) or LibreOffice \`soffice --convert-to docx\`, then read the .docx.`,
						},
					],
					details: { error: "legacy-doc" },
				};
			}

			let buffer: Buffer;
			try {
				const info = await stat(resolved);
				if (info.size > MAX_DOCX_BYTES) {
					return {
						content: [{ type: "text" as const, text: `${params.path}: ${(info.size / 1024 / 1024).toFixed(1)} MiB exceeds the ${MAX_DOCX_BYTES / 1024 / 1024} MiB limit for in-process parsing.` }],
						details: { error: "too-large", bytes: info.size },
					};
				}
				buffer = await readFile(resolved);
			} catch (error) {
				const code = (error as NodeJS.ErrnoException).code ?? "ERROR";
				return { content: [{ type: "text" as const, text: `${params.path}: ${code === "ENOENT" ? "NOT FOUND" : `read failed (${code})`}` }], details: { error: code } };
			}

			const wanted = ["word/document.xml"];
			if (params.include_headers) {
				wanted.push("word/header1.xml", "word/header2.xml", "word/header3.xml", "word/footer1.xml", "word/footer2.xml", "word/footer3.xml");
			}

			let entries: Map<string, Buffer>;
			try {
				entries = readZipEntries(buffer, wanted);
			} catch (error) {
				return {
					content: [{ type: "text" as const, text: `${params.path}: ${error instanceof Error ? error.message : String(error)} — this is not an OOXML document.` }],
					details: { error: "not-zip" },
				};
			}

			const document = entries.get("word/document.xml");
			if (!document) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${params.path}: zip archive has no word/document.xml — it is not a Word document (${[...entries.keys()].join(", ") || "no matching entries"}).`,
						},
					],
					details: { error: "not-docx" },
				};
			}

			const body = docxXmlToText(document.toString("utf8"));
			const page = paginateBlocks(body, params.offset, params.limit);
			const parts = [page.text];
			if (params.include_headers) {
				for (const name of [...entries.keys()].filter((entry) => entry !== "word/document.xml")) {
					const text = docxXmlToText(entries.get(name)!.toString("utf8"));
					if (text) parts.push(`--- ${name} ---\n${text}`);
				}
			}

			const full = parts.filter(Boolean).join("\n\n");
			const rangeLabel = page.shown > 1 ? `blocks ${page.offset}–${page.offset + page.shown - 1}` : `block ${page.offset}`;
			const continueLabel = page.nextOffset ? `, nextOffset ${page.nextOffset}` : "";
			const clipped = clip(full || "(document contains no extractable text)", maxChars);
			const header = `${params.path} — Word document, ${rangeLabel} of ${page.total}${continueLabel}, ${body.length} chars${clipped.truncated ? `, showing ${maxChars}` : ""}`;
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${clipped.text}` }],
				details: { total: page.total, offset: page.offset, shown: page.shown, nextOffset: page.nextOffset, chars: body.length, truncated: clipped.truncated },
			};
		},
	});
}
