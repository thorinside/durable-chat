import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export const DEFAULT_AUTH_FILE = resolve(homedir(), ".pi/agent/auth.json");

function isCredential(value: unknown): value is Credential {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	if (type === "api_key") return true;
	if (type === "oauth") {
		const record = value as { access?: unknown; refresh?: unknown; expires?: unknown };
		return typeof record.access === "string" && typeof record.refresh === "string" && typeof record.expires === "number";
	}
	return false;
}

/**
 * CredentialStore over the pi/Codex auth file. It reads the existing OAuth
 * subscription token and writes refreshed tokens back atomically, preserving
 * other providers in the same file.
 */
export class PiAuthStore implements CredentialStore {
	readonly path: string;
	private readonly chains = new Map<string, Promise<unknown>>();
	private readonly providerIds: ReadonlyMap<string, string>;

	constructor(path = process.env.DURABLE_AUTH_FILE ?? DEFAULT_AUTH_FILE, providerIds: ReadonlyMap<string, string> = new Map()) {
		this.path = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
		// Configured names share the existing Pi credential and refresh lock for their provider kind.
		this.providerIds = providerIds;
	}

	private async readAll(): Promise<Record<string, unknown>> {
		try {
			const parsed = JSON.parse(await readFile(this.path, "utf8"));
			return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? parsed as Record<string, unknown>
				: {};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
			throw error;
		}
	}

	private async writeAll(entries: Record<string, unknown>): Promise<void> {
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = `${this.path}.tmp.${process.pid}.${Date.now()}`;
		await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, this.path);
		await chmod(this.path, 0o600);
	}

	async read(providerId: string, _options?: AuthOperationOptions): Promise<Credential | undefined> {
		providerId = this.providerIds.get(providerId) ?? providerId;
		const value = (await this.readAll())[providerId];
		return isCredential(value) ? value : undefined;
	}

	async list(_options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = await this.readAll();
		return Object.entries(entries).flatMap(([providerId, value]) =>
			isCredential(value) ? [{ providerId, type: value.type }] : []);
	}

	async modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		providerId = this.providerIds.get(providerId) ?? providerId;
		const previous = this.chains.get(providerId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(async () => {
			options?.signal?.throwIfAborted();
			const entries = await this.readAll();
			const current = isCredential(entries[providerId]) ? entries[providerId] as Credential : undefined;
			const updated = await fn(current);
			if (updated === undefined) return current;
			entries[providerId] = updated;
			await this.writeAll(entries);
			return updated;
		});
		this.chains.set(providerId, next);
		try {
			return await next;
		} finally {
			if (this.chains.get(providerId) === next) this.chains.delete(providerId);
		}
	}

	async delete(providerId: string, _options?: AuthOperationOptions): Promise<void> {
		providerId = this.providerIds.get(providerId) ?? providerId;
		const entries = await this.readAll();
		if (!(providerId in entries)) return;
		delete entries[providerId];
		await this.writeAll(entries);
	}
}
