import { execFileText } from "./exec.ts";
import { clip, junkRatio } from "./text.ts";

/** Page window bounds, mirroring dsh-ops' read_pdf contract (default 10, hard cap 32 per call). */
export const PDF_DEFAULT_PAGES = 10;
export const PDF_MAX_PAGES_PER_CALL = 32;
/** Refuse absurd inputs instead of loading hundreds of megabytes into memory. */
export const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/** Convert an offset/limit window (1-based, like dsh-ops) into an explicit page list. */
export function pageWindow(offset: number | undefined, limit: number | undefined): number[] {
	const start = Math.max(1, Math.floor(offset ?? 1));
	const count = Math.min(PDF_MAX_PAGES_PER_CALL, Math.max(1, Math.floor(limit ?? PDF_DEFAULT_PAGES)));
	return Array.from({ length: count }, (_, index) => start + index);
}

/** Parse "3", "1-5", "1,4,7-9" into sorted 1-based page numbers. */
export function parsePageRange(spec: string | undefined): number[] | undefined {
	if (!spec || !spec.trim()) return undefined;
	const pages: number[] = [];
	for (const part of spec.split(",")) {
		const piece = part.trim();
		if (!piece) continue;
		const range = /^(\d+)\s*[-–:]\s*(\d+)$/.exec(piece);
		if (range) {
			const from = Number(range[1]);
			const to = Number(range[2]);
			if (from <= 0 || to < from) throw new Error(`invalid page range "${piece}"`);
			for (let page = from; page <= Math.min(to, from + 300); page++) pages.push(page);
			continue;
		}
		const single = Number(piece);
		if (!Number.isInteger(single) || single <= 0) throw new Error(`invalid page number "${piece}"`);
		pages.push(single);
	}
	return pages.length ? [...new Set(pages)].sort((left, right) => left - right) : undefined;
}

/** Turn form-feed-delimited pages into numbered sections so the model can cite pages. */
export function labelPages(text: string, firstPage: number, alwaysLabel = false): string {
	const pageTexts = text.split("\f");
	while (pageTexts.length > 1 && !pageTexts[pageTexts.length - 1]!.trim()) pageTexts.pop();
	if (pageTexts.length <= 1 && !alwaysLabel) return text.replace(/\f/g, "").replace(/\n{3,}/g, "\n\n").trim();
	return pageTexts
		.map((pageText, index) => `--- page ${firstPage + index} ---\n${pageText.replace(/[ \t]+$/gm, "").trim()}`)
		.join("\n\n")
		.trim();
}

export interface PdfExtraction {
	text: string;
	backend: "pdftotext" | "pypdf";
	/** Exact page count when known; undefined when the window filled up, i.e. "at least". */
	totalPages?: number;
	observedPages: number;
	firstPage: number;
	empty: boolean;
}

/** Extract PDF text with pdftotext (ships with Git for Windows), falling back to pypdf through uv. */
export async function extractPdfText(file: string, pages?: number[], layout = true): Promise<PdfExtraction> {
	const firstPage = pages?.[0] ?? 1;
	const rangeArgs = pages ? ["-f", String(pages[0]), "-l", String(pages[pages.length - 1])] : [];

	const pdftotext = await execFileText("pdftotext", ["-enc", "UTF-8", ...(layout ? ["-layout"] : []), ...rangeArgs, file, "-"], 60_000);
	if (pdftotext.code === 0) {
		const raw = pdftotext.stdout.replace(/\r\n/g, "\n");
		const labelled = labelPages(raw, firstPage, pages !== undefined);
		// A short window means the window ran past the end, so the total is exact; a full window
		// only proves the document has at least that many pages.
		const observed = raw.split("\f").filter((pageText, index, all) => index < all.length - 1 || pageText.trim()).length;
		const totalPages = pages ? (observed < pages.length ? firstPage + observed - 1 : undefined) : observed;
		return { text: labelled, backend: "pdftotext", totalPages, observedPages: observed, firstPage, empty: !labelled };
	}

	// Fallback: python + pypdf, cached by uv (only reached when pdftotext is unavailable).
	const script = [
		"import sys",
		"from pypdf import PdfReader",
		"reader = PdfReader(sys.argv[1])",
		"total = len(reader.pages)",
		"wanted = [int(p) for p in sys.argv[2].split(',') if p] or list(range(1, total + 1))",
		"parts = []",
		"for number in wanted:",
		"    try:",
		"        parts.append(reader.pages[number - 1].extract_text() or '')",
		"    except Exception as exc:",
		"        parts.append('[page %d failed: %s]' % (number, exc))",
		"sys.stdout.write('\\f'.join(parts))",
		"sys.stderr.write('PAGES=%d' % total)",
	].join("\n");
	const pypdf = await execFileText("uv", ["run", "--no-project", "--quiet", "--with", "pypdf", "python", "-c", script, file, (pages ?? []).join(",")], 180_000);
	if (pypdf.code === 0) {
		const total = Number(/PAGES=(\d+)/.exec(pypdf.stderr)?.[1] ?? 0) || undefined;
		const labelled = labelPages(pypdf.stdout.replace(/\r\n/g, "\n"), firstPage, pages !== undefined);
		return { text: labelled, backend: "pypdf", totalPages: total, observedPages: labelled ? labelled.split("--- page ").length - 1 : 0, firstPage, empty: !labelled };
	}

	throw new Error(
		`no PDF text backend worked — pdftotext: ${pdftotext.stderr.trim() || `exit ${pdftotext.code}`}; pypdf via uv: ${pypdf.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${pypdf.code}`}`,
	);
}
