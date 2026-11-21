import { homedir } from "node:os";
import { isAbsolute, relative, sep } from "node:path";
import { backgroundAnsi, indexedColor, styleText, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { MarkdownTheme, TextAttributes } from "@earendil-works/pi-tui";
import type { EntryRecord, UsageState } from "@earendil-works/pi-durable";
import { formatDuration } from "../format.ts";
import { renderCopyableMarkdown, type CodeCopySpan } from "./markdown-copy.ts";

/** Display paths beneath home with `~`, keeping sibling directories and other roots absolute. */
export function shortenHome(path: string, home = homedir()): string {
	const suffix = relative(home, path);
	if (suffix === "") return "~";
	return suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix) ? path : `~${sep}${suffix}`;
}

const MODE = "256color" as const;

export const ACCENT = 39;
export const GREEN = 76;
export const YELLOW = 214;
export const RED = 203;
export const MUTED = 245;
export const BORDER = 240;
export const TEXT = 250;
export const COMPOSER_BG = 235;
export const TRANSCRIPT_BG = 16;

export function fg(text: string, color: number, attributes: TextAttributes = {}): string {
	return styleText(text, { fg: indexedColor(color), ...attributes }, MODE);
}

/** Fill the entire row and keep its background through nested Markdown/Input resets. */
export function backgroundLine(text: string, width: number, color: number): string {
	const background = backgroundAnsi(indexedColor(color), MODE);
	const line = truncateToWidth(text, width, "", true).replace(/\x1b\[(?:0|49)?m/g, (reset) => reset + background);
	return styleText(line, { bg: indexedColor(color) }, MODE);
}

export function dim(text: string): string {
	return fg(text, MUTED, { dim: true });
}

export function bold(text: string): string {
	return fg(text, TEXT, { bold: true });
}

export function statusColor(status: string): number {
	if (status.includes("failed") || status.includes("faulted") || status.includes("blocked")) return RED;
	if (status.includes("aborted")) return YELLOW;
	if (status.includes("completed") || status.includes("answered") || status.includes("handed off") || status.includes("done") || status.includes("handoff")) return GREEN;
	if (status.includes("running")) return ACCENT;
	if (status.includes("pending") || status.includes("waiting") || status.includes("sleeping")) return YELLOW;
	return MUTED;
}

export function statusText(status: string): string {
	return fg(status, statusColor(status));
}

type Message = {
	role?: string;
	content?: unknown;
	toolName?: string;
	isError?: boolean;
	durationMs?: number;
	stopReason?: string;
};

export type EntryFormatOptions = {
	width: number;
	toolsExpanded: boolean;
	showSystem?: boolean;
};

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (typeof block !== "object" || block === null) return [];
		const value = block as Record<string, unknown>;
		if (value.type === "text" && typeof value.text === "string") return [value.text];
		if (value.type === "toolCall") {
			const name = typeof value.name === "string" ? value.name : "tool";
			const args = value.arguments;
			const compact = typeof args === "object" && args !== null ? JSON.stringify(args) : String(args ?? "");
			return [`→ ${name} ${compact.length > 120 ? `${compact.slice(0, 119)}…` : compact}`];
		}
		if (value.type === "image") return ["[image]"];
		return [];
	}).join("\n");
}

const TRANSCRIPT_MARKDOWN_THEME: MarkdownTheme = {
	// The transcript already has a speaker gutter; don't add the toolkit's two
	// decorative code columns on top of source indentation (or copy them out).
	codeBlockIndent: "",
	heading: (text) => fg(text, TEXT),
	link: (text) => fg(text, ACCENT),
	linkUrl: dim,
	code: (text) => fg(text, ACCENT),
	codeBlock: (text) => fg(text, TEXT),
	codeBlockBorder: dim,
	quote: dim,
	quoteBorder: dim,
	hr: dim,
	listBullet: dim,
	bold: (text) => styleText(text, { bold: true }, MODE),
	italic: (text) => styleText(text, { italic: true }, MODE),
	strikethrough: (text) => styleText(text, { strikethrough: true }, MODE),
	underline: (text) => styleText(text, { underline: true }, MODE),
};

/** Copy bounds are terminal columns, recorded before pane padding is added. */
export type TranscriptLine = { text: string; copyStart: number; copyEnd: number; code?: CodeCopySpan; copySkip?: boolean };

