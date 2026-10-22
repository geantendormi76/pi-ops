import { execFile } from "node:child_process";

export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
}

/**
 * Run a binary with argv (never a shell string), UTF-8 output, bounded buffer.
 * Resolves instead of rejecting so callers can fall back to another backend.
 */
export function execFileText(cmd: string, args: string[], timeout = 30_000): Promise<ExecResult> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, windowsHide: true, encoding: "utf8", maxBuffer: 32 << 20 }, (error, stdout, stderr) => {
			const raw = (error as { code?: unknown } | null)?.code;
			const code = typeof raw === "number" ? raw : error ? 1 : 0;
			resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? ""), code });
		});
	});
}

export async function commandExists(cmd: string): Promise<boolean> {
	const result = await execFileText(process.platform === "win32" ? "where.exe" : "which", [cmd], 10_000);
	return result.code === 0 && Boolean(result.stdout.trim());
}
