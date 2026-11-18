import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, type ResolvedConfig } from "../src/config.ts";
import { selectModel } from "../src/models.ts";
import { openRuntime, setupProviders, type AppRuntime } from "../src/harness.ts";
import { createJobInCommit, findJobConversation, jobOptionsOf } from "../src/jobs.ts";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

function tempConfig(text: string): string {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-providers-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, text);
	return configPath;
}

/** Two offline entries so nothing in these wiring checks reaches a real provider. */
function twoProviders(): string {
	return tempConfig([
		"provider: first",
		"mcp:",
		"  enabled: false",
		"providers:",
		"  first: { kind: faux, model: first-model, contextWindow: 200000, maxTokens: 8000 }",
		"  second: { kind: faux, model: second-model, contextWindow: 8192, maxTokens: 512, streamTimeoutMs: 1000, thinkingLevel: off }",
	].join("\n"));
}

test("a configured provider entry keeps its own model, endpoint, and limits and inherits the flat defaults", () => {
	const config = resolveConfig({ configPath: tempConfig([
		"provider: codex",
		"thinkingLevel: medium",
		"providers:",
		"  codex: { kind: openai-codex, model: gpt-6.1-sol }",
		"  ollama: { kind: local, model: llama3, baseUrl: http://127.0.0.1:11434/v1, contextWindow: 131072, thinkingLevel: off }",
	].join("\n")) }, EMPTY_ENV);
	assert.equal(config.provider, "codex");
	assert.equal(config.active.name, "codex");
	assert.equal(config.model, "gpt-6.1-sol");
	assert.deepEqual(config.providers.map((entry) => entry.name), ["codex", "ollama"]);

	const ollama = config.providers[1]!;
	assert.equal(ollama.kind, "local");
	assert.equal(ollama.model, "llama3");
	assert.equal(ollama.baseUrl, "http://127.0.0.1:11434/v1");
	assert.equal(ollama.contextWindow, 131072);
	// Only contextWindow was set, so the rest of this entry falls back to the flat defaults.
	assert.equal(ollama.maxTokens, 8192);
	assert.equal(ollama.thinkingLevel, "off");

	// The same entry becomes the resolved top-level values when it is the active one.
	const active = resolveConfig({ configPath: tempConfig([
		"provider: ollama",
		"providers:",
		"  ollama: { kind: local, model: llama3, baseUrl: http://127.0.0.1:11434/v1, contextWindow: 131072 }",
	].join("\n")) }, EMPTY_ENV);
	assert.equal(active.model, "llama3");
	assert.equal(active.baseUrl, "http://127.0.0.1:11434/v1");
	assert.equal(active.contextWindow, 131072);
});

test("an entry with no kind takes the flat provider kind, and a provider value naming no entry is rejected", () => {
	const inherited = resolveConfig({ configPath: tempConfig("providers:\n  ollama: { model: llama3, baseUrl: http://127.0.0.1:11434/v1 }\n"), provider: "ollama" }, EMPTY_ENV);
	assert.equal(inherited.providers[0]!.kind, "local");
	// With no provider value at all, the built-in default kind fills the entry.
	assert.equal(resolveConfig({ configPath: tempConfig("providers:\n  weird: { model: x }\n") }, EMPTY_ENV).providers[0]!.kind, "faux");
	assert.throws(
		() => resolveConfig({ configPath: tempConfig("provider: ollama\nproviders:\n  codex: { kind: openai-codex, model: gpt-6.1-sol }\n"), model: "gpt-6.1-sol" }, EMPTY_ENV),
		/provider must be .* or a configured provider name/,
	);
});

test("the command line and environment can select a configured entry by name", () => {
	const configPath = tempConfig("provider: codex\nproviders:\n  codex: { kind: openai-codex, model: gpt-6.1-sol }\n  ollama: { kind: local, model: llama3, baseUrl: http://127.0.0.1:11434/v1 }\n");
	assert.equal(resolveConfig({ configPath }, { DURABLE_PROVIDER: "ollama" }).provider, "ollama");
	assert.equal(resolveConfig({ configPath, provider: "ollama" }, EMPTY_ENV).provider, "ollama");
	// A name still wins over a kind, and the entry's own model is kept unless the caller names one.
	assert.equal(resolveConfig({ configPath, provider: "ollama" }, EMPTY_ENV).model, "llama3");
});

