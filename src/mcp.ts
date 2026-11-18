import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
type JsonObject = Record<string, unknown>;
import type { Schema } from "@earendil-works/pi-schema";
import { int, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { CallToolResult, Tool as McpTool } from "@earendil-works/pi-mcp";

export type McpServerEntry = {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	timeout?: number;
	description?: string;
};

type McpConfigFile = { mcpServers?: Record<string, McpServerEntry> };

export const DEFAULT_MCP_CONFIG = resolve(homedir(), ".pi/agent/mcp.json");

function expand(value: string): string {
	return value
		.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? "")
		.replace(/^~(?=$|\/)/, homedir());
}

function readConfig(path: string, notes: string[]): Record<string, McpServerEntry> {
	if (!existsSync(path)) {
		notes.push(`no MCP config at ${path}`);
		return {};
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as McpConfigFile;
		return parsed.mcpServers ?? {};
	} catch (error) {
		notes.push(`could not read ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return {};
	}
}

/** Read user and project MCP config; a project entry replaces a user entry of the same name. */
export function readMcpServers(configPath: string | undefined, notes: string[], cwd = process.cwd()): Record<string, McpServerEntry> {
	const primary = configPath ?? process.env.DURABLE_MCP_CONFIG ?? DEFAULT_MCP_CONFIG;
	const servers: Record<string, McpServerEntry> = {};
	Object.assign(servers, readConfig(resolve(homedir(), ".pi/agent/mcp.json"), notes));
	const projectPath = resolve(cwd, ".pi/mcp.json");
	if (projectPath !== resolve(primary)) Object.assign(servers, readConfig(projectPath, []));
	if (resolve(primary) !== resolve(homedir(), ".pi/agent/mcp.json") && resolve(primary) !== projectPath) {
		Object.assign(servers, readConfig(primary, notes));
	}
	return servers;
}

async function connect(name: string, entry: McpServerEntry, notes: string[], cwd: string, literal: boolean): Promise<McpClient | undefined> {
	const value = literal ? (text: string) => text : expand;
	const requestTimeoutMs = (entry.timeout ?? 60) * 1000;
	const client = new McpClient({ name: "durable-chat", version: "0.1.0", requestTimeoutMs });
	try {
		if (entry.url !== undefined) {
			const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([key, value]) => [key, expand(value)]));
			await client.connect(new StreamableHttpTransport({ url: expand(entry.url), headers }));
		} else if (entry.command !== undefined) {
			const expandedCwd = entry.cwd === undefined ? cwd : value(entry.cwd);
			const childCwd = resolve(cwd, expandedCwd);
			await client.connect(new StdioTransport({
				command: value(entry.command),
				args: (entry.args ?? []).map(value),
				cwd: childCwd,
				env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, text]) => [key, value(text)])),
				inheritEnv: true,
				stderr: "pipe",
				onStderr: (chunk) => {
					const text = chunk.trim();
					if (text.length > 0 && !literal) notes.push(`[${name}] ${text.slice(0, 300)}`);
				},
			}));
		} else {
			notes.push(`MCP server ${name} has no url or command`);
			return undefined;
		}
		return client;
	} catch (error) {
		notes.push(literal ? "Session MCP connection failed" : `MCP server ${name} failed to connect: ${error instanceof Error ? error.message : String(error)}`);
		await client.close().catch(() => undefined);
		return undefined;
	}
}

function llmOutput(result: CallToolResult) {
	const blocks = toLlmContent(result).map((block) => block.type === "text"
		? { type: "text" as const, text: block.text }
		: { type: "image" as const, data: block.data, mimeType: block.mimeType });
	return blocks.length > 0 ? blocks : [{ type: "text" as const, text: JSON.stringify(result.structuredContent ?? null) }];
}

function errorText(error: unknown, redact = false): string {
	return redact ? "MCP operation failed (details redacted)" : error instanceof Error ? error.message : String(error);
}

function serverToolName(toolName: string): string {
	return `mcp__${toolName.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Three tools that cover the whole Substrate surface without offering 249 separate schemas. */
function substrateGateway(client: McpClient, timeoutMs: number, redact = false): ToolRegistration[] {
	const call = async (name: string, args: JsonObject) => client.callTool(name, args, { timeoutMs });
	const search = defineTool({
		name: "substrate_search",
		description: "Search the Substrate MCP tool catalog. Start here when you need Substrate state or an operation.",
		parameters: obj({ query: str({ minLength: 1 }), limit: opt(int({ minimum: 1, maximum: 50 })) }),
		replay: "safe",
		execute: async (args) => {
			try {
				const result = await call("search_tool", { query: args.query, limit: args.limit ?? 12 });
				return { output: llmOutput(result), ...(result.isError === true ? { isError: true } : {}) };
			} catch (error) {
				return { output: [{ type: "text" as const, text: `Substrate search failed: ${errorText(error, redact)}` }], isError: true };
			}
		},
	});
	const describe = defineTool({
		name: "substrate_describe",
		description: "Return the input schema and description of one Substrate MCP tool by exact name.",
		parameters: obj({ name: str({ minLength: 1 }) }),
		replay: "safe",
		execute: async (args) => {
			try {
				const result = await call("get_tool", { name: args.name });
				return { output: llmOutput(result), ...(result.isError === true ? { isError: true } : {}) };
			} catch (error) {
				return { output: [{ type: "text" as const, text: `Substrate describe failed: ${errorText(error, redact)}` }], isError: true };
			}
		},
	});
	const invoke = defineTool({
		name: "substrate_call",
		description: "Invoke one Substrate MCP tool by exact name with a JSON args object. Describe it first.",
		parameters: obj({ name: str({ minLength: 1 }), args: opt(map(unknown())) }),
		replay: "unsafe",
		execute: async (args) => {
			try {
				const result = await call(args.name, (args.args ?? {}) as JsonObject);
				return { output: llmOutput(result), ...(result.isError === true ? { isError: true } : {}) };
			} catch (error) {
				return { output: [{ type: "text" as const, text: `Substrate call failed: ${errorText(error, redact)}` }], isError: true };
			}
		},
	});
	return [search, describe, invoke];
}

function directTools(client: McpClient, server: string, tools: readonly McpTool[], timeoutMs: number, redact = false): ToolRegistration[] {
	return tools.map((tool) => defineTool({
		name: serverToolName(`${server}__${tool.name}`),
		description: tool.description ?? `${server} MCP tool ${tool.name}`,
		parameters: tool.inputSchema as unknown as Schema,
		replay: "unsafe",
		execute: async (args) => {
			try {
				const result = await client.callTool(tool.name, args as JsonObject, { timeoutMs });
				return { output: llmOutput(result), ...(result.isError === true ? { isError: true } : {}) };
			} catch (error) {
				return { output: [{ type: "text" as const, text: `${server}/${tool.name} failed: ${errorText(error, redact)}` }], isError: true };
			}
		},
	}));
}

export type McpSetup = {
	extensions: Extension[];
	notes: string[];
	close(): Promise<void>;
};

/**
 * Connect the selected MCP servers per runtime and expose them as extensions.
 * Substrate gets a three-tool gateway; other servers expose selected tools directly.
 */
export async function connectMcp(options: {
	configPath?: string;
	servers?: string[];
	tools?: string[];
	verbose?: boolean;
	cwd?: string;
	/** Literal, session-owned ACP entries: no discovery, expansion or implicit server selection. */
	entries?: Record<string, McpServerEntry>;
	redactErrors?: boolean;
} = {}): Promise<McpSetup> {
	const notes: string[] = [];
	const servers = options.entries === undefined ? options.servers ?? (process.env.DURABLE_MCP_SERVERS ?? "substrate").split(",").map((name) => name.trim()).filter(Boolean) : Object.keys(options.entries);
	const wantedTools = options.tools ?? (process.env.DURABLE_MCP_TOOLS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
	const configured = options.entries ?? readMcpServers(options.configPath, notes, options.cwd);
	const clients: McpClient[] = [];
	const extensions: Extension[] = [];

	try {
		for (const name of servers) {
			const entry = configured[name];
			const extensionName = `durable-chat.mcp.${name}`;
			if (entry === undefined) {
				notes.push(`MCP server ${name} is not configured`);
				extensions.push(unavailableExtension(extensionName, name, "not configured"));
				continue;
			}
			if (entry.enabled === false) {
				notes.push(`MCP server ${name} is disabled`);
				extensions.push(unavailableExtension(extensionName, name, "disabled"));
				continue;
			}
			const client = await connect(name, entry, notes, options.cwd ?? process.cwd(), options.entries !== undefined);
			if (client === undefined) {
				if (options.entries !== undefined) throw new Error("Session MCP connection failed");
				extensions.push(unavailableExtension(extensionName, name, "connection failed"));
				continue;
			}
			clients.push(client);
			const timeoutMs = (entry.timeout ?? 60) * 1000;
			let tools: McpTool[] = [];
			try {
				tools = await client.listTools({ timeoutMs });
			} catch (error) {
				if (options.entries !== undefined) throw new Error("Session MCP tool discovery failed");
				notes.push(`MCP server ${name} listed no tools: ${errorText(error)}`);
			}
			const isSubstrate = name === "substrate" && tools.some((tool) => tool.name === "search_tool");
			let registrations: ToolRegistration[];
			if (isSubstrate) {
				registrations = substrateGateway(client, timeoutMs, options.redactErrors);
				const extras = wantedTools.length === 0
					? []
					: tools.filter((tool) => wantedTools.includes(tool.name) && tool.name !== "search_tool" && tool.name !== "get_tool");
				registrations.push(...directTools(client, name, extras, timeoutMs, options.redactErrors));
			} else {
				const selected = wantedTools.length === 0 ? tools.slice(0, 20) : tools.filter((tool) => wantedTools.includes(tool.name));
				registrations = directTools(client, name, selected, timeoutMs, options.redactErrors);
			}
			extensions.push(defineExtension({ name: extensionName, tools: registrations }));
		}

	} catch (error) {
		await Promise.allSettled(clients.map((client) => client.close()));
		throw error;
	}
	return {
		extensions,
		notes,
		async close() {
			await Promise.allSettled(clients.map((client) => client.close()));
		},
	};
}

function unavailableExtension(name: string, server: string, reason: string): Extension {
	return defineExtension({
		name,
		tools: [defineTool({
			name: `mcp_${server}_unavailable`,
			description: `The ${server} MCP server is unavailable: ${reason}.`,
			parameters: obj({}),
			replay: "safe",
			execute: async () => ({
				isError: true,
				output: [{ type: "text" as const, text: `${server} MCP is unavailable: ${reason}.` }],
			}),
		})],
	});
}
