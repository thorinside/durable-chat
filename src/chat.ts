import { LiveDoc } from "@earendil-works/pi-durable";
import type { Conversation } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { AppRuntime } from "./harness.ts";

type AssistantJson = {
	role?: string;
	content?: { type?: string; text?: string }[];
};

export function assistantText(message: AssistantJson | undefined): string {
	return (message?.content ?? []).flatMap((block) => block.type === "text" && typeof block.text === "string" ? [block.text] : []).join("");
}

export function answerText(entry: { model?: readonly { role?: string }[] } | undefined): string | undefined {
	const messages = (entry?.model ?? []) as readonly AssistantJson[];
	const assistant = messages.filter((message) => message.role === "assistant");
	const text = assistantText(assistant.at(-1));
	return text.trim().length === 0 ? undefined : text;
}

export type Streamer = {
	begin(): void;
	end(): void;
	printed(): number;
	/** Text already written for the newest attempt, for printing only the missing suffix. */
	streamed(): string;
	stop(): Promise<void>;
};

/**
 * Streams partial assistant text and tool names from `pi.live`. The watcher only prints:
 * it never awaits or re-enters the harness inside a listener.
 */
export async function attachStreamer(
	conversation: Conversation,
	context: Context,
	options: { enabled: boolean; out?: NodeJS.WriteStream } = { enabled: true },
): Promise<Streamer> {
	const out = options.out ?? process.stdout;
	const watch = await conversation.watch(context);
	let active = false;
	let attempt = -1;
	let printed = 0;
	let everPrinted = false;
	let currentText = "";
	const seenTools = new Set<string>();

	watch.start(async (call) => {
		if (call.kind !== "value" || !active) return;
		const live = call.value.docs["pi.live"] as {
			generation?: { attempt?: number; message?: AssistantJson };
			tools?: { callId?: string; name?: string; status?: string }[];
		} | undefined;
		const generation = live?.generation;
		const text = assistantText(generation?.message);
		// `generation` is absent between attempts and after the answer: keep the
		// printed count then, or the final answer would be printed twice.
		if (generation !== undefined) {
			const currentAttempt = generation.attempt ?? 0;
			if (currentAttempt !== attempt) {
				attempt = currentAttempt;
				printed = 0;
				currentText = "";
				if (options.enabled && text.length > 0) out.write("\n");
			}
			if (text.length > printed) {
				const delta = text.slice(printed);
				if (options.enabled) out.write(delta);
				currentText += delta;
				printed = text.length;
				everPrinted = true;
			}
		}
		for (const slot of live?.tools ?? []) {
			if (slot.status === "running" && slot.callId !== undefined && !seenTools.has(slot.callId)) {
				seenTools.add(slot.callId);
				if (options.enabled) out.write(`\n[${slot.name ?? "tool"}]\n`);
			}
		}
	});

	return {
		begin() {
			active = true;
			attempt = -1;
			printed = 0;
			everPrinted = false;
			currentText = "";
			seenTools.clear();
		},
		end() {
			active = false;
		},
		printed() {
			return everPrinted ? 1 : 0;
		},
		streamed() {
			return currentText;
		},
		async stop() {
			await watch.stop();
		},
	};
}

export type AskResult = { ok: true; answer?: string } | { ok: false; reason: string };

export async function askMain(
	runtime: AppRuntime,
	text: string,
	streamer: Streamer | undefined,
	context: Context = runtime.context,
): Promise<AskResult> {
	runtime.faux?.ensure();
	streamer?.begin();
	let settled;
	try {
		const submission = await runtime.root.submit({ type: "input", content: text }, context);
		settled = await submission.wait(context);
	} finally {
		streamer?.end();
	}
	if (settled.status === "done" && settled.type === "input") {
		const entry = await runtime.root.commit((tx) => tx.entry(settled.answer), context);
		const answer = answerText(entry as { model?: readonly { role?: string }[] } | undefined) ?? "";
		const streamed = streamer?.streamed() ?? "";
		if (answer.trim().length > 0) {
			if (streamed.length === 0) {
				process.stdout.write(`${answer.trimEnd()}\n`);
			} else if (answer.startsWith(streamed)) {
				// The last progress commit can be older than the answer; print the missing tail.
				const rest = answer.slice(streamed.length);
				process.stdout.write(`${rest}${rest.endsWith("\n") ? "" : "\n"}`);
			} else {
				// A retry reset the stream; keep both attempts distinguishable.
				process.stdout.write(`\n${answer.trimEnd()}\n`);
			}
		} else if (streamed.length > 0) {
			process.stdout.write("\n");
		}
		return { ok: true, ...(answer.length === 0 ? {} : { answer }) };
	}
	const live = await runtime.harness.snapshot(LiveDoc, runtime.root.id, context) as
		{ runFailure?: { reason?: string; detail?: string } } | undefined;
	const failure = live?.runFailure;
	const reason = settled.status === "unanswered"
		? `${failure?.reason ?? String(settled.reason)}${failure?.detail === undefined ? "" : `: ${failure.detail}`}`
		: "not answered";
	return { ok: false, reason };
}