test("the offline catalog lists every configured entry with that entry's own limits", async (t: TestContext) => {
	const configPath = twoProviders();
	const dir = join(configPath, "..");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	t.after(async () => { await runtime.close(); rmSync(dir, { recursive: true, force: true }); });

	// An aborted signal proves no entry is contacted: only the active one could be.
	const choices = await runtime.listModels(AbortSignal.abort());
	assert.equal(choices.warning, undefined);
	assert.deepEqual(choices.items.map((item) => item.lookup), ["first/first-model", "second/second-model"]);
	assert.equal(choices.items[0]!.contextWindow, 200000);
	assert.equal(choices.items[1]!.contextWindow, 8192);
	assert.equal(runtime.modelLabel, "first/first-model (offline)");
});

/** Entries that are not provider kinds still resolve through the catalog, so switching can reach them. */
async function openPair(t: TestContext): Promise<AppRuntime> {
	const configPath = twoProviders();
	const runtime = await openRuntime({ configPath, storePath: join(join(configPath, ".."), "store.sqlite"), withMcp: false });
	t.after(async () => { await runtime.close(); rmSync(join(configPath, ".."), { recursive: true, force: true }); });
	return runtime;
}

test("switching provider reopens the same store on the entry's model, limits, and thinking level", async (t: TestContext) => {
	const runtime = await openPair(t);
	await runtime.root.commit((tx) => tx.appendEntry(runtime.root.id, { kind: "app.kept-history", data: { note: "retain" } }), runtime.context);
	const switched = await runtime.switchProvider("second");
	assert.equal(switched.error, undefined);
	// The store lease moved to the replacement, so the runtime it replaced must refuse to act.
	await assert.rejects(() => runtime.setThinkingLevel("off"), /already closing or closed/);
	assert.equal(switched.runtime.storePath, runtime.storePath);
	assert.equal(switched.runtime.config.provider, "second");
	assert.equal(switched.runtime.model.modelId, "second-model");
	assert.equal(switched.runtime.config.contextWindow, 8192);
	assert.equal(switched.runtime.config.maxTokens, 512);
	assert.equal(switched.runtime.config.thinkingLevel, "off");
	// The active entry must be one of the listed entries, so the picker reports the model in use.
	assert.equal(switched.runtime.config.active.name, "second");
	assert.equal(switched.runtime.config.active.model, "second-model");
	assert.equal((await switched.runtime.listModels(AbortSignal.abort())).items[0]!.lookup, "second/second-model");

	const after = await switched.runtime.root.entries({ order: "ascending" }, 100, undefined, switched.runtime.context);
	assert.ok(after.items.some((entry) => entry.kind === "app.kept-history"));
	await switched.runtime.close();
});

test("switching to a provider that is not configured names the known entries without reopening", async (t: TestContext) => {
	const runtime = await openPair(t);
	const refused = await runtime.switchProvider("nope");
	assert.equal(refused.runtime, runtime);
	assert.match(refused.error ?? "", /Known: first, second/);
	// The refused switch left this runtime open and usable.
	assert.equal((await runtime.switchProvider("first")).runtime, runtime);
});

test("a model ID shared by two providers is selected by its provider-qualified lookup", () => {
	const choices = [
		{ provider: "first", id: "shared", name: "Shared", contextWindow: 200000, maxTokens: 8000, lookup: "first/shared" },
		{ provider: "second", id: "shared", name: "Shared", contextWindow: 8192, maxTokens: 512, lookup: "second/shared" },
	];
	assert.equal(selectModel("second/shared", choices).lookup, "second/shared");
	// The number and bare-ID paths keep working for a single-provider session.
	assert.equal(selectModel("2", choices).lookup, "second/shared");
	assert.equal(selectModel("shared", choices).provider, "first");
});

