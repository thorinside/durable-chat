import { defineDoc, defineExtension, defineTask, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { Tx } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";

export const REMINDER_KIND = "durable-chat.reminder";
export const MAX_PENDING_REMINDERS = 100;
export const MAX_REMINDER_DELAY_MS = 365 * 24 * 60 * 60 * 1000;
export type Reminder = { at: number; message: string };

/** Only undelivered reminders. Cancellation and delivery serialize on this document. */
export const PendingReminders = defineDoc<{ byId: Record<string, Reminder> }>({
	kind: "durable-chat.pending-reminders",
	version: 1,
	scope: "session",
	initial: () => ({ byId: {} }),
	checkpointWhen: () => false,
});

export function normalizeReminder(at: string | undefined, message: string | undefined, now: number): Reminder {
	// Require an explicit timezone; never interpret a model's date in the host's local timezone.
	if (at === undefined || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
		throw new Error("Provide at as an ISO timestamp with seconds and an explicit timezone (Z or ±HH:MM).");
	}
	const deadline = Date.parse(at);
	const [hour, minute, second] = at.slice(11, 19).split(":").map(Number);
	// Date.parse normalizes impossible month days; reject those instead of moving the reminder.
	const [year, month, day] = at.slice(0, 10).split("-").map(Number);
	const days = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
	if (!Number.isFinite(deadline) || hour! > 23 || minute! > 59 || second! > 59 || month! < 1 || month! > 12 || day! < 1 || day! > days
		|| deadline <= now || deadline - now > MAX_REMINDER_DELAY_MS) {
		throw new Error("Reminder time must be valid, in the future, and within 365 days.");
	}
	const text = message?.trim() ?? "";
	if (text.length === 0 || text.length > 4000) throw new Error("Provide a reminder message of 1–4000 characters.");
	return { at: deadline, message: text };
}

export async function createReminderInCommit(tx: Tx, reminder: Reminder) {
	const pending = await tx.doc(PendingReminders);
	if (Object.keys(pending.byId).length >= MAX_PENDING_REMINDERS) throw new Error("Too many pending reminders (limit 100). Cancel one first.");
	const id = await tx.createTask(ReminderTask, reminder, {
		ownership: { kind: "conversation" }, conversationId: ROOT_CONVERSATION_ID,
		background: true, abandonOnRestart: false,
	});
	pending.byId[String(id)] = reminder;
	return id;
}

export async function cancelReminderInCommit(tx: Tx, id: string): Promise<boolean> {
	const pending = await tx.doc(PendingReminders);
	if (pending.byId[id] === undefined) return false;
	delete pending.byId[id];
	return true;
}

export const ReminderTask = defineTask<Reminder, { phase: "sleep" | "deliver" }, { status: "delivered" | "cancelled" }>({
	name: REMINDER_KIND,
	version: 1,
	initial: () => ({ phase: "sleep" }),
	phases: {
		sleep: async (task, runtime, context) => {
			await runtime.sleepUntil(task.input.at, { phase: "deliver" }, context);
		},
		deliver: async (task, runtime, context) => {
			const main = await runtime.conversation(ROOT_CONVERSATION_ID, context);
			if (main === undefined) throw new Error("Main conversation is unavailable for reminder delivery.");
			await runtime.commit(async (tx) => {
				const pending = await tx.doc(PendingReminders);
				const reminder = pending.byId[String(task.id)];
				if (reminder !== undefined) {
					// Admission, removal, and the terminal receipt are one durable transaction.
					// followUp uses Main's inbox: never start a competing model turn or interrupt a tool.
					await main.submit(tx, {
						type: "input", whenBusy: "followUp", requestId: `reminder:${task.id}`,
						content: `[host reminder #${task.id}; scheduled ${new Date(reminder.at).toISOString()}] ${reminder.message}`,
						entry: { kind: "app.reminder", data: { id: Number(task.id), ...reminder } },
					});
					delete pending.byId[String(task.id)];
				}
				return { status: "terminal", outcome: { status: "completed", result: { status: reminder === undefined ? "cancelled" : "delivered" } } };
			}, context);
		},
	},
	abort: async (task, runtime, context) => {
		await runtime.commit(async (tx) => {
			await cancelReminderInCommit(tx, String(task.id));
			return { status: "terminal", outcome: { status: "aborted", reason: "Reminder aborted.", result: { status: "cancelled" } } };
		}, context);
	},
});

const reply = (text: string, isError = false) => ({ output: [{ type: "text" as const, text }], ...(isError ? { isError: true } : {}) });
export const ReminderTools = defineExtension({
	name: "durable-chat.reminders",
	tasks: [ReminderTask],
	tools: [defineTool({
		name: "reminder",
		description: "Main only: schedule a one-shot future wake-up, returning immediately. Use action schedule with at (ISO timestamp with timezone) and message (what to check next). Main receives a host reminder through its normal inbox when due, or on next running session if offline. Do not wait or poll. list shows pending reminders; cancel with id suppresses an undelivered reminder but cannot retract an already queued input.",
		parameters: obj({ action: oneOf(["schedule", "list", "cancel"]), at: opt(str()), message: opt(str({ maxLength: 4000 })), id: opt(str({ pattern: "^[1-9][0-9]*$" })) }),
		replay: "unsafe",
		execute: async (args, api, context) => {
			if (api.conversationId !== ROOT_CONVERSATION_ID) return reply("Only main may manage reminders.", true);
			try {
				if (args.action === "list") {
					const pending = await api.snapshot(PendingReminders, context);
					const items = Object.entries(pending?.byId ?? {}).sort((a, b) => a[1].at - b[1].at);
					return reply(items.map(([id, item]) => `#${id} ${new Date(item.at).toISOString()} ${item.message}`).join("\n") || "No pending reminders.");
				}
				if (args.action === "cancel") {
					if (args.id === undefined || !Number.isSafeInteger(Number(args.id)) || Number(args.id) <= 0) return reply("Provide a valid reminder id.", true);
					const cancelled = await api.commit((tx) => cancelReminderInCommit(tx, args.id!), context);
					return reply(cancelled ? `Cancelled reminder #${args.id}.` : `No pending reminder #${args.id}; it may already have been delivered.`, !cancelled);
				}
				const reminder = normalizeReminder(args.at, args.message, api.now());
				const id = await api.commit((tx) => createReminderInCommit(tx, reminder), context);
				return reply(`Scheduled reminder #${id} for ${new Date(reminder.at).toISOString()}. Return to the user now; do not wait or poll.`);
			} catch (error) { return reply(error instanceof Error ? error.message : String(error), true); }
		},
	})],
});
