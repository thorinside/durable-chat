#!/usr/bin/env node
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { withCancel } from "@earendil-works/chord/context";
import { openRuntime, StoreInUseError, type AppRuntime } from "./harness.ts";
import { focusExistingSession } from "./existing-session.ts";
import { askMain, attachStreamer } from "./chat.ts";
import {
	cancelJob,
	compactJob,
	compactMain,
	followAll,
	listJobs,
	printHelp,
	printInfo,
	resetJob,
	resetMain,
	sendJob,
	showJob,
	showLog,
	startJob,
} from "./commands.ts";
import { scanJobs } from "./jobs.ts";
import { runConfigCommand, printConfigHelp } from "./config-commands.ts";
import { JOB_KIND } from "./tasks.ts";
import { selectModel, type RuntimeNotice } from "./models.ts";
import { rollbackChoices, rollbackSource } from "./rollback.ts";
import type { InteractiveExit } from "./reboot.ts";
import { forkLocalState } from "./state.ts";

const OPTIONS = {
	store: { type: "string" as const },
	provider: { type: "string" as const },
	model: { type: "string" as const },
	config: { type: "string" as const },
	force: { type: "boolean" as const, default: false },
	local: { type: "boolean" as const, default: false },
	plain: { type: "boolean" as const, default: false },
	steer: { type: "boolean" as const, default: false },
	follow: { type: "boolean" as const, default: false },
	detach: { type: "boolean" as const, default: false },
	wait: { type: "boolean" as const, default: false },
	verbose: { type: "boolean" as const, default: false },
	"no-mcp": { type: "boolean" as const, default: false },
	help: { type: "boolean" as const, short: "h", default: false },
};

async function readStdin(): Promise<string> {
	const chunks: string[] = [];
	for await (const chunk of process.stdin) chunks.push(String(chunk));
	return chunks.join("").trim();
}

function textOf(positionals: readonly string[], from: number): string {
	return positionals.slice(from).join(" ").trim();
}

function banner(runtime: AppRuntime): void {
	process.stdout.write(`durable-chat — ${runtime.modelLabel} — ${runtime.storePath}\n`);
	const mcp = runtime.mcpAttempted ? (runtime.mcpConnected ? "Substrate MCP connected" : "Substrate MCP unavailable") : "MCP disabled";
	if (runtime.previousStateArchive !== undefined) process.stdout.write(`Previous state archive: ${runtime.previousStateArchive}\n`);
	if (runtime.restoredFrom !== undefined) process.stdout.write(`Restored from: ${runtime.restoredFrom}\n`);
	process.stdout.write(`jobs: ${mcp} · /help for commands\n\n`);
}

type SlashState = {
	cancelWait?: () => void;
	confirmReboot: () => Promise<boolean>;
	requestRollback: (choice: string) => Promise<string | undefined>;
	requestModel: (choice: string) => Promise<string | undefined>;
	exit?: InteractiveExit;
};

async function slash(runtime: AppRuntime, input: string, state: SlashState): Promise<boolean> {
	const [command, ...rest] = input.slice(1).trim().split(/\s+/);
	const tail = input.slice(1 + (command?.length ?? 0)).trim();
	switch (command) {
		case "help":
			printHelp();
			return true;
		case "model": {
			const id = await state.requestModel(tail);
			if (id === undefined) return true;
			state.exit = { modelId: id };
			return false;
		}
		case "provider": {
			const entries = runtime.config.providers;
			if (rest[0] === undefined) {
				process.stdout.write(`Providers: ${entries.map((entry) => `${entry.name}${entry.name === runtime.config.provider ? " (current)" : ""}`).join(", ")} — the config file decides the next run\n`);
				return true;
			}
			state.exit = { provider: rest[0] };
			return false;
		}
		case "thinking": {
			if (rest[0] === undefined) {
				process.stdout.write(`thinking: ${runtime.thinkingLevel} (session override; the config file decides the next run)\n`);
				return true;
			}
			process.stdout.write(`thinking level: ${await runtime.setThinkingLevel(rest[0])}\n`);
			return true;
		}
		case "rollback": {
			const source = await state.requestRollback(tail);
			if (source === undefined) return true;
			state.exit = { rollbackFrom: source };
			return false;
		}
		case "reboot":
			if (tail.length > 0) throw new Error("Usage: /reboot");
			if (!(await state.confirmReboot())) return true;
			state.exit = "reboot";
			return false;
		case "quit":
		case "exit":
			return false;
		case "tasks":
			await listJobs(runtime);
			return true;
		case "task":
		case "show":
			if (rest[0] === undefined) return true;
			await showJob(runtime, rest[0]);
			return true;
		case "log":
			if (rest[0] === undefined) return true;
			await showLog(runtime, rest[0]);
			return true;
		case "new":
			if (tail.length === 0) {
				process.stdout.write("Usage: /new <brief>\n");
				return true;
			}
			await startJob(runtime, tail, { detach: true, resume: true });
			return true;
		case "send":
		case "steer": {
			const [id, ...message] = tail.split(/\s+/);
			if (id === undefined || message.length === 0) {
				process.stdout.write(`Usage: /${command} <id> <message>\n`);
				return true;
			}
			await sendJob(runtime, id, message.join(" "), { steer: command === "steer" });
			return true;
		}
		case "cancel":
			if (rest[0] !== undefined) await cancelJob(runtime, rest[0]);
			return true;
		case "compact":
			await compactMain(runtime, tail.length === 0 ? undefined : tail);
			return true;
		case "reset":
			await resetMain(runtime, tail.length === 0 ? undefined : tail);
			return true;
		case "wait": {
			const controller = new AbortController();
			state.cancelWait = () => controller.abort();
			try {
				const { followJobs } = await import("./watch.ts");
				await followJobs(runtime, { signal: controller.signal });
			} finally {
				state.cancelWait = undefined;
			}
			return true;
		}
		case "info":
			await printInfo(runtime);
			return true;
		default:
			process.stdout.write(`Unknown command /${command ?? ""}. /help lists commands.\n`);
			return true;
	}
}

