import type { CopyResult, CopyText } from "./clipboard.ts";
import { getOsc8LinkAtColumn, sliceByColumn, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import type { TranscriptLine } from "./format.ts";

type Point = { row: number; col: number };
type Frame = { x: number; y: number; width: number; lines: string[]; copyBounds: Omit<TranscriptLine, "text">[]; source?: object };
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const words = new Intl.Segmenter(undefined, { granularity: "word" });
const wordJoiners = new Set(["/", "-", "+", "\\", "~", "_", "."]);

/** Selection uses transcript-local cells, never the composited dashboard rows. */
export class TranscriptSelection {
	private frame?: Frame;
	private anchor?: Point;
	private focus?: Point;
	private pressed = false;
	private dragged = false;
	private version = 0;

	private readonly copy: CopyText;
	private readonly notify: (result: CopyResult) => void;
	private readonly render: () => void;
	private readonly open: (url: string) => void;

	constructor(copy: CopyText, notify: (result: CopyResult) => void, render: () => void, open: (url: string) => void) {
		this.copy = copy;
		this.notify = notify;
		this.render = render;
		this.open = open;
	}

	reset(): void {
		this.anchor = this.focus = undefined;
		this.pressed = this.dragged = false;
		this.version++;
	}

	update(frame?: Frame): void {
		const old = this.frame;
		if (!old || !frame || old.source !== frame.source || old.x !== frame.x || old.y !== frame.y || old.width !== frame.width
			|| old.lines.length !== frame.lines.length || old.lines.some((line, index) => line !== frame.lines[index])
			|| old.copyBounds.length !== frame.copyBounds.length
			|| old.copyBounds.some((bounds, index) => {
				const next = frame.copyBounds[index];
				return bounds.copyStart !== next?.copyStart || bounds.copyEnd !== next?.copyEnd || bounds.copySkip !== next?.copySkip
					|| bounds.code?.source !== next?.code?.source || bounds.code?.start !== next?.code?.start
					|| bounds.code?.end !== next?.code?.end || bounds.code?.continues !== next?.code?.continues;
			})) this.reset();
		this.frame = frame;
	}

	private point(event: TuiMouseEvent): Point {
		const frame = this.frame!;
		return { row: Math.max(0, Math.min(frame.lines.length - 1, event.y - frame.y)), col: Math.max(0, Math.min(frame.width - 1, event.x - frame.x)) };
	}

	private cell(row: number, col: number): { start: number; end: number } {
		let start = 0;
		for (const { segment } of graphemes.segment(stripTerminalSequences(this.frame!.lines[row]!))) {
			const end = start + visibleWidth(segment);
			if (end > col) return { start, end };
			start = end;
		}
		return { start: col, end: col + 1 };
	}

	private columns(row: number): { start: number; end: number } | undefined {
		if (!this.anchor || !this.focus) return;
		const before = this.anchor.row < this.focus.row || (this.anchor.row === this.focus.row && this.anchor.col <= this.focus.col);
		const start = before ? this.anchor : this.focus;
		const end = before ? this.focus : this.anchor;
		if (row < start.row || row > end.row) return;
		return { start: row === start.row ? this.cell(row, start.col).start : 0,
			end: row === end.row ? this.cell(row, end.col).end : this.frame!.width };
	}

	lines(): string[] {
		return this.frame?.lines.map((line, row) => {
			const columns = this.columns(row);
			if (!columns || (!this.dragged && this.pressed)) return line;
			const { start, end } = columns;
			const selected = sliceByColumn(line, start, end - start);
			// Nested Markdown resets must not end the selection highlight early.
			const highlighted = `\x1b[7m${selected.replace(/\x1b\[[0-9;:]*m/g, "$&\x1b[7m")}\x1b[27m`;
			return sliceByColumn(line, 0, start) + highlighted + sliceByColumn(line, end, this.frame!.width - end) + "\x1b]8;;\x1b\\\x1b[0m";
		}) ?? [];
	}

	private async copySelection(): Promise<void> {
		let text = "";
		let selectedRows = 0;
		let previousCodeEnd: number | undefined;
		for (const [row, line] of this.frame!.lines.entries()) {
			const columns = this.columns(row);
			if (!columns) continue;
			const bounds = this.frame!.copyBounds[row];
			if (bounds?.copySkip) { previousCodeEnd = undefined; continue; }
			const start = Math.max(bounds?.copyStart ?? 0, Math.min(columns.start, bounds?.copyEnd ?? 0));
			const end = Math.max(start, Math.min(columns.end, bounds?.copyEnd ?? 0));
			const fragment = stripTerminalSequences(sliceByColumn(line, start, end - start));
			const code = bounds?.code;
			if (code) {
				const offset = stripTerminalSequences(sliceByColumn(line, bounds.copyStart, start - bounds.copyStart)).length;
				const sourceStart = code.start + offset;
				const sourceEnd = sourceStart + fragment.length;
				// Only semantic continuations join. Restore whitespace dropped by word wrapping
				// from the toolkit's code source, never by guessing from rail characters.
				if (code.continues && previousCodeEnd !== undefined) text += code.source.slice(previousCodeEnd, sourceStart);
				else if (selectedRows > 0) text += "\n";
				text += code.source.slice(sourceStart, sourceEnd);
				previousCodeEnd = sourceEnd;
			} else {
				if (selectedRows > 0) text += "\n";
				text += fragment;
				previousCodeEnd = undefined;
			}
			selectedRows++;
		}
		if (!text) return;
		const version = this.version;
		let result: CopyResult;
		try { result = await this.copy(text); }
		catch (error) { result = error instanceof Error ? error.message : String(error); }
		if (version !== this.version) return; // An old clipboard completion must not erase a newer gesture.
		if (result === true) this.reset();
		this.notify(result);
		this.render();
	}

	handle(event: TuiMouseEvent): void {
		const frame = this.frame;
		if (!frame) return;
		const inside = event.x >= frame.x && event.x < frame.x + frame.width && event.y >= frame.y && event.y < frame.y + frame.lines.length;
		if (event.type === "press") {
			this.reset();
			if (event.button !== "left" || !inside) return;
			this.anchor = this.focus = this.point(event);
			this.pressed = true;
		} else if (event.type === "drag" && this.pressed) {
			this.focus = this.point(event);
			this.dragged = true;
		} else if (event.type === "release" && this.pressed) {
			this.focus = this.point(event);
			this.dragged ||= this.anchor!.row !== this.focus.row || this.anchor!.col !== this.focus.col;
			this.pressed = false;
			if (this.dragged) void this.copySelection();
			else this.anchor = this.focus = undefined;
		} else if (event.type === "click" && inside && event.button === "left") {
			const point = this.point(event);
			const line = frame.lines[point.row]!;
			if ((event.clickCount ?? 1) === 1) {
				const url = getOsc8LinkAtColumn(line, point.col);
				if (url) {
					try { this.open(url); } catch { /* Link activation is best-effort, as in the toolkit. */ }
				}
			} else {
				this.version++;
				let start = 0;
				let end = frame.width;
				if (event.clickCount === 2) {
					// Keep terminal-style word boundaries, including path/identifier joiners.
					let column = 0;
					const segments = [...words.segment(stripTerminalSequences(line))].map((segment) => {
						const start = column;
						column += visibleWidth(segment.segment);
						const joiner = wordJoiners.has(segment.segment);
						return { start, end: column, joiner, selectable: segment.isWordLike || joiner };
					});
					const index = segments.findIndex((segment) => point.col >= segment.start && point.col < segment.end);
					if (index >= 0) {
						const joins = (left: typeof segments[number], right: typeof segments[number]) => left.selectable && right.selectable && (left.joiner || right.joiner);
						start = segments[index]!.start;
						end = segments[index]!.end;
						for (let i = index; i > 0 && joins(segments[i - 1]!, segments[i]!); i--) start = segments[i - 1]!.start;
						for (let i = index; i + 1 < segments.length && joins(segments[i]!, segments[i + 1]!); i++) end = segments[i + 1]!.end;
					}
				}
				this.anchor = { row: point.row, col: start };
				this.focus = { row: point.row, col: Math.max(start, end - 1) };
				void this.copySelection();
			}
		}
	}
}
