import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { ConfigOverrides } from "./config.ts";
import {
	configEditPath,
	configKeys,
	localConfigPath,
	describeConfig,
	effectiveValue,
	initConfigFile,
	resolveConfig,
	setConfigValue,
	unsetConfigValue,
} from "./config.ts";

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

function overridesFor(configPath: string | undefined): ConfigOverrides {
	return configPath === undefined ? {} : { configPath };
}

function requireArg(value: string | undefined, usage: string): string {
	if (value === undefined || value.trim() === "") throw new Error(`Usage: durable-chat ${usage}`);
	return value;
}

const ENV_FOR_KEY: Record<string, string> = {
	store: "DURABLE_STORE",
	provider: "DURABLE_PROVIDER",
	model: "DURABLE_MODEL_ID",
	baseUrl: "DURABLE_BASE_URL",
	contextWindow: "DURABLE_CONTEXT_WINDOW",
	maxTokens: "DURABLE_MAX_TOKENS",
	streamTimeoutMs: "DURABLE_STREAM_TIMEOUT_MS",
	retries: "DURABLE_RETRIES",
	thinkingLevel: "DURABLE_THINKING_LEVEL",
	maxTurns: "DURABLE_MAX_TURNS",
	jobMaxTurns: "DURABLE_JOB_MAX_TURNS",
	autoContinue: "DURABLE_AUTO_CONTINUE",
	"mcp.enabled": "DURABLE_MCP_ENABLED",
	"mcp.servers": "DURABLE_MCP_SERVERS",
	"mcp.tools": "DURABLE_MCP_TOOLS",
	"mcp.config": "DURABLE_MCP_CONFIG",
};

function warnIfShadowed(key: string): void {
	const name = ENV_FOR_KEY[key];
	if (name !== undefined && process.env[name] !== undefined && process.env[name] !== "") {
		out(`note: ${name} is set and overrides this key for now.`);
	}
}

function warnIfUnresolved(configPath: string | undefined): void {
	try {
		resolveConfig(overridesFor(configPath));
	} catch (error) {
		out(`note: the config does not resolve yet: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * `config` subcommands. `set` and `unset` edit the YAML document in place, so
 * comments and key order survive; every write is type-checked before it lands.
 */
export function runConfigCommand(args: string[], options: { configPath?: string; force?: boolean; local?: boolean } = {}): void {
	const [sub, ...rest] = args;
	const explicit = options.configPath !== undefined || (process.env.DURABLE_CHAT_CONFIG?.trim() ?? "") !== "";
	if (options.local === true && explicit) throw new Error("--local cannot be combined with --config or DURABLE_CHAT_CONFIG.");
	const configPath = options.local === true ? localConfigPath() : configEditPath(options.configPath);
	const local = !explicit && configPath === localConfigPath();
	const overrides = overridesFor(options.configPath);
	switch (sub ?? "show") {
		case "path":
			out(configPath);
			return;
		case "show":
			for (const line of describeConfig(resolveConfig(overrides))) out(line);
			return;
		case "keys":
			for (const key of configKeys()) out(key);
			return;
		case "init": {
			const written = initConfigFile(configPath, { force: options.force === true, local });
			out(`Created ${written}`);
			out("Change one key with `durable-chat config set <key> <value>`, or open it with `durable-chat config edit`.");
			return;
		}
		case "edit": {
			if (!existsSync(configPath)) {
				initConfigFile(configPath, { local });
				out(`Created ${configPath}`);
			}
			const editor = process.env.VISUAL ?? process.env.EDITOR;
			if (editor === undefined || editor.trim() === "") {
				out(`No $VISUAL or $EDITOR set. Edit ${configPath} directly.`);
				return;
			}
			const [command, ...editorArgs] = editor.trim().split(/\s+/);
			const result = spawnSync(command!, [...editorArgs, configPath], { stdio: "inherit" });
			if (result.error !== undefined) throw new Error(`Could not run ${editor}: ${result.error.message}`);
			if (result.status !== 0) {
				process.exitCode = result.status ?? 1;
				return;
			}
			try {
				resolveConfig(overrides);
				out("config valid");
			} catch (error) {
				process.stderr.write(`config error: ${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			}
			return;
		}
		case "get": {
			const key = requireArg(rest[0], "config get <key>");
			out(effectiveValue(resolveConfig(overrides), key));
			return;
		}
		case "set": {
			const key = requireArg(rest[0], "config set <key> <value>");
			const value = requireArg(rest.slice(1).join(" "), "config set <key> <value>");
			const written = setConfigValue(configPath, key, value);
			out(`${written.key} = ${JSON.stringify(written.value)}  (${configPath})`);
			warnIfShadowed(key);
			warnIfUnresolved(options.configPath);
			return;
		}
		case "unset": {
			const key = requireArg(rest[0], "config unset <key>");
			const removed = unsetConfigValue(configPath, key);
			out(removed ? `Removed ${key} from ${configPath}` : `${key} was not set in ${configPath}`);
			warnIfUnresolved(options.configPath);
			return;
		}
		default:
			throw new Error(`Unknown config command "${sub}". Try path, show, keys, init, edit, get, set, or unset.`);
	}
}

export function printConfigHelp(): void {
	out("");
	out("Config commands:");
	out("durable-chat config path            show the active edit target (local if present, otherwise global)");
	out("durable-chat config show            print the effective values");
	out("durable-chat config keys            list editable keys");
	out("durable-chat config init [--local] [--force]  create a config (--local creates folder overrides)");
	out("Add --local to config commands to target .durable-chat/config.yaml; --config selects a standalone file.");
	out("durable-chat config edit            open the file in $VISUAL/$EDITOR");
	out("durable-chat config get <key>       print one effective value");
	out("durable-chat config set <key> <v>   edit one key in place");
	out("durable-chat config unset <key>     remove one key");
}
