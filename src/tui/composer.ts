import { CURSOR_MARKER, Editor, matchesKey } from "@earendil-works/pi-tui";
import type { TUI } from "@earendil-works/pi-tui";
import { dim } from "./format.ts";

/** Newline gestures must be checked before Enter: legacy Ctrl-J also matches Enter. */
export function isComposerNewline(data: string): boolean {
	return matchesKey(data, "ctrl+j") || matchesKey(data, "shift+enter")
		|| matchesKey(data, "alt+enter") || data === "\x1b\r" || data === "\x1b[13;2~";
}

/** Command/Super+Shift+Enter is one-shot follow-up, only when CSI-u reports it.
 * xterm modifyOtherKeys has no distinct Super modifier (its bit 8 is Meta).
 */
export function isComposerQueue(data: string): boolean {
	return data.endsWith("u") && matchesKey(data, "super+shift+enter");
}

/** Toolkit editing/paste/undo semantics, embedded in the dashboard's own layout. */
export class Composer extends Editor {
	constructor(rows: () => number, requestRender: () => void) {
		// Editor only uses these two host services (no terminal IO or overlays).
		// The dashboard, rather than a second TUI renderer, owns focus and layout.
		const host = { terminal: { get rows() { return rows(); } }, requestRender } as TUI;
		super(host, {
			borderColor: dim,
			selectList: { selectedPrefix: dim, selectedText: dim, description: dim, scrollInfo: dim, noMatch: dim },
		});
		// Dashboard owns submission/validation, including preserving outer newlines.
		this.disableSubmit = true;
	}

	getValue(): string { return this.getExpandedText(); }
	setValue(value: string): void { this.setText(value); }

	protected override renderTopBorder(width: number, hidden: number): string {
		return hidden > 0 ? super.renderTopBorder(width, hidden) : "";
	}

	protected override renderBottomBorder(width: number, hidden: number): string {
		return hidden > 0 ? super.renderBottomBorder(width, hidden) : "";
	}

	override render(width: number, maxContentRows = Number.POSITIVE_INFINITY): string[] {
		// The toolkit scrolls at 30% of terminal height but has a five-line minimum.
		// On short terminals crop that viewport around the cursor so panes still fit.
		const focused = this.focused;
		this.focused = true;
		const lines = super.render(width);
		this.focused = focused;
		const content = lines.slice(1, -1);
		const count = Math.max(1, Math.min(content.length, maxContentRows));
		const cursor = Math.max(0, content.findIndex((line) => line.includes(CURSOR_MARKER)));
		const start = Math.max(0, Math.min(cursor - count + 1, content.length - count));
		const result = [
			start > 0 ? super.renderTopBorder(width, start) : lines[0]!,
			...content.slice(start, start + count),
			start + count < content.length ? super.renderBottomBorder(width, content.length - start - count) : lines.at(-1)!,
		];
		return focused ? result : result.map((line) => line.replaceAll(CURSOR_MARKER, ""));
	}
}
