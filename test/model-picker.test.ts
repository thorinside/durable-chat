import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, AgentDoc } from "@earendil-works/pi-durable";
import type { ToolApi } from "@earendil-works/pi-durable";
import { acquireStoreLock, openRuntime } from "../src/harness.ts";
import type { AppRuntime } from "../src/harness.ts";
import { createJobInCommit, findJobConversation, jobOptionsOf, scanJobs } from "../src/jobs.ts";
import { modelChoices, selectModel } from "../src/models.ts";
import { JobLink } from "../src/tasks.ts";

async function fixture(t: TestContext, provider: "local" | "openai-codex" = "local") {
	const dir = mkdtempSync(join(tmpdir(), "dchat-model-picker-"));
	const received = Promise.withResolvers<void>();
	let listingStatus = 200;
	let authorization: string | undefined;
	let streamOpen = false;
	const server = createServer((request, response) => {
		if (request.url === "/v1/models") {
			authorization = request.headers.authorization;
			response.writeHead(listingStatus, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ data: [{ id: "beta" }, { id: "alpha" }, { id: "beta" }, { id: null }, { id: "\u001b]52;unsafe" }] }));
			return;
		}
		if (request.url === "/v1/chat/completions") {
			streamOpen = true;
			response.once("close", () => { streamOpen = false; });
			let body = "";
			request.on("data", (chunk) => { body += String(chunk); });
			request.on("end", () => {
				const { model } = JSON.parse(body) as { model: string };
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				response.write(`data: ${JSON.stringify({ id: "pending", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta: { role: "assistant", content: model === "beta" ? "selected model answered" : "pending" }, finish_reason: model === "beta" ? "stop" : null }] })}\n\n`);
				if (model === "beta") response.end("data: [DONE]\n\n");
				received.resolve(); // Alpha stays open until shutdown; beta answers new requests.
			});
			return;
		}
		response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	assert.ok(address !== null && typeof address === "object");
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, `provider: ${provider}\nmodel: ${provider === "local" ? "alpha" : "gpt-6.1-sol"}\nbaseUrl: http://127.0.0.1:${address.port}/v1\ncontextWindow: 2000000\nmaxTokens: 200000\nretries: 1\nautoContinue: false\nmcp:\n  enabled: false\n`);
	const authFile = process.env.DURABLE_AUTH_FILE;
	// Catalog-only Codex checks must never read the user's real credential store.
	if (provider === "openai-codex") process.env.DURABLE_AUTH_FILE = join(dir, "no-credentials.json");
	const runtimes: AppRuntime[] = [];
	const keep = (runtime: AppRuntime) => { runtimes.push(runtime); return runtime; };
	t.after(async () => {
		for (const runtime of runtimes.reverse()) await runtime.close();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		if (provider === "openai-codex") {
			if (authFile === undefined) delete process.env.DURABLE_AUTH_FILE;
			else process.env.DURABLE_AUTH_FILE = authFile;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	const runtime = keep(await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false }));
	return { runtime, keep, dir, configPath, received, streamOpen: () => streamOpen, authorization: () => authorization, failListing: () => { listingStatus = 503; } };
}

test("local model discovery uses the configured authenticated endpoint, deduplicates IDs, and falls back without generating", { timeout: 10_000 }, async (t) => {
	const { runtime, authorization, failListing } = await fixture(t);
	const choices = await modelChoices({ ...runtime.config, apiKey: "fixture-key" }, createModels(), runtime.model);
	assert.deepEqual(choices.items.map((model) => model.id), ["alpha", "beta"]);
	assert.equal(authorization(), "Bearer fixture-key");
	assert.equal(selectModel("2", choices.items).id, "beta");
	assert.equal(selectModel("alpha", choices.items).id, "alpha");
	assert.throws(() => selectModel("missing", choices.items), /listed model/);
	failListing();
	const fallback = await runtime.listModels();
	assert.deepEqual(fallback.items.map((model) => model.id), ["alpha"]);
	assert.match(fallback.warning!, /HTTP 503/);
	assert.deepEqual((await runtime.harness.inspect(runtime.context)).tasks, []);
});

test("a session-wide model selection preserves history and tags, updates worker templates and main's creation tool, and keeps configuration files unchanged", { timeout: 10_000 }, async (t) => {
	const { runtime, keep, configPath, dir } = await fixture(t);
	const originalConfig = readFileSync(configPath);
	await runtime.root.commit((tx) => tx.appendEntry(runtime.root.id, { kind: "app.kept-history", data: { note: "retain" } }), runtime.context);
	const queued = await runtime.root.commit((tx) => createJobInCommit(tx, "queued work", runtime.model, runtime.jobExtensions, runtime.cwd, { ...jobOptionsOf(runtime.config), tags: ["kept"] }), runtime.context);
	await runtime.listModels();
	const result = await runtime.switchModel("beta");
	assert.equal(result.error, undefined);
	const next = keep(result.runtime);
	assert.equal(next.model.modelId, "beta");
	assert.equal(next.storePath, runtime.storePath);
	assert.equal(next.config.provider, runtime.config.provider);
	assert.ok(readFileSync(configPath).equals(originalConfig));
	assert.ok((await next.root.entries({ order: "ascending" }, 100, undefined, next.context)).items.some((entry) => entry.kind === "app.kept-history"));
	assert.deepEqual((await scanJobs(next.harness, next.context))[0]!.tags, ["kept"]);
	assert.deepEqual((await next.root.agent(next.context)).model, next.model);
	const worker = (await findJobConversation(next.harness, Number(queued.taskId), next.context))!;
	assert.deepEqual((await worker.agent(next.context)).model, next.model);
	assert.deepEqual((await next.harness.snapshot(JobLink, queued.taskId, next.context))?.template?.model, next.model);
	// Updating agents alone misses the coordinator tool's captured model for future jobs.
	const create = next.tasksExtension.tools!.find((tool) => tool.name === "task")!;
	const api = { conversationId: next.root.id, agent: () => next.root.agent(next.context), commit: (body: Parameters<typeof next.root.commit>[0]) => next.root.commit(body, next.context) } as unknown as ToolApi;
	await create.execute!({ action: "create", brief: "new selected-model work" }, api, next.context);
	for (const job of await scanJobs(next.harness, next.context)) {
		const conversation = (await findJobConversation(next.harness, Number(job.id), next.context))!;
		assert.deepEqual((await next.harness.snapshot(AgentDoc, conversation.id, next.context))?.model, next.model);
	}
	await runtime.close();
	assert.throws(() => acquireStoreLock(next.storePath), /already open/);
	assert.equal(readdirSync(dir).some((file) => file.includes(".reboot-")), false, "model selection does not archive or reset state");
	await next.close();
	const reopened = keep(await openRuntime({ configPath, storePath: runtime.storePath, withMcp: false }));
	assert.equal(reopened.model.modelId, "alpha", "selection is session-only, not a config rewrite");
});

