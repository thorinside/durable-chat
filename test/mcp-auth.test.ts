import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { connectMcp } from "../src/mcp.ts";

// Runtime tests disable MCP, so exercise config-to-transport wiring here without any real credentials or network.
function fixture(t: TestContext, entry: unknown, failure?: (headers: Record<string, string>) => Error) {
	const dir = mkdtempSync(join(tmpdir(), "durable-chat-mcp-auth-"));
	const previousCwd = process.cwd();
	const previousEnv = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DCHAT_TEST_MCP_TOKEN: process.env.DCHAT_TEST_MCP_TOKEN, DCHAT_TEST_MCP_TOKEN_MISSING: process.env.DCHAT_TEST_MCP_TOKEN_MISSING };
	t.after(() => {
		process.chdir(previousCwd);
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	});
	process.env.HOME = dir;
	process.env.USERPROFILE = dir;
	process.env.DCHAT_TEST_MCP_TOKEN = "synthetic-env-token";
	delete process.env.DCHAT_TEST_MCP_TOKEN_MISSING;
	process.chdir(dir);
	const configPath = join(dir, ".pi", "agent", "mcp.json");
	mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ mcpServers: { fixture: entry } }));
	const transports: StreamableHttpTransport[] = [];
	t.mock.method(McpClient.prototype, "connect", async (transport: StreamableHttpTransport) => {
		assert.ok(transport instanceof StreamableHttpTransport);
		transports.push(transport);
		if (failure) throw failure(transport.options.headers ?? {});
	});
	t.mock.method(McpClient.prototype, "listTools", async () => []);
	t.mock.method(McpClient.prototype, "close", async () => {});
	t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected live network request"); });
	return {
		configPath,
		transports,
		async connect() {
			const setup = await connectMcp({ configPath, servers: ["fixture"] });
			t.after(() => setup.close());
			return setup;
		},
	};
}

const url = "https://mcp.example.invalid/mcp";

test("MCP bearer auth maps a literal bearerToken to the HTTP transport Authorization header", async (t) => {
	const f = fixture(t, { url, auth: "bearer", bearerToken: "synthetic-literal-token", headers: { "X-Fixture": "kept" } });
	const setup = await f.connect();
	assert.deepEqual(setup.notes, []);
	assert.equal(f.transports[0]!.url.href, url);
	assert.deepEqual(f.transports[0]!.options.headers, { "X-Fixture": "kept", Authorization: "Bearer synthetic-literal-token" });
});

test("MCP headers-only bearer auth still reaches the HTTP transport with environment expansion", async (t) => {
	const f = fixture(t, { url, headers: { Authorization: "Bearer ${DCHAT_TEST_MCP_TOKEN}", "X-Fixture": "kept" } });
	assert.deepEqual((await f.connect()).notes, []);
	assert.deepEqual(f.transports[0]!.options.headers, { Authorization: "Bearer synthetic-env-token", "X-Fixture": "kept" });
});

test("MCP bearerToken expands environment references before creating the Authorization header", async (t) => {
	const f = fixture(t, { url, auth: "bearer", bearerToken: "${DCHAT_TEST_MCP_TOKEN}" });
	assert.deepEqual((await f.connect()).notes, []);
	assert.equal(f.transports[0]!.options.headers?.Authorization, "Bearer synthetic-env-token");
});

test("explicit MCP Authorization headers take precedence over bearerToken regardless of header-name casing", async (t) => {
	for (const name of ["Authorization", "authorization", "aUtHoRiZaTiOn"]) {
		await t.test(name, async (t) => {
			const f = fixture(t, { url, auth: "bearer", bearerToken: "synthetic-ignored-token", headers: { [name]: "Bearer synthetic-explicit-token", "X-Fixture": "kept" } });
			assert.deepEqual((await f.connect()).notes, []);
			assert.deepEqual(f.transports[0]!.options.headers, { [name]: "Bearer synthetic-explicit-token", "X-Fixture": "kept" });
			assert.equal(new Headers(f.transports[0]!.options.headers).get("authorization"), "Bearer synthetic-explicit-token");
		});
	}
});

test("explicit empty MCP Authorization is preserved without consulting an absent bearerToken", async (t) => {
	const f = fixture(t, { url, auth: "bearer", headers: { authorization: "" } });
	assert.deepEqual((await f.connect()).notes, []);
	assert.deepEqual(f.transports[0]!.options.headers, { authorization: "" });
});

