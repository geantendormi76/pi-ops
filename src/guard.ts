import type { HostFacts } from "./probe.ts";

export type GuardDecision = { kind: "allow" } | { kind: "rewrite"; command: string; note: string } | { kind: "block"; reason: string };

const ALLOW: GuardDecision = { kind: "allow" };

const PKG_MANAGERS = new Set(["apt", "apt-get", "aptitude", "apt-cache", "dpkg", "yum", "dnf", "pacman", "zypper", "apk", "brew", "snap"]);
const SERVICE_TOOLS = new Set(["systemctl", "journalctl", "service", "update-rc.d", "rc-service", "systemd-analyze", "loginctl"]);
const PYTHON_TOOLS = new Set(["python", "python3", "pip", "pip3", "poetry", "pyenv", "virtualenv", "conda", "py"]);
const OPENERS = new Set(["xdg-open", "gnome-open", "kde-open", "open", "gio"]);
const PATH_CONSUMERS = new Set(["cd", "ls", "cat", "cp", "mv", "rm", "mkdir", "tar", "unzip", "git", "node", "npm", "npx", "code", "notepad", "uv", "rg"]);
const WRAPPERS = new Set(["sudo", "command", "env", "nohup", "time", "exec", "builtin", "&"]);

/** Split a shell command line into simple commands, respecting quotes. */
export function splitSegments(command: string): string[] {
	const out: string[] = [];
	let buf = "";
	let quote: string | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			buf += ch;
			if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			buf += ch;
			continue;
		}
		if (ch === "\\") {
			buf += ch + (command[i + 1] ?? "");
			i++;
			continue;
		}
		if (";&|\n()".includes(ch)) {
			out.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	out.push(buf);
	return out.map((segment) => segment.trim()).filter(Boolean);
}

/** Strip env assignments and wrappers; return the command word and the argument text. */
export function commandWord(segment: string): { word: string; args: string } {
	let rest = segment.trim();
	for (let guard = 0; guard < 8; guard++) {
		const assignment = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s*/);
		if (assignment) {
			rest = rest.slice(assignment[0].length);
			continue;
		}
		const first = rest.match(/^([A-Za-z_.\\/&][^\s]*)\s*/);
		if (first && WRAPPERS.has(first[1])) {
			rest = rest.slice(first[0].length);
			continue;
		}
		break;
	}
	const match = rest.match(/^([^\s;|&]+)\s*([\s\S]*)$/);
	if (!match) return { word: "", args: "" };
	return { word: match[1], args: match[2] ?? "" };
}

function baseName(word: string): string {
	return word.replace(/\\/g, "/").split("/").pop() ?? word;
}

function isAbsent(facts: HostFacts, name: string): boolean {
	return !facts.tools[name] && facts.missing.includes(name);
}

/** Inspect a bash command against this host's facts. Pure: no I/O, no side effects. */
export function inspectBash(command: string, facts: HostFacts): GuardDecision {
	if (!command.trim()) return ALLOW;
	// `sudo` is meaningless here: drop it and let the rest of the rules judge the command.
	const stripped = command.replace(/(^|[;&|\n]\s*)sudo(\s+-[A-Za-z-]+)*\s+/g, "$1");
	let rewritten = stripped;
	let note = stripped === command ? "" : "sudo 已移除：本机没有提权模型，bash 直接以当前用户身份运行。";

	for (const segment of splitSegments(stripped)) {
		const { word, args } = commandWord(segment);
		if (!word) continue;
		const cmd = baseName(word).toLowerCase();

		if (cmd === "sudo") continue;

		if (PKG_MANAGERS.has(cmd)) {
			return {
				kind: "block",
				reason:
					`\`${cmd}\` does not exist on this Windows host. ` +
					`Install software with winget: \`winget search <name>\` then \`winget install --id <PackageId> -e --accept-source-agreements\`. ` +
					`Python packages: \`uv pip install <pkg>\`. Node: \`npm i -g <pkg>\`. Already on PATH: rg, fd, jq, curl, git, gh, uv.`,
			};
		}

		if (SERVICE_TOOLS.has(cmd)) {
			return {
				kind: "block",
				reason:
					`No systemd on Windows (\`${cmd}\` is unavailable). Use the \`powershell\` tool instead: ` +
					`\`Get-Service <name>\`, \`Start-Service <name>\`, \`Stop-Service <name>\`, \`Get-Service | Where-Object Status -eq Running\`, or \`sc.exe query\`.`,
			};
		}

		if (PYTHON_TOOLS.has(cmd)) {
			const broken = facts.stubs.includes("python") || facts.stubs.includes("python3") || isAbsent(facts, "python");
			if (broken && cmd !== "uv") {
				return {
					kind: "block",
					reason:
						`\`${cmd}\` is a Microsoft Store stub on this host (it exits with "Python was not found"), and there is no \`py\` launcher. ` +
						`Use uv instead: \`uv run script.py\`, \`uv run --with <pkg> python -c "..."\`, \`uv pip install <pkg>\`, \`uv venv .venv\`, \`uv python install 3.12\`.`,
				};
			}
		}

		if (OPENERS.has(cmd) && args.trim()) {
			const target = args.trim();
			rewritten = rewritten.replace(segment, `cmd //c start "" ${target}`);
			note = `${cmd} 已改写为 cmd //c start ""（Windows 没有 xdg-open/open）。`;
			continue;
		}

		if (cmd === "touch" || cmd === "whereis") {
			return {
				kind: "block",
				reason: `\`${cmd}\` is not available. Use \`New-Item -ItemType File <path>\` in the powershell tool, or \`printf '' > <path>\` in bash.`,
			};
		}

		if ((cmd === "make" || cmd === "gcc" || cmd === "g++" || cmd === "cmake") && isAbsent(facts, "make")) {
			return {
				kind: "block",
				reason: `No C/C++ toolchain on PATH (\`${cmd}\` absent). Prefer a Node/Python scripted step, or install one with winget. Do not retry the same command.`,
			};
		}

		if ((cmd === "docker" || cmd === "podman" || cmd === "kubectl") && isAbsent(facts, "docker")) {
			return {
				kind: "block",
				reason: `\`${cmd}\` is not installed on this host. Skip container steps, or install with \`winget install --id Docker.DockerDesktop -e\` and say that a restart/login is required.`,
			};
		}

		if (PATH_CONSUMERS.has(cmd)) {
			const posixPath = args.match(/(^|\s)(\/home\/[A-Za-z0-9_.-]+|\/root|\/usr\/local\/[a-z]*)\b/);
			if (posixPath) {
				return {
					kind: "block",
					reason:
						`\`${posixPath[2]}\` does not exist on Windows. The user's home is \`${facts.home}\` (bash: \`$HOME\`), ` +
						`project root is \`${facts.cwdHint}\`, temp is \`$TEMP\`. Use those paths and retry once.`,
				};
			}
		}
	}

	if (rewritten !== command) return { kind: "rewrite", command: rewritten, note };
	return ALLOW;
}

