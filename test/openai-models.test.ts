import { test, type TestContext } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { OPENAI_CATALOG_FIXTURE } from "./fixtures/openai-catalog.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createOpenAiCatalog } from "../src/openai-models.ts";
import { resolveConfig } from "../src/config.ts";
import { openRuntime, setupProviders } from "../src/harness.ts";

const remote = {
	...openaiProvider().getModels()[0]!,
	id: "synthetic-remote-chat",
	name: "Synthetic remote chat",
	api: "openai-responses" as const,
	baseUrl: "https://catalog-model.invalid/v1",
	contextWindow: 654321,
	maxTokens: 12345,
	thinkingLevelMap: { off: null, low: "low", high: "high" },
	compat: { supportsToolSearch: true, supportsMidConvoSystemMessages: true },
	inputLimits: { maxRequestBytes: 123456 },
};
const headers = { "last-modified": "Fri, 01 Jan 2100 00:00:00 GMT", etag: '"synthetic-catalog"' };

// Bundled-model tests cannot detect refresh auth policy or preserve newly discovered metadata.
test("canonical remote catalogs preserve exact metadata, skip OAuth refresh, and honor Pi freshness", async (t) => {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("openai", async () => ({ type: "api_key", key: "synthetic-key" }));
	await credentials.modify("openai-codex", async () => ({ type: "oauth", access: "expired", refresh: "must-not-refresh", expires: 0 }));
	let now = Date.UTC(2099, 0, 1);
	t.mock.method(Date, "now", () => now);
	const requests: string[] = [];
	t.mock.method(globalThis, "fetch", async (input, init) => {
		const url = new URL(String(input));
		assert.equal(url.origin, "https://catalog.invalid");
		assert.equal(init?.method ?? "GET", "GET");
		assert.equal(new Headers(init?.headers).get("authorization"), null);
		const provider = url.pathname.split("/").at(-1)!;
		assert.ok(["openai", "openai-codex"].includes(provider));
		requests.push(provider);
		return new Response(JSON.stringify([{ ...remote, provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses" }]), { headers });
	});
	const catalog = createOpenAiCatalog({ catalogBaseUrl: "https://catalog.invalid", modelsStore: new InMemoryModelsStore() });
	const providers = ["openai", "openai-codex"];
	const first = await catalog.load(credentials, providers);
	for (const provider of providers) {
		const model = first.get(provider)!.getModels().find((model) => model.id === remote.id)!;
		assert.ok(model);
		assert.equal(model.provider, provider);
		assert.equal(model.baseUrl, remote.baseUrl);
		assert.equal(model.contextWindow, remote.contextWindow);
		assert.equal(model.maxTokens, remote.maxTokens);
		assert.deepEqual(model.compat, remote.compat);
		assert.deepEqual(model.thinkingLevelMap, remote.thinkingLevelMap);
		assert.deepEqual(model.inputLimits, remote.inputLimits);
		assert.equal(first.get(provider)!.refreshModelsAuth, "configured");
	}
	assert.equal(requests.length, 2);
	await catalog.load(credentials, providers);
	assert.equal(requests.length, 2);
	now += 4 * 60 * 60 * 1000 + 1;
	await catalog.load(credentials, providers);
	assert.equal(requests.length, 4);
	assert.equal((await credentials.read("openai-codex"))?.type, "oauth");
});

test("an unauthenticated provider never becomes configured merely by enabling remote discovery", async (t) => {
	t.mock.method(globalThis, "fetch", async () => { throw new Error("No unauthenticated discovery expected"); });
	const catalog = createOpenAiCatalog();
	const providers = await catalog.load(new InMemoryCredentialStore(), ["openai-codex"]);
	assert.ok(providers.get("openai-codex")!.getModels().length > 0);
	assert.ok(!providers.get("openai-codex")!.getModels().some((model) => model.id === remote.id));
});

test("startup refresh precedes exact model validation and keeps configured provider aliases", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-remote-catalog-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, `provider: api\nproviders:\n  api: { kind: openai, model: ${remote.id} }\n  subscription: { kind: openai-codex, model: ${remote.id} }\n`);
	const authPath = join(dir, "auth.json");
	writeFileSync(authPath, JSON.stringify({
		openai: { type: "api_key", key: "synthetic-key" },
		"openai-codex": { type: "oauth", access: "expired", refresh: "must-not-refresh", expires: 0 },
	}));
	const previous = process.env.DURABLE_AUTH_FILE;
	process.env.DURABLE_AUTH_FILE = authPath;
	t.after(() => { if (previous === undefined) delete process.env.DURABLE_AUTH_FILE; else process.env.DURABLE_AUTH_FILE = previous; });
	let requests = 0;
	t.mock.method(globalThis, "fetch", async (input) => {
		const url = new URL(String(input));
		assert.equal(url.origin, "https://pi.dev");
		const provider = url.pathname.split("/").at(-1)!;
		requests++;
		return new Response(JSON.stringify([...OPENAI_CATALOG_FIXTURE.filter((model) => model.provider === provider), { ...remote, api: provider === "openai" ? "openai-responses" : "openai-codex-responses" }]), { headers });
	});
	const config = resolveConfig({ configPath }, {});
	const { models } = await setupProviders(config);
	assert.equal(requests, 2);
	for (const name of ["api", "subscription"]) {
		assert.equal(models.getModel(name, remote.id)?.provider, name);
		assert.deepEqual(models.getModel(name, remote.id)?.compat, remote.compat);
	}
	assert.equal(models.getModel("openai", remote.id)?.provider, "openai");
	await assert.rejects(setupProviders({ ...config, providers: config.providers.map((entry) => ({ ...entry, model: "missing-exact-id" })) }), /does not list model/);
	assert.equal(requests, 2, "model switching must not download the catalog again within Pi's freshness window");
});

function fixtureResponse(input: Parameters<typeof fetch>[0]): Response {
	const provider = new URL(String(input)).pathname.split("/").at(-1)!;
	return new Response(JSON.stringify(OPENAI_CATALOG_FIXTURE.filter((model) => model.provider === provider)), { headers });
}

const IDS = ["gpt-6.2-astra", "gpt-6.2-sol"];
const API_KEY = "sk-synthetic-model-test";
const TOKEN = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })).toString("base64url")}.signature`;

function fixture(t: TestContext, aliases = true): { dir: string; configPath: string; api: string; codex: string } {
	const dir = mkdtempSync(join(tmpdir(), "dchat-models-"));
	const api = aliases ? "api" : "openai";
	const codex = aliases ? "subscription" : "openai-codex";
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, [
		`provider: ${api}`,
		"mcp: { enabled: false }",
		"autoContinue: false",
		"providers:",
		`  ${api}: { kind: openai, model: gpt-6.2-sol }`,
		`  ${codex}: { kind: openai-codex, model: gpt-6.2-astra }`,
	].join("\n"));
	const authPath = join(dir, "synthetic-auth.json");
	writeFileSync(authPath, JSON.stringify({
		openai: { type: "api_key", key: API_KEY },
		"openai-codex": { type: "oauth", access: TOKEN, refresh: "never-refresh", expires: Number.MAX_SAFE_INTEGER },
	}));
	for (const [key, value] of Object.entries({ DURABLE_AUTH_FILE: authPath, DCHAT_IPC_DIR: dir })) {
		const previous = process.env[key];
		process.env[key] = value;
		t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
	}
	// A missing fetch override must fail, never fall back to a real account/network.
	t.mock.method(globalThis, "fetch", async (input) => {
		if (String(input).startsWith("https://pi.dev/")) return fixtureResponse(input);
		throw new Error("Unexpected real network request");
	});
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return { dir, configPath, api, codex };
}

// Existing provider tests use old IDs or faux models, not these missing catalog entries.
test("GPT-6.2 discovery and session switching retain named provider identities and operating limits offline", async (t) => {
	const { dir, configPath, api, codex } = fixture(t);
	let runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	t.after(async () => runtime.close());
	const choices = await runtime.listModels(AbortSignal.abort());
	assert.equal(choices.warning, undefined);
	for (const provider of [api, codex]) {
		for (const id of IDS) {
			const choice = choices.items.find((item) => item.lookup === `${provider}/${id}`);
			assert.ok(choice);
			assert.equal(choice.contextWindow, provider === codex && id === "gpt-6.2-sol" ? 500000 : 272000);
			assert.equal(choice.maxTokens, 128000);
			const switched = await runtime.switchModel(choice.lookup);
			assert.equal(switched.error, undefined);
			runtime = switched.runtime;
			assert.deepEqual(runtime.model, { provider, modelId: id });
			assert.equal(runtime.config.active.kind, provider === api ? "openai" : "openai-codex");
			assert.equal((await runtime.listModels(AbortSignal.abort())).items[0]!.lookup, choice.lookup);
		}
	}
});

const tool: Tool = {
	name: "lookup",
	description: "Look up a path",
	parameters: { type: "object", properties: { path: { type: "string" }, optional: { type: "string" } }, required: ["path"] },
};
const reasoningItem = { id: "rs_test", type: "reasoning", summary: [], encrypted_content: "synthetic-encrypted-reasoning" };

function sse(toolCall: boolean): Response {
	const items = toolCall ? [reasoningItem, {
		id: "fc_test", call_id: "call_test", type: "function_call", name: tool.name, arguments: '{"path":"example"}', status: "completed",
	}] : [{ id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "done", annotations: [] }] }];
	const events = [
		...items.map((item, output_index) => ({ type: "response.output_item.done", output_index, item })),
		{ type: "response.completed", response: { id: "resp_test", status: "completed", usage: { input_tokens: 1, output_tokens: 2 } } },
	];
	return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "Content-Type": "text/event-stream" } });
}

// Direct completeSimple checks below bypass Pi Durable's off-to-omitted option handling.
test("a fresh GPT-6.2 runtime with default thinking off omits reasoning and effort configuration updates", { timeout: 10_000 }, async (t) => {
	const { dir, configPath } = fixture(t);
	const requests: any[] = [];
	t.mock.method(globalThis, "fetch", async (url, init) => {
		if (String(url).startsWith("https://pi.dev/")) return fixtureResponse(url);
		assert.equal(String(url), "https://api.openai.com/v1/responses");
		assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${API_KEY}`);
		requests.push(JSON.parse(String(init?.body)));
		return sse(false);
	});
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	t.after(async () => runtime.close());
	assert.equal((await runtime.root.agent(runtime.context)).thinkingLevel, "off");
	const submission = await runtime.root.submit({ type: "input", content: "answer without an effort override" }, runtime.context);
	runtime.harness.resume();
	const settled = await submission.wait(runtime.context);
	assert.equal(settled.status, "done", JSON.stringify(settled));
	assert.equal(requests.length, 1);
	assert.equal(requests[0].model, "gpt-6.2-sol");
	assert.equal(requests[0].reasoning, undefined);
	assert.ok(!requests[0].input.some((item: any) => item.type === "configuration_update"));
});

