import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { resolveConfig } from "../src/config.ts";
import { openRuntime, setupProviders } from "../src/harness.ts";
import { withOpenAiModelSnapshot } from "../src/openai-models.ts";

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
	t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected real network request"); });
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

test("the GPT-6.2 overlay preserves bundled definitions, provider auth, dispatch and non-chat models", () => {
	for (const base of [openaiProvider(), openaiCodexProvider()]) {
		const overlay = withOpenAiModelSnapshot(base);
		assert.equal(overlay.auth, base.auth);
		assert.equal(overlay.streamSimple, base.streamSimple);
		assert.equal(overlay.filterAllModels, base.filterAllModels);
		for (const model of base.getAllModels!()) {
			assert.equal(overlay.getAllModels!().find((entry) => entry.id === model.id && entry.type === model.type), model);
		}
		assert.equal(overlay.getModels().filter((model) => IDS.includes(model.id)).length, 2);
		// Bundled definitions must win after Pi catches up, rather than being frozen by the shim.
		const bundled = { ...overlay.getModels().find((model) => model.id === IDS[0])!, name: "future bundled definition" };
		const future = withOpenAiModelSnapshot({ ...base, getModels: () => [bundled], getAllModels: () => [bundled] });
		assert.equal(future.getModels().find((model) => model.id === bundled.id), bundled);
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

// Catalog-only checks cannot prove that pinned Pi consumes compat flags or serializes usable tools.
for (const aliases of [false, true]) {
	for (const kind of ["openai", "openai-codex"]) {
		for (const id of IDS) {
			test(`${aliases ? "named" : "built-in"} ${kind}/${id} uses Responses tools, constrained thinking and append-only updates`, async (t) => {
				const { configPath, api, codex } = fixture(t, aliases);
				const provider = kind === "openai" ? api : codex;
				const { models } = setupProviders(resolveConfig({ configPath }, {}));
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
				// The app defaults to off: Pi must clamp it rather than sending rejected effort none.
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
