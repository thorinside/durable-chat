import type { AnyModel, Model } from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

// Exact typed pi.dev chat definitions, checked against Pi catalog commit
// d4d188646c6bbd5d103238cbd05f1e5c01feb9e4. Pi AI 1.5.0's bundled catalog
// predates these models; its Responses implementations support these fields.
// See docs/openai-models.md for provenance, wire checks, and removal criteria.
const SNAPSHOT = [
	{
		"id": "gpt-6.2-astra",
		"name": "GPT-6.2 Astra",
		"api": "openai-responses",
		"provider": "openai",
		"baseUrl": "https://api.openai.com/v1",
		"reasoning": true,
		"input": [
			"text",
			"image"
		],
		"cost": {
			"input": 8,
			"output": 40,
			"cacheRead": 0.4,
			"cacheWrite": 10,
			"tiers": [
				{
					"inputTokensAbove": 272000,
					"input": 16,
					"output": 60,
					"cacheRead": 0.8,
					"cacheWrite": 20
				}
			]
		},
		"contextWindow": 272000,
		"maxTokens": 128000,
		"thinkingLevelMap": {
			"off": null,
			"minimal": null,
			"low": "low",
			"medium": "medium",
			"high": "high",
			"xhigh": "xhigh",
			"max": "max"
		},
		"compat": {
			"supportsStrictMode": true,
			"supportsOpenAIGrammarTools": true,
			"supportsAdditionalTools": true,
			"supportsToolSearch": true,
			"supportsMidConvoSystemMessages": true,
			"supportsExplicitPromptCacheMode": true,
			"supportsMidConvoEffort": true
		},
		"inputLimits": {
			"maxRequestBytes": 536870912,
			"images": {
				"maxPerRequest": 1500,
				"resize": {
					"maxWidth": 2000,
					"maxHeight": 2000,
					"maxBytes": 4718592,
					"jpegQuality": 80
				}
			}
		},
		"type": "chat"
	},
	{
		"id": "gpt-6.2-sol",
		"name": "GPT-6.2 Sol",
		"api": "openai-responses",
		"provider": "openai",
		"baseUrl": "https://api.openai.com/v1",
		"reasoning": true,
		"input": [
			"text",
			"image"
		],
		"cost": {
			"input": 2,
			"output": 10,
			"cacheRead": 0.1,
			"cacheWrite": 2.5,
			"tiers": [
				{
					"inputTokensAbove": 272000,
					"input": 4,
					"output": 15,
					"cacheRead": 0.2,
					"cacheWrite": 5
				}
			]
		},
		"contextWindow": 272000,
		"maxTokens": 128000,
		"thinkingLevelMap": {
			"off": null,
			"minimal": null,
			"low": "low",
			"medium": "medium",
			"high": "high",
			"xhigh": "xhigh",
			"max": "max"
		},
		"compat": {
			"supportsStrictMode": true,
			"supportsOpenAIGrammarTools": true,
			"supportsAdditionalTools": true,
			"supportsToolSearch": true,
			"supportsMidConvoSystemMessages": true,
			"supportsExplicitPromptCacheMode": true,
			"supportsMidConvoEffort": true
		},
		"inputLimits": {
			"maxRequestBytes": 536870912,
			"images": {
				"maxPerRequest": 1500,
				"resize": {
					"maxWidth": 2000,
					"maxHeight": 2000,
					"maxBytes": 4718592,
					"jpegQuality": 80
				}
			}
		},
		"type": "chat"
	},
	{
		"id": "gpt-6.2-astra",
		"name": "GPT-6.2 Astra",
		"api": "openai-codex-responses",
		"provider": "openai-codex",
		"baseUrl": "https://chatgpt.com/backend-api",
		"reasoning": true,
		"input": [
			"text",
			"image"
		],
		"cost": {
			"input": 8,
			"output": 40,
			"cacheRead": 0.4,
			"cacheWrite": 10,
			"tiers": [
				{
					"inputTokensAbove": 272000,
					"input": 16,
					"output": 60,
					"cacheRead": 0.8,
					"cacheWrite": 20
				}
			]
		},
		"contextWindow": 272000,
		"maxTokens": 128000,
		"thinkingLevelMap": {
			"off": null,
			"minimal": "low",
			"low": "low",
			"medium": "medium",
			"high": "high",
			"xhigh": "xhigh",
			"max": "max"
		},
		"compat": {
			"supportsOpenAIGrammarTools": true,
			"supportsAdditionalTools": true,
			"supportsToolSearch": true,
			"supportsMidConvoSystemMessages": true
		},
		"inputLimits": {
			"images": {
				"resize": {
					"maxWidth": 2000,
					"maxHeight": 2000,
					"maxBytes": 4718592,
					"jpegQuality": 80
				}
			}
		},
		"type": "chat"
	},
	{
		"id": "gpt-6.2-sol",
		"name": "GPT-6.2 Sol",
		"api": "openai-codex-responses",
		"provider": "openai-codex",
		"baseUrl": "https://chatgpt.com/backend-api",
		"reasoning": true,
		"input": [
			"text",
			"image"
		],
		"cost": {
			"input": 2,
			"output": 10,
			"cacheRead": 0.1,
			"cacheWrite": 2.5,
			"tiers": [
				{
					"inputTokensAbove": 272000,
					"input": 4,
					"output": 15,
					"cacheRead": 0.2,
					"cacheWrite": 5
				}
			]
		},
		"contextWindow": 500000,
		"maxTokens": 128000,
		"thinkingLevelMap": {
			"off": null,
			"minimal": "low",
			"low": "low",
			"medium": "medium",
			"high": "high",
			"xhigh": "xhigh",
			"max": "max"
		},
		"compat": {
			"supportsOpenAIGrammarTools": true,
			"supportsAdditionalTools": true,
			"supportsToolSearch": true,
			"supportsMidConvoSystemMessages": true
		},
		"inputLimits": {
			"images": {
				"resize": {
					"maxWidth": 2000,
					"maxHeight": 2000,
					"maxBytes": 4718592,
					"jpegQuality": 80
				}
			}
		},
		"type": "chat"
	}
] satisfies Model<"openai-responses" | "openai-codex-responses">[];

/** Fill only missing chat IDs; keep bundled definitions and all other model types. */
export function withOpenAiModelSnapshot(provider: Provider): Provider {
	const additions = SNAPSHOT.filter((model) => model.provider === provider.id);
	function merge<T extends AnyModel>(baseline: readonly T[]): (T | (typeof SNAPSHOT)[number])[] {
		return [...baseline, ...additions.filter((model) => !baseline.some((entry) =>
			(entry.type === undefined || entry.type === "chat") && entry.id === model.id))];
	}
	return {
		...provider,
		getModels: () => merge(provider.getModels()),
		getAllModels: () => merge(provider.getAllModels?.() ?? provider.getModels()),
	};
}
