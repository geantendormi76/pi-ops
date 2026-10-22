import { access, stat } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clip, junkRatio } from "./text.ts";
import {
	extractPdfText,
	MAX_DOCUMENT_BYTES,
	PDF_DEFAULT_PAGES,
	PDF_MAX_PAGES_PER_CALL,
	pageWindow,
	parsePageRange,
} from "./pdf-core.ts";

const DEFAULT_MAX_CHARS = 40_000;

export function registerReadPdf(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "read_pdf",
		label: "Read PDF",
		description:
			"Extract a PDF's text with layout preserved and pages labelled, using the pdftotext binary already present in Git for Windows (pypdf via uv as fallback). Pages are addressed by offset/limit (default 1/10, max 32 per call) or by an explicit `pages` list, and the header reports the page window plus the next offset to continue from. No network, no shell.",
		promptSnippet: "Extract text from a PDF (layout preserved, page windows)",
		promptGuidelines: [
			"Use read_pdf for PDFs instead of asking the user to paste text, converting pages to images, or installing poppler.",
			'Continue a long PDF with `offset: <nextOffset from the header>` rather than re-reading from page 1.',
		],
		parameters: Type.Object({
			path: Type.String({ description: "Path to the .pdf file" }),
			offset: Type.Optional(Type.Number({ description: `First page, 1-based (default 1)` })),
			limit: Type.Optional(Type.Number({ description: `Pages to read, 1-${PDF_MAX_PAGES_PER_CALL} (default ${PDF_DEFAULT_PAGES})` })),
			pages: Type.Optional(Type.String({ description: 'Explicit selection instead of offset/limit: "3", "1-12", "1,4,7-9"' })),
			layout: Type.Optional(Type.Boolean({ description: "Keep visual layout with spaces (default true; false reflows text)" })),
			max_chars: Type.Optional(Type.Number({ description: `Output budget (default ${DEFAULT_MAX_CHARS})` })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const cwd = ctx.cwd ?? process.cwd();
			const resolved = path.isAbsolute(params.path) ? params.path : path.resolve(cwd, params.path);
			const maxChars = Math.max(2000, Math.floor(params.max_chars ?? DEFAULT_MAX_CHARS));

			try {
				const info = await stat(resolved);
				if (!info.isFile()) {
					return { content: [{ type: "text" as const, text: `${params.path}: not a regular file` }], details: { error: "not-a-file" } };
				}
				if (info.size > MAX_DOCUMENT_BYTES) {
					return {
						content: [
							{
								type: "text" as const,
								text: `${params.path}: ${(info.size / 1024 / 1024).toFixed(1)} MiB is above the ${MAX_DOCUMENT_BYTES / 1024 / 1024} MiB limit. Read it in page windows (\`offset\`/\`limit\`) is still the only safe option — the size guard applies to the whole file, so ask the user to split it.`,
							},
						],
						details: { error: "too-large", bytes: info.size },
					};
				}
			} catch {
				return { content: [{ type: "text" as const, text: `${params.path}: NOT FOUND` }], details: { error: "ENOENT" } };
			}

			let pages: number[];
			try {
				pages = parsePageRange(params.pages) ?? pageWindow(params.offset, params.limit);
			} catch (error) {
				return { content: [{ type: "text" as const, text: `${params.path}: ${error instanceof Error ? error.message : String(error)}` }], details: { error: "bad-pages" } };
			}

			let result: Awaited<ReturnType<typeof extractPdfText>>;
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
							text: `${params.path}: no extractable text on pages ${pages[0]}–${pages[pages.length - 1]}${result.totalPages ? ` of ${result.totalPages}` : ""} — this looks like a scanned/image PDF. OCR is not available here; ask the user rather than inventing content.`,
						},
					],
					details: { empty: true, totalPages: result.totalPages, backend: result.backend },
				};
			}

			const firstShown = result.firstPage;
			const lastShown = result.firstPage + result.observedPages - 1;
			const nextOffset = result.totalPages === undefined && result.observedPages >= pages.length ? result.firstPage + result.observedPages : undefined;
			const windowLabel = result.observedPages <= 1 ? `page ${firstShown}` : `pages ${firstShown}–${lastShown}`;
			const totalLabel = result.totalPages ? `of ${result.totalPages}` : nextOffset ? `(document continues; next offset ${nextOffset})` : "";
			const clipped = clip(result.text, maxChars);
			const junk = junkRatio(result.text);
			const header = `${params.path} — PDF, ${windowLabel} ${totalLabel}, ${result.text.length} chars via ${result.backend}${clipped.truncated ? ` (showing ${maxChars})` : ""}`;
			const warning = junk > 0.05 ? "\n\n[warn] many unmappable characters — this PDF's fonts may be undecodable; retry with layout: false or read the pages you need only." : "";
			return {
				content: [{ type: "text" as const, text: `${header}\n\n${clipped.text}${warning}` }],
				details: {
					totalPages: result.totalPages,
					firstPage: firstShown,
					lastPage: lastShown,
					nextOffset,
					chars: result.text.length,
					backend: result.backend,
					truncated: clipped.truncated,
				},
			};
		},
	});
}