test("a session model switch that crosses entries reports the provider it landed on", async (t: TestContext) => {
	const runtime = await openPair(t);
	const switched = await runtime.switchModel("second/second-model");
	assert.equal(switched.error, undefined);
	assert.equal(switched.runtime.config.provider, "second");
	assert.equal(switched.runtime.model.provider, "second");
	await switched.runtime.close();
});

// Catalog and configuration checks never dispatch a model, so they missed the stale model.provider.
test("named providers answer main and worker requests across a session model switch", { timeout: 10_000 }, async (t) => {
	const runtime = await openPair(t);
	const submission = await runtime.root.submit({ type: "input", content: "hello" }, runtime.context);
	const answer = await submission.wait(runtime.context);
	assert.equal(answer.status, "done", JSON.stringify(answer));
	const entries = await runtime.root.entries({ order: "ascending" }, 100, undefined, runtime.context);
	assert.ok(entries.items.some((entry) => entry.model?.some((message) => message.role === "assistant" && message.provider === "first")));

	const switched = await runtime.switchModel("second/second-model");
	assert.equal(switched.error, undefined);
	const next = switched.runtime;
	try {
		const started = await next.root.commit((tx) => createJobInCommit(tx, "hello worker", next.model, next.jobExtensions, next.cwd, jobOptionsOf(next.config)), next.context);
		const job = await next.harness.waitForTask(started.taskId, next.context);
		assert.equal(job.state.outcome.status, "completed", JSON.stringify(job.state.outcome));
		const worker = (await findJobConversation(next.harness, Number(started.taskId), next.context))!;
		const workerEntries = await worker.entries({ order: "ascending" }, 100, undefined, next.context);
		assert.ok(workerEntries.items.some((entry) => entry.model?.some((message) => message.role === "assistant" && message.provider === "second")));
	} finally {
		await next.close();
	}
});

test("a named Codex provider dispatches with its registry identity and existing Pi credentials", async (t) => {
	const configPath = tempConfig("provider: codex\nproviders:\n  codex: { kind: openai-codex, model: gpt-6.1-sol }\n  api: { kind: openai, model: gpt-6.1-terra }\n");
	const dir = join(configPath, "..");
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
	const authPath = join(dir, "auth.json");
	writeFileSync(authPath, JSON.stringify({ "openai-codex": { type: "oauth", access: token, refresh: "unused", expires: Number.MAX_SAFE_INTEGER } }));
	const previousAuthPath = process.env.DURABLE_AUTH_FILE;
	process.env.DURABLE_AUTH_FILE = authPath;
	t.after(() => {
		if (previousAuthPath === undefined) delete process.env.DURABLE_AUTH_FILE;
		else process.env.DURABLE_AUTH_FILE = previousAuthPath;
	});
	t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 404 }));
	const { models, model } = await setupProviders(resolveConfig({ configPath }, EMPTY_ENV));
	const resolved = models.getModel(model.provider, model.modelId)!;
	assert.equal(resolved.provider, "codex");
	const apiModels = models.getAllModels("api");
	assert.ok(apiModels.length > 0);
	assert.ok(apiModels.every((entry) => entry.provider === "api"));
	// Old checkpoints still refer to the built-in ID after a configured entry is renamed.
	assert.equal(models.getModel("openai-codex", model.modelId)?.provider, "openai-codex");
	let requests = 0;
	const response = await models.complete(resolved, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
		transport: "sse",
		fetch: async (url, init) => {
			requests++;
			assert.equal(String(url), "https://chatgpt.com/backend-api/codex/responses");
			assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`);
			const events = [
				{ type: "response.output_item.done", output_index: 0, item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello back", annotations: [] }] } },
				{ type: "response.completed", response: { id: "response", status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } },
			];
			return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
		},
	});
	assert.equal(requests, 1);
	assert.equal(response.stopReason, "stop", response.errorMessage);
	assert.equal(response.provider, "codex");
	assert.ok(response.content.some((block) => block.type === "text" && block.text === "hello back"));
});
