import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { openRuntime } from "../src/harness.ts";
import { Dashboard } from "../src/tui/app.ts";

test("padded dashboard chrome keeps the composer and newest transcript visible and paging uses the reduced viewport", async () => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-layout-"));
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, "provider: faux\nmcp:\n  enabled: false\n");
	const runtime = await openRuntime({ configPath, storePath: join(dir, "store.sqlite"), withMcp: false });
	let rows = 24;
	const dashboard = new Dashboard({ runtime, rows: () => rows, requestRender: () => {}, onQuit: () => {} });
	try {
		await runtime.root.commit(async (tx) => {
			for (let index = 1; index <= 20; index++) {
				await tx.appendEntry(runtime.root.id, { kind: "pi.user", model: [{ role: "user", content: `entry-${index}`, timestamp: 0 }] });
			}
		}, runtime.context);
		await dashboard.start();
		for (const width of [40, 80, 140]) {
			for (rows of [11, 24, 36]) {
				const rendered = dashboard.render(width);
				const plain = rendered.map(stripTerminalSequences);
				assert.equal(rendered.length, rows);
				assert.ok(rendered.every((line) => visibleWidth(line) <= width));
				const composer = plain.findIndex((line) => line.trimStart().startsWith("to main › "));
				assert.ok(composer > 0 && composer < rows - 1);
				assert.equal(plain[composer - 1]?.trim(), "");
				assert.equal(plain[composer + 1]?.trim(), "");
				const targetHeader = plain.findIndex((line) => line.startsWith(" target "));
				assert.ok(targetHeader > 0);
				assert.equal(plain[targetHeader - 1]?.trim(), "");
				assert.equal(plain[1]?.trim(), "");
				assert.match(plain[2]!, /TRANSCRIPT/);
				assert.equal(plain[3]?.replace(/│/g, "").trim(), "");
				assert.match(plain.join("\n"), /entry-20/);
			}
		}
		rows = 16;
		dashboard.render(120);
		dashboard.handleInput("\t");
		dashboard.handleInput("\t");
		dashboard.handleInput("\x1b[5~");
		assert.doesNotMatch(dashboard.render(120).map(stripTerminalSequences).join("\n"), /entry-20/);
		dashboard.handleInput("\x1b[6~");
		assert.match(dashboard.render(120).map(stripTerminalSequences).join("\n"), /entry-20/);
	} finally {
		await dashboard.stop();
		await runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});
