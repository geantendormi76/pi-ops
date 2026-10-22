import { execFile } from "node:child_process";
import os from "node:os";

/** Facts about this Windows host that the model cannot guess. */
export interface HostFacts {
	osVersion: string;
	arch: string;
	uiLocale: string;
	ansiCodePage: string;
	bashVersion: string;
	bashKind: string;
	pwshVersion: string;
	pwshPath: string;
	tools: Record<string, string>;
	missing: string[];
	stubs: string[];
	drives: string[];
	wslDistros: string[];
	home: string;
	cwdHint: string;
	probedAt: string;
	probeError?: string;
}

function exec(cmd: string, args: string[], timeout = 6000, encoding: BufferEncoding = "utf8"): Promise<string> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, windowsHide: true, encoding, maxBuffer: 2 << 20 }, (error, stdout) => {
			resolve(error && !stdout ? "" : String(stdout ?? "").trim());
		});
	});
}

/**
 * One PowerShell process that reports host facts. Tools are executed with an explicit
 * `--version` flag and empty stdin: a bare `& node` would start a REPL and hang the probe.
 */
const PS_SCRIPT = String.raw`
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='SilentlyContinue'
function Ver($name){
  $out = $null | & $name '--version' 2>&1 | Out-String
  if($out){ ($out -split "\r?\n" | Where-Object { $_.Trim() } | Select-Object -First 1).Trim() }
}
"os|" + [Environment]::OSVersion.Version.ToString()
"arch|" + $env:PROCESSOR_ARCHITECTURE
"locale|" + (Get-UICulture).Name
"acp|" + (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Nls\CodePage').ACP
"pwsh|" + $PSVersionTable.PSVersion.ToString()
"pwshpath|" + [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
foreach($t in @('git','node','npm','rg','fd','uv','gh','winget','scoop','choco','pnpm','bun','deno','docker','wsl','make','py','python','python3','pip','7z','tar','curl','jq','bat','delta','code','wt')){
  $c = Get-Command $t -ErrorAction SilentlyContinue
  if($c){ "have|$t|$($c.Source)" } else { "miss|$t" }
}
foreach($t in @('python','python3','pip','py')){
  if(Get-Command $t -ErrorAction SilentlyContinue){
    $o = ($null | & $t '--version' 2>&1 | Out-String).Trim()
    "pycheck|$t|" + ($o -replace "\r?\n", " ")
  }
}
foreach($t in @('git','node','npm','rg','uv','gh')){
  if(Get-Command $t -ErrorAction SilentlyContinue){ "ver|$t|" + (Ver $t) }
}
"drives|" + (((Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root.Substring(0,2) }) | Where-Object { $_ -match '^[A-Z]:$' } | Sort-Object -Unique) -join ',')
`;

const CORE_TOOLS = ["git", "node", "npm", "rg", "fd", "uv", "gh", "winget", "pnpm", "python", "py", "make", "jq", "bat", "docker"];

function classifyBash(kernel: string, version: string): string {
	const k = kernel.toUpperCase();
	if (k.includes("CYGWIN")) return "Cygwin bash";
	if (k.includes("MINGW") || k.includes("MSYS")) return "Git bash (MSYS2)";
	if (k.startsWith("LINUX")) return "Linux bash (WSL or container)";
	return version ? "bash" : "unknown";
}

