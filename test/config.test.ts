import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	configEditPath,
	configTemplate,
	initConfigFile,
	resolveConfig,
	setConfigValue,
	unsetConfigValue,
} from "../src/config.ts";

const EMPTY_ENV: NodeJS.ProcessEnv = {};

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "durable-chat-config-"));
}

function withWorkspace(run: (paths: { globalPath: string; localPath: string; env: NodeJS.ProcessEnv }) => void): void {
	const dir = realpathSync(tempDir());
	const cwd = join(dir, "project");
	const globalPath = join(dir, "xdg/durable-chat/config.yaml");
	const localPath = join(cwd, ".durable-chat/config.yaml");
	mkdirSync(join(dir, "xdg/durable-chat"), { recursive: true });
	mkdirSync(join(cwd, ".durable-chat"), { recursive: true });
	const previous = process.cwd();
	try {
		process.chdir(cwd);
		run({ globalPath, localPath, env: { XDG_CONFIG_HOME: join(dir, "xdg") } });
	} finally {
		process.chdir(previous);
		rmSync(dir, { recursive: true, force: true });
	}
}

const CLI_PATH = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

function configCommand(env: NodeJS.ProcessEnv, ...args: string[]) {
	// Exercise the real CLI without inheriting this machine's config or provider overrides.
	const result = spawnSync(process.execPath, [CLI_PATH, "config", ...args], { env, encoding: "utf8", timeout: 15_000 });
	assert.ifError(result.error);
	return result;
}

test("the default config file selects local inference and resolves its paths", () => {
	const configPath = join(tempDir(), "config.yaml");
	writeFileSync(configPath, configTemplate());
	const config = resolveConfig({ configPath }, EMPTY_ENV);
	assert.equal(config.provider, "local");
	assert.equal(config.model, "nemotron-bolt");
	assert.equal(config.baseUrl, "http://dev.local:1234/v1");
	assert.equal(config.contextWindow, 262144);
	assert.equal(config.maxTokens, 32768);
	assert.equal(config.streamTimeoutMs, 600000);
	assert.equal(config.autoContinue, true);
	assert.equal(config.storePath, join(homedir(), ".local/share/durable-chat/store.sqlite"));
	assert.deepEqual(config.mcp.servers, ["substrate"]);
	assert.equal(config.mcp.configPath, join(homedir(), ".pi/agent/mcp.json"));
});

test("CLI overrides beat environment variables, which beat the config file", () => {
	const configPath = join(tempDir(), "config.yaml");
	writeFileSync(configPath, [
		"provider: local",
		"model: config-model",
		"baseUrl: http://config.example/v1",
		"maxTurns: 7",
		"store: ./config-store.sqlite",
	].join("\n"));
	const env: NodeJS.ProcessEnv = { DURABLE_MODEL_ID: "env-model", DURABLE_MAX_TURNS: "9" };

	const fromFile = resolveConfig({ configPath }, env);
	assert.equal(fromFile.model, "env-model");
	assert.equal(fromFile.maxTurns, 9);
	assert.equal(fromFile.provider, "local");

	const overridden = resolveConfig({ configPath, model: "cli-model", provider: "faux", store: "./cli-store.sqlite" }, env);
	assert.equal(overridden.model, "cli-model");
	assert.equal(overridden.provider, "faux");
	assert.equal(overridden.storePath, join(process.cwd(), "cli-store.sqlite"));
});

