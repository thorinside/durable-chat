import type { TaskId } from "@earendil-works/pi-durable";
import { withAbortSignal } from "@earendil-works/chord/context";
import type { AppRuntime } from "./harness.ts";
import { formatJobDetail, formatJobList } from "./format.ts";
import {
	announceJobStart,
	compactConversation,
	createJobInCommit,
	findJobConversation,
	formatLog,
	jobConversationId,
	jobCreateOptionsOf,
	jobRecord,
	normalizeBrief,
	readLog,
	scanJobs,
	sendToJob,
} from "./jobs.ts";
import { followJobs } from "./watch.ts";
import { compactionLimit, contextPercent, estimateContextTokens, formatTokenCount } from "./context-usage.ts";

function line(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function printMcpWarning(runtime: AppRuntime): void {
	if (runtime.mcpAttempted && !runtime.mcpConnected) {
		line("! Substrate MCP is not connected; job agents run without it (see `info`).");
	}
}

export async function listJobs(runtime: AppRuntime): Promise<void> {
	const records = await scanJobs(runtime.harness, runtime.context);
	printMcpWarning(runtime);
	line(formatJobList(records, Date.now()));
}

export async function showJob(runtime: AppRuntime, rawId: string): Promise<void> {
	const id = parseId(rawId);
	const record = await jobRecord(runtime.harness, id, runtime.context);
	if (record === undefined) {
		line(`No job #${id}.`);
		return;
	}
	line(formatJobDetail(record, Date.now()));
	const conversation = await findJobConversation(runtime.harness, id, runtime.context);
	const conversationId = conversation === undefined ? undefined : Number(conversation.id);
	if (conversation !== undefined) {
		const view = await conversation.context(runtime.context);
		const tokens = estimateContextTokens(view);
		const window = runtime.config.contextWindow;
		line("");
		line(`Context: ~${formatTokenCount(tokens)} / ${formatTokenCount(window)} (${contextPercent(tokens, window).toFixed(0)}%; compact at ~${formatTokenCount(compactionLimit(window))})`);
	}
	if (conversationId !== undefined) {
		line("");
		line(`Conversation #${conversationId}. Recent transcript:`);
		line(formatLog(await readLog(runtime.harness, conversationId, runtime.context, 12)));
	}
}

export async function showLog(runtime: AppRuntime, rawId: string): Promise<void> {
	const id = parseId(rawId);
	const conversationId = await jobConversationId(runtime.harness, id, runtime.context);
	if (conversationId === undefined) {
		line(`Job #${id} has no conversation yet.`);
		return;
	}
	line(formatLog(await readLog(runtime.harness, conversationId, runtime.context, 40)));
}

export async function startJob(
	runtime: AppRuntime,
	rawBrief: string,
	options: { detach?: boolean; resume?: boolean } = {},
): Promise<number> {
	const brief = normalizeBrief(rawBrief);
	if (options.resume === true) runtime.harness.resume();
	const started = await runtime.root.commit(
		(tx) => createJobInCommit(tx, brief, runtime.model, runtime.jobExtensions, runtime.cwd, {
			...jobCreateOptionsOf(runtime.config),
			notifyMain: true,
		}),
		runtime.context,
	);
	line(`Started job #${started.taskId} in conversation #${started.conversationId}.`);
	try {
		await announceJobStart(runtime.root, started, brief, runtime.context);
		line("Main conversation notified.");
	} catch (error) {
		line(`! could not notify main: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (options.detach !== true) {
		const controller = new AbortController();
		const onSigint = () => controller.abort();
		process.once("SIGINT", onSigint);
		try {
			await followJobs(runtime, { ids: [Number(started.taskId)], signal: controller.signal });
		} finally {
			process.removeListener("SIGINT", onSigint);
		}
		const record = await jobRecord(runtime.harness, Number(started.taskId), runtime.context);
		if (record !== undefined) line(formatJobDetail(record, Date.now()));
	}
	return Number(started.taskId);
}

export async function sendJob(
	runtime: AppRuntime,
	rawId: string,
	message: string,
	options: { steer?: boolean } = {},
): Promise<void> {
	const id = parseId(rawId);
	line(`${options.steer === true ? "Steering" : "Sending to"} job #${id}…`);
	const result = await sendToJob(runtime.harness, id, message, runtime.context, options);
	if (result.status === "answered") {
		line(result.answer ?? "(answered without text)");
	} else {
		line(`Job #${id} did not answer: ${result.reason}`);
	}
}

export async function cancelJob(runtime: AppRuntime, rawId: string): Promise<void> {
	const id = parseId(rawId);
	const mark = await runtime.harness.abortTask(id as unknown as TaskId, runtime.context);
	if (mark === "terminal") {
		line(`Job #${id} is already terminal.`);
		return;
	}
	line(`Abort requested for job #${id}.`);
	try {
		const settled = await runtime.harness.waitForTask(
			id as unknown as TaskId,
			withAbortSignal(AbortSignal.timeout(20_000), runtime.context),
		);
		line(`Job #${id} settled: ${settled.state.outcome.status}`);
	} catch {
		line(`Job #${id} is still releasing; its abort mark is durable. Check \`task show ${id}\` later.`);
	}
}

export async function compactMain(runtime: AppRuntime, instructions: string | undefined): Promise<void> {
	line("Compacting the main conversation…");
	const result = await compactConversation(runtime.harness, runtime.root, instructions, runtime.context);
	if (result.noop) {
		line(`Compaction task #${result.taskId} produced no summary (nothing to compact or declined).`);
		return;
	}
	line(`Compaction complete (task #${result.taskId}${result.entryId === undefined ? ", summary placed" : `, summary entry #${result.entryId}`}).`);
}

export async function resetMain(runtime: AppRuntime, handoff: string | undefined): Promise<void> {
	const clean = handoff === undefined || handoff.trim().length === 0 ? undefined : handoff;
	await runtime.root.reset(clean, runtime.context);
	line(clean === undefined
		? "Reset admitted: the next context starts empty. Raw history is retained."
		: "Reset admitted: the next context starts from the handoff. Raw history is retained.");
}

export async function compactJob(runtime: AppRuntime, rawId: string, instructions: string | undefined): Promise<void> {
	const id = parseId(rawId);
	const conversation = await findJobConversation(runtime.harness, id, runtime.context);
	if (conversation === undefined) {
		line(`Job #${id} has no conversation.`);
		return;
	}
	line(`Compacting job #${id} (conversation #${conversation.id})…`);
	const result = await compactConversation(runtime.harness, conversation, instructions, runtime.context);
	if (result.noop) {
		line(`Compaction task #${result.taskId} produced no summary.`);
		return;
	}
	line(`Compaction complete (task #${result.taskId}${result.entryId === undefined ? ", summary placed" : `, summary entry #${result.entryId}`}).`);
}

export async function resetJob(runtime: AppRuntime, rawId: string, handoff: string | undefined): Promise<void> {
	const id = parseId(rawId);
	const conversation = await findJobConversation(runtime.harness, id, runtime.context);
	if (conversation === undefined) {
		line(`Job #${id} has no conversation.`);
		return;
	}
	const clean = handoff === undefined || handoff.trim().length === 0 ? undefined : handoff;
	await conversation.reset(clean, runtime.context);
	line(`Reset admitted for job #${id}${clean === undefined ? "" : " with a handoff"}. Raw history is retained.`);
}

export async function followAll(runtime: AppRuntime, follow: boolean): Promise<void> {
	const controller = new AbortController();
	const onSigint = () => controller.abort();
	process.once("SIGINT", onSigint);
	try {
		await followJobs(runtime, { follow, signal: controller.signal });
	} finally {
		process.removeListener("SIGINT", onSigint);
	}
}

export async function printInfo(runtime: AppRuntime): Promise<void> {
	const view = await runtime.root.context(runtime.context);
	const tokens = estimateContextTokens(view);
	const window = runtime.config.contextWindow;
	line(`Config:     ${runtime.config.configPath}${runtime.config.configFound ? "" : " (not found; built-ins)"}`);
	if (runtime.config.configPaths.length > 1) line(`Layers:     ${runtime.config.configPaths.join(" → ")} (low → high)`);
	line(`Store:      ${runtime.storePath}`);
	if (runtime.previousStateArchive !== undefined) line(`Archive:    ${runtime.previousStateArchive}`);
	if (runtime.restoredFrom !== undefined) line(`Restored:   ${runtime.restoredFrom}`);
	line(`Model:      ${runtime.modelLabel}`);
	line(`Limits:     context ${runtime.config.contextWindow}, output ${runtime.config.maxTokens}, timeout ${runtime.config.streamTimeoutMs}ms, thinking ${runtime.config.thinkingLevel}`);
	line(`Context:    ~${formatTokenCount(tokens)} / ${formatTokenCount(window)} (${contextPercent(tokens, window).toFixed(0)}%; compact at ~${formatTokenCount(compactionLimit(window))})`);
	line(`Jobs:       ${runtime.config.autoContinue ? "auto-continue main on completion" : "passive completion notices"}`);
	line(`Workspace:  ${runtime.cwd}`);
	line(`Main tools: ${[...(runtime.tasksExtension.tools?.map((tool) => tool.name) ?? []), ...(runtime.codemodeExtension === undefined ? [] : ["codemode"])].join(", ")}`);
	// `pi.codemode.*` tools are script globals (the `models` catalog), not tools the model is offered.
	const jobTools = runtime.jobExtensions
		.flatMap((extension) => extension.tools?.map((tool) => tool.name) ?? [])
		.filter((name) => !name.startsWith("pi.codemode."));
	line(`Job tools:  ${jobTools.length === 0 ? "(none)" : jobTools.join(", ")}`);
	line(`MCP:        ${runtime.mcpAttempted ? (runtime.mcpConnected ? "substrate connected" : "substrate unavailable") : "not checked by this command"}`);
	for (const note of runtime.mcpNotes) line(`  · ${note}`);
	line(`ACP:        ${runtime.acpError === undefined ? "Main attachable with `durable-chat acp`" : `unavailable (${runtime.acpError})`}`);
	for (const warning of runtime.config.warnings) line(`  ! ${warning}`);
}

export function printHelp(command: "main" | "jobs" = "main"): void {
	if (command === "jobs") {
		line("task add <brief> [--detach]   start a background agent job");
		line("task show <id>                job status, answer, recent transcript");
		line("task log <id>                 recent job transcript");
		line("task send <id> <message> [--steer]  continue the job conversation, or steer its run");
		line("task cancel <id>              abort a running job");
		line("task compact <id> [focus]     compact the job conversation");
		line("task reset <id> [handoff]     reset the job context");
		return;
	}
	line("durable-chat                     full-screen TUI dashboard");
	line("durable-chat --plain             line-oriented chat (same runtime)");
	line("durable-chat ask <text>          one-shot message to the main agent (--wait joins jobs)");
	line("durable-chat tui                 force the TUI even if chat was implied");
	line("durable-chat task add <brief>    start a background job (--detach returns at once)");
	line("durable-chat tasks               list jobs");
	line("durable-chat task <id>           show a job");
	line("durable-chat task log <id>       recent job transcript");
	line("durable-chat task send <id> <m> [--steer]  continue or steer a job");
	line("durable-chat task cancel <id>    abort a job");
	line("durable-chat watch [--follow]    live job board until jobs settle");
	line("durable-chat acp                attach-only ACP stdio frontend for existing Main");
	line("durable-chat acp list           running Mains as JSON, each with its --endpoint");
	line("durable-chat compact [focus]     compact the main conversation");
	line("durable-chat reset [handoff]     reset the main context");
	line("durable-chat info                store, model, limits, tools, MCP status");
	line("durable-chat state fork          fork the selected state into this folder (--store selects a source)");
	line("durable-chat config ...          path/show/keys/init/edit/get/set/unset");
	line("");
	line("In chat: /tasks /task <id> /log <id> /new <brief> /send <id> <msg> /steer <id> <msg>");
	line("         /cancel <id> /compact [focus] /reset [handoff] /model [id] /provider [name] /thinking [level] /wait /info /reboot /rollback [path] /quit");
}

export function parseId(raw: string | undefined): number {
	if (raw === undefined || !/^[0-9]+$/.test(raw)) throw new Error("Provide a numeric job id.");
	return Number(raw);
}
