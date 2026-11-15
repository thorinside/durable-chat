import type { TaskGraph, TaskGraphNode } from "@earendil-works/pi-durable";
import type { AppRuntime } from "./harness.ts";
import { formatLiveJobLine } from "./format.ts";
import { scanJobs } from "./jobs.ts";
import { JOB_KIND } from "./tasks.ts";

export type FollowOptions = {
	follow?: boolean;
	ids?: number[];
	signal?: AbortSignal;
};

function nodeLine(node: TaskGraphNode): string {
	const state = node.state;
	const detail = state.status === "waiting"
		? ` waiting on ${state.on.join(",")}`
		: state.status === "sleeping"
			? ` until ${new Date(state.until).toISOString().slice(11, 19)}`
			: "";
	const blocked = node.blocked === undefined ? "" : ` BLOCKED(${node.blocked})`;
	return `#${node.id} ${node.kind} ${state.status}${detail}${blocked}`;
}

function jobNodes(graph: TaskGraph, ids: ReadonlySet<number> | undefined): TaskGraphNode[] {
	return Object.values(graph.tasks)
		.filter((node) => node.kind === JOB_KIND && (ids === undefined || ids.has(Number(node.id))))
		.sort((a, b) => Number(a.id) - Number(b.id));
}

/**
 * Follow background jobs through the task graph. The graph watch is the source of
 * completion; the interval only repaints elapsed time.
 */
export async function followJobs(runtime: AppRuntime, options: FollowOptions = {}): Promise<void> {
	const context = runtime.context;
	const ids = options.ids === undefined ? undefined : new Set(options.ids);
	runtime.harness.resume();

	const initial = await runtime.harness.inspect(context);
	const initialJobs = initial.tasks.filter((task) => task.record.kind === JOB_KIND && (ids === undefined || ids.has(Number(task.record.id))));
	if (initialJobs.length === 0 && options.follow !== true) {
		process.stdout.write("No live jobs.\n");
		return;
	}

	const graph = await runtime.harness.watchTaskGraph(context);
	const tty = process.stdout.isTTY === true;
	const done = Promise.withResolvers<void>();
	let last = "";
	let lastSignature = "<initial>";
	let records = await scanJobs(runtime.harness, context).catch(() => []);
	let recordsById = new Map(records.map((record) => [Number(record.id), record]));
	let refreshing = false;

	const paint = () => {
		const nodes = jobNodes(graph.value, ids);
		const lines: string[] = [];
		if (nodes.length === 0) {
			lines.push("No live jobs.");
		} else {
			lines.push(`Durable jobs — ${nodes.length} live`);
			for (const node of nodes) {
				const record = recordsById.get(Number(node.id));
				lines.push(record === undefined ? nodeLine(node) : `${formatLiveJobLine(record, Date.now())}${node.blocked === undefined ? "" : ` BLOCKED(${node.blocked})`}`);
			}
			if (options.follow === true) lines.push("", "Following. Ctrl-C to stop (work keeps its durable state).");
		}
		const text = lines.join("\n");
		const signature = nodes.map((node) => `${node.id}:${node.state.status}:${node.blocked ?? ""}`).join("|");
		if (tty) {
			if (text === last) return;
			last = text;
			process.stdout.write(`\x1b[H\x1b[2J${text}\n`);
			return;
		}
		// Piped output: print on a status change, not on every elapsed-time repaint.
		if (signature === lastSignature) return;
		lastSignature = signature;
		process.stdout.write(`${text}\n`);
	};

	const check = (graphValue: TaskGraph) => {
		if (options.follow === true) return;
		const nodes = jobNodes(graphValue, ids);
		if (nodes.length === 0) {
			done.resolve();
			return;
		}
		if (nodes.every((node) => node.blocked !== undefined)) {
			process.stderr.write("Every remaining job is blocked; stopping the wait.\n");
			done.resolve();
		}
	};
	const refreshRecords = async () => {
		if (refreshing) return;
		refreshing = true;
		try {
			records = await scanJobs(runtime.harness, context).catch(() => records);
			recordsById = new Map(records.map((record) => [Number(record.id), record]));
			paint();
		} finally {
			refreshing = false;
		}
	};
	graph.start(async (call) => {
		if (call.kind !== "value") return;
		// The graph watch reports status; a task record is fetched only when a new
		// node appears, for its brief. No periodic store scans.
		const missing = jobNodes(call.value, ids).some((node) => !recordsById.has(Number(node.id)));
		if (missing) await refreshRecords();
		else paint();
		check(call.value);
	});
	paint();
	check(graph.value);

	// Keep the wait alive and repaint ages without reading the store.
	const interval = setInterval(() => {
		if (tty) paint();
	}, 1000);

	const stop = () => done.resolve();
	options.signal?.addEventListener("abort", stop, { once: true });
	if (options.signal?.aborted === true) done.resolve();

	try {
		await done.promise;
	} finally {
		clearInterval(interval);
		options.signal?.removeEventListener("abort", stop);
		await graph.stop();
		if (tty) process.stdout.write("\n");
		const finished = await scanJobs(runtime.harness, context).catch(() => []);
		if (finished.length > 0) {
			process.stdout.write(`${finished.filter((record) => record.state.status === "terminal").length} job(s) terminal, ${finished.filter((record) => record.state.status !== "terminal").length} live.\n`);
		}
	}
}
