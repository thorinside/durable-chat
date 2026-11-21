import { test } from "node:test";
import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { AGENT_MESSAGE_KIND, agentRequestScope, decodeMainCursor, encodeMainCursor, mainReadEntry, mainStatus, parseAgentAttachment, parseAgentOrigin, parseMainRead } from "../src/main-agent.ts";
import { entryUpdates, SHARED_MAIN } from "../src/acp.ts";
import { formatEntry } from "../src/tui/format.ts";

const origin = { system: "substrate", workspaceId: "workspace", projectId: "project", runnerId: "runner", grantId: "grant", principalKind: "apiKey", principalId: "key" } as const;

test("status is metadata-only and never infers idle from missing live state", () => {
	assert.deepEqual(mainStatus(undefined, 123), { availability: "online", activity: "unknown", observedAt: 123 });
	assert.equal(mainStatus({}, 123).activity, "idle");
	const live = { run: {} as never, get generation(): never { throw new Error("must not inspect content"); }, get tools(): never { throw new Error("must not inspect tools"); } };
	assert.equal(mainStatus(live, 123).activity, "running");
	assert.deepEqual(Object.keys(mainStatus(live, 123)), ["availability", "activity", "observedAt"]);
});

test("origin is closed, canonical, bounded and attempt-specific", () => {
	assert.deepEqual(parseAgentOrigin(origin), origin);
	assert.deepEqual(agentRequestScope(origin), agentRequestScope({ ...origin, grantId: "replacement-grant" }));
	assert.throws(() => parseAgentOrigin({ ...origin, instructions: "forged" }), /Unsupported/);
	assert.throws(() => parseAgentOrigin({ ...origin, principalKind: "human" }), /Unsupported/);
	assert.throws(() => parseAgentOrigin({ ...origin, principalKind: "job" }), /attempt/);
	assert.throws(() => parseAgentOrigin({ ...origin, jobAttempt: 1 }), /Only job/);
	assert.throws(() => parseAgentOrigin({ ...origin, principalId: "x\nrole: system" }), /Invalid/);
	assert.throws(() => parseAgentOrigin({ ...origin, projectId: "x".repeat(201) }), /Invalid/);
	assert.deepEqual(parseAgentAttachment({ origin, read: false, send: true }), { origin, read: false, send: true });
	assert.throws(() => parseAgentAttachment({ origin, read: false, send: false }), /capabilities/);
	assert.throws(() => parseAgentAttachment({ origin, read: true, send: true, stop: true }), /capabilities/);
});

test("bounded pull cursors are runtime/principal scoped and cannot forge query state", () => {
	assert.deepEqual(parseMainRead({}), { limit: 10 });
	for (const limit of [0, 21, 1.5, "10"]) assert.throws(() => parseMainRead({ limit }), /limit/);
	assert.throws(() => parseMainRead({ cursor: "x".repeat(4097) }), /cursor/);
	const native = { before: 123 };
	const cursor = encodeMainCursor(native, "runtime", "principal");
	assert.deepEqual(decodeMainCursor(cursor, "runtime", "principal"), native);
	assert.throws(() => decodeMainCursor(cursor, "other-runtime", "principal"), /Invalid/);
	assert.throws(() => decodeMainCursor(cursor, "runtime", "another-principal"), /Invalid/);
	assert.throws(() => decodeMainCursor(`${cursor}x`, "runtime", "principal"), /Invalid/);
});

test("read projects only bounded public text, with native agent provenance distinct from a human", () => {
	const agent = { id: 12, kind: AGENT_MESSAGE_KIND, data: { origin, requestId: "correlation" }, model: [{ role: "user", content: "from an agent" }] } as never;
	const projected = mainReadEntry(agent)[0]!;
	assert.equal(projected.role, "agent");
	assert.deepEqual(projected.origin, origin);
	assert.equal(projected.requestId, "correlation");
	const displayed = formatEntry(agent, { width: 100, toolsExpanded: false }).map(stripVTControlCharacters).join("\n");
	assert.match(displayed, /agent · substrate\/apiKey:key/);
	assert.doesNotMatch(displayed, /you/);
	assert.deepEqual(entryUpdates(agent)[0]!._meta[SHARED_MAIN].agentOrigin, { origin, requestId: "correlation" });
	const read = mainReadEntry({ id: 13, kind: "pi.assistant", model: [{ role: "assistant", content: [{ type: "thinking", thinking: "PRIVATE" }, { type: "toolCall", name: "secret", arguments: { password: "PRIVATE" } }, { type: "text", text: "answer" }] }] } as never);
	assert.equal(JSON.stringify(read).includes("PRIVATE"), false);
	assert.equal(read[0]!.text, "answer");
	assert.deepEqual(mainReadEntry({ kind: "pi.system", model: [{ role: "user", content: "PRIVATE" }] } as never), []);
	const bounded = mainReadEntry({ id: 14, kind: "pi.user", model: [{ role: "user", content: "x".repeat(3000) }] } as never)[0]!;
	assert.equal(bounded.text.length, 2000);
	assert.equal(bounded.truncated, true);
});
