import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { DefaultTextStyle, MarkdownTheme } from "@earendil-works/pi-tui";

export type CodeCopySpan = { source: string; start: number; end: number; continues: boolean };
export type MarkdownCopyLine = { text: string; code?: CodeCopySpan; copyStart?: number; copyEnd?: number; copySkip?: boolean };

/**
 * Theme callbacks identify actual code, not characters that happen to look like rails.
 * Internal OSC 8 annotations survive the toolkit's nested wrapping (including quotes/
 * lists). They are consumed here, BEFORE any rows reach display or link hit testing.
 * Unlike a second Markdown parser, this uses exactly the code the toolkit rendered.
 */
export function renderCopyableMarkdown(text: string, width: number, theme: MarkdownTheme, style: DefaultTextStyle): MarkdownCopyLine[] {
	const sources: { text: string; border: boolean }[] = [];
	const annotate = (value: string, rendered: string, border = false): string => {
		const id = sources.push({ text: stripTerminalSequences(value), border }) - 1;
		return `\x1b]8;;dchat-internal-code:${id}\x1b\\${rendered}\x1b]8;;\x1b\\`;
	};
	const markdown = new Markdown(text, 0, 0, {
		...theme,
		codeBlock: (value) => annotate(value, theme.codeBlock(value)),
		codeBlockBorder: (value) => annotate(value, theme.codeBlockBorder(value), true),
	}, style, { renderLatex: false });
	let previous: { id: number; end: number } | undefined;
	return markdown.render(width).map((line) => {
		let code: CodeCopySpan | undefined;
		let copyStart: number | undefined;
		let copyEnd: number | undefined;
		let copySkip = false;
		let active: { id: number; column: number; offset: number } | undefined;
		let cleaned = "";
		let cursor = 0;
		for (const match of line.matchAll(/\x1b\]8;;([^\x1b\x07]*)(?:\x1b\\|\x07)/g)) {
			cleaned += line.slice(cursor, match.index);
			const internal = /^dchat-internal-code:(\d+)$/.exec(match[1]!);
			if (internal && sources[Number(internal[1])]) {
				active = { id: Number(internal[1]), column: visibleWidth(cleaned), offset: cleaned.length };
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
				active = undefined;
			} else {
				cleaned += match[0];
			}
			cursor = match.index + match[0].length;
		}
		cleaned += line.slice(cursor);
		if (!code) previous = undefined;
		return { text: cleaned, code, copyStart, copyEnd, copySkip };
	});
}