test("config set edits one key in place, preserves comments, and rejects a bad value", () => {
	const dir = tempDir();
	const configPath = join(dir, "config.yaml");
	writeFileSync(configPath, `# keep this comment\nprovider: faux\nmaxTurns: 12\n`);
	setConfigValue(configPath, "maxTurns", "20");
	assert.match(readFileSync(configPath, "utf8"), /# keep this comment/);
	assert.equal(resolveConfig({ configPath }, EMPTY_ENV).maxTurns, 20);

	const before = readFileSync(configPath, "utf8");
	assert.throws(() => setConfigValue(configPath, "maxTurns", "many"), /maxTurns must be a positive number/);
	assert.equal(readFileSync(configPath, "utf8"), before);
	assert.throws(() => setConfigValue(configPath, "nope", "1"), /Unknown config key/);
});

test("config unset removes a key and init refuses to clobber an existing file", () => {
	const dir = tempDir();
	const configPath = join(dir, "config.yaml");
	initConfigFile(configPath);
	assert.throws(() => initConfigFile(configPath), /already exists/);
	assert.equal(resolveConfig({ configPath }, EMPTY_ENV).jobMaxTurns, 120);
	unsetConfigValue(configPath, "jobMaxTurns");
	assert.doesNotMatch(readFileSync(configPath, "utf8"), /jobMaxTurns/);
	assert.equal(resolveConfig({ configPath }, EMPTY_ENV).jobMaxTurns, 120);
});

test("the openai-codex provider defaults to a Codex subscription model", () => {
	const configPath = join(tempDir(), "config.yaml");
	writeFileSync(configPath, "");
	const config = resolveConfig({ provider: "openai-codex", configPath }, EMPTY_ENV);
	assert.equal(config.provider, "openai-codex");
	assert.equal(config.model, "gpt-6.1-sol");
	assert.equal(config.thinkingLevel, "medium");
	assert.equal(config.autoContinue, true);
});

test("codemode is on by default and the environment overrides the file", () => {
	// The default decides whether main and jobs get scripts at all, so it needs its own check.
	const configPath = join(tempDir(), "config.yaml");
	writeFileSync(configPath, "");
	assert.equal(resolveConfig({ configPath }, EMPTY_ENV).codemode, true);
	writeFileSync(configPath, "codemode: false\n");
	assert.equal(resolveConfig({ configPath }, EMPTY_ENV).codemode, false);
	assert.equal(resolveConfig({ configPath }, { DURABLE_CODEMODE: "true" }).codemode, true);
});

test("folder overrides inherit unspecified global values and merge MCP keys while replacing lists", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, [
			"provider: local", "model: global-model", "baseUrl: http://global.example/v1", "maxTurns: 12",
			"store: /shared/store.sqlite", "mcp:", "  enabled: true", "  servers: [substrate]",
			"  tools: [global-tool]", "  config: ./servers.json",
		].join("\n"));
		writeFileSync(localPath, [
			"model: project-model", "store: .durable-chat/store.sqlite", "autoContinue: false",
			"mcp:", "  enabled: false", "  servers: [nt_helper]", "  tools: []",
		].join("\n"));
		const config = resolveConfig({}, env);
		assert.equal(config.provider, "local");
		assert.equal(config.model, "project-model");
		assert.equal(config.baseUrl, "http://global.example/v1");
		assert.equal(config.maxTurns, 12);
		assert.equal(config.autoContinue, false);
		assert.equal(config.storePath, join(process.cwd(), ".durable-chat/store.sqlite"));
		assert.deepEqual(config.mcp, {
			enabled: false, servers: ["nt_helper"], tools: [], configPath: join(process.cwd(), "servers.json"),
		});
		assert.deepEqual(config.configPaths, [globalPath, localPath]);
		assert.equal(config.configPath, localPath);
		assert.equal(configEditPath(undefined, env), localPath);
	});
});

test("environment and CLI overrides retain priority over folder-local values", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, "provider: faux\nmodel: global-model\nmaxTurns: 12\n");
		writeFileSync(localPath, "model: local-model\nmaxTurns: 24\nstore: local.sqlite\nmcp:\n  enabled: true\n");
		const overriddenEnv = { ...env, DURABLE_MODEL_ID: "env-model", DURABLE_MAX_TURNS: "36", DURABLE_STORE: "env.sqlite", DURABLE_MCP_ENABLED: "false" };
		const fromEnv = resolveConfig({}, overriddenEnv);
		assert.equal(fromEnv.model, "env-model");
		assert.equal(fromEnv.maxTurns, 36);
		assert.equal(fromEnv.storePath, join(process.cwd(), "env.sqlite"));
		assert.equal(fromEnv.mcp.enabled, false);
		const fromCli = resolveConfig({ model: "cli-model", store: "cli.sqlite", noMcp: true }, { ...overriddenEnv, DURABLE_MCP_ENABLED: "true" });
		assert.equal(fromCli.model, "cli-model");
		assert.equal(fromCli.storePath, join(process.cwd(), "cli.sqlite"));
		assert.equal(fromCli.mcp.enabled, false);
	});
});

test("a local directory or empty override file does not change global settings or storage", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, "provider: faux\nmaxTurns: 17\nstore: /shared/store.sqlite\n");
		const before = resolveConfig({}, env);
		assert.equal(before.configPath, globalPath);
		assert.equal(configEditPath(undefined, env), globalPath);
		writeFileSync(localPath, "# Inherit everything\n");
		const after = resolveConfig({}, env);
		assert.equal(after.provider, before.provider);
		assert.equal(after.maxTurns, before.maxTurns);
		assert.equal(after.storePath, before.storePath);
		assert.deepEqual(after.mcp, before.mcp);
	});
});

test("folder overrides work without a global config and resolve fallback storage in the launch folder", () => {
	withWorkspace(({ localPath, env }) => {
		const builtin = resolveConfig({}, env);
		assert.equal(builtin.configFound, false);
		assert.deepEqual(builtin.configPaths, []);
		assert.equal(builtin.storePath, join(process.cwd(), ".durable-chat/store.sqlite"));
		writeFileSync(localPath, "maxTurns: 23\n");
		const config = resolveConfig({}, env);
		assert.equal(config.configFound, true);
		assert.equal(config.maxTurns, 23);
		assert.deepEqual(config.configPaths, [localPath]);
	});
});

