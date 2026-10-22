import path from "node:path";
import { access } from "node:fs/promises";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip, junkRatio } from "./text.ts";
import { extractPdfText, parsePageRange, type PdfExtraction } from "./pdf-core.ts";

const DEFAULT_MAX_CHARS = 40_000;

export function registerReadPdf(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description:
			"Extract a PDF's text with layout preserved and pages labelled, using the pdftotext binary already present in Git for Windows (pypdf via uv as fallback). Supports page ranges so a 300-page report costs only the pages you read. No network, no shell.",
		promptSnippet: "Extract text from a PDF (pdftotext, page ranges)",
		promptGuidelines: [
			"Use read_pdf for PDFs instead of asking the user to paste text, converting pages to images, or installing poppler.",
			"Read long PDFs in page ranges (pages: \"1-10\") to keep output small.",
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .pdf file" }),
			pages: Type.Optional(Type.String({ description: 'Page selection: "3", "1-12", "1,4,7-9" (default: all)' })),
			layout: Type.Optional(Type.Boolean({ description: "Keep visual layout with spaces (default true; false reflows text)" })),
			max_chars: Type.Optional(Type.Number({ description: `Output budget (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const resolved = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
			const maxChars = Math.max(2000, Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS));

			try {
				await access(resolved);
			} catch {
				return { content: [{ type: "text" as const, text: `${params.path}: NOT FOUND` }], details: { error: "ENOENT" } };
			}

			let pages: number[] | undefined;
			try {
				pages = parsePageRange(params.pages);
			} catch (error) {
				return { content: [{ type: "text" as const, text: `${params.path}: ${error instanceof Error ? error.message : String(error)}` }], details: { error: "bad-pages" } };
			}

			let result: PdfExtraction;
			try {
				result = await extractPdfText(resolved, pages, params.layout !== false);
			} catch (error) {
				return { content: [{ type: "text" as const, text: `${params.path}: ${error instanceof Error ? error.message : String(error)}` }], details: { error: "no-backend" } };
			}

			if (result.empty) {
				return {
					content: [
						{
							type: "text" as const,
							text: `${params.path}: no extractable text${result.pageCount ? ` (${result.pageCount} pages)` : ""} — this looks like a scanned/image PDF. OCR is not available here; ask the user rather than inventing content.`,
						},
					],
					details: { empty: true, pageCount: result.pageCount, backend: result.backend },
				};
			}

			const clipped = clip(result.text, maxChars);
			const junk = junkRatio(result.text);
			const header = [
				`${params.path} — PDF${result.pageCount ? `, ${result.pageCount} page(s)` : ""}${pages ? `, pages ${params.pages}` : ""}, ${result.text.length} chars via ${result.backend}${clipped.truncated ? ` (showing ${maxChars})` : ""}`,
			].join("");
			const warning = junk > 0.05 ? "\n\n[warn] many unmappable characters — this PDF's fonts may be undecodable; retry with layout: false or read the pages you need only." : "";
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${clipped.text}${warning}` }],
				details: { pageCount: result.pageCount, chars: result.text.length, backend: result.backend, truncated: clipped.truncated },
			};
		},
	});
}