async function interactive(runtime: AppRuntime, notice?: RuntimeNotice): Promise<InteractiveExit> {
	const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
	const streamer = process.stdout.isTTY === true
		? await attachStreamer(runtime.root, runtime.context, { enabled: true })
		: undefined;
	const state: SlashState = {
		confirmReboot: async () => (await rl.question(`Archive all conversations, jobs and tags at ${runtime.storePath} and start fresh? Durable work pauses; project files and worktrees remain. [y/N] `)).trim().toLowerCase() === "y",
		requestModel: async (choice) => {
			const choices = await runtime.listModels();
			if (choices.warning !== undefined) process.stdout.write(`${choices.warning}\n`);
			if (choice.length === 0) {
				process.stdout.write(`Models for ${runtime.model.provider} — main and all jobs, this session only:\n`);
				process.stdout.write(`${choices.items.map((model, index) => `${index + 1}. ${model.id}${model.id === runtime.model.modelId ? " (current)" : ""}`).join("\n")}\n`);
				choice = (await rl.question("Model number or ID (Enter cancels)> ")).trim();
				if (choice.length === 0) return undefined;
			}
			return selectModel(choice, choices.items).lookup;
		},
		requestRollback: async (choice) => {
			const choices = rollbackChoices(runtime.storePath, runtime.previousStateArchive);
			if (choice.length === 0) {
				process.stdout.write(choices.length === 0 ? "No recent archives; enter a database file path.\n" : `${choices.map((path, index) => `${index + 1}. ${path}`).join("\n")}\n`);
				choice = (await rl.question("Rollback file or number (Enter cancels)> ")).trim();
				if (choice.length === 0) return undefined;
			}
			const source = rollbackSource(choice, choices, runtime.storePath);
			const answer = await rl.question(`Restore from ${source}? Current state will be archived; the selected file stays unchanged. Restored jobs resume; project files/worktrees remain. [y/N] `);
			return answer.trim().toLowerCase() === "y" ? source : undefined;
		},
	};
	const pendingNotes: string[] = [];
	let busy = false;
	const note = (text: string) => {
		if (busy) pendingNotes.push(text);
		else process.stdout.write(`· ${text}\n`);
	};
	const graph = await runtime.harness.watchTaskGraph(runtime.context);
	let previous = new Map<string, string>();
	graph.start(async (call) => {
		if (call.kind !== "value") return;
		const nodes = Object.values(call.value.tasks).filter((node) => node.kind === JOB_KIND);
		const next = new Map(nodes.map((node) => [String(node.id), node.state.status]));
		for (const [id, status] of next) {
			const before = previous.get(id);
			if (before !== status) note(`job #${id} ${status}`);
		}
		for (const id of previous.keys()) {
			if (!next.has(id)) note(`job #${id} finished — /task ${id} for the answer`);
		}
		previous = next;
	});
	let closed = false;
	rl.on("close", () => {
		closed = true;
	});
	rl.on("SIGINT", () => {
		if (state.cancelWait !== undefined) {
			state.cancelWait();
			process.stdout.write("\n(stopped waiting; durable work continues)\n");
			return;
		}
		process.stdout.write("\n(leaving; live jobs keep their durable state)\n");
		rl.close();
	});

	banner(runtime);
	if (notice !== undefined) (notice.error === true ? process.stderr : process.stdout).write(`${notice.text}\n`);
	while (!closed) {
		let line: string;
		try {
			line = await rl.question("you> ");
		} catch {
			break;
		}
		const text = line.trim();
		if (text.length === 0) continue;
		if (text.startsWith("/")) {
			try {
				if (!(await slash(runtime, text, state))) break;
			} catch (error) {
				process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
			}
			continue;
		}
		const turn = withCancel(runtime.context);
		state.cancelWait = () => turn.cancel(new Error("interrupted"));
		busy = true;
		try {
			const result = await askMain(runtime, text, streamer, turn.context);
			if (!result.ok) process.stdout.write(`(run failed: ${result.reason})\n`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (message.includes("interrupted")) process.stdout.write("(stopped waiting; the run may still finish)\n");
			else process.stderr.write(`error: ${message}\n`);
		} finally {
			state.cancelWait = undefined;
			busy = false;
			for (const line of pendingNotes.splice(0)) process.stdout.write(`· ${line}\n`);
		}
		try {
			const jobs = await scanJobs(runtime.harness, runtime.context);
			const live = jobs.filter((record) => record.state.status !== "terminal");
			if (live.length > 0) {
				process.stdout.write(`· ${live.length} live job${live.length === 1 ? "" : "s"} — /tasks\n`);
			}
		} catch {
			// A failed read must not end the chat.
		}
	}
	await graph.stop();
	await streamer?.stop();
	rl.close();
	return state.exit ?? "quit";
}

async function runTui(runtime: AppRuntime, notice?: RuntimeNotice): Promise<InteractiveExit> {
	const { runTui: start } = await import("./tui/main.ts");
	return start(runtime, notice);
}

async function main(): Promise<void> {
	let parsed;
	try {
		parsed = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: OPTIONS });
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		printHelp();
		process.exitCode = 2;
		return;
	}
	const { values, positionals } = parsed;
	if (values.help === true || positionals[0] === "help") {
		printHelp();
		printConfigHelp();
		return;
	}
	const command = positionals[0];
	if (command === "config") {
		runConfigCommand(positionals.slice(1), {
			...(values.config === undefined ? {} : { configPath: values.config }),
			force: values.force === true,
			local: values.local === true,
		});
		return;
	}
	if (values.local === true) throw new Error("--local is only supported by config commands.");
	const sub = positionals[1];
	if (command === "state") {
		if (sub !== "fork" || positionals.length !== 2) throw new Error("Usage: dchat state fork [--store <source.sqlite>]");
		if (values.force === true) throw new Error("State forks never overwrite existing local state; --force is not supported.");
		const fork = forkLocalState({
			...(values.store === undefined ? {} : { store: values.store }),
			...(values.config === undefined ? {} : { configPath: values.config }),
			...(values.provider === undefined ? {} : { provider: values.provider }),
			...(values.model === undefined ? {} : { model: values.model }),
		});
		process.stdout.write(`Forked state:\n  from: ${fork.sourcePath}\n  to:   ${fork.storePath}\nLocal config: ${fork.configPath}\n`);
		process.stdout.write("Run dchat in this folder to continue the fork. The source is unchanged.\n");
		process.stdout.write("Pending work is copied too; running both copies can repeat external actions. Existing jobs keep their saved working directories.\n");
		for (const name of ["DURABLE_STORE", "DURABLE_CHAT_CONFIG"]) {
			if ((process.env[name]?.trim() ?? "") !== "") process.stdout.write(`note: unset ${name} to let the new folder-local config select its database.\n`);
		}
		return;
	}
	if (command === "acp") {
		const { acpFrontend } = await import("./acp.ts");
		await acpFrontend({ ...(values.store === undefined ? {} : { store: values.store }), ...(values.config === undefined ? {} : { configPath: values.config }) });
		return;
	}
	const noMcp = values["no-mcp"] === true;
	const readOnly = command === "tasks"
		|| (command === "task" && (sub === "show" || sub === "log" || sub === "get" || (sub !== undefined && /^[0-9]+$/.test(sub))));
	let runtime: AppRuntime;
	try {
		runtime = await openRuntime({
			...(values.store === undefined ? {} : { storePath: values.store }),
			...(values.provider === undefined ? {} : { provider: values.provider }),
			...(values.model === undefined ? {} : { model: values.model }),
			...(values.config === undefined ? {} : { configPath: values.config }),
			verbose: values.verbose === true,
			...(readOnly || noMcp ? { withMcp: false } : {}),
		});
	} catch (error) {
		if (error instanceof StoreInUseError && await focusExistingSession(error.pid, { command })) {
			process.stdout.write("dchat is already running for this store; focused its existing Ghostty terminal.\n");
			return;
		}
		throw error;
	}

	const runInteractive = async (mode: "plain" | "tui"): Promise<void> => {
		let notice: RuntimeNotice | undefined;
		for (;;) {
			const exit = await (mode === "plain" ? interactive(runtime, notice) : runTui(runtime, notice));
			notice = undefined;
			if (exit === "quit") return;
			if (exit === "reboot") runtime = await runtime.reboot();
			else if ("rollbackFrom" in exit) runtime = await runtime.rollback(exit.rollbackFrom);
			else if ("provider" in exit) {
				const result = await runtime.switchProvider(exit.provider);
				runtime = result.runtime;
				notice = result.error === undefined ? { text: `Provider: ${runtime.modelLabel} (all agents, this session)` } : { text: result.error, error: true };
			}
			else {
				const result = await runtime.switchModel(exit.modelId);
				runtime = result.runtime;
				notice = result.error === undefined ? { text: `Model: ${runtime.modelLabel} (all agents, this session)` } : { text: result.error, error: true };
			}
		}
	};
	try {
		switch (command) {
			case undefined:
				if (process.stdin.isTTY !== true) {
					process.stderr.write("Interactive mode needs a TTY; use `durable-chat ask <text>`.\n");
					process.exitCode = 2;
					return;
				}
				if (values.plain === true) {
					await runInteractive("plain");
					return;
				}
				await runInteractive("tui");
				return;
			case "tui":
				await runInteractive("tui");
				return;
			case "chat":
				if (process.stdin.isTTY !== true) {
					process.stderr.write("Interactive mode needs a TTY; use `durable-chat ask <text>`.\n");
					process.exitCode = 2;
					return;
				}
				await runInteractive("plain");
				return;
			case "ask": {
				const text = textOf(positionals, 1) || (process.stdin.isTTY === true ? "" : await readStdin());
				if (text.length === 0) {
					process.stderr.write("Usage: durable-chat ask <text>\n");
					process.exitCode = 2;
					return;
				}
				const streamer = process.stdout.isTTY === true
					? await attachStreamer(runtime.root, runtime.context, { enabled: true })
					: undefined;
				let result;
				try {
					result = await askMain(runtime, text, streamer);
				} finally {
					await streamer?.stop();
				}
				if (!result.ok) process.stderr.write(`run failed: ${result.reason}\n`);
				if (values.wait === true) await followAll(runtime, false);
				const jobs = await scanJobs(runtime.harness, runtime.context);
				const live = jobs.filter((record) => record.state.status !== "terminal");
				if (live.length > 0) {
					process.stdout.write(`· ${live.length} live job${live.length === 1 ? "" : "s"}; follow with \`durable-chat watch\`.\n`);
				}
				return;
			}
			case "tasks":
				await listJobs(runtime);
				return;
			case "task": {
				if (sub === undefined) {
					await listJobs(runtime);
					return;
				}
				if (/^[0-9]+$/.test(sub)) {
					await showJob(runtime, sub);
					return;
				}
				switch (sub) {
					case "add":
					case "new": {
						const brief = textOf(positionals, 2) || (process.stdin.isTTY === true ? "" : await readStdin());
						if (brief.length === 0) {
							process.stderr.write("Usage: durable-chat task add <brief>\n");
							process.exitCode = 2;
							return;
						}
						await startJob(runtime, brief, { detach: values.detach === true });
						return;
					}
					case "show":
					case "get":
						await showJob(runtime, required(positionals[2], "task show <id>"));
						return;
					case "log":
						await showLog(runtime, required(positionals[2], "task log <id>"));
						return;
					case "send":
						await sendJob(runtime, required(positionals[2], "task send <id> <message>"), required(textOf(positionals, 3), "task send <id> <message>"), { steer: values.steer === true });
						return;
					case "cancel":
						await cancelJob(runtime, required(positionals[2], "task cancel <id>"));
						return;
					case "compact":
						await compactJob(runtime, required(positionals[2], "task compact <id> [focus]"), textOf(positionals, 3) || undefined);
						return;
					case "reset":
						await resetJob(runtime, required(positionals[2], "task reset <id> [handoff]"), textOf(positionals, 3) || undefined);
						return;
					default:
						printHelp("jobs");
						return;
				}
			}
			case "watch":
				await followAll(runtime, values.follow === true);
				return;
			case "compact":
				await compactMain(runtime, textOf(positionals, 1) || undefined);
				return;
			case "reset":
				await resetMain(runtime, textOf(positionals, 1) || undefined);
				return;
			case "info":
				await printInfo(runtime);
				return;
			default:
				process.stderr.write(`Unknown command "${command}".\n`);
				printHelp();
				process.exitCode = 2;
		}
	} finally {
		await runtime.close();
	}
}

function required(value: string | undefined, usage: string): string {
	if (value === undefined || value.length === 0) throw new Error(`Usage: durable-chat ${usage}`);
	return value;
}

main().catch((error) => {
	process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

