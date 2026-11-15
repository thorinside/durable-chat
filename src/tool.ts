import { arr, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { AgentDoc, ConversationIdle, defineExtension, defineTool, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import type { ConversationId, EntryId, Extension, ModelRef, TaskId } from "@earendil-works/pi-durable";
import { formatJobDetail, formatJobList } from "./format.ts";
import { createJobInCommit, jobConversationId, jobInputDraft, normalizeBrief, type JobCreateOptions } from "./jobs.ts";
import { JobLink, JOB_KIND, type JobState } from "./tasks.ts";
import { selectForkSource } from "./forks.ts";
import { planWorkspace } from "./workspaces.ts";
import { JobTags, normalizeTags, resolveTaggedSource, setJobTags, taggedJob } from "./tags.ts";

function textReply(text: string, isError = false) {
	return {
		...(isError ? { isError: true } : {}),
		output: [{ type: "text" as const, text }],
	};
}

/**
 * The coordinator's task/fork tools. Creating a job is a real external effect: each tool is
 * unsafe on replay so a restart cannot admit a duplicate job.
 */
export function createTaskExtension(options: {
	model: ModelRef;
	jobExtensions: readonly Extension[];
	cwd: string;
	/** The runtime's live job options, read at call time: a session change to the thinking level applies to jobs created after it. */
	jobOptions: JobCreateOptions;
}): Extension {
	// Presentation guards, not durable state: a model that ignores the prompt must
	// not burn its run polling a live job. The first read is allowed; repeats end
	// the run with a clear tool result.
	const listedAt = new Map<number, number>();
	const shownAt = new Map<string, number>();
	const LIST_COOLDOWN_MS = 10_000;
	const LIVE_SHOW_COOLDOWN_MS = 30_000;
	const tagsSchema = arr(str({ minLength: 1, maxLength: 48 }), { maxItems: 8 });
	const taskTool = defineTool({
		name: "task",
		description:
			"Start a background job. A job is a separate durable agent conversation with read/write/edit/bash " +
			"and the Substrate MCP gateway; it runs while you stay responsive. Use `create` for work that takes more than " +
			"a couple of steps, then report the job id. Do not poll: completion notices arrive automatically. " +
			"`list` and `show` are for an explicit user request or a specific detail. Tag reusable prepared contexts at creation; " +
			"`tag` replaces a job's tags (an empty array clears them), including completed jobs. Fork from tag:reviewer to reuse context. " +
			"`steer` queues `message` for running job `id` and returns immediately. The worker receives it at its next boundary; " +
			"stay responsive and wait for its normal completion notice.",
		parameters: obj({
			action: oneOf(["create", "list", "show", "tag", "steer"]),
			brief: opt(str({ minLength: 1, maxLength: 4000 })),
			message: opt(str({ minLength: 1, maxLength: 4000 })),
			id: opt(str({ pattern: "^[0-9]+$" })),
			tags: opt(tagsSchema),
		}),
		replay: "unsafe",
		execute: async (args, api, context) => {
			if (args.action === "steer") {
				if (api.conversationId !== ROOT_CONVERSATION_ID) return textReply("Only main may steer jobs.", true);
				const id = Number(args.id);
				if (!Number.isSafeInteger(id) || id <= 0) return textReply("Provide a valid positive job id.", true);
				try {
					const draft = jobInputDraft(args.message ?? "", true);
					const job = await api.getTask(id as TaskId, context);
					if (job === undefined || job.kind !== JOB_KIND) return textReply(`No job #${id}.`, true);
					if (job.state.status === "terminal") return textReply(`Job #${id} is no longer running. Start or fork a job for new work.`, true);
					const conversationId = await jobConversationId(api, id, context);
					const conversation = conversationId === undefined ? undefined : await api.conversation(conversationId as ConversationId, context);
					if (conversation === undefined) return textReply(`Job #${id} has no conversation.`, true);
					const requestId = `job:${id}:steer:${api.taskId}`;
					await api.commit(async (tx) => {
						const current = await tx.task(id as TaskId);
						if (current === undefined || current.kind !== JOB_KIND || current.state.status === "terminal"
							|| (current.state.checkpoint as JobState).phase !== "run") throw new Error(`Job #${id} is no longer running.`);
						const link = await tx.doc(JobLink, id as TaskId);
						// Admission and tracking are atomic; the job cannot finish between them.
						await conversation.submit(tx, { ...draft, requestId, whenIdle: "reject" });
						link.steering = { requestId, message: draft.content };
					}, context);
					return textReply(`Steering queued for job #${id}. It will receive the message at its next boundary; work continues. Wait for its completion notice; do not poll.`);
				} catch (error) {
					return textReply(error instanceof ConversationIdle
						? `Job #${id} has no active run to steer; it may have just finished.`
						: error instanceof Error ? error.message : String(error), true);
				}
			}
			if (args.action === "tag") {
				if (api.conversationId !== ROOT_CONVERSATION_ID) return textReply("Only main may assign job tags.", true);
				if (args.id === undefined || args.tags === undefined) return textReply("Provide a job id and tags array; [] clears the tags.", true);
				try {
					const tags = await api.commit((tx) => setJobTags(tx, Number(args.id) as TaskId, args.tags!), context);
					return textReply(`Job #${args.id} tags: ${tags.join(", ") || "(none)"}.`);
				} catch (error) {
					return textReply(error instanceof Error ? error.message : String(error), true);
				}
			}
			if (args.action === "list") {
				const now = Date.now();
				const previous = listedAt.get(Number(api.conversationId)) ?? 0;
				if (now - previous < LIST_COOLDOWN_MS) {
					return {
						output: [{
							type: "text" as const,
							text: "You just listed jobs. Do not poll; end this turn and wait for a completion notice.",
						}],
						control: { terminate: true },
					};
				}
				listedAt.set(Number(api.conversationId), now);
				const page = await api.commit((tx) => tx.scanTasks({ kind: JOB_KIND }, 100), context);
				const labels = await api.snapshot(JobTags, context);
				return textReply(formatJobList(page.items.map((record) => taggedJob(record, labels)), Date.now()));
			}
			if (args.action === "show") {
				if (args.id === undefined) return textReply("Provide a job id.", true);
				const raw = await api.getTask(args.id as unknown as TaskId, context);
				if (raw === undefined) return textReply(`No job #${args.id}.`, true);
				const record = taggedJob(raw, await api.snapshot(JobTags, context));
				const live = record.state.status !== "terminal";
				if (live) {
					const key = `${Number(api.conversationId)}:${args.id}`;
					const now = Date.now();
					const previous = shownAt.get(key) ?? 0;
					if (now - previous < LIVE_SHOW_COOLDOWN_MS) {
						return {
							output: [{
								type: "text" as const,
								text: `Job #${args.id} is still running. You already checked it; do not poll. ` +
									`End this turn; a completion notice will start the next turn.`,
							}],
							control: { terminate: true },
						};
					}
					shownAt.set(key, now);
					return textReply(
						`${formatJobDetail(record, Date.now())}\n\n` +
						`Still running. Do not poll; a completion notice will arrive automatically.`,
					);
				}
				return textReply(formatJobDetail(record, Date.now()));
			}
			let brief: string;
			let tags: string[];
			try {
				brief = normalizeBrief(args.brief);
				tags = normalizeTags(args.tags ?? []);
			} catch (error) {
				return textReply(error instanceof Error ? error.message : String(error), true);
			}
			const cwd = (await api.agent(context)).cwd ?? options.cwd;
			const started = await api.commit(
				(tx) => createJobInCommit(tx, brief, options.model, options.jobExtensions, cwd, {
					...options.jobOptions,
					notifyMain: true,
					tags,
				}),
				context,
			);
			return textReply(
				`Started job #${started.taskId} in conversation #${started.conversationId}${tags.length === 0 ? "" : ` with tags ${tags.join(", ")}`}. It runs in the background. ` +
				`A completion notice will arrive automatically; do not poll.`,
			);
		},
	});
	const forkTool = defineTool({
		name: "fork",
		description:
			"Main only: fork prepared conversation context into a new background job with a new brief. " +
			"source is main, a numeric job id, or tag:reviewer for a uniquely tagged job. The latest completed assistant turn is the cutoff; running tasks are not copied. " +
			"Prime one scouting job, then fork it into variants. Choose shared to use the source directory, or worktree " +
			"for a host-managed branch from its clean Git HEAD. Worktrees persist for review/resume; all variants report to main. " +
			"The active session model is used for every job. Completion notices arrive automatically; do not poll.",
		parameters: obj({
			source: str({ pattern: "^(main|[1-9][0-9]*|tag:[A-Za-z0-9][A-Za-z0-9._-]{0,47})$" }),
			brief: str({ minLength: 1, maxLength: 4000 }),
			workspace: opt(oneOf(["shared", "worktree"])),
			tags: opt(tagsSchema),
		}),
		callers: ["model"],
		replay: "unsafe",
		execute: async (args, api, context) => {
			if (api.conversationId !== ROOT_CONVERSATION_ID) return textReply("Only main may fork context into jobs.", true);
			try {
				const brief = normalizeBrief(args.brief);
				const tags = normalizeTags(args.tags ?? []);
				const source = resolveTaggedSource(args.source, await api.snapshot(JobTags, context));
				const origin = await api.commit((tx) => selectForkSource(tx, source), context);
				const agent = await api.snapshotAsOf(AgentDoc, origin.conversationId as ConversationId, origin.entryId as EntryId, context);
				const workspace = await planWorkspace(agent?.cwd ?? options.cwd, args.workspace ?? "shared", context.abortSignal);
				const started = await api.commit((tx) => createJobInCommit(tx, brief, options.model, options.jobExtensions, workspace.cwd, {
					...options.jobOptions,
					notifyMain: true,
					fork: origin,
					workspace,
					tags,
				}), context);
				return textReply(
					`Forked ${origin.jobId === undefined ? "main" : `job #${origin.jobId}`} (${args.source}) at entry #${origin.entryId} into job #${started.taskId} ` +
					`(conversation #${started.conversationId}). Brief: ${brief}. Tags: ${tags.join(", ") || "none"}. Workspace: ${workspace.cwd}` +
					`${workspace.kind === "worktree" ? `; branch ${workspace.branch}; base ${workspace.baseCommit}. Setup finishes before the job starts.` : " (shared)."} ` +
					"It reports back to main automatically. Do not poll.",
				);
			} catch (error) {
				return textReply(error instanceof Error ? error.message : String(error), true);
			}
		},
	});
	return defineExtension({
		name: "durable-chat.tasks",
		tools: [taskTool, forkTool],
	});
}