export function transcriptLine(text: string, copyStart = 0): TranscriptLine {
	return { text, copyStart, copyEnd: visibleWidth(stripTerminalSequences(text).replace(/ +$/u, "")) };
}

function prefixLines(text: string, prefix: string, width: number, color: number): TranscriptLine[] {
	const inner = Math.max(1, width - visibleWidth(prefix));
	const rendered = renderCopyableMarkdown(text, inner, TRANSCRIPT_MARKDOWN_THEME, { color: (value) => fg(value, color) });
	const lines = rendered.length === 0 ? [{ text: "" }] : rendered;
	const gutter = visibleWidth(prefix);
	const pad = " ".repeat(gutter);
	return lines.map((line, index) => {
		const row = transcriptLine(fg(index === 0 ? prefix : pad, color) + line.text,
			// Keep visible speaker labels, but not the blank continuation gutter.
			index === 0 && prefix.trim() !== "" ? prefix.length - prefix.trimStart().length : gutter);
		if (line.copyStart !== undefined && line.copyEnd !== undefined) {
			row.code = line.code;
			row.copyStart = gutter + line.copyStart;
			row.copyEnd = gutter + line.copyEnd;
		}
		row.copySkip = line.copySkip;
		return row;
	});
}

function rule(label: string, width: number): string {
	const text = `── ${label} `;
	return fg(truncateToWidth(text, width, ""), BORDER);
}

function ruleWithText(label: string, body: string, width: number, color = MUTED): TranscriptLine[] {
	const lines = [transcriptLine(rule(label, width))];
	if (body.trim().length > 0) lines.push(...prefixLines(body.trimEnd(), "  ", width, color));
	return lines;
}

function toolResultLines(message: Message, width: number, expanded: boolean): TranscriptLine[] {
	const name = message.toolName ?? "tool";
	const mark = message.isError === true ? "✗" : "✓";
	const ms = message.durationMs === undefined ? "" : ` · ${formatDuration(message.durationMs)}`;
	const body = blockText(message.content).replace(/\s+/g, " ").trim();
	const summary = body.length > 140 ? `${body.slice(0, 139)}…` : body;
	const head = fg(`      ↳ ${mark} ${name}${ms}`, message.isError === true ? RED : GREEN);
	const lines = [transcriptLine(truncateToWidth(`${head}${summary.length === 0 ? "" : dim(`  ${summary}`)}`, width, ""), 6)];
	if (expanded) {
		const indent = " ".repeat(Math.min(10, width - 1));
		const full = blockText(message.content).trimEnd();
		const shown = full.split("\n").slice(0, 12);
		for (const line of shown) {
			for (const wrapped of wrapTextWithAnsi(line, width - indent.length)) {
				lines.push(transcriptLine(dim(`${indent}${wrapped}`), indent.length));
			}
		}
		if (full.split("\n").length > shown.length) lines.push(transcriptLine(dim(`${indent}…`), indent.length));
	}
	return lines;
}

/** One immutable transcript entry to display lines. */
export function formatEntry(entry: EntryRecord, options: EntryFormatOptions): string[] {
	return formatEntryLines(entry, options).map((line) => line.text);
}

