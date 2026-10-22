/**
 * CSV/TSV reading: BOM-aware decoding plus a strict RFC 4180 parser and row paging.
 * Excel on this host exports UTF-16LE and ANSI/GBK by default, so decode problems are
 * reported instead of being papered over with replacement characters.
 */

export type Encoding = "utf-8" | "utf-16le" | "utf-16be";

export interface DecodedText {
	text: string;
	encoding: Encoding;
	hadBom: boolean;
	/** Share of U+FFFD characters — high values mean the bytes are not UTF-8 (likely GBK). */
	replacementRatio: number;
}

/** Decode by BOM, defaulting to UTF-8, and measure how much of it failed to decode. */
export function decodeText(buffer: Buffer): DecodedText {
	let encoding: Encoding = "utf-8";
	let hadBom = false;
	let body = buffer;
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		hadBom = true;
		body = buffer.subarray(3);
	} else if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
		hadBom = true;
		encoding = "utf-16le";
		body = buffer.subarray(2);
	} else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
		hadBom = true;
		encoding = "utf-16be";
		const swapped = Buffer.from(body.subarray(2));
		swapped.swap16();
		body = swapped;
	}
	const text = body.toString(encoding === "utf-16be" ? "utf16le" : encoding);
	const replacementRatio = text ? (text.match(/\uFFFD/g)?.length ?? 0) / text.length : 0;
	return { text, encoding, hadBom, replacementRatio };
}

/** Split delimited text into records, honouring quotes, escaped quotes and embedded newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
	const records: string[][] = [];
	let cells: string[] = [];
	let cell = "";
	let quoted = false;
	let index = 0;
	while (index < text.length) {
		const char = text[index];
		if (quoted) {
			if (char === '"') {
				if (text[index + 1] === '"') {
					cell += '"';
					index += 2;
					continue;
				}
				quoted = false;
				index++;
				continue;
			}
			cell += char;
			index++;
			continue;
		}
		if (char === '"' && cell === "") {
			quoted = true;
			index++;
			continue;
		}
		if (char === delimiter) {
			cells.push(cell);
			cell = "";
			index++;
			continue;
		}
		if (char === "\r" && text[index + 1] === "\n") {
			cells.push(cell);
			records.push(cells);
			cells = [];
			cell = "";
			index += 2;
			continue;
		}
		if (char === "\n") {
			cells.push(cell);
			records.push(cells);
			cells = [];
			cell = "";
			index++;
			continue;
		}
		cell += char;
		index++;
	}
	if (cell !== "" || cells.length) {
		cells.push(cell);
		records.push(cells);
	}
	return records.filter((record) => record.length > 1 || record[0] !== "");
}

export interface TablePage {
	columns?: string[];
	rows: Array<{ row: number; cells: string[] }>;
	total: number;
	offset: number;
	limit: number;
	nextOffset?: number;
}

/** Page data rows (1-based, header excluded) out of a parsed table. */
export function pageTable(records: string[][], hasHeader: boolean, offset: number, limit: number): TablePage {
	const columns = hasHeader ? records[0] : undefined;
	const data = hasHeader ? records.slice(1) : records;
	const start = Math.max(1, Math.floor(offset));
	const size = Math.max(1, Math.floor(limit));
	const slice = data.slice(start - 1, start - 1 + size);
	const nextOffset = start - 1 + slice.length < data.length ? start + slice.length : undefined;
	return {
		columns,
		rows: slice.map((cells, index) => ({ row: start + index, cells })),
		total: data.length,
		offset: start,
		limit: size,
		nextOffset,
	};
}

/** Render a page as a pipe table with cells escaped for one-line rows. */
export function renderTable(page: TablePage): string {
	const width = Math.max(page.columns?.length ?? 0, ...page.rows.map((row) => row.cells.length), 1);
	const escape = (value: string) => value.replace(/\r?\n/g, "\\n").replace(/\|/g, "\\|").trim();
	const lines: string[] = [];
	if (page.columns) {
		const header = Array.from({ length: width }, (_, i) => escape(page.columns![i] ?? ""));
		lines.push(`| row | ${header.join(" | ")} |`, `|---|${header.map(() => "---").join("|")}|`);
	}
	for (const row of page.rows) {
		const cells = Array.from({ length: width }, (_, i) => escape(row.cells[i] ?? ""));
		lines.push(`| ${row.row} | ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}
