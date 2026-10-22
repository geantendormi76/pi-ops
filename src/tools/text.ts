/** Shared output budgeting for the ops tools. */

export interface Clipped {
	text: string;
	truncated: boolean;
	originalChars: number;
}

/** Cut text to `maxChars`, appending a marker the model can act on. */
export function clip(text: string, maxChars: number): Clipped {
	const originalChars = text.length;
	if (originalChars <= maxChars) return { text, truncated: false, originalChars };
	const head = Math.max(1, Math.floor(maxChars * 0.75));
	const tail = Math.max(1, maxChars - head);
	return {
		text: `${text.slice(0, head)}\n\n... [${originalChars - maxChars} characters cut — narrow the request (pages/offset/max_chars) for the rest] ...\n\n${text.slice(-tail)}`,
		truncated: true,
		originalChars,
	};
}

/** Count how much of a string is replacement/control junk (a sign of a broken text backend). */
export function junkRatio(text: string): number {
	if (!text) return 0;
	let junk = 0;
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		if (ch === "\uFFFD" || (code < 9 && code !== 0) || code === 0) junk++;
	}
	return junk / text.length;
}