/** Collect host facts. Never throws; missing tools just show up as absent. */
export async function probeHost(cwd: string): Promise<HostFacts> {
	const [psOut, bashOut, wslOut] = await Promise.all([
		exec("pwsh", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT]).then((out) =>
			out ? out : exec("powershell", ["-NoProfile", "-NonInteractive", "-Command", PS_SCRIPT]),
		),
		exec("bash", ["-c", 'uname -s; printf "%s" "$BASH_VERSION"']),
		// wsl.exe writes UTF-16LE regardless of the console code page.
		exec("wsl.exe", ["-l", "-q"], 4000, "utf16le"),
	]);
	const [bashKernel = "", bashVersion = ""] = bashOut.split(/\r?\n/);

	const facts: HostFacts = {
		osVersion: "",
		arch: process.arch === "x64" ? "x64" : process.arch,
		uiLocale: "",
		ansiCodePage: "",
		bashVersion,
		bashKind: classifyBash(bashKernel, bashVersion),
		pwshVersion: "",
		pwshPath: "",
		tools: {},
		missing: [],
		stubs: [],
		drives: [],
		wslDistros: wslOut
			.split(/\r?\n/)
			.map((line) => line.replace(/\u0000/g, "").trim())
			.filter((line) => line && !/Windows Subsystem|wsl|已安装|发行版|适用于/i.test(line)),
		home: os.homedir().replace(/\\/g, "/"),
		cwdHint: cwd,
		probedAt: new Date().toISOString(),
	};

	const seen = new Set<string>();
	for (const line of psOut.split(/\r?\n/)) {
		const parts = line.split("|");
		const key = parts[0];
		if (!key) continue;
		seen.add(key);
		if (key === "os") facts.osVersion = parts[1] ?? "";
		else if (key === "arch") facts.arch = parts[1] || facts.arch;
		else if (key === "locale") facts.uiLocale = parts[1] ?? "";
		else if (key === "acp") facts.ansiCodePage = parts[1] ?? "";
		else if (key === "pwsh") facts.pwshVersion = parts[1] ?? "";
		else if (key === "pwshpath") facts.pwshPath = (parts[1] ?? "").replace(/\\/g, "/");
		else if (key === "drives") facts.drives = (parts[1] ?? "").split(",").filter(Boolean);
		else if (key === "have") {
			const name = parts[1] ?? "";
			facts.tools[name] = "installed";
		} else if (key === "pycheck") {
			const name = parts[1] ?? "";
			const output = parts.slice(2).join("|");
			// A Windows store execution alias "exists" but exits with this message.
			if (/Python was not found|app execution alias|Microsoft Store/i.test(output)) {
				delete facts.tools[name];
				if (!facts.stubs.includes(name)) facts.stubs.push(name);
			} else if (output) {
				facts.tools[name] = output.replace(/\s+/g, " ").slice(0, 60);
			}
		} else if (key === "ver") {
			const name = parts[1] ?? "";
			const version = parts.slice(2).join("|").replace(/\s+/g, " ").slice(0, 60).trim();
			if (facts.tools[name] && version) facts.tools[name] = version;
		} else if (key === "miss") {
			facts.missing.push(parts[1] ?? "");
		}
	}

	// Best effort: if PowerShell was unavailable, fall back to a PATH scan.
	if (!seen.has("os")) {
		facts.osVersion = `${os.type()} ${os.release()}`;
		facts.probeError = "PowerShell probe returned nothing; tool list degraded to a PATH scan.";
		for (const name of CORE_TOOLS) {
			const found = await exec("where.exe", [name], 1500);
			if (found) facts.tools[name] = "installed";
			else facts.missing.push(name);
		}
	}
	facts.missing = facts.missing.filter((name) => !facts.tools[name]);
	return facts;
}

/** Compact human-readable report used by the `win_env` tool and the prompt section. */
export function formatFacts(facts: HostFacts): string {
	const have = Object.entries(facts.tools)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([name, version]) => {
			if (version === "installed") return name;
			const numeric = version.match(/(\d+(?:\.\d+)+[\w.-]*)/);
			if (numeric) return `${name} ${numeric[1]}`;
			const word = version.match(/([vV]?\d[\w.-]*)/);
			return word ? `${name} ${word[1]}` : name;
		});
	const lines = [
		`OS: Windows ${facts.osVersion} (${facts.arch}), UI locale ${facts.uiLocale || "?"}, ANSI/OEM code page ${facts.ansiCodePage || "?"}${facts.ansiCodePage === "936" ? " = GBK, so native .exe output with Chinese text decodes as mojibake in bash" : ""}`,
		`bash tool: ${facts.bashKind} ${facts.bashVersion} — POSIX coreutils present; \`C:/dev/x\` and \`/c/dev/x\` both resolve`,
		`powershell tool: pwsh ${facts.pwshVersion || "MISSING"}${facts.pwshPath ? ` (${facts.pwshPath})` : ""}`,
		`Available CLIs: ${have.join(", ") || "none detected"}`,
		facts.stubs.length ? `Broken stubs (present, exit non-zero): ${facts.stubs.join(", ")}` : "",
		facts.missing.length ? `Absent: ${facts.missing.join(", ")}` : "",
		`Drives: ${facts.drives.join(" ") || "C:"}   Home: ${facts.home}`,
		facts.wslDistros.length
			? `WSL distros: ${facts.wslDistros.join(", ")} — \`wsl -e bash -lc '<cmd>'\` runs real Linux (apt/pip live in there, not on Windows)`
			: "wsl.exe: no distro installed, so it cannot run Linux commands",
	];
	return lines.filter(Boolean).join("\n");
}