export function formatEntryLines(entry: EntryRecord, options: EntryFormatOptions): TranscriptLine[] {
	const width = Math.max(8, options.width);
	const messages = (entry.model ?? []) as readonly Message[];
	if (entry.kind === "app.agent-message") {
		const data = entry.data as { origin?: { principalKind?: string; principalId?: string } } | undefined;
		const author = data?.origin;
		return [
			transcriptLine(dim(truncateToWidth(`── agent · substrate/${author?.principalKind ?? "unknown"}:${author?.principalId ?? "unknown"}`, width, ""))),
			...messages.flatMap((message) => prefixLines(blockText(message.content), " agent ", width, ACCENT)),
		];
	}
	if (entry.kind === "pi.user") {
		return messages.flatMap((message) => prefixLines(blockText(message.content), " you  ", width, ACCENT));
	}
	if (entry.kind === "pi.assistant") {
		const lines: TranscriptLine[] = [];
		for (const message of messages) {
			const text = blockText(message.content).trimEnd();
			if (text.length > 0) lines.push(...prefixLines(text, " ai   ", width, GREEN));
			if (message.stopReason === "aborted" && text.length === 0) lines.push(transcriptLine(fg("      [aborted attempt]", MUTED, { dim: true }), 6));
		}
		return lines;
	}
	if (entry.kind === "pi.tool-result") {
		return messages.flatMap((message) => toolResultLines(message, width, options.toolsExpanded));
	}
	if (entry.kind === "pi.reset") {
		const handoff = messages.map((message) => blockText(message.content)).join("\n").trim();
		return ruleWithText("reset", handoff, width, MUTED);
	}
	if (entry.kind === "pi.compaction") {
		const summary = messages.map((message) => blockText(message.content)).join("\n").trim();
		return ruleWithText("compacted context", options.toolsExpanded ? summary : "summary retained in history", width, MUTED);
	}
	if (entry.kind === "pi.system") {
		return options.showSystem === true ? [transcriptLine(dim(truncateToWidth("── system prompt updated", width, "")))] : [];
	}
	if (entry.kind === "app.job-handoff") {
		const data = entry.data as { fromJob?: unknown } | undefined;
		const body = messages.map((message) => blockText(message.content)).join(" ").trim();
		return ruleWithText(`job #${data?.fromJob ?? "?"} handoff → main`, body, width, MUTED);
	}
	if (entry.kind === "app.job-notice") {
		const data = entry.data as { taskId?: unknown; phase?: unknown } | undefined;
		const body = messages.map((message) => blockText(message.content)).join(" ").replace(/^\[host\]\s*/, "").trim();
		const lines = ruleWithText(`host · job #${data?.taskId ?? "?"} ${data?.phase ?? "notice"}`, body, width, MUTED);
		if (body.length > 0) lines.splice(1, 0, transcriptLine(""));
		return lines;
	}
	if (entry.kind.startsWith("app.")) return [];
	return options.showSystem === true ? [transcriptLine(dim(truncateToWidth(`── ${entry.kind}`, width, "")))] : [];
}

export type LiveView = {
	generation?: { attempt?: number; message?: { content?: unknown } };
	tools?: { callId?: string; name?: string; status?: string }[];
	runFailure?: { reason?: string; detail?: string };
};

/** Streaming partial answer and tool slots below the committed transcript. */
export function formatLive(live: LiveView | undefined, width: number): string[] {
	return formatLiveLines(live, width).map((line) => line.text);
}

export function formatLiveLines(live: LiveView | undefined, width: number): TranscriptLine[] {
	if (live === undefined) return [];
	const lines: TranscriptLine[] = [];
	const text = blockText(live.generation?.message?.content).trimEnd();
	if (text.length > 0) lines.push(...prefixLines(text, " ai   ", width, GREEN));
	// Completed slots already have committed tool-result entries; only show current work.
	const active = (live.tools ?? []).filter((slot) => slot.status !== "done").slice(0, 8);
	for (const slot of active) {
		const status = slot.status ?? "pending";
		lines.push(transcriptLine(fg(`  ${status === "running" ? "▸" : "·"} ${slot.name ?? "tool"} ${status}`, YELLOW), 2));
	}
	if (live.runFailure !== undefined) {
		const detail = live.runFailure.detail === undefined ? "" : `: ${live.runFailure.detail}`;
		lines.push(transcriptLine(fg(`  run failed: ${live.runFailure.reason ?? "unknown"}${detail}`, RED), 2));
	}
	return lines;
}

export function usageTotals(usage: UsageState | undefined): { tokens: number; cost: number } {
	let tokens = 0;
	let cost = 0;
	if (usage === undefined) return { tokens, cost };
	for (const bucket of [...Object.values(usage.models), ...Object.values(usage.tools)]) {
		const value = bucket as unknown as { totalTokens?: unknown; cost?: unknown };
		if (typeof value.totalTokens === "number") tokens += value.totalTokens;
		const costs = value.cost;
		if (typeof costs === "object" && costs !== null && !Array.isArray(costs)) {
			const total = (costs as { total?: unknown }).total;
			if (typeof total === "number") cost += total;
		}
	}
	return { tokens, cost };
}

export function padLines(lines: readonly string[], height: number, width: number): string[] {
	const out = lines.slice(0, height).map((line) => truncateToWidth(line, width, "", true));
	while (out.length < height) out.push(" ".repeat(width));
	return out;
}
