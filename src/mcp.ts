import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
type JsonObject = Record<string, unknown>;
import type { Schema } from "@earendil-works/pi-schema";
import { int, map, obj, opt, str, unknown } from "@earendil-works/pi-schema";
import { McpClient, StdioTransport, StreamableHttpTransport, toLlmContent } from "@earendil-works/pi-mcp";
import type { CallToolResult, Tool as McpTool, StreamableHttpTransportOptions } from "@earendil-works/pi-mcp";

type McpServerEntry = {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: StreamableHttpTransportOptions["headers"];
	// dchat compatibility shorthand, not Pi 1.5.0's provider-auth object.
	auth?: "bearer";
	bearerToken?: string;
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
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
			|| (parsed.mcpServers !== undefined && (parsed.mcpServers === null || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers)))) {
			throw new Error("invalid MCP config shape");
		}
		return parsed.mcpServers ?? {};
	} catch {
		// JSON parser errors can include source excerpts containing credentials.
		notes.push(`could not read ${path}: invalid or unreadable MCP config`);
		return {};
	}
}

/** Read user and project MCP config; a project entry replaces a user entry of the same name. */
export function readMcpServers(configPath: string | undefined, notes: string[]): Record<string, McpServerEntry> {
	const primary = configPath ?? process.env.DURABLE_MCP_CONFIG ?? DEFAULT_MCP_CONFIG;
	const servers: Record<string, McpServerEntry> = {};
	Object.assign(servers, readConfig(resolve(homedir(), ".pi/agent/mcp.json"), notes));
	const projectPath = resolve(process.cwd(), ".pi/mcp.json");
	if (projectPath !== resolve(primary)) Object.assign(servers, readConfig(projectPath, []));
	if (resolve(primary) !== resolve(homedir(), ".pi/agent/mcp.json") && resolve(primary) !== projectPath) {
		Object.assign(servers, readConfig(primary, notes));
	}
	return servers;
}

function httpHeaders(entry: McpServerEntry): Record<string, string> {
	if (entry.headers !== undefined && (entry.headers === null || typeof entry.headers !== "object" || Array.isArray(entry.headers)
		|| Object.values(entry.headers).some((value) => typeof value !== "string"))) {
		throw new Error("MCP headers must map names to strings");
	}
	const headers = Object.fromEntries(Object.entries(entry.headers ?? {}).map(([key, value]) => [key, expand(value)]));
	// Header names are case-insensitive. Explicit headers win, even an empty Authorization.
	if (!Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		if (entry.auth !== undefined && entry.auth !== "bearer") throw new Error('MCP auth must be "bearer"; use headers for other authorization');
		if (entry.auth === "bearer") {
			if (typeof entry.bearerToken !== "string") throw new Error("MCP bearer auth requires a non-empty bearerToken");
			const token = expand(entry.bearerToken);
			if (token.length === 0 || /\s/.test(token)) throw new Error("MCP bearer auth requires a non-empty bearerToken without whitespace");
			headers.Authorization = `Bearer ${token}`;
		}
	}
	try {
		// Validate without exposing header values in a platform-specific TypeError.
		new Headers(headers);
	} catch {
		throw new Error("MCP headers contain an invalid name or value");
	}
	return headers;
}

