import { InMemoryCredentialStore, InMemoryModelsStore, createModels } from "@earendil-works/pi-ai";
import type { CredentialStore, ModelsStore, Provider } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * Use coding-agent's public factory for its remote-decorated canonical providers.
 * Never load the user's models.json, auth.json or catalog cache through ModelRuntime.
 * Request credentials remain owned by durable-chat's PiAuthStore.
 */
export function createOpenAiCatalog(options: { catalogBaseUrl?: string; modelsStore?: ModelsStore } = {}) {
	const source = ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		refreshOnCreate: false,
		...options,
	});
	const modelsStore = options.modelsStore ?? new InMemoryModelsStore();
	let refresh: Promise<ReadonlyMap<string, Provider>> | undefined;
	return {
		load(credentials: CredentialStore, providers: readonly string[]) {
			// One startup pass at a time; Pi's stored checkedAt supplies its native freshness window.
			const previous = refresh;
			const next = (async () => {
				await previous?.catch(() => undefined);
				const runtime = await source;
				const models = createModels({ credentials, modelsStore });
				for (const id of providers) {
					const provider = runtime.getProvider(id);
					if (!provider) throw new Error(`Unknown built-in provider: ${id}`);
					models.setProvider(provider);
				}
				const result = await models.refresh({
					providers,
					allowNetwork: process.env.PI_OFFLINE === undefined,
					signal: AbortSignal.timeout(10_000),
				});
				// Deliberately do not print upstream errors or credentials.
				for (const id of result.errors.keys()) process.stderr.write(`[durable-chat] Model catalog refresh failed for ${id}; retaining Pi's catalog.\n`);
				if (result.aborted) process.stderr.write("[durable-chat] Model catalog refresh timed out; retaining Pi's catalog.\n");
				return new Map(models.getProviders().map((provider) => [provider.id, provider]));
			})();
			refresh = next;
			return next;
		},
	};
}

let catalog: ReturnType<typeof createOpenAiCatalog> | undefined;
export function openAiCatalog() {
	return catalog ??= createOpenAiCatalog();
}
