// Guard regression tests. Run: node test/guard.test.mjs
import { createJiti } from "file:///C:/Users/52484/.pi/agent/install/releases/1.4.0/node_modules/jiti/lib/jiti.mjs";

const jiti = createJiti(import.meta.url);
const { inspectBash, inspectPowerShell, splitSegments, commandWord } = await jiti.import("C:/dev/pi-ops/src/guard.ts");

const facts = {
	osVersion: "10.0.26200.0",
	arch: "x64",
	uiLocale: "zh-CN",
	ansiCodePage: "936",
	bashVersion: "5.3.5(1)-release",
	bashKind: "Cygwin bash",
	pwshVersion: "7.6.7",
	pwshPath: "C:/Program Files/PowerShell/7/pwsh.exe",
	tools: { git: "git version 2.55", node: "v24.20.0", rg: "ripgrep 15.2.0", uv: "uv 0.13.1", winget: "v1.29", npm: "11.19.0", fd: "fd 10" },
	missing: ["python", "py", "make", "docker", "scoop", "choco", "pip", "python3"],
	stubs: ["python", "python3"],
	drives: ["C:", "D:"],
	home: "C:/Users/52484",
	cwdHint: "C:/dev/pi-ops",
	probedAt: new Date().toISOString(),
};

const cases = [
	// [label, kind, command, expected kind, expected substring]
	["sudo stripped", "bash", "sudo ls /c/dev", "rewrite", "ls /c/dev"],
	["apt blocked", "bash", "sudo apt-get install -y jq", "block", "winget"],
	["brew blocked", "bash", "brew install ripgrep", "block", "winget"],
	["systemctl blocked", "bash", "systemctl restart nginx", "block", "Get-Service"],
	["python stub blocked", "bash", "python3 -m http.server 8000", "block", "uv run"],
	["python after pipe blocked", "bash", "cat x | python -c 'print(1)'", "block", "uv run"],
	["pip blocked", "bash", "pip install requests", "block", "uv pip install"],
	["xdg-open rewritten", "bash", "xdg-open report.html", "rewrite", 'cmd //c start "" report.html'],
	["posix home blocked", "bash", "cd /home/zhz/project && ls", "block", "C:/Users/52484"],
	["make blocked", "bash", "make build", "block", "toolchain"],
	["docker blocked", "bash", "docker compose up", "block", "Docker"],
	["normal command allowed", "bash", "cd C:/dev/pi-ops && node --version", "allow", ""],
	["rg allowed", "bash", "rg -n 'apt-get' src/", "allow", ""],
	["git allowed", "bash", "git status --short", "allow", ""],
	["uv allowed", "bash", "uv run script.py", "allow", ""],
	["echo apt allowed", "bash", "echo 'apt-get is unavailable'", "allow", ""],
	["powershell ls -la blocked", "ps", "ls -la", "block", "Get-ChildItem -Force"],
	["powershell rm -rf blocked", "ps", "rm -rf node_modules", "block", "Remove-Item -Recurse -Force"],
	["powershell export blocked", "ps", "export PATH=/x:$PATH", "block", "$env:"],
	["powershell bash grep blocked", "ps", "ls | grep foo", "block", "Select-String"],
	["powershell dev null blocked", "ps", "node app.js 2>/dev/null", "block", "$null"],
	["powershell env var blocked", "ps", "echo $HOME_PATH", "block", "$env:"],
	["powershell native allowed", "ps", "Get-ChildItem -Force", "allow", ""],
	["powershell env allowed", "ps", "$env:PATH", "allow", ""],
];

let failed = 0;
for (const [label, shell, command, expectedKind, expectedSubstring] of cases) {
	const decision = shell === "ps" ? inspectPowerShell(command, facts) : inspectBash(command, facts);
	const kindOk = decision.kind === expectedKind;
	const sub = expectedKind === "block" ? decision.reason : expectedKind === "rewrite" ? decision.command : "";
	const subOk = !expectedSubstring || String(sub).includes(expectedSubstring);
	if (!kindOk || !subOk) {
		failed++;
		console.error(`FAIL ${label}: expected ${expectedKind}/${expectedSubstring}, got ${decision.kind} :: ${JSON.stringify(decision)}`);
	}
}

// Segment splitting must not cut inside quotes.
const segments = splitSegments(`echo "a && b" && rg -n "x|y" src`);
if (segments.length !== 2) {
	failed++;
	console.error(`FAIL splitSegments: ${JSON.stringify(segments)}`);
}
const { word } = commandWord(`FOO=1 BAR="x y" sudo env git status`);
if (word !== "git") {
	failed++;
	console.error(`FAIL commandWord: ${word}`);
}

console.log(failed === 0 ? `PASS all ${cases.length + 2} guard checks` : `${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
