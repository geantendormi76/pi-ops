import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatFacts, type HostFacts } from "../probe.ts";

/** `win_env`: one cheap call that answers "what does this machine actually have?". */
export function registerWinEnv(pi: ExtensionAPI, getFacts: (refresh?: boolean) => Promise<HostFacts>): void {
	pi.registerTool({
		name: "win_env",
		label: "Windows environment",
		description:
			"Report this Windows host's real capabilities: OS build, locale/code page, both shells (bash flavour + pwsh version), which CLIs exist with versions, which are broken stubs, and available drives. Use it instead of guessing or probing with ad-hoc commands (ver, uname, Get-ComputerInfo, where, which).",
		promptSnippet: "Report Windows host facts (shells, tool versions, missing tools)",
		promptGuidelines: [
			"Call win_env before writing a command whose availability you are unsure about — one call beats a failed command plus a retry.",
			"win_env is cheap and cached; pass refresh=true only after installing software.",
		],
		parameters: Type.Object({
			refresh: Type.Optional(Type.Boolean({ description: "Re-probe instead of using the cached snapshot" })),
		}),
		async execute(_toolCallId, params) {
			const facts = await getFacts(params.refresh === true);
			const absentCritical = ["git", "node", "rg"].filter((name) => !facts.tools[name]);
			const notes: string[] = [];
			if (facts.stubs.length) notes.push(`Broken stubs (present but exit non-zero): ${facts.stubs.join(", ")} — use the substitutes from the prompt, not these.`);
			if (absentCritical.length) notes.push(`Missing essentials: ${absentCritical.join(", ")} — check before assuming a build step works.`);
			if (facts.pwshVersion) notes.push("Use the powershell tool for services, registry, tasks, ACLs and any Windows-native .exe.");
			const text = [formatFacts(facts), "", notes.join("\n"), `Probed ${facts.probedAt}`].filter((part) => part !== "").join("\n");
			return { content: [{ type: "text" as const, text }], details: { facts } };
		},
	});
}
