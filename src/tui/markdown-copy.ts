import { randomUUID } from "node:crypto";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";

export type CodeCopySpan = { source: string; start: number; end: number; continues: boolean };
export type MarkdownCopyLine = { text: string; code?: CodeCopySpan; copyStart?: number; copyEnd?: number; copySkip?: boolean };

const osc8 = /\x1b\]8;[^;\x1b\x07]*;([^\x1b\x07]*)(?:\x1b\\|\x07)/g;

/**
 * Theme callbacks identify actual code, not characters that happen to look like rails.
 * OSC 8 annotations survive the toolkit's nested wrapping (including quotes/lists).
 * Real OSC 8 events inside them travel as opaque APC markers: otherwise a real link
 * would replace the annotation in the toolkit's single (NOT stacked) hyperlink state,
 * and its empty close would be indistinguishable from the annotation's close.
 * Both transports are consumed BEFORE rows reach display or link hit testing.
 */
export function renderCopyableMarkdown(text: string, width: number, theme: MarkdownTheme, style: DefaultTextStyle): MarkdownCopyLine[] {
	// No user-authored URL or control sequence can be mistaken for this render's metadata.
	let namespace: string;
	do { namespace = `dchat-internal-code:${randomUUID()}:`; } while (text.includes(namespace));
	const sources: { text: string; border: boolean }[] = [];
	const annotations = new Map<string, number>();
	const links = new Map<string, { sequence: string; close: string | undefined }>();
	const annotate = (value: string, rendered: string, border = false): string => {
		const id = sources.push({ text: stripTerminalSequences(value), border }) - 1;
		const url = `${namespace}${id}`;
		annotations.set(url, id);
		const shielded = rendered.replace(osc8, (sequence: string, url: string) => {
			const marker = `\x1b_${namespace}link:${links.size}\x1b\\`;
			links.set(marker, { sequence, close: url ? `\x1b]8;;${sequence.endsWith("\x07") ? "\x07" : "\x1b\\"}` : undefined });
			return marker;
		});
		return `\x1b]8;;${url}\x1b\\${shielded}\x1b]8;;\x1b\\`;
	};
	const markdown = new Markdown(text, 0, 0, {
		...theme,
		codeBlock: (value) => annotate(value, theme.codeBlock(value)),
		codeBlockBorder: (value) => annotate(value, theme.codeBlockBorder(value), true),
	}, style, { renderLatex: false });
	let previous: { id: number; end: number } | undefined;
	let link: { sequence: string; close: string } | undefined;
	return markdown.render(width).map((line) => {
		let code: CodeCopySpan | undefined;
		let copyStart: number | undefined;
		let copyEnd: number | undefined;
		let copySkip = false;
		let active: { id: number; column: number; offset: number } | undefined;
		let cleaned = "";
		let cursor = 0;
		for (const match of line.matchAll(/\x1b(?:\]8;[^;\x1b\x07]*;([^\x1b\x07]*)|_[^\x1b\x07]*)(?:\x1b\\|\x07)/g)) {
			cleaned += line.slice(cursor, match.index);
			const id = annotations.get(match[1]!);
			const original = links.get(match[0]);
			if (id !== undefined) {
				active = { id, column: visibleWidth(cleaned), offset: cleaned.length };
				if (previous?.id !== id) link = undefined;
				// Reopen only inside code bounds, never over the quote/list rail.
				if (link) cleaned += link.sequence;
			} else if (active && original) {
				cleaned += original.sequence;
				link = original.close ? { sequence: original.sequence, close: original.close } : undefined;
			} else if (active && match[1] === "") {
				const source = sources[active.id]!;
				const fragment = stripTerminalSequences(cleaned.slice(active.offset));
				const continues = previous?.id === active.id;
				const start = source.text.indexOf(fragment, continues ? previous!.end : 0);
				if (source.border) copySkip = true;
				else {
					copyStart = active.column;
					copyEnd = copyStart + visibleWidth(fragment);
					// If the toolkit transforms a fragment unexpectedly, retain code-only
					// bounds but fall back to rendered rows instead of guessing a source range.
					if (start >= 0) code = { source: source.text, start, end: start + fragment.length, continues };
				}
				previous = source.border || start < 0 ? undefined : { id: active.id, end: start + fragment.length };
				// The toolkit closed the annotation, not the shielded user hyperlink.
				// Balance the latter on each physical row; retain its logical state for wraps.
				if (link) cleaned += link.close;
				active = undefined;
			} else {
				cleaned += match[0];
			}
			cursor = match.index + match[0].length;
		}
		cleaned += line.slice(cursor);
		if (!code) { previous = undefined; link = undefined; }
		return { text: cleaned, code, copyStart, copyEnd, copySkip };
	});
}