test("missing, empty, malformed or unresolved MCP bearer tokens fail before transport connection without exposing values", async (t) => {
	for (const token of [undefined, null, 42, {}, "", "  ", "synthetic-token\r\ninjected", "${DCHAT_TEST_MCP_TOKEN_MISSING}"]) {
		await t.test(`token shape ${typeof token}: ${token === undefined ? "missing" : "invalid"}`, async (t) => {
			const f = fixture(t, { url, auth: "bearer", bearerToken: token });
			const setup = await f.connect();
			assert.equal(f.transports.length, 0);
			assert.match(setup.notes.join("\n"), /MCP bearer auth requires a non-empty bearerToken/);
			assert.doesNotMatch(setup.notes.join("\n"), /synthetic-token|injected|DCHAT_TEST_MCP_TOKEN_MISSING/);
		});
	}
});

test("MCP entries without bearer auth retain unauthenticated headers and ignore orphan bearerToken fields", async (t) => {
	const f = fixture(t, { url, bearerToken: "synthetic-unused-token", headers: { "X-Fixture": "kept" } });
	assert.deepEqual((await f.connect()).notes, []);
	assert.deepEqual(f.transports[0]!.options.headers, { "X-Fixture": "kept" });
});

test("malformed MCP header values fail safely instead of leaking credentials through header validation errors", async (t) => {
	for (const headers of [null, [], { Authorization: 42 }, { Authorization: "Bearer synthetic-header\r\ninjected" }]) {
		await t.test(`headers shape ${headers === null ? "null" : Array.isArray(headers) ? "array" : typeof headers.Authorization}`, async (t) => {
			const f = fixture(t, { url, headers });
			const setup = await f.connect();
			assert.equal(f.transports.length, 0);
			assert.match(setup.notes.join("\n"), /MCP headers/);
			assert.doesNotMatch(setup.notes.join("\n"), /synthetic-header|injected/);
		});
	}
});

test("MCP connection failure notes redact both configured bearer tokens and explicit headers echoed by the transport", async (t) => {
	const f = fixture(t, { url, auth: "bearer", bearerToken: "synthetic-ignored-token", headers: { Authorization: "Bearer synthetic-explicit-token" } },
		(headers) => new Error(`rejected ${headers.Authorization} and synthetic-ignored-token; echoed token synthetic-explicit-token`));
	const setup = await f.connect();
	assert.match(setup.notes.join("\n"), /failed to connect: rejected \[redacted\] and \[redacted\]; echoed token \[redacted\]/);
	assert.doesNotMatch(setup.notes.join("\n"), /synthetic-/);
});

test("malformed MCP JSON and server entries produce safe unavailable notes without attempting transport connection", async (t) => {
	for (const text of [
		'{"mcpServers":{"fixture":{"bearerToken":"synthetic-private-value" BROKEN',
		'{"mcpServers":[]}',
		'{"mcpServers":{"fixture":null}}',
	]) {
		await t.test("invalid config shape or JSON", async (t) => {
			const f = fixture(t, {});
			writeFileSync(f.configPath, text);
			const setup = await f.connect();
			assert.equal(f.transports.length, 0);
			assert.match(setup.notes.join("\n"), /invalid or unreadable MCP config|must be an object/);
			assert.doesNotMatch(setup.notes.join("\n"), /synthetic-private-value/);
		});
	}
});

test("unsupported MCP auth types fail safely unless an explicit Authorization header provides authentication", async (t) => {
	for (const auth of [42, null, {}, { provider: "synthetic-provider" }, "basic"]) {
		await t.test(`auth shape ${typeof auth}`, async (t) => {
			const f = fixture(t, { url, auth });
			assert.match((await f.connect()).notes.join("\n"), /MCP auth must be "bearer"/);
			assert.equal(f.transports.length, 0);
		});
	}
	await t.test("explicit headers do not require a supported auth shorthand", async (t) => {
		const f = fixture(t, { url, auth: { provider: "synthetic-provider" }, headers: { authorization: "Bearer synthetic-header-token" } });
		assert.deepEqual((await f.connect()).notes, []);
		assert.deepEqual(f.transports[0]!.options.headers, { authorization: "Bearer synthetic-header-token" });
	});
});
