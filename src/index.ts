import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describeDecision, inspectBash, inspectPowerShell } from "./guard.ts";
import { formatFacts, probeHost, type HostFacts } from "./probe.ts";
import { buildWindowsPromptSection } from "./prompt.ts";
import { registerDiffFiles } from "./tools/diff.ts";
import { registerReadDocx } from "./tools/docx.ts";
import { registerReadPdf } from "./tools/pdf.ts";
import { registerReadMany } from "./tools/read-many.ts";
import { registerReadTable } from "./tools/table.ts";
import { registerWinEnv } from "./tools/win-env.ts";

/** Tools that already exist in pi but are not activated by default; Windows work needs them. */
const ACTIVATE = ["powershell", "grep", "find", "ls"];

export default function piOps(pi: ExtensionAPI) {
	pi.registerFlag("no-win-guard", {
		description: "Disable the pi-ops Windows command guard (Linux-only command blocking)",
		type: "boolean",
		default: false,
	});

	let factsPromise: Promise<HostFacts> | undefined;
	let cachedCwd = process.cwd();

	const getFacts = (refresh = false): Promise<HostFacts> => {
		if (refresh || !factsPromise) {
			factsPromise = probeHost(cachedCwd).catch((error) => {
				// A failed probe must not break the session: degrade to the bare minimum.
				return {
					osVersion: `${process.platform} ${process.getSystemVersion?.() ?? ""}`.trim(),
					arch: process.arch,
					uiLocale: "",
					ansiCodePage: "",
					bashVersion: "",
					bashKind: "unknown",
					pwshVersion: "",
					pwshPath: "",
					tools: {},
					missing: [],
					stubs: [],
					drives: [],
					home: process.env.USERPROFILE?.replace(/\\/g, "/") ?? "",
					cwdHint: cachedCwd,
					probedAt: new Date().toISOString(),
					probeError: String(error instanceof Error ? error.message : error),
				} as HostFacts;
			});
		}
		return factsPromise;
	};

	const guardEnabled = (): boolean => process.env.PI_OPS_GUARD !== "off" && pi.getFlag("no-win-guard") !== true;

	registerWinEnv(pi, getFacts);
	registerReadMany(pi);
	registerReadPdf(pi);
	registerReadDocx(pi);
	registerReadTable(pi);
	registerDiffFiles(pi);

	pi.on("session_start", async (_event, ctx) => {
		cachedCwd = ctx.cwd ?? process.cwd();
		factsPromise = undefined;

		// Activate the built-in tools Windows work needs (idempotent, never removes anything).
		if (process.env.PI_OPS_NO_ACTIVATE !== "1") {
			const available = new Set(pi.getAllTools().map((tool) => tool.name));
			const active = pi.getActiveTools();
			const missing = ACTIVATE.filter((name) => available.has(name) && !active.includes(name));
			if (missing.length) pi.setActiveTools([...active, ...missing]);
		}

		// Warm the probe so the first command does not pay for it.
		void getFacts();
	});

	pi.on("before_agent_start", async (event) => {
		try {
			const facts = await getFacts();
			event.systemPromptOptions.sections.windows_environment = buildWindowsPromptSection(facts);
		} catch {
			// Prompt enrichment is best effort.
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!guardEnabled()) return;
		if (event.toolName !== "bash" && event.toolName !== "powershell") return;

		let facts: HostFacts;
		try {
			facts = await getFacts();
		} catch {
			return;
		}

		const command = String((event.input as { command?: unknown }).command ?? "");
		if (!command.trim()) return;

		const decision = event.toolName === "bash" ? inspectBash(command, facts) : inspectPowerShell(command, facts);
		if (decision.kind === "allow") return;

		const summary = describeDecision(decision);
		if (decision.kind === "rewrite") {
			(event.input as { command?: string }).command = decision.command;
			if (ctx.hasUI && summary) ctx.ui.notify(`pi-ops: ${summary}`, "warning");
			return;
		}

		if (ctx.hasUI && summary) ctx.ui.notify(`pi-ops blocked \`${command.split("\n")[0].slice(0, 60)}\``, "warning");
		return { block: true, reason: decision.reason };
	});

	pi.registerCommand("winenv", {
		description: "Show the probed Windows environment report",
		async handler(_args, ctx) {
			const facts = await getFacts(true);
			pi.sendMessage({ customType: "pi-ops-env", content: formatFacts(facts), display: true });
			ctx.ui?.notify?.("pi-ops: environment re-probed", "info");
		},
	});
}
