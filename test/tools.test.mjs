// Tests for the PDF / DOCX / diff tools. Run: node test/tools.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJiti } from "file:///C:/Users/52484/.pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const CWD = "C:/dev/pi-ops";
const pdf = await jiti.import(`${CWD}/src/tools/pdf-core.ts`);
const docx = await jiti.import(`${CWD}/src/tools/docx-core.ts`);
const diff = await jiti.import(`${CWD}/src/tools/diff-core.ts`);
const text = await jiti.import(`${CWD}/src/tools/text.ts`);

let checks = 0;
function check(name, fn) {
	checks++;
	try {
		fn();
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}
async function checkAsync(name, fn) {
	checks++;
	try {
		await fn();
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

// --- page range parsing -------------------------------------------------
check("parsePageRange single", () => assert.deepEqual(pdf.parsePageRange("3"), [3]));
check("parsePageRange range", () => assert.deepEqual(pdf.parsePageRange("1-3"), [1, 2, 3]));
check("parsePageRange mixed + dedupe", () => assert.deepEqual(pdf.parsePageRange("1,4,7-9,9"), [1, 4, 7, 8, 9]));
check("parsePageRange also accepts en dash", () => assert.deepEqual(pdf.parsePageRange("2–4"), [2, 3, 4]));
check("parsePageRange empty -> undefined", () => assert.equal(pdf.parsePageRange("  "), undefined));
check("parsePageRange rejects garbage", () => assert.throws(() => pdf.parsePageRange("abc"), /invalid page/));
check("parsePageRange rejects inverted range", () => assert.throws(() => pdf.parsePageRange("5-2"), /invalid page range/));

// --- page labelling ----------------------------------------------------
check("labelPages numbers pages", () => {
	const out = pdf.labelPages("first\fsecond\f", 4);
	assert.match(out, /--- page 4 ---\nfirst/);
	assert.match(out, /--- page 5 ---\nsecond/);
});
check("labelPages leaves single page unlabelled", () => {
	assert.equal(pdf.labelPages("only page\n\f", 1), "only page");
});

// --- real pdftotext on the fixture -------------------------------------
await checkAsync("extractPdfText reads whole fixture", async () => {
	const result = await pdf.extractPdfText(`${CWD}/test/fixtures/sample.pdf`);
	assert.equal(result.backend, "pdftotext");
	assert.equal(result.empty, false);
	assert.equal(result.totalPages, 2);
	assert.equal(result.observedPages, 2);
	assert.equal(result.firstPage, 1);
	assert.match(result.text, /Hello pi-ops PDF/);
	assert.match(result.text, /Second page here/);
	assert.match(result.text, /--- page 1 ---/);
});
await checkAsync("extractPdfText honours page range", async () => {
	const result = await pdf.extractPdfText(`${CWD}/test/fixtures/sample.pdf`, [2]);
	assert.match(result.text, /--- page 2 ---/);
	assert.match(result.text, /Second page here/);
	assert.doesNotMatch(result.text, /Hello pi-ops PDF/);
});
await checkAsync("extractPdfText reflow mode works", async () => {
	const result = await pdf.extractPdfText(`${CWD}/test/fixtures/sample.pdf`, undefined, false);
	assert.match(result.text, /Hello pi-ops PDF/);
});

// --- docx --------------------------------------------------------------
check("readZipEntries inflates a deflated entry", () => {
	const entries = docx.readZipEntries(readFileSync(`${CWD}/test/fixtures/sample.docx`), ["word/document.xml"]);
	assert.ok(entries.get("word/document.xml").toString("utf8").includes("Quarterly report"));
});
check("readZipEntries ignores unrequested entries", () => {
	const entries = docx.readZipEntries(readFileSync(`${CWD}/test/fixtures/sample.docx`), ["word/header1.xml"]);
	assert.deepEqual([...entries.keys()], ["word/header1.xml"]);
});
check("readZipEntries rejects non-zip", () => assert.throws(() => docx.readZipEntries(Buffer.from("not a zip at all, just text"), ["x"]), /not a zip/));

const xml = docx.readZipEntries(readFileSync(`${CWD}/test/fixtures/sample.docx`), ["word/document.xml"]).get("word/document.xml").toString("utf8");
const body = docx.docxXmlToText(xml);
check("docx paragraphs split", () => assert.match(body, /^Quarterly report$/m));
check("docx joins runs in one paragraph", () => assert.match(body, /Chapter 1 — Windows notes/));
check("docx keeps tabs", () => assert.match(body, /Windows notes\ttabbed/));
check("docx renders table rows as pipes", () => assert.match(body, /^Metric \| Value$/m));
check("docx keeps a row on one line", () => assert.match(body, /^Retries \| 7$/m));
check("docx keeps CJK", () => assert.match(body, /中文段落：命令执行失败/));
check("docx decodes entities", () => assert.match(body, /& more/));
check("docx drops deleted revisions", () => assert.doesNotMatch(body, /deleted revision text/));
check("docx keeps surviving text after deletion", () => assert.match(body, /kept text/));
check("docx strips all tags", () => assert.doesNotMatch(body, /<w:/));

// --- diff --------------------------------------------------------------
check("summarizeDiff counts hunks and lines", () => {
	const stats = diff.summarizeDiff(["@@ -1,2 +1,3 @@", " context", "-old", "+new", "+extra", "--- a/x", "+++ b/x"].join("\n"));
	assert.deepEqual(stats, { hunks: 1, added: 2, removed: 1 });
});
check("relabelDiff rewrites headers", () => {
	const out = diff.relabelDiff(["diff --git a/tmp-1 b/tmp-2", "--- tmp-1", "+++ file.ts", "@@ -1 +1 @@"].join("\n"), "HEAD", "file.ts");
	assert.match(out, /^diff --git a\/HEAD b\/file\.ts$/m);
	assert.match(out, /^--- HEAD$/m);
	assert.match(out, /^\+\+\+ file\.ts$/m);
});
check("relabelDiff leaves hunk content alone", () => {
	assert.match(diff.relabelDiff("@@ -1 +1 @@\n-old\n+new", "HEAD", "f.ts"), /-old\n\+new/);
});

const repo = mkdtempSync(path.join(tmpdir(), "pi-ops-diff-"));
await checkAsync("stashHeadVersion returns the committed text", async () => {
	const file = path.join(repo, "a.txt");
	writeFileSync(file, "one\n");
	const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
	git("init", "-q");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "test");
	git("add", ".");
	git("commit", "-q", "-m", "first");
	writeFileSync(file, "two\n");
	const stashed = await diff.stashHeadVersion(file);
	assert.equal(readFileSync(stashed.tempPath, "utf8"), "one\n");
	assert.match(stashed.reloadedFrom, /HEAD:a\.txt$/);
});
await checkAsync("stashHeadVersion explains a missing HEAD version", async () => {
	const file = path.join(repo, "untracked.txt");
	writeFileSync(file, "x\n");
	await assert.rejects(() => diff.stashHeadVersion(file), /HEAD has no version/);
});
await checkAsync("stashHeadVersion explains a non-repo", async () => {
	const stray = mkdtempSync(path.join(tmpdir(), "pi-ops-norepo-"));
	const file = path.join(stray, "x.txt");
	writeFileSync(file, "x\n");
	await assert.rejects(() => diff.stashHeadVersion(file), /not inside a git repository/);
});

// --- shared helpers ----------------------------------------------------
check("clip leaves short text alone", () => {
	const result = text.clip("hello", 100);
	assert.equal(result.truncated, false);
	assert.equal(result.text, "hello");
});
check("clip keeps head and tail with a marker", () => {
	const result = text.clip("A".repeat(50) + "B".repeat(50), 40);
	assert.equal(result.truncated, true);
	assert.equal(result.originalChars, 100);
	assert.match(result.text, /characters cut/);
	assert.ok(result.text.startsWith("A"));
	assert.ok(result.text.endsWith("B"));
});
check("junkRatio ignores clean text", () => assert.equal(text.junkRatio("clean ascii"), 0));
check("junkRatio flags replacement chars", () => assert.ok(text.junkRatio("\uFFFD\uFFFD\uFFFDabc") > 0.4));

console.log(`tools.test.mjs: ${checks} checks passed`);
