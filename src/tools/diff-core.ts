import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileText } from "./exec.ts";

import { createHash } from "node:crypto";

/** Short content hash for "did this actually change?" checks. */
export function shortHash(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 12);
}

export function lineCount(content: string): number {
	if (!content) return 0;
	return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/** Count hunks and added/removed lines in a unified diff. */
export function summarizeDiff(diff: string): { hunks: number; added: number; removed: number } {
	let hunks = 0;
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("@@")) hunks++;
		else if (line.startsWith("+") && !line.startsWith("+++")) added++;
		else if (line.startsWith("-") && !line.startsWith("---")) removed++;
	}
	return { hunks, added, removed };
}

/** Materialize `HEAD:<file>` so it can be diffed against the working copy. */
export async function stashHeadVersion(file: string): Promise<{ tempPath: string; reloadedFrom: string }> {
	const root = await execFileText("git", ["-C", path.dirname(file), "rev-parse", "--show-toplevel"], 20_000);
	if (root.code !== 0) throw new Error(`not inside a git repository (${root.stderr.trim() || `exit ${root.code}`})`);
	const top = root.stdout.trim();
	const relative = path.relative(top, file).split(path.sep).join("/");
	const show = await execFileText("git", ["-C", top, "show", `HEAD:${relative}`], 30_000);
	if (show.code !== 0) throw new Error(`HEAD has no version of ${relative} (${show.stderr.trim() || `exit ${show.code}`})`);
	const tempPath = path.join(tmpdir(), `pi-ops-head-${process.pid}-${Date.now()}${path.extname(file) || ".txt"}`);
	await writeFile(tempPath, show.stdout, "utf8");
	return { tempPath, reloadedFrom: `HEAD:${relative}` };
}

/** Rewrite the `---`/`+++`/`diff --git` header lines so they name the real files, not temp paths. */
export function relabelDiff(diff: string, before: string, after: string): string {
	return diff
		.split("\n")
		.map((line) => {
			if (line.startsWith("diff --git")) return `diff --git a/${before} b/${after}`;
			if (line.startsWith("--- ")) return `--- ${before}`;
			if (line.startsWith("+++ ")) return `+++ ${after}`;
			return line;
		})
		.join("\n");
}