test("Codex model selection uses catalog limits and restores the startup ceiling when switching back to a larger model", { timeout: 10_000 }, async (t) => {
	const { runtime, keep } = await fixture(t, "openai-codex");
	const choices = (await runtime.listModels()).items;
	const small = [...choices].sort((a, b) => a.contextWindow - b.contextWindow)[0]!;
	const large = [...choices].sort((a, b) => b.contextWindow - a.contextWindow)[0]!;
	assert.ok(small.contextWindow < large.contextWindow);
	const first = await runtime.switchModel(small.id);
	assert.equal(first.error, undefined);
	const smaller = keep(first.runtime);
	assert.equal(smaller.config.contextWindow, Math.min(runtime.config.contextWindow, small.contextWindow));
	assert.equal(smaller.config.maxTokens, Math.min(runtime.config.maxTokens, small.maxTokens));
	await smaller.listModels();
	const second = await smaller.switchModel(large.id);
	assert.equal(second.error, undefined);
	const larger = keep(second.runtime);
	assert.equal(larger.config.contextWindow, Math.min(runtime.config.contextWindow, large.contextWindow));
});

// A prepared request already pins its model in its checkpoint, so it cannot corrupt a switch. The
// user's selected model wins even when a provider request is still outstanding.
test("a model change during a prepared request leaves the selected model usable", { timeout: 10_000 }, async (t) => {
	const { runtime, keep, received } = await fixture(t);
	await runtime.listModels();
	const submission = await runtime.root.submit({ type: "input", content: "keep this request", requestId: "prepared-before-model-switch" }, runtime.context);
	runtime.harness.resume();
	await received.promise;
	const result = await runtime.switchModel("beta");
	assert.equal(result.error, undefined);
	const next = keep(result.runtime);
	assert.notEqual(next, runtime);
	assert.equal(next.model.modelId, "beta");
	assert.equal(next.storePath, runtime.storePath);
	assert.throws(() => acquireStoreLock(next.storePath), /already open/);
	const resumed = await next.harness.submission(submission.id, next.context);
	assert.ok(resumed !== undefined);
	await resumed.wait(next.context);
	const fresh = await next.root.submit({ type: "input", content: "use the selected model" }, next.context);
	const settled = await fresh.wait(next.context);
	assert.equal(settled.status, "done", JSON.stringify(settled));
	const entries = await next.root.entries({ order: "ascending" }, 100, undefined, next.context);
	assert.ok(entries.items.some((entry) => entry.model?.some((message) => message.role === "assistant" && message.model === "beta" && message.stopReason === "stop")));
});

test("concurrent model selections transfer the store lease to exactly one replacement runtime", { timeout: 10_000 }, async (t) => {
	const { runtime, keep } = await fixture(t, "openai-codex");
	const alternatives = (await runtime.listModels()).items.filter((model) => model.id !== runtime.model.modelId);
	const results = await Promise.allSettled([runtime.switchModel(alternatives[0]!.id), runtime.switchModel(alternatives[1]!.id)]);
	const successes = results.filter((result) => result.status === "fulfilled");
	assert.equal(successes.length, 1);
	const winner = successes[0]!;
	assert.equal(winner.status, "fulfilled");
	if (winner.status !== "fulfilled") return;
	assert.equal(winner.value.error, undefined);
	const next = keep(winner.value.runtime);
	await runtime.close();
	assert.throws(() => acquireStoreLock(next.storePath), /already open/);
	assert.deepEqual((await next.root.agent(next.context)).model, next.model);
});

test("a failed model restart recovers the previous runtime and keeps its queued work usable", { timeout: 10_000 }, async (t) => {
	const { runtime, keep } = await fixture(t);
	await runtime.root.commit((tx) => createJobInCommit(tx, "survive restart failure", runtime.model, runtime.jobExtensions, runtime.cwd, jobOptionsOf(runtime.config)), runtime.context);
	await runtime.listModels();
	const open = Harness.open;
	let fail = true;
	t.mock.method(Harness, "open", async (...args: Parameters<typeof open>) => {
		if (fail) { fail = false; throw new Error("injected startup failure"); }
		return open(...args);
	});
	const result = await runtime.switchModel("beta");
	assert.match(result.error!, /injected startup failure/);
	const recovered = keep(result.runtime);
	assert.equal(recovered.model.modelId, "alpha");
	assert.equal((await scanJobs(recovered.harness, recovered.context)).length, 1);
	await recovered.root.commit((tx) => tx.appendEntry(recovered.root.id, { kind: "app.recovered", data: {} }), recovered.context);
});
