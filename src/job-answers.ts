import type { AssistantMessage } from "@earendil-works/pi-ai";

/** Missing/non-assistant sources are not empty answers. Preserve valid empty/whitespace responses. */
export function answerTextOfEntry(
	entry: { model?: readonly unknown[]; conversationId?: number } | undefined,
	conversationId?: number,
): string | undefined {
	if (conversationId !== undefined && entry?.conversationId !== conversationId) return undefined;
	const assistant = (entry?.model ?? []).filter(
		(message): message is AssistantMessage => typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant",
	).at(-1);
	return assistant?.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}

/** Legacy receipts saved a tail only when prefixed with this marker. Empty legacy text is unproven. */
export function completeAnswer(answer: string | undefined, complete?: boolean): boolean {
	return answer !== undefined && (complete === true || (complete === undefined && answer.length > 0 && !answer.startsWith("[...answer truncated...]")));
}