// Catalog-only checks cannot prove that pinned Pi consumes compat flags or serializes usable tools.
for (const aliases of [false, true]) {
	for (const kind of ["openai", "openai-codex"]) {
		for (const id of IDS) {
			test(`${aliases ? "named" : "built-in"} ${kind}/${id} with ${kind === "openai" ? "API key" : "Codex OAuth"} uses Responses tools, explicit effort clamping and append-only updates`, async (t) => {
				const { configPath, api, codex } = fixture(t, aliases);
				const provider = kind === "openai" ? api : codex;
				const { models } = await setupProviders(resolveConfig({ configPath }, {}));
				const model = models.getModel(provider, id)!;
				assert.ok(model);
				assert.equal(model.api, kind === "openai" ? "openai-responses" : "openai-codex-responses");
				assert.equal(model.provider, provider);
				assert.equal(models.getModel(kind, id)?.provider, kind);
				assert.deepEqual(model.input, ["text", "image"]);
				assert.ok(!getSupportedThinkingLevels(model).includes("off"));
				assert.equal(getSupportedThinkingLevels(model).includes("minimal"), kind === "openai-codex");
				const requests: any[] = [];
				const fetch: typeof globalThis.fetch = async (url, init) => {
					assert.equal(String(url), kind === "openai" ? "https://api.openai.com/v1/responses" : "https://chatgpt.com/backend-api/codex/responses");
					assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${kind === "openai" ? API_KEY : TOKEN}`);
					const compressed = new Headers(init?.headers).get("content-encoding") === "zstd";
					const body = JSON.parse(compressed ? zstdDecompressSync(init!.body as Uint8Array).toString("utf8") : String(init?.body));
					assert.equal(body.model, id);
					assert.equal(body.messages, undefined); // Not Chat Completions, even with tools.
					for (const key of ["temperature", "top_p", "top_logprobs", "logprobs", "reasoning_effort"]) assert.equal(body[key], undefined);
					assert.ok(!body.include?.includes("message.output_text.logprobs"));
					assert.ok(body.reasoning?.effort !== "none" && body.reasoning?.effort !== "minimal");
					requests.push(body);
					return sse(requests.length === 1);
				};
				const context: Context = {
					systemPrompt: "Stable developer instructions",
					tools: [tool],
					messages: [{ role: "user", content: [{ type: "text", text: "look this up" }, { type: "image", mimeType: "image/png", data: "c3ludGhldGlj" }], timestamp: 0 }],
				};
				const options = { transport: "sse" as const, fetch, maxRetries: 0, cacheRetention: "long" as const };
				// Explicit completeSimple off clamps to low; Pi Durable's default off omits the option instead.
				const first = await models.completeSimple(model, context, { ...options, reasoning: "off" });
				assert.equal(first.stopReason, "toolUse", first.errorMessage);
				assert.equal(first.provider, provider);
				const call = first.content.find((block) => block.type === "toolCall");
				assert.ok(call?.type === "toolCall");
				assert.deepEqual(call.arguments, { path: "example" });
				const declaration = requests[0].input.find((item: any) => item.type === "additional_tools").tools[0];
				assert.equal(declaration.type, "function");
				assert.equal(declaration.name, tool.name);
				assert.deepEqual(declaration.parameters, tool.parameters);
				assert.ok(declaration.strict !== true); // Do not turn optional properties into required ones.
				assert.ok(requests[0].input.some((item: any) => item.role === "user" && item.content.some((part: any) => part.type === "input_image")));
				if (kind === "openai") {
					assert.equal(requests[0].instructions, undefined);
					assert.ok(requests[0].input.some((item: any) => item.role === "developer" && item.content === context.systemPrompt));
					assert.deepEqual(requests[0].prompt_cache_options, { ttl: "30m" });
					assert.equal(requests[0].prompt_cache_retention, undefined);
				} else {
					// Pi's Codex transport keeps the initial instructions outside input (also upstream).
					assert.equal(requests[0].instructions, context.systemPrompt);
					assert.equal(requests[0].reasoning.effort, "low");
				}
				// Real agent transcripts record the native effort used for historical responses.
				first.providerThinkingLevel = "low";
				context.messages.push(first, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "found" }], isError: false, timestamp: 1 });
				context.messages.push({ role: "system", content: "New guidance", toolsAdded: [{ ...tool, name: "second_lookup" }], timestamp: 2 });
				context.messages.push({ role: "user", content: "continue", timestamp: 3 });
				const second = await models.completeSimple(model, context, { ...options, reasoning: "max" });
				assert.equal(second.stopReason, "stop", second.errorMessage);
				const replay = requests[1].input;
				assert.deepEqual(replay.slice(0, requests[0].input.length), requests[0].input);
				assert.deepEqual(replay.find((item: any) => item.type === "reasoning"), reasoningItem);
				const replayedCall = replay.find((item: any) => item.type === "function_call");
				const result = replay.find((item: any) => item.type === "function_call_output");
				assert.equal(replayedCall.name, tool.name);
				assert.equal(replayedCall.call_id, result.call_id);
				assert.deepEqual(JSON.parse(replayedCall.arguments), { path: "example" });
				assert.equal(result.output, "found");
				assert.ok(replay.some((item: any) => item.role === "developer" && typeof item.content === "string" && item.content.includes("New guidance")));
				assert.ok(replay.some((item: any) => item.type === "additional_tools" && item.tools.some((entry: any) => entry.name === "second_lookup")));
				if (kind === "openai") {
					assert.equal(requests[0].reasoning.effort, "medium");
					assert.equal(requests[1].reasoning.effort, "medium");
					assert.deepEqual(replay.filter((item: any) => item.type === "configuration_update").map((item: any) => item.reasoning.effort), ["low", "max"]);
				} else {
					assert.equal(requests[1].instructions, requests[0].instructions);
					assert.equal(requests[1].reasoning.effort, "max");
				}
				// No effort override must omit reasoning instead of falling back to generic none.
				const omitted = await models.completeSimple(model, context, options);
				assert.equal(omitted.stopReason, "stop", omitted.errorMessage);
				assert.equal(requests[2].reasoning, undefined);
				const minimal = await models.completeSimple(model, context, { ...options, reasoning: "minimal" });
				assert.equal(minimal.stopReason, "stop", minimal.errorMessage);
				const wireEffort = kind === "openai" ? requests[3].input.at(-1).reasoning.effort : requests[3].reasoning.effort;
				assert.equal(wireEffort, "low");
				assert.equal(requests.length, 4);
			});
		}
	}
}
