// Parity tests: exercise the real registered tools through a stub ExtensionAPI.
// Run: node test/parity.test.mjs
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "file:///C:/Users/52484/.pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
	// The host provides these at runtime; point jiti at the installed copies for tests.
	alias: { typebox: "C:/Users/52484/.pi/agent/install/releases/1.4.0/node_modules/typebox/build/index.mjs" },
});
const CWD = "C:/dev/pi-ops";
const FIXTURES = `${CWD}/test/fixtures`;

// A stub is enough: every register* function only calls pi.registerTool.
function loadTool(module, register) {
	const tools = {};
	const stub = { registerTool: (tool) => (tools[tool.name] = tool), on() {}, registerCommand() {}, registerShortcut() {}, registerFlag() {} };
	register(stub);
	return tools[Object.keys(tools)[0]];
}

const readMany = loadTool("read-many", (await jiti.import(`${CWD}/src/tools/read-many.ts`)).registerReadMany);
const readPdf = loadTool("pdf", (await jiti.import(`${CWD}/src/tools/pdf.ts`)).registerReadPdf);
const readDocx = loadTool("docx", (await jiti.import(`${CWD}/src/tools/docx.ts`)).registerReadDocx);
const diffFiles = loadTool("diff", (await jiti.import(`${CWD}/src/tools/diff.ts`)).registerDiffFiles);

const ctx = { cwd: CWD };
const run = (tool, params) => tool.execute("test", params, undefined, undefined, ctx);
const textOf = (result) => result.content.map((part) => part.text ?? "").join("\n");

