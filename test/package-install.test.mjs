import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// Source CLI tests cannot catch Node refusing TypeScript under node_modules,
// npm excluding build output, or missing executable aliases/license notices.
test("the published archive installs built JavaScript and both binaries run durable offline jobs without exposing local state", { timeout: 120_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-package-"));
	try {
		const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("DURABLE_") && !["NODE_OPTIONS", "OPENAI_API_KEY"].includes(key)));
		Object.assign(env, {
			HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: join(dir, "config"),
			XDG_DATA_HOME: join(dir, "data"), npm_config_cache: join(dir, "npm-cache"),
			npm_config_userconfig: join(dir, "empty-npmrc"), npm_config_logs_max: "0",
			npm_config_registry: "https://registry.npmjs.org",
		});
		writeFileSync(env.npm_config_userconfig, "");
		const run = (command, args, cwd = dir) => execFileSync(command, args, {
			cwd, env, encoding: "utf8", timeout: 90_000, stdio: ["ignore", "pipe", "pipe"],
		});
		const result = JSON.parse(run(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", dir], root));
		const pack = (Array.isArray(result) ? result : Object.values(result))[0];
		const paths = pack.files.map((file) => file.path);
		for (const required of ["dist/cli.js", "dist/harness.js", "dist/tui/main.js", "LICENSE", "LICENSES/pi-MIT.txt", "LICENSES/mcp-sdk-MIT.txt", "LICENSES/typebox-MIT.txt", "LICENSES/yaml-ISC.txt", "THIRD_PARTY_NOTICES.md", "README.md", "package.json"]) {
			assert.ok(paths.includes(required), `Missing package content: ${required}`);
		}
		for (const path of paths) {
			assert.match(path, /^(dist\/[a-z/-]+\.js|LICENSE|LICENSES\/[a-zA-Z-]+\.txt|THIRD_PARTY_NOTICES\.md|README\.md|package\.json)$/);
		}
		writeFileSync(join(dir, "package.json"), '{"private":true}\n');
		run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", join(dir, pack.filename)]);
		const installed = join(dir, "node_modules", "durable-chat");
		const metadata = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
		assert.deepEqual(metadata.bin, { dchat: "./dist/cli.js", "durable-chat": "./dist/cli.js" });
		assert.equal(metadata.license, "MIT");
		assert.ok(!existsSync(join(installed, "src")));
		assert.ok(!existsSync(join(installed, "node_modules", "typescript")));
		assert.match(readFileSync(join(installed, "LICENSES", "pi-MIT.txt"), "utf8"), /Copyright \(c\) 2025 Mario Zechner/);
		const bin = (name) => join(dir, "node_modules", ".bin", name);
		for (const name of ["dchat", "durable-chat"]) assert.match(run(bin(name), ["help"]), /durable-chat/);
		assert.match(run(npm, ["start", "--", "help"], installed), /durable-chat/);
		const config = join(dir, "offline.yaml");
		const store = join(dir, "smoke.sqlite");
		writeFileSync(config, "provider: faux\nautoContinue: false\ncodemode: true\nmcp:\n  enabled: false\n");
		const args = ["--config", config, "--store", store, "--no-mcp"];
		assert.match(run(bin("dchat"), [...args, "ask", "task: release package smoke", "--wait"]), /Task created/);
		const jobs = run(bin("durable-chat"), [...args, "tasks"]);
		assert.match(jobs, /completed/);
		assert.match(jobs, /release package smoke/);
		// Source tests cannot detect a missing built host module or manifest-relative version lookup.
		const sessions = join(env.XDG_DATA_HOME, "durable-chat", "acp");
		const host = spawn(bin("dchat"), ["acp", "serve"], { cwd: dir, env: { ...env, DURABLE_CHAT_CONFIG: config }, stdio: ["pipe", "pipe", "pipe"] });
		const exited = once(host, "exit");
		const frames = [];
		const pending = new Map();
		let diagnostics = "";
		host.stderr.on("data", (value) => { diagnostics += value; });
		const lines = createInterface({ input: host.stdout });
		lines.on("line", (line) => {
			const frame = JSON.parse(line);
			assert.equal(frame.jsonrpc, "2.0");
			frames.push(frame);
			pending.get(frame.id)?.(frame);
		});
		let next = 0;
		const request = (method, params) => new Promise((resolve, reject) => {
			const id = ++next;
			// Deadline for an actual installed CLI event, not a model pacing sleep.
			const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Installed ACP deadline: ${diagnostics}`)); }, 15_000);
			pending.set(id, (frame) => { clearTimeout(timeout); pending.delete(id); frame.error ? reject(new Error(frame.error.message)) : resolve(frame.result); });
			host.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
		try {
			assert.equal((await request("initialize", { protocolVersion: 1 })).agentInfo.version, metadata.version);
			const { sessionId } = await request("session/new", { cwd: dir, mcpServers: [] });
			assert.equal((await request("session/prompt", { sessionId, prompt: [{ type: "text", text: "installed ACP host smoke" }] })).stopReason, "end_turn");
			assert.equal((await request("session/list", {})).sessions[0].sessionId, sessionId);
			assert.ok(frames.some((frame) => frame.params?.update?.sessionUpdate === "agent_message_chunk"));
			host.stdin.end();
			assert.deepEqual(await exited, [0, null], diagnostics);
			assert.equal(existsSync(join(sessions, sessionId, "state.sqlite.lock")), false);
		} finally {
			if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
			await exited;
			lines.close();
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
