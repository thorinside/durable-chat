import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openRuntime } from "../src/harness.ts";
import { compactionLimit, contextPercent, estimateContextTokens } from "../src/context-usage.ts";

test("the context meter estimates the active request and the compaction limit", async () => {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-context-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({
		storePath: join(dir, "store.sqlite"),
		configPath,
		provider: "faux",
		withMcp: false,
	});
	const before = estimateContextTokens(await runtime.root.context(runtime.context));
	const submission = await runtime.root.submit({ type: "input", content: "hello context meter" }, runtime.context);
	await submission.wait(runtime.context);
	const after = estimateContextTokens(await runtime.root.context(runtime.context));
	assert.ok(after > before);
	assert.equal(compactionLimit(500_000), 500_000 - 16_384);
	assert.equal(contextPercent(250_000, 500_000), 50);
	await runtime.close();
});
