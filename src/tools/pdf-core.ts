import { execFileText } from "./exec.ts";
import { clip, junkRatio } from "./text.ts";

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
	pageCount?: number;
	empty: boolean;
}

/** Extract PDF text with pdftotext (ships with Git for Windows), falling back to pypdf through uv. */
export async function extractPdfText(file: string, pages?: number[], layout = true): Promise<PdfExtraction> {
	const firstPage = pages?.[0] ?? 1;
	const rangeArgs = pages ? ["-f", String(pages[0]), "-l", String(pages[pages.length - 1])] : [];

	const pdftotext = await execFileText("pdftotext", ["-enc", "UTF-8", ...(layout ? ["-layout"] : []), ...rangeArgs, file, "-"], 60_000);
	if (pdftotext.code === 0) {
		const labelled = labelPages(pdftotext.stdout.replace(/\r\n/g, "\n"), firstPage, pages !== undefined);
		const pageCount = pages ? undefined : pdftotext.stdout.split("\f").filter((pageText, index, all) => index < all.length - 1 || pageText.trim()).length;
		return { text: labelled, backend: "pdftotext", pageCount, empty: !labelled };
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
		return { text: labelled, backend: "pypdf", pageCount: total, empty: !labelled };
	}

	throw new Error(
		`no PDF text backend worked — pdftotext: ${pdftotext.stderr.trim() || `exit ${pdftotext.code}`}; pypdf via uv: ${pypdf.stderr.trim().split("\n").slice(-2).join(" ") || `exit ${pypdf.code}`}`,
	);
}