test("local discovery accepts yml, prefers yaml, and does not inherit parent-folder overrides", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, "maxTurns: 11\n");
		const alternate = localPath.replace(/\.yaml$/, ".yml");
		writeFileSync(alternate, "maxTurns: 22\n");
		assert.equal(resolveConfig({}, env).maxTurns, 22);
		assert.equal(configEditPath(undefined, env), alternate);
		writeFileSync(localPath, "maxTurns: 33\n");
		assert.equal(resolveConfig({}, env).maxTurns, 33);
		assert.equal(configEditPath(undefined, env), localPath);
		mkdirSync("child");
		process.chdir("child");
		assert.equal(resolveConfig({}, env).maxTurns, 11);
		assert.equal(configEditPath(undefined, env), globalPath);
	});
});

test("invalid local overrides fail with their source path but remain selectable for repair", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, "maxTurns: 11\n");
		for (const invalid of ["maxTurns: many\n", "mcp: [\n"]) {
			writeFileSync(localPath, invalid);
			assert.throws(() => resolveConfig({}, env), (error: Error) => error.message.includes(localPath));
			assert.equal(configEditPath(undefined, env), localPath);
		}
		writeFileSync(localPath, "unknownLocalKey: true\n");
		assert.ok(resolveConfig({}, env).warnings.some((warning) => warning.includes(localPath) && warning.includes("unknownLocalKey")));
	});
});

test("explicit config selectors stay standalone and bypass automatic global and local files", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, "maxTurns: 11\nstore: /shared/store.sqlite\n");
		writeFileSync(localPath, "maxTurns: invalid\n");
		const selected = join(process.cwd(), "selected.yaml");
		writeFileSync(selected, "maxTurns: 44\n");
		for (const config of [resolveConfig({ configPath: selected }, env), resolveConfig({}, { ...env, DURABLE_CHAT_CONFIG: selected })]) {
			assert.equal(config.maxTurns, 44);
			assert.equal(config.storePath, join(process.cwd(), ".durable-chat/store.sqlite"));
			assert.deepEqual(config.configPaths, [selected]);
			assert.equal(config.explicitConfigPath, selected);
		}
		assert.equal(configEditPath(undefined, { ...env, DURABLE_CHAT_CONFIG: selected }), selected);
		assert.throws(() => resolveConfig({ configPath: "missing.yaml" }, env), /Config file not found/);
	});
});

test("config CLI creates partial local overrides and edits or unsets them without modifying global defaults", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		const globalText = "provider: faux\nmaxTurns: 11\nstore: /shared/store.sqlite\n";
		writeFileSync(globalPath, globalText);
		assert.equal(configCommand(env, "init", "--local").status, 0);
		assert.deepEqual(parseYaml(readFileSync(localPath, "utf8")), {});
		assert.equal(configCommand(env, "init", "--local").status, 1);
		assert.equal(configCommand(env, "get", "maxTurns").stdout.trim(), "11");
		assert.equal(configCommand(env, "set", "maxTurns", "25").status, 0);
		assert.equal(configCommand(env, "get", "maxTurns").stdout.trim(), "25");
		assert.equal(configCommand(env, "path").stdout.trim(), localPath);
		assert.equal(configCommand(env, "unset", "maxTurns").status, 0);
		assert.equal(configCommand(env, "get", "maxTurns").stdout.trim(), "11");
		assert.equal(configCommand(env, "set", "store", ".durable-chat/store.sqlite", "--local").status, 0);
		assert.equal(configCommand(env, "get", "store").stdout.trim(), join(process.cwd(), ".durable-chat/store.sqlite"));
		assert.equal(configCommand(env, "init", "--local", "--force").status, 0);
		assert.equal(configCommand(env, "get", "store").stdout.trim(), "/shared/store.sqlite");
		assert.equal(readFileSync(globalPath, "utf8"), globalText);
	});
});

test("config CLI can create a local override directly but rejects conflicting explicit selectors", () => {
	withWorkspace(({ globalPath, localPath, env }) => {
		writeFileSync(globalPath, "maxTurns: 11\n");
		assert.equal(configCommand(env, "set", "maxTurns", "25", "--local").status, 0);
		assert.equal(resolveConfig({}, env).maxTurns, 25);
		rmSync(localPath);
		for (const result of [
			configCommand(env, "init", "--local", "--config", globalPath),
			configCommand({ ...env, DURABLE_CHAT_CONFIG: globalPath }, "init", "--local"),
		]) {
			assert.equal(result.status, 1);
			assert.match(result.stderr, /--local cannot be combined/);
		}
		assert.equal(existsSync(localPath), false);
		assert.equal(readFileSync(globalPath, "utf8"), "maxTurns: 11\n");
	});
});
