import { formatFacts, type HostFacts } from "./probe.ts";

/**
 * The prompt section that keeps the model from emitting Linux commands on Windows.
 * Everything here is a hard fact about this host (probed at session start) plus the
 * command shapes that silently fail on it.
 */
export function buildWindowsPromptSection(facts: HostFacts): string {
	const absent = new Set(facts.missing);
	const notes: string[] = [];

	if (absent.has("python") || facts.stubs.includes("python")) {
		notes.push(
			"Python: `python`/`python3`/`pip` are Microsoft Store stubs that exit with \"Python was not found\"; there is no `py` launcher. Use `uv run <script>` / `uv pip install <pkg>` / `uv python install <ver>`.",
		);
	}
	if (absent.has("scoop") && absent.has("choco")) {
		notes.push("Package installs: only winget exists — `winget install --id <PackageId> -e --accept-source-agreements` (`winget search <name>` to find the id). No scoop/choco/brew/apt.");
	}
	if (facts.pwshVersion) {
		notes.push("Windows-native work (services, registry, WMI/CIM, scheduled tasks, ACLs, .NET/COM, installers with Windows-style args) belongs in the `powershell` tool, not bash.");
	}
	if (facts.ansiCodePage === "936") {
		notes.push("Console code page is 936 (GBK): a native .exe printing Chinese decodes as mojibake in `bash`. Run it through `powershell` (pwsh emits UTF-8) or `cmd //c chcp 65001 >nul & ...`.");
	}

	return [
		"This host is Windows, not Linux. The facts below were probed, not assumed:",
		"",
		formatFacts(facts),
		"",
		"Two shells are available — pick deliberately:",
		`- \`bash\` = ${facts.bashKind}. POSIX coreutils (ls, grep, sed, awk, find, xargs) work; \`C:/dev/proj\` and \`/c/dev/proj\` both resolve.`,
		"- `powershell` = pwsh 7. Native Windows tooling, cmdlets, and any command whose arguments differ from POSIX conventions.",
		facts.wslDistros.length
			? `- WSL is installed (${facts.wslDistros.join(", ")}): \`wsl -e bash -lc '<cmd>'\` is real Linux with apt/pip, but it is a separate filesystem (/mnt/c/...) — use it only when a Linux-only tool is genuinely required, never for ordinary file or build work.`
			: "- WSL is installed but has no distro: `wsl <cmd>` cannot give you apt, so do not try it.",
		"",
		"Commands that always fail here (a guard blocks them before they run and returns the fix):",
		"1. `sudo` — no elevation model. If a step truly needs admin, say so and stop retrying.",
		"2. `apt` `apt-get` `dpkg` `yum` `dnf` `pacman` `apk` `snap` `brew` — absent. Install with winget (see below).",
		"3. `systemctl` `journalctl` `service … start` — no systemd. Use `Get-Service`, `Start-Service`, `New-Service`, or `sc.exe`.",
		...notes.map((note, index) => `${index + 4}. ${note}`),
		"",
		"Portability rules:",
		"- Paths: forward slashes (`C:/dev/pi-ops`) work in both shells. `$HOME` is a real directory; `/root`, `/usr/local`, `/home/<user>` are not. Quote paths containing spaces.",
		"- Temp files go to `$TEMP` (bash: `/c/Users/.../AppData/Local/Temp`), not `/tmp`, when another Windows program must read them.",
		"- PowerShell is not bash: env vars are `$env:NAME`; `ls -la` → `Get-ChildItem -Force`; `rm -rf` → `Remove-Item -Recurse -Force`; `2>/dev/null` → `2>$null`; `grep`/`sed`/`awk` only exist on the bash side.",
		"- No `xdg-open`/`open`: `powershell` `Start-Process <path>`; bash `cmd //c start \"\" \"<path>\"`.",
		"- `chmod`/`chown` barely matter: the git exec bit is `git update-index --chmod=+x <file>`.",
		"- CRLF breaks `#!/usr/bin/env bash` scripts: `sed -i 's/\\r$//' <file>` before running them.",
		"- Prefer the `win_env` tool over ad-hoc probing (`ver`, `uname`, `Get-ComputerInfo`), `read_many` over repeated `cat`, and `rg` (installed) over `find | xargs grep`.",
		"- Before retrying a failed command, read the error: if it is a missing tool, use the substitute above instead of re-running the same command with different quoting.",
		"- Native Windows programs often need Windows-style arguments; prefer `powershell` over bash for them instead of escaping across the boundary.",
	].join("\n");
}
