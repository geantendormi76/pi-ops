// Generates the binary fixtures used by tests (no external zip/python needed).
// Usage: node test/make-fixtures.mjs
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const crcTable = (() => {
	const table = new Uint32Array(256);
	for (let i = 0; i < 256; i++) {
		let c = i;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[i] = c >>> 0;
	}
	return table;
})();

function crc32(buffer) {
	let crc = 0xffffffff;
	for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive with deflate-compressed entries. */
export function makeZip(files) {
	const locals = [];
	const centrals = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const nameBytes = Buffer.from(name, "utf8");
		const data = Buffer.from(content, "utf8");
		const compressed = deflateRawSync(data);
		const crc = crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x0800, 6);
		local.writeUInt16LE(8, 8);
		local.writeUInt16LE(0, 10);
		local.writeUInt16LE(0, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(compressed.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, nameBytes, compressed);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x0800, 8);
		central.writeUInt16LE(8, 10);
		central.writeUInt16LE(0, 12);
		central.writeUInt16LE(0, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(compressed.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt16LE(0, 30);
		central.writeUInt16LE(0, 32);
		central.writeUInt16LE(0, 34);
		central.writeUInt16LE(0, 36);
		central.writeUInt32LE(0, 38);
		central.writeUInt32LE(offset, 42);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + compressed.length;
	}
	const centralBuffer = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(Object.keys(files).length, 8);
	eocd.writeUInt16LE(Object.keys(files).length, 10);
	eocd.writeUInt32LE(centralBuffer.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, centralBuffer, eocd]);
}

const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Chapter 1 — </w:t></w:r><w:r><w:t>Windows notes</w:t></w:r><w:r><w:tab/><w:t>tabbed</w:t></w:r></w:p>
    <w:p/>
    <w:tbl>
      <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>Retries</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>7</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
    <w:p><w:r><w:t>中文段落：命令执行失败</w:t></w:r><w:r><w:t> &amp; more</w:t></w:r></w:p>
    <w:p><w:r><w:delText>deleted revision text</w:delText></w:r><w:r><w:t>kept text</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;

const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>Confidential header</w:t></w:r></w:p></w:hdr>`;

mkdirSync("test/fixtures", { recursive: true });
writeFileSync(
	"test/fixtures/sample.docx",
	makeZip({
		"[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
		"word/document.xml": documentXml,
		"word/header1.xml": headerXml,
	}),
);
writeFileSync("test/fixtures/not-a-doc.docx", makeZip({ "hello.txt": "not word" }));
console.log("wrote test/fixtures/sample.docx and test/fixtures/not-a-doc.docx");
