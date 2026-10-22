import path from "node:path";
import { inflateRawSync } from "node:zlib";

/** Read the central directory of a zip archive and return the requested entries. */
export function readZipEntries(buffer: Buffer, wanted: string[]): Map<string, Buffer> {
	const entries = new Map<string, Buffer>();
	// End of central directory: signature 0x06054b50, searched from the tail (comment <= 64K).
	let eocd = -1;
	for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 66_000); i--) {
		if (buffer.readUInt32LE(i) === 0x06054b50) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error("not a zip archive (no end-of-central-directory record)");

	const count = buffer.readUInt16LE(eocd + 10);
	let offset = buffer.readUInt32LE(eocd + 16);
	for (let index = 0; index < count; index++) {
		if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
		const method = buffer.readUInt16LE(offset + 10);
		const compressedSize = buffer.readUInt32LE(offset + 20);
		const nameLength = buffer.readUInt16LE(offset + 28);
		const extraLength = buffer.readUInt16LE(offset + 30);
		const commentLength = buffer.readUInt16LE(offset + 32);
		const localOffset = buffer.readUInt32LE(offset + 42);
		const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
		offset += 46 + nameLength + extraLength + commentLength;
		if (!wanted.includes(name)) continue;

		const localNameLength = buffer.readUInt16LE(localOffset + 26);
		const localExtraLength = buffer.readUInt16LE(localOffset + 28);
		const dataStart = localOffset + 30 + localNameLength + localExtraLength;
		const data = buffer.subarray(dataStart, dataStart + compressedSize);
		entries.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
	}
	return entries;
}

function decodeEntities(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
		.replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
		.replace(/&amp;/g, "&");
}

/** Paragraph-block paging bounds, mirroring dsh-ops' read_docx contract. */
export const DOCX_DEFAULT_PARAGRAPHS = 200;
export const DOCX_MAX_PARAGRAPHS_PER_CALL = 1000;

export interface BlockPage {
	text: string;
	total: number;
	offset: number;
	limit: number;
	shown: number;
	nextOffset?: number;
}

/** Split converted body text into paragraph blocks (blank-line separated). */
export function splitBlocks(text: string): string[] {
	return text.split(/\n{2,}/).filter((block) => block.trim());
}

/** Page through paragraph blocks with 1-based offset/limit. */
export function paginateBlocks(text: string, offset?: number, limit?: number): BlockPage {
	const blocks = splitBlocks(text);
	const start = Math.max(1, Math.floor(offset ?? 1));
	const size = Math.min(DOCX_MAX_PARAGRAPHS_PER_CALL, Math.max(1, Math.floor(limit ?? DOCX_DEFAULT_PARAGRAPHS)));
	const slice = blocks.slice(start - 1, start - 1 + size);
	const nextOffset = start - 1 + slice.length < blocks.length ? start + slice.length : undefined;
	return { text: slice.join("\n\n"), total: blocks.length, offset: start, limit: size, shown: slice.length, nextOffset };
}

/** Convert WordprocessingML (`word/document.xml`) into plain text. */
export function docxXmlToText(xml: string): string {
	let text = xml
		// Drop deleted revisions and field instructions before any text extraction.
		.replace(/<w:delText[\s\S]*?<\/w:delText>/g, "")
		.replace(/<w:instrText[\s\S]*?<\/w:instrText>/g, "");

	// Inside a table a paragraph break separates cell content, not rows: keep each row on one line.
	text = text.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (table: string) => table.replace(/<\/w:p>/g, " "));

	text = text
		// Structure → text markers.
		.replace(/<w:tab\/>/g, "\t")
		.replace(/<w:br\s*\/>/g, "\n")
		.replace(/<\/w:tc>/g, " | ")
		.replace(/<\/w:tr>/g, "\n")
		.replace(/<\/w:p>/g, "\n")
		// Keep run text (including runs inside hyperlinks/smartTags).
		.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_match: string, content: string) => decodeEntities(content));
	// Everything still tagged is markup (including embedded objects and field codes).
	text = text.replace(/<[^>]+>/g, "");
	return text
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => line.replace(/ {2,}/g, " ").replace(/\s*\|\s*$/, "").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}