/** Inspect a PowerShell command: catch bash habits that PowerShell rejects. */
export function inspectPowerShell(command: string, _facts: HostFacts): GuardDecision {
	if (!command.trim()) return ALLOW;
	for (const segment of splitSegments(command)) {
		const { word, args } = commandWord(segment);
		const cmd = baseName(word).toLowerCase();
		if (!cmd) continue;

		if ((cmd === "ls" || cmd === "dir" || cmd === "ll") && /\s-[a-zA-Z]*[lahr][a-zA-Z]*\b/.test(segment)) {
			return {
				kind: "block",
				reason: `PowerShell has no \`ls -la\`. Use \`Get-ChildItem -Force\` (recurse: \`-Recurse\`; sizes: \`| Format-Table Name,Length\`).`,
			};
		}

		if ((cmd === "rm" || cmd === "del" || cmd === "rmdir") && /-(rf|fr|Rf|fR|r\s+-f)\b/.test(segment)) {
			return {
				kind: "block",
				reason: `PowerShell has no \`rm -rf\`. Use \`Remove-Item -Recurse -Force <path>\` (confirm the path first).`,
			};
		}

		if (cmd === "export") {
			return {
				kind: "block",
				reason: `\`export\` is bash. In PowerShell: \`$env:NAME = "value"\` (session only).`,
			};
		}

		if (cmd === "which") {
			return { kind: "block", reason: `Use \`Get-Command <name>\` in PowerShell (\`where.exe <name>\` also works).` };
		}

		if (cmd === "grep" || cmd === "sed" || cmd === "awk" || cmd === "cut" || cmd === "tr" || cmd === "head" || cmd === "tail" || cmd === "wc" || cmd === "xargs") {
			return {
				kind: "block",
				reason:
					`\`${cmd}\` is a Unix tool, not a cmdlet. Either run it with the \`bash\` tool, or use PowerShell natives: ` +
					`Select-String (grep), Get-Content -TotalCount N / -Tail N (head/tail), -replace (sed), Measure-Object -Line -Word -Character (wc).`,
			};
		}

		if (cmd === "uname" || cmd === "chmod" || cmd === "chown") {
			return {
				kind: "block",
				reason: `\`${cmd}\` does not exist in PowerShell. Host info: \`Get-CimInstance Win32_OperatingSystem\`; permissions: \`icacls\`. For the git exec bit: \`git update-index --chmod=+x <file>\`.`,
			};
		}

		if (/\/dev\/null/.test(segment)) {
			return { kind: "block", reason: `No \`/dev/null\` in PowerShell. Redirect instead: \`2>$null\` or \`> $null\`.` };
		}

		if (/\$[A-Z_][A-Z0-9_]{1,}\b/.test(args) && !/\$env:|\$PSVersionTable|\$PSScriptRoot|\$PWD\b|\$HOME\b/.test(segment)) {
			const name = args.match(/\$([A-Z_][A-Z0-9_]{1,})\b/);
			return {
				kind: "block",
				reason: `\`$${name?.[1] ?? "VAR"}\` is not a PowerShell variable. Environment variables are \`$env:${name?.[1] ?? "NAME"}\` (bash-style exports do not carry over).`,
			};
		}
	}
	return ALLOW;
}

/** Detects whether a command mutates anything (used to decide if a note should be surfaced). */
export function describeDecision(decision: GuardDecision): string | undefined {
	if (decision.kind === "rewrite") return decision.note;
	if (decision.kind === "block") return decision.reason;
	return undefined;
}
