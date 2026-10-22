// Smoke test: load the real extension entry point and verify what it registers.
// Run: node test/smoke.test.mjs
import assert from "node:assert/strict";
import { createJiti } from "file:///C:/Users/52484/.pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url, {
	alias: { typebox: "C:/Users/52484/.pi/agent/install/releases/1.4.0/node_modules/typebox/build/index.mjs" },
});

const CWD = "C:/dev/pi-ops";
const mod = await jiti.import(`${CWD}/src/index.ts`);
const piOps = mod.default;
assert.equal(typeof piOps, "function", "default export must be the extension factory");

const tools = [];
const commands = [];
const events = [];
const flags = [];
const pi = {
	registerTool: (tool) => tools.push(tool),
	registerCommand: (name) => commands.push(name),
	registerFlag: (name) => flags.push(name),
	registerShortcut() {},
	on: (name) => events.push(name),
	getAllTools: () => [
		{ name: "powershell" },
		{ name: "grep" },
		{ name: "find" },
		{ name: "ls" },
	],
	getActiveTools: () => ["read", "bash", "edit", "write"],
	setActiveTools() {},
	getFlag: () => false,
	sendMessage() {},
};

piOps(pi);

const names = tools.map((tool) => tool.name).sort();
assert.deepEqual(names, ["diff_files", "read_docx", "read_many", "read_pdf", "read_table", "win_env"], `registered tools: ${names.join(", ")}`);
for (const tool of tools) {
	assert.equal(typeof tool.description, "string");
	assert.ok(tool.description.length > 40, `${tool.name} needs a usable description`);
	assert.equal(typeof tool.execute, "function");
	assert.ok(tool.parameters, `${tool.name} needs a parameters schema`);
	assert.equal(typeof tool.promptSnippet, "string", `${tool.name} needs a prompt snippet`);
}

assert.deepEqual(flags, ["no-win-guard"]);
assert.deepEqual(commands, ["winenv"]);
for (const required of ["session_start", "before_agent_start", "tool_call"]) {
	assert.ok(events.includes(required), `missing handler: ${required}`);
}

console.log(`smoke: ${tools.length} tools, ${commands.length} command, ${events.length} event handlers — OK`);