async function connect(name: string, entry: McpServerEntry, notes: string[]): Promise<McpClient | undefined> {
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
		notes.push(`MCP server ${name} must be an object`);
		return undefined;
	}
	const requestTimeoutMs = (entry.timeout ?? 60) * 1000;
	const client = new McpClient({ name: "durable-chat", version: "0.1.0", requestTimeoutMs });
	let headers: Record<string, string> = {};
	try {
		if (entry.url !== undefined) {
			headers = httpHeaders(entry);
			await client.connect(new StreamableHttpTransport({ url: expand(entry.url), headers }));
		} else if (entry.command !== undefined) {
			const expandedCwd = entry.cwd === undefined ? undefined : expand(entry.cwd);
			const cwd = expandedCwd === undefined ? undefined : resolve(isAbsolute(expandedCwd) ? expandedCwd : process.cwd(), "");
			await client.connect(new StdioTransport({
				command: expand(entry.command),
				args: (entry.args ?? []).map(expand),
				...(cwd === undefined ? {} : { cwd }),
				env: Object.fromEntries(Object.entries(entry.env ?? {}).map(([key, value]) => [key, expand(value)])),
				inheritEnv: true,
				stderr: "pipe",
				onStderr: (chunk) => {
					const text = chunk.trim();
					if (text.length > 0) notes.push(`[${name}] ${text.slice(0, 300)}`);
				},
			}));
		} else {
			notes.push(`MCP server ${name} has no url or command`);
			return undefined;
		}
		return client;
	} catch (error) {
		let message = errorText(error);
		// A transport/server error may echo request headers; never include those credentials in notes.
		const bearerValues = Object.entries(headers).filter(([key]) => key.toLowerCase() === "authorization")
			.map(([, value]) => /^Bearer\s+(.+)$/i.exec(value)?.[1] ?? "");
		const sensitive = [...Object.values(headers), ...bearerValues, ...(typeof entry.bearerToken === "string" ? [entry.bearerToken, expand(entry.bearerToken)] : [])];
		for (const value of sensitive.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.replaceAll(value, "[redacted]");
		notes.push(`MCP server ${name} failed to connect: ${message}`);
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

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function serverToolName(toolName: string): string {
	return `mcp__${toolName.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Three tools that cover the whole Substrate surface without offering 249 separate schemas. */
function substrateGateway(client: McpClient, timeoutMs: number): ToolRegistration[] {
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
				return { output: [{ type: "text" as const, text: `Substrate search failed: ${errorText(error)}` }], isError: true };
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
				return { output: [{ type: "text" as const, text: `Substrate describe failed: ${errorText(error)}` }], isError: true };
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
				return { output: [{ type: "text" as const, text: `Substrate call failed: ${errorText(error)}` }], isError: true };
			}
		},
	});
	return [search, describe, invoke];
}

function directTools(client: McpClient, server: string, tools: readonly McpTool[], timeoutMs: number): ToolRegistration[] {
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
				return { output: [{ type: "text" as const, text: `${server}/${tool.name} failed: ${errorText(error)}` }], isError: true };
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
 * Connect the selected MCP servers once per process and expose them as extensions.
 * Substrate gets a three-tool gateway; other servers expose selected tools directly.
 */
export async function connectMcp(options: {
	configPath?: string;
	servers?: string[];
	tools?: string[];
	verbose?: boolean;
} = {}): Promise<McpSetup> {
	const notes: string[] = [];
	const servers = options.servers ?? (process.env.DURABLE_MCP_SERVERS ?? "substrate").split(",").map((name) => name.trim()).filter(Boolean);
	const wantedTools = options.tools ?? (process.env.DURABLE_MCP_TOOLS ?? "").split(",").map((name) => name.trim()).filter(Boolean);
	const configured = readMcpServers(options.configPath, notes);
	const clients: McpClient[] = [];
	const extensions: Extension[] = [];

	for (const name of servers) {
		const entry = configured[name];
		const extensionName = `durable-chat.mcp.${name}`;
		if (entry === undefined) {
			notes.push(`MCP server ${name} is not configured`);
			extensions.push(unavailableExtension(extensionName, name, "not configured"));
			continue;
		}
		if (entry !== null && entry.enabled === false) {
			notes.push(`MCP server ${name} is disabled`);
			extensions.push(unavailableExtension(extensionName, name, "disabled"));
			continue;
		}
		const client = await connect(name, entry, notes);
		if (client === undefined) {
			extensions.push(unavailableExtension(extensionName, name, "connection failed"));
			continue;
		}
		clients.push(client);
		const timeoutMs = (entry.timeout ?? 60) * 1000;
		let tools: McpTool[] = [];
		try {
			tools = await client.listTools({ timeoutMs });
		} catch (error) {
			notes.push(`MCP server ${name} listed no tools: ${errorText(error)}`);
		}
		const isSubstrate = name === "substrate" && tools.some((tool) => tool.name === "search_tool");
		let registrations: ToolRegistration[];
		if (isSubstrate) {
			registrations = substrateGateway(client, timeoutMs);
			const extras = wantedTools.length === 0
				? []
				: tools.filter((tool) => wantedTools.includes(tool.name) && tool.name !== "search_tool" && tool.name !== "get_tool");
			registrations.push(...directTools(client, name, extras, timeoutMs));
		} else {
			const selected = wantedTools.length === 0 ? tools.slice(0, 20) : tools.filter((tool) => wantedTools.includes(tool.name));
			registrations = directTools(client, name, selected, timeoutMs);
		}
		extensions.push(defineExtension({ name: extensionName, tools: registrations }));
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
