import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiAuthStore } from "../src/auth.ts";

test("the auth store refreshes one provider and preserves the others", async () => {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-auth-"));
	const path = join(dir, "auth.json");
	writeFileSync(path, JSON.stringify({
		"openai-codex": { type: "oauth", access: "old", refresh: "refresh", expires: 1, accountId: "acct" },
		groq: { type: "api_key", key: "g" },
	}), { mode: 0o600 });
	const store = new PiAuthStore(path);
	const initial = await store.read("openai-codex");
	assert.equal(initial?.type, "oauth");
	await store.modify("openai-codex", async (current) => ({ ...current!, access: "new" }));
	const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, { access?: string; key?: string }>;
	assert.equal(raw["openai-codex"]?.access, "new");
	assert.equal(raw.groq?.key, "g");
	assert.equal((await store.list()).length, 2);
	assert.equal(statSync(path).mode & 0o777, 0o600);
	await store.delete("groq");
	assert.equal((await store.read("groq")), undefined);
	assert.equal((await store.read("openai-codex"))?.type, "oauth");
});

test("named provider aliases read and serialize refreshes against the original Pi credential", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-auth-alias-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const path = join(dir, "auth.json");
	const credential = { type: "oauth", access: "old", refresh: "refresh", expires: 1 };
	writeFileSync(path, JSON.stringify({ "openai-codex": credential, groq: { type: "api_key", key: "g" } }));
	const store = new PiAuthStore(path, new Map([["codex", "openai-codex"], ["backup", "openai-codex"]]));
	assert.deepEqual(await store.read("codex"), credential);
	await Promise.all([
		store.modify("codex", async (current) => {
			assert.ok(current?.type === "oauth");
			await Promise.resolve();
			return { ...current, access: "first" };
		}),
		store.modify("backup", async (current) => {
			assert.ok(current?.type === "oauth");
			assert.equal(current.access, "first", "aliases must share the canonical refresh lock");
			return { ...current, access: "second" };
		}),
	]);
	const raw = JSON.parse(readFileSync(path, "utf8"));
	assert.equal(raw["openai-codex"].access, "second");
	assert.equal(raw.codex, undefined);
	assert.equal(raw.backup, undefined);
	assert.equal(raw.groq.key, "g");
	await store.delete("codex");
	assert.equal(await store.read("openai-codex"), undefined);
	assert.equal(await store.read("backup"), undefined);
});
