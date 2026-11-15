import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { ModelRef } from "@earendil-works/pi-durable";
import type { ProviderEntry, ResolvedConfig } from "./config.ts";

export type RuntimeNotice = { text: string; error?: boolean };
/** `lookup` is the unambiguous key when two providers list the same model ID. */
export type ModelChoice = {
	provider: string; id: string; name: string; contextWindow: number; maxTokens: number; lookup: string;
};
export type ModelChoices = { items: ModelChoice[]; warning?: string };

/** Catalog-only view of the keys a choice needs; the active entry follows the resolved config. */
type ChoiceValues = Pick<ProviderEntry, "name" | "kind" | "model" | "baseUrl" | "apiKey" | "contextWindow" | "maxTokens">;

/** Providers that build their own catalog need a model name; the offline one has a fixed ID. */
export function defaultModelId(entry: ProviderEntry): string {
	return entry.model ?? (entry.kind === "openai-codex" ? "gpt-6.1-sol" : entry.kind === "faux" ? "faux-1" : "model");
}

/** Catalog browsing never refreshes OAuth or sends a generation request. */
export async function modelChoices(config: ResolvedConfig, models: MutableModels, current: ModelRef, signal?: AbortSignal): Promise<ModelChoices> {
	// The active entry comes first, then the other configured providers in config order.
	const entries = [...config.providers.filter((entry) => entry.name === current.provider), ...config.providers.filter((entry) => entry.name !== current.provider)];
	let warning: string | undefined;
	const items: ModelChoice[] = [];
	for (const entry of entries) {
		// The active entry follows the resolved config, so a caller that copies the config still applies.
		const values: ChoiceValues = entry === config.active
			? { name: entry.name, kind: entry.kind, model: config.model, baseUrl: config.baseUrl, apiKey: config.apiKey, contextWindow: config.contextWindow, maxTokens: config.maxTokens }
			: entry;
		const entryItems = models.getModels(entry.name).map((model) => choice(values, model.id, model.name, model.contextWindow, model.maxTokens));
		// Only the active provider is contacted for its dynamic list; the others show their configured model.
		if (values.kind === "local" && entry === config.active) {
			try {
				const url = new URL(values.baseUrl!);
				url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
				const response = await fetch(url, {
					signal: AbortSignal.any([AbortSignal.timeout(5000), ...(signal === undefined ? [] : [signal])]),
					...(values.apiKey === undefined ? {} : { headers: { Authorization: `Bearer ${values.apiKey}` } }),
					redirect: "error",
				});
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body: unknown = await response.json();
				const data = body !== null && typeof body === "object" && "data" in body ? body.data : undefined;
				if (!Array.isArray(data)) throw new Error("expected an OpenAI-compatible model list");
				entryItems.push(...data.flatMap((model: unknown) => {
					const id = model !== null && typeof model === "object" && "id" in model ? model.id : undefined;
					return typeof id === "string" && id.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(id)
						? [choice(values, id.trim(), id.trim(), values.contextWindow, values.maxTokens)] : [];
				}));
			} catch (error) {
				if (signal?.aborted) throw error;
				const reason = error instanceof SyntaxError ? "invalid model-list JSON" : error instanceof Error ? error.message : String(error);
				warning = `Local model discovery failed (${reason}); showing the configured model.`;
			}
		}
		const unique = [...new Map(entryItems.map((model) => [model.id, model])).values()];
		unique.sort((a, b) => Number(b.lookup === `${current.provider}/${current.modelId}`) - Number(a.lookup === `${current.provider}/${current.modelId}`) || a.id.localeCompare(b.id));
		items.push(...unique);
	}
	items.sort((a, b) => Number(b.lookup === `${current.provider}/${current.modelId}`) - Number(a.lookup === `${current.provider}/${current.modelId}`));
	return { items, ...(warning === undefined ? {} : { warning }) };
}

function choice(values: ChoiceValues, id: string, name: string, contextWindow: number, maxTokens: number): ModelChoice {
	return { provider: values.name, id, name, contextWindow, maxTokens, lookup: `${values.name}/${id}` };
}

export function selectModel(input: string, choices: readonly ModelChoice[]): ModelChoice {
	const value = input.trim();
	const model = choices.find((choice) => choice.lookup === value)
		?? choices.find((choice) => choice.id === value)
		?? (/^[1-9][0-9]*$/.test(value) ? choices[Number(value) - 1] : undefined);
	if (model === undefined) throw new Error("Choose a listed model by number or exact model ID.");
	return model;
}
