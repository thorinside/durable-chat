import type { FauxProviderHandle, FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { Message } from "@earendil-works/pi-ai";

function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.flatMap((block) => {
		if (typeof block !== "object" || block === null) return [];
		const value = block as Record<string, unknown>;
		return value.type === "text" && typeof value.text === "string" ? [value.text] : [];
	}).join("");
}

function latestUserText(messages: readonly Message[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") return blockText(message.content).trim();
	}
	return "";
}

function toolResultSinceUser(messages: readonly Message[]): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]!;
		if (message.role === "user") return undefined;
		if (message.role === "toolResult" && (message.toolName === "task" || message.toolName === "handoff" || message.toolName === "fork")) return message.toolName;
	}
	return undefined;
}

/**
 * Offline stand-in for a real model. It scripts one deterministic turn per request:
 * `task: <objective>` becomes a real call to the task tool, so the durable path can be
 * exercised without credentials. It is not a model and makes no claim to be one.
 */
export function createFauxResponder(faux: FauxProviderHandle): { ensure(): void } {
	const script: FauxResponseFactory = (context) => {
		// Keep exactly one scripted turn queued: the tool round asks for a second generation.
		faux.appendResponses([script]);
		const messages = context.messages;
		const completedTool = toolResultSinceUser(messages);
		if (completedTool !== undefined) {
			return fauxAssistantMessage([
				fauxText(completedTool === "task"
					? "Task created by the offline faux model. Use /tasks (or `durable-chat tasks`) to follow it."
					: completedTool === "fork" ? "Fork request handled by the offline faux model; watch its job notice."
						: "Handoff recorded by the offline faux model. This job ends here."),
			]);
		}
		const userText = latestUserText(messages);
		const fork = /^fork\s*:\s*(main|[1-9][0-9]*|tag:[a-z0-9][a-z0-9._-]{0,47})\s+([\s\S]+)$/i.exec(userText);
		if (fork !== null) {
			return fauxAssistantMessage([fauxToolCall("fork", { source: fork[1]!.toLowerCase(), brief: fork[2]!.trim(), workspace: "shared" })], { stopReason: "toolUse" });
		}
		const handoff = /^handoff\s*:\s*(main|job)\s+([\s\S]+)$/i.exec(userText);
		if (handoff !== null) {
			return fauxAssistantMessage([
				fauxToolCall("handoff", {
					target: handoff[1]!.toLowerCase(),
					brief: handoff[2]!.trim(),
					summary: "Offline faux handoff: verified progress recorded from the previous step.",
				}),
			], { stopReason: "toolUse" });
		}
		const taskRequest = /^(?:task|job)\s*:\s*([\s\S]+)$/i.exec(userText);
		if (taskRequest !== null) {
			return fauxAssistantMessage([
				fauxToolCall("task", {
					action: "create",
					brief: taskRequest[1]!.trim(),
				}),
			], { stopReason: "toolUse" });
		}
		const text = latestUserText(messages);
		return fauxAssistantMessage([
			fauxText(
				`Offline faux model. You said: ${text || "(nothing)"}\n\n` +
				`Set DURABLE_PROVIDER=openai and DURABLE_MODEL_ID for a real model, or send "task: <objective>" to create a durable task.`,
			),
		]);
	};
	return {
		ensure() {
			// Keep a small burst buffer: a job generation and a main generation can start together.
			const pending = faux.getPendingResponseCount();
			if (pending < 4) faux.appendResponses(Array.from({ length: 4 - pending }, () => script));
		},
	};
}
