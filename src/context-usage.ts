import type { ContextView } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { DEFAULT_COMPACTION_POLICY } from "@earendil-works/pi-durable";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";

/**
 * The same active-request estimate Pi Durable uses for automatic compaction:
 * the newest assistant's recorded context usage after the head marker, plus
 * estimates for the messages that followed it.
 */
export function estimateContextTokens(view: ContextView): number {
	let measured: number | undefined;
	let measuredMessage: Message | undefined;
	const after = Number(view.head?.id ?? Number.NEGATIVE_INFINITY);
	for (let index = view.entries.length - 1; index >= 0 && measured === undefined; index--) {
		const entry = view.entries[index]!;
		if (Number(entry.id) <= after) continue;
		const assistant = view.contributions[index]?.flatMap((message) => {
			if (message.role !== "assistant") return [];
			const tokens = calculateContextTokens(message.usage);
			return tokens > 0 ? [{ message, tokens }] : [];
		}).at(-1);
		if (assistant !== undefined) {
			measured = assistant.tokens;
			measuredMessage = assistant.message;
		}
	}
	const from = measuredMessage === undefined ? 0 : view.messages.indexOf(measuredMessage) + 1;
	let tokens = measured ?? 0;
	for (const message of view.messages.slice(from)) tokens += estimateMessageTokens(message);
	return tokens;
}

/** Default automatic-compaction blocking threshold for a model window. */
export function compactionLimit(contextWindow: number): number {
	return Math.max(0, contextWindow - DEFAULT_COMPACTION_POLICY.reserveTokens);
}

export function contextPercent(tokens: number, contextWindow: number): number {
	return contextWindow <= 0 ? 0 : Math.min(100, Math.max(0, (tokens / contextWindow) * 100));
}

export function formatTokenCount(tokens: number): string {
	if (!Number.isFinite(tokens) || tokens <= 0) return "0";
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 100_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}
