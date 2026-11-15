import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { acquireStoreLock, StoreInUseError } from "../src/harness.ts";
import { focusExistingSession } from "../src/existing-session.ts";

const localGhostty = { platform: "darwin" as const, isTTY: true, env: { TERM_PROGRAM: "ghostty" } };

test("store conflicts expose the owner identity without changing the existing lock", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-store-owner-"));
	const store = join(dir, "store.sqlite");
	const release = acquireStoreLock(store);
	t.after(() => { release(); rmSync(dir, { recursive: true, force: true }); });
	const before = readFileSync(`${store}.lock`);
	assert.throws(() => acquireStoreLock(store), (error) => {
		assert.ok(error instanceof StoreInUseError);
		assert.equal(error.pid, process.pid);
		assert.equal(error.storePath, store);
		assert.match(error.message, /already open/);
		return true;
	});
	assert.deepEqual(readFileSync(`${store}.lock`), before);
	assert.equal(existsSync(store), false);
});

test("interactive Ghostty launches focus the owning terminal using PID and TTY as literal script arguments", async (t) => {
	const calls: { command: string; args: string[]; options: { timeout: number; shell?: boolean } }[] = [];
	let focused = 0;
	const app = { running: () => true, terminals: () => [
		{ pid: () => 999, tty: () => "/dev/ttys999", focus: () => assert.fail("must not focus another terminal") },
		{ pid: () => 12345, tty: () => "/dev/ttys042", focus: () => { focused++; } },
	] };
	t.mock.method(childProcess, "execFile", (command: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string) => void) => {
		calls.push({ command, args, options });
		const result = command === "/bin/ps" ? " ttys042\n" : runInNewContext(`${args[3]}\nrun(argv)`, {
			argv: args.slice(4), Application: (id: string) => { assert.equal(id, "com.mitchellh.ghostty"); return app; },
		});
		callback(null, result);
		return {} as never;
	});
	for (const command of [undefined, "tui", "chat"]) assert.equal(await focusExistingSession(12345, { ...localGhostty, command }), true);
	assert.equal(calls.length, 6);
	assert.equal(focused, 3);
	for (let index = 0; index < calls.length; index += 2) {
		assert.equal(calls[index]!.command, "/bin/ps");
		assert.deepEqual(calls[index]!.args, ["-p", "12345", "-o", "tty="]);
		const focus = calls[index + 1]!;
		assert.equal(focus.command, "/usr/bin/osascript");
		assert.deepEqual(focus.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
		assert.deepEqual(focus.args.slice(4), ["12345", "/dev/ttys042"]);
		assert.ok(focus.options.timeout > 0 && focus.options.timeout <= 3000);
		assert.equal(focus.options.shell, undefined);
	}
});

test("Ghostty lookup falls back to the owner TTY and leaves unrelated terminals unfocused", async (t) => {
	let device = "ttys042";
	let running = true;
	let focused = 0;
	const app = { running: () => running, terminals: () => [
		{ pid: () => 999, tty: () => "", focus: () => assert.fail("an unknown owner TTY cannot match another terminal") },
		{ pid: () => { throw new Error("Foreground PID unavailable"); }, tty: () => "/dev/ttys042", focus: () => { focused++; } },
	] };
	t.mock.method(childProcess, "execFile", (command: string, args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
		callback(null, command === "/bin/ps" ? device : runInNewContext(`${args[3]}\nrun(argv)`, { argv: args.slice(4), Application: () => app }));
		return {} as never;
	});
	assert.equal(await focusExistingSession(12345, localGhostty), true);
	assert.equal(focused, 1);
	device = "/dev/ttys042";
	assert.equal(await focusExistingSession(12345, localGhostty), true);
	device = "??";
	assert.equal(await focusExistingSession(12345, localGhostty), false);
	running = false;
	assert.equal(await focusExistingSession(12345, localGhostty), false);
	assert.equal(focused, 2);
});

