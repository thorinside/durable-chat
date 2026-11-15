import { test } from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { openBrowser } from "../src/tui/browser.ts";

test("activated web links use the platform browser opener with the URL as a literal argument", async (t) => {
	const calls: { command: string; args: string[]; options: object }[] = [];
	t.mock.method(childProcess, "execFile", (command: string, args: string[], options: object, callback: (error: Error | null) => void) => {
		calls.push({ command, args, options });
		callback(null);
		return {} as never;
	});
	const url = "https://example.com/path?query=a&other=$(touch%20unwanted)";
	for (const platform of ["darwin", "linux", "win32"] as const) await openBrowser(url, platform);
	assert.deepEqual(calls.map(({ command, args }) => ({ command, args })), [
		{ command: "open", args: [url] },
		{ command: "xdg-open", args: [url] },
		{ command: "rundll32.exe", args: ["url.dll,FileProtocolHandler", url] },
	]);
	assert.ok(calls.every(({ options }) => !("shell" in options)));
});

test("transcript link activation rejects executable and local-file schemes before starting a process", async (t) => {
	const launch = t.mock.method(childProcess, "execFile", () => { throw new Error("Unexpected process launch"); });
	for (const url of ["javascript:alert(1)", "file:///private/file", "data:text/html,hello", "not a URL", "https://example.com/\nunsafe"]) {
		await assert.rejects(openBrowser(url));
	}
	assert.equal(launch.mock.callCount(), 0);
});

test("browser launcher failures remain observable to the UI", async (t) => {
	const failure = new Error("Browser launcher unavailable");
	t.mock.method(childProcess, "execFile", (_command: string, _args: string[], _options: object, callback: (error: Error) => void) => {
		callback(failure);
		return {} as never;
	});
	await assert.rejects(openBrowser("https://example.com/"), (error) => error === failure);
});