let checks = 0;
let failures = 0;
async function check(name, fn) {
	checks++;
	try {
		await fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL  ${name}\n      ${error.message}`);
	}
}

const DOCX = `${FIXTURES}/sample.docx`;
const PDF = `${FIXTURES}/sample.pdf`;

// --- read_docx paging (dsh-ops: offset/limit + nextOffset) ---------------
await check("read_docx reports total blocks and a nextOffset", async () => {
	const result = await run(readDocx, { path: DOCX, limit: 1 });
	assert.match(textOf(result), /Word document, block 1 of \d+/);
	assert.match(textOf(result), /nextOffset 2/);
	assert.equal(result.details.offset, 1);
	assert.equal(result.details.shown, 1);
	assert.ok(result.details.nextOffset > 1);
});

await check("read_docx continues exactly where it left off", async () => {
	const first = await run(readDocx, { path: DOCX, limit: 1 });
	const second = await run(readDocx, { path: DOCX, offset: first.details.nextOffset, limit: 1 });
	assert.ok(!textOf(second).includes(textOf(first).split("\n\n").pop().trim().slice(0, 20)), "page 2 must not repeat page 1");
	assert.equal(second.details.offset, first.details.nextOffset);
});

await check("read_docx rejects a zip that is not a Word document", async () => {
	const result = await run(readDocx, { path: `${FIXTURES}/not-a-doc.docx` });
	assert.match(textOf(result), /not a Word document/);
	assert.equal(result.details.error, "not-docx");
});

await check("read_docx explains that legacy .doc is unsupported", async () => {
	const result = await run(readDocx, { path: `${FIXTURES}/legacy.doc` });
	assert.equal(result.details.error, "legacy-doc");
	assert.match(textOf(result), /soffice --convert-to docx/);
});

// --- read_pdf paging (dsh-ops: page windows + continuation) --------------
await check("read_pdf labels the page window and reports nextOffset", async () => {
	const result = await run(readPdf, { path: PDF, offset: 1, limit: 1 });
	assert.match(textOf(result), /PDF, page 1/);
	assert.match(textOf(result), /--- page 1 ---/);
	assert.ok(result.details.nextOffset === 2, `expected nextOffset 2, got ${result.details.nextOffset}`);
});

await check("read_pdf reads a later window without restarting", async () => {
	const result = await run(readPdf, { path: PDF, offset: 2, limit: 1 });
	assert.match(textOf(result), /--- page 2 ---/);
	assert.ok(!textOf(result).includes("--- page 1 ---"));
});

await check("read_pdf honours an explicit pages list", async () => {
	const result = await run(readPdf, { path: PDF, pages: "1" });
	assert.equal(result.details.firstPage, 1);
	assert.equal(result.details.lastPage, 1);
});

// --- diff_files preview mode (dsh-ops: diff_content) --------------------
await check("diff_files previews proposed content with sha/line identity", async () => {
	const original = readFileSync(`${CWD}/README.md`, "utf8");
	const result = await run(diffFiles, { a: "README.md", content: `${original}\n<!-- parity check -->\n` });
	assert.match(textOf(result), /README\.md vs proposed/);
	assert.match(textOf(result), /sha [0-9a-f]{12}→[0-9a-f]{12}/);
	assert.match(textOf(result), /\+\d+ -\d+|1 hunk/);
	assert.ok(result.details.added >= 1);
});

await check("diff_files preview reports identical content as no differences", async () => {
	const original = readFileSync(`${CWD}/README.md`, "utf8");
	const result = await run(diffFiles, { a: "README.md", content: original });
	assert.match(textOf(result), /no differences/);
	assert.equal(result.details.hunks, 0);
});

await check("diff_files still diffs two files", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-ops-parity-"));
	writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
	writeFileSync(path.join(dir, "b.txt"), "one\nTWO\n");
	const result = await run(diffFiles, { a: path.join(dir, "a.txt"), b: path.join(dir, "b.txt") });
	assert.match(textOf(result), /a\.txt vs .*b\.txt/);
	assert.equal(result.details.added, 1);
	assert.equal(result.details.removed, 1);
});

await check("diff_files rejects ambiguous b+content", async () => {
	const result = await run(diffFiles, { a: "README.md", b: "package.json", content: "x" });
	assert.equal(result.details.error, "ambiguous-input");
});

// --- read_many line ranges (dsh-ops: start_line/end_line) ---------------
await check("read_many honours start_line/end_line", async () => {
	const result = await run(readMany, { paths: [`${CWD}/package.json`], start_line: 2, end_line: 3 });
	const lines = textOf(result).split("\n");
	assert.equal(lines.length, 3, `expected header + 2 lines, got ${lines.length}`);
	assert.match(lines[1], /"name"/);
	assert.match(lines[2], /"version"/);
	assert.match(lines[0], /lines 2-3 of \d+/);
});

await check("read_many reads several files in one call", async () => {
	const result = await run(readMany, { paths: [`${CWD}/package.json`, `${CWD}/README.md`, `${CWD}/src/index.ts`] });
	assert.equal(result.details.read, 3);
	assert.match(textOf(result), /### .*package\.json/);
	assert.match(textOf(result), /### .*README\.md/);
	assert.match(textOf(result), /### .*src\/index\.ts/);
});

const tableCore = await jiti.import(`${CWD}/src/tools/table-core.ts`);
const readTable = loadTool("table", (await jiti.import(`${CWD}/src/tools/table.ts`)).registerReadTable);

// --- read_table (dsh-ops: csv/tsv with encoding + header + paging) -------
await check("decodeText honours a UTF-16LE BOM", async () => {
	const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("héllo,world\r\n1,2\r\n", "utf16le")]);
	const decoded = tableCore.decodeText(buffer);
	assert.equal(decoded.encoding, "utf-16le");
	assert.equal(decoded.hadBom, true);
	assert.match(decoded.text, /héllo,world/);
});

await check("parseDelimited keeps quoted newlines and escaped quotes", async () => {
	const records = tableCore.parseDelimited('a,"b,c","say ""hi""\nnext"\r\n1,2,3\r\n', ",");
	assert.equal(records.length, 2);
	assert.deepEqual(records[0], ["a", "b,c", 'say "hi"\nnext']);
	assert.deepEqual(records[1], ["1", "2", "3"]);
});

await check("pageTable reports header, range and nextOffset", async () => {
	const records = [
		["id", "name"],
		["1", "a"],
		["2", "b"],
		["3", "c"],
	];
	const first = tableCore.pageTable(records, true, 1, 2);
	assert.deepEqual(first.columns, ["id", "name"]);
	assert.equal(first.total, 3);
	assert.equal(first.nextOffset, 3);
	assert.deepEqual(first.rows.map((row) => row.row), [1, 2]);
	const last = tableCore.pageTable(records, true, 3, 2);
	assert.equal(last.nextOffset, undefined);
	assert.equal(last.rows.length, 1);
});

await check("read_table reads a UTF-16LE CSV end to end", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-ops-table-"));
	const file = path.join(dir, "data.csv");
	writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("id,name\r\n1,alpha\r\n2,beta\r\n3,gamma\r\n", "utf16le")]));
	const result = await run(readTable, { path: file, limit: 2 });
	assert.match(textOf(result), /encoding utf-16le/);
	assert.match(textOf(result), /rows 1–2 of 3/);
	assert.match(textOf(result), /nextOffset 3/);
	assert.match(textOf(result), /\| 1 \| alpha \|/);
	assert.equal(result.details.columns, 2);
	const next = await run(readTable, { path: file, offset: 3 });
	assert.match(textOf(next), /gamma/);
	assert.equal(next.details.nextOffset, undefined);
});

await check("read_table warns when the bytes are not UTF-8", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-ops-gbk-"));
	const file = path.join(dir, "gbk.csv");
	// 0xC4 0xE3 0xBA 0xC3 is "你好" in GBK/936 and invalid UTF-8.
	writeFileSync(file, Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x2c, 0x31, 0x0a, 0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x32, 0x0a]));
	const result = await run(readTable, { path: file });
	assert.match(textOf(result), /probably ANSI\/GBK/);
});

await check("read_table treats TSV paths as tab-delimited", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-ops-tsv-"));
	const file = path.join(dir, "data.tsv");
	writeFileSync(file, "a\tb\n1\t2\n");
	const result = await run(readTable, { path: file });
	assert.match(textOf(result), /delimiter "\\t"/);
	assert.match(textOf(result), /\| 1 \| 1 \| 2 \|/);
});

const pdfCore = await jiti.import(`${CWD}/src/tools/pdf-core.ts`);

// --- pdftotext discovery (Windows PATH lacks Git's mingw64/bin) ---------
await check("resolvePdftotext finds Git's binary even without it on PATH", async () => {
	const savedPath = process.env.PATH;
	const savedLocalAppData = process.env.LOCALAPPDATA;
	process.env.PATH = "C:/Windows/system32";
	pdfCore.resetPdftotextCache();
	try {
		const resolved = await pdfCore.resolvePdftotext();
		assert.ok(resolved, "expected a pdftotext binary to be discovered");
		assert.match(resolved, /pdftotext(\.exe)?$/i);
		if (process.platform === "win32") assert.ok(path.isAbsolute(resolved), `expected an absolute Windows path, got ${resolved}`);
	} finally {
		process.env.PATH = savedPath;
		process.env.LOCALAPPDATA = savedLocalAppData;
		pdfCore.resetPdftotextCache();
	}
});

await check("extractPdfText prefers pdftotext over the pypdf fallback", async () => {
	const result = await pdfCore.extractPdfText(`${FIXTURES}/sample.pdf`, [1]);
	assert.equal(result.backend, "pdftotext");
	assert.match(result.text, /Hello pi-ops PDF/);
});

await check("diff_files preview labels a/ as the current file and b/ as proposed", async () => {
	const original = readFileSync(`${CWD}/README.md`, "utf8");
	const result = await run(diffFiles, { a: "README.md", content: `${original}\n<!-- parity check -->\n` });
	const text = textOf(result);
	assert.match(text, /^--- README\.md$/m, "minus lines come from the current file");
	assert.match(text, /^\+\+\+ proposed$/m, "plus lines come from the proposed content");
	assert.match(text, /^\+<!-- parity check -->$/m);
});

console.log(`\n${checks - failures}/${checks} parity checks passed`);
if (failures) process.exit(1);