test("batch commands, remote shells, other terminals and invalid owners never attempt window automation", async (t) => {
	const launch = t.mock.method(childProcess, "execFile", () => { throw new Error("Unexpected automation"); });
	for (const command of ["ask", "task", "tasks", "watch", "state", "info", "config", "help"]) {
		assert.equal(await focusExistingSession(12345, { ...localGhostty, command }), false);
	}
	for (const options of [
		{ ...localGhostty, isTTY: false },
		{ ...localGhostty, platform: "linux" as const },
		{ ...localGhostty, platform: "win32" as const },
		{ ...localGhostty, env: { TERM_PROGRAM: "iTerm.app" } },
		...["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].map((key) => ({ ...localGhostty, env: { TERM_PROGRAM: "ghostty", [key]: "remote" } })),
	]) assert.equal(await focusExistingSession(12345, options), false);
	for (const pid of [0, -1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(await focusExistingSession(pid, localGhostty), false);
	assert.equal(launch.mock.callCount(), 0);
});

test("unavailable terminals, denied Automation permission and timeouts retain the lock-error fallback", async (t) => {
	let result = "not-found\n";
	let failure: Error | undefined;
	let psFailure = false;
	t.mock.method(childProcess, "execFile", (command: string, _args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
		callback(command === "/bin/ps" ? (psFailure ? new Error("Process exited") : null) : failure ?? null,
			command === "/bin/ps" ? "??\n" : result);
		return {} as never;
	});
	assert.equal(await focusExistingSession(12345, localGhostty), false);
	result = "";
	assert.equal(await focusExistingSession(12345, localGhostty), false);
	for (const error of [new Error("Not authorized to send Apple events"), Object.assign(new Error("Timed out"), { code: "ETIMEDOUT" })]) {
		failure = error;
		assert.equal(await focusExistingSession(12345, localGhostty), false);
	}
	psFailure = true;
	assert.equal(await focusExistingSession(12345, localGhostty), false);
});

test("a repeated CLI launch focuses the existing session while failed focus and batch commands keep the original error", { timeout: 20_000 }, (t) => {
	const dir = mkdtempSync(join(tmpdir(), "dchat-existing-cli-"));
	const store = join(dir, "shared store.sqlite");
	const config = join(dir, "config.yaml");
	writeFileSync(config, `provider: faux\ncodemode: false\nstore: ${JSON.stringify(store)}\nmcp:\n  enabled: false\n`);
	const release = acquireStoreLock(store);
	t.after(() => { release(); rmSync(dir, { recursive: true, force: true }); });
	const before = readFileSync(`${store}.lock`);
	const cli = new URL("../src/cli.ts", import.meta.url).href;
	for (const scenario of [
		{ args: [], result: "focused", status: 0, focuses: 1 },
		{ args: ["tui"], result: "not-found", status: 1, focuses: 1 },
		{ args: ["chat"], result: "denied", status: 1, focuses: 1 },
		{ args: ["ask", "hello"], result: "focused", status: 1, focuses: 0 },
		{ args: ["tasks"], result: "focused", status: 1, focuses: 0 },
	]) {
		const trace = join(dir, "trace.json");
		const wrapper = `
			import childProcess from 'node:child_process';
			import {writeFileSync} from 'node:fs';
			Object.defineProperty(process, 'platform', {value:'darwin'});
			Object.defineProperty(process.stdin, 'isTTY', {value:true});
			Object.defineProperty(process.stdout, 'isTTY', {value:true});
			let focuses=0;
			childProcess.execFile=(command,args,options,callback)=>{
				if(command==='/bin/ps')callback(null,'ttys042\\n','');
				else {focuses++;writeFileSync(${JSON.stringify(trace)},JSON.stringify({focuses}));callback(${scenario.result === "denied" ? "new Error('Denied')" : "null"},${JSON.stringify(scenario.result)},'');}
				return {};
			};
			writeFileSync(${JSON.stringify(trace)},JSON.stringify({focuses}));
			process.argv=[process.execPath,${JSON.stringify(fileURLToPath(cli))},'--config',${JSON.stringify(config)},...${JSON.stringify(scenario.args)}];
			await import(${JSON.stringify(cli)});
		`;
		const run = childProcess.spawnSync(process.execPath, ["--input-type=module", "-e", wrapper], {
			encoding: "utf8", timeout: 10_000,
			env: { ...process.env, DURABLE_PROVIDER: "faux", TERM_PROGRAM: "ghostty", SSH_CONNECTION: "", SSH_CLIENT: "", SSH_TTY: "" },
		});
		assert.ifError(run.error);
		assert.equal(run.status, scenario.status, run.stderr);
		assert.equal(JSON.parse(readFileSync(trace, "utf8")).focuses, scenario.focuses);
		if (scenario.status === 0) assert.match(run.stdout, /focused its existing Ghostty terminal/);
		else assert.match(run.stderr, new RegExp(`already open by pid ${process.pid}`));
		assert.deepEqual(readFileSync(`${store}.lock`), before);
		assert.equal(existsSync(store), false, "a conflicting launcher must never open another database connection");
	}
});
