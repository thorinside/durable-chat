import { ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Cursor, TaskId, Tx } from "@earendil-works/pi-durable";
import { JOB_KIND, type ForkOrigin } from "./tasks.ts";

/** Read a stable completed-turn cutoff. An in-flight tool round is never inherited as the fork point. */
export async function selectForkSource(tx: Tx, source: string): Promise<ForkOrigin> {
	let conversationId = ROOT_CONVERSATION_ID;
	let jobId: number | undefined;
	if (source !== "main") {
		if (!/^[1-9][0-9]*$/.test(source) || !Number.isSafeInteger(Number(source))) throw new Error("Fork source must be main or a positive job id.");
		jobId = Number(source);
		const task = await tx.task(jobId as TaskId);
		if (task?.kind !== JOB_KIND) throw new Error(`No source job #${jobId}.`);
		const owned = await tx.scanConversations({ ownerTaskId: task.id }, 2);
		if (owned.items.length !== 1) throw new Error(`Source job #${jobId} has no unique conversation.`);
		conversationId = owned.items[0]!.id;
	}
	const head = await tx.latestHeadMarker(conversationId);
	let cursor: Cursor | undefined;
	do {
		const page = await tx.scanEntries({ conversationId, order: "descending" }, 100, cursor);
		for (const entry of page.items) {
			if (head !== undefined && entry.id < head.head) break;
			if (entry.kind === "pi.assistant" && entry.model?.some((message) => message.role === "assistant" && message.stopReason === "stop")) {
				return { conversationId: Number(conversationId), entryId: Number(entry.id), ...(jobId === undefined ? {} : { jobId }) };
			}
		}
		cursor = head !== undefined && page.items.some((entry) => entry.id < head.head) ? undefined : page.next;
	} while (cursor !== undefined);
	throw new Error(`${source === "main" ? "Main" : `Job #${jobId}`} has no completed assistant turn to fork. Prime its context first.`);
}
