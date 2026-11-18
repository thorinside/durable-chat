# GPT-6.2 catalog compatibility

`gpt-6.2-astra` and `gpt-6.2-sol` are available in the **local chat catalog** for configured `openai` and `openai-codex` providers, including named entries. They accept text/images and produce text; these are not image-generation or classifier entries. Listing a model is not a claim that an account can use it. OpenAI controls account entitlements and availability; authentication is unchanged.

For example, configure both kinds and pick a provider-qualified ID with `/model api/gpt-6.2-sol` or `/model subscription/gpt-6.2-astra`:

```yaml
provider: api
providers:
  api: { kind: openai, model: gpt-6.2-sol }
  subscription: { kind: openai-codex, model: gpt-6.2-astra }
```

Named entries still use the existing Pi credentials for their **kind**, not a new credential namespace. No login, generation, account model-list request, or catalog refresh is performed by browsing the picker.

## Why a static overlay

This application pins `@earendil-works/pi-ai` **1.5.0**. Its bundled catalog lacks both IDs. The latest published **1.5.2**, published November 10, 2026, also lacks both (verified in the npm tarball's `dist/providers/data/{openai,openai-codex}.json`). A dependency bump alone would not fix discovery.

`src/openai-models.ts` contains exactly four typed chat definitions from the public Pi catalog. It fills missing IDs through the supported provider registration interface (`getModels`/`getAllModels` + `setProvider`), before the existing named-provider wrapper runs. Pi 1.5.0 does not expose an `existingModels` factory option. The overlay preserves the built-in auth, filtering, non-chat models and request implementations. Bundled definitions take precedence if an upgraded Pi already supplies an ID. Local/faux providers and configured defaults are unchanged; there is no new dependency, config schema, network refresh, or global Pi modification.

### Provenance

Fetched and inspected for this change:

- [OpenAI changelog, November 17, 2026](https://developers.openai.com/api/docs/changelog.md): both exact IDs; tool calling **requires Responses**, not Chat Completions.
- Official model pages: [Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol.md), [Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra.md). Both reject effort `none`; both document a 1,050,000-token capability window, 922,000 maximum input, and 128,000 maximum output.
- [GPT-6.2 migration guide](https://developers.openai.com/api/docs/guides/latest-model.md): prefix-edit/reasoning loss, top-level `instructions` ordering, unsupported sampling parameters, and prompt-cache changes.
- Complete typed definitions: [`openai`](https://pi.dev/api/models/providers/openai?types=chat,image,classifier), [`openai-codex`](https://pi.dev/api/models/providers/openai-codex?types=chat,image,classifier). Only the two requested chat IDs from each response are copied, including all cost tiers, compatibility flags, image limits and thinking mappings. No missing field was guessed.
- Pinned Pi catalog commit [`d4d188646c6bbd5d103238cbd05f1e5c01feb9e4`](https://github.com/earendil-works/pi/tree/d4d188646c6bbd5d103238cbd05f1e5c01feb9e4/packages/ai/catalog): [`providers/openai.ts`](https://github.com/earendil-works/pi/blob/d4d188646c6bbd5d103238cbd05f1e5c01feb9e4/packages/ai/catalog/providers/openai.ts), [`providers/openai-codex.ts`](https://github.com/earendil-works/pi/blob/d4d188646c6bbd5d103238cbd05f1e5c01feb9e4/packages/ai/catalog/providers/openai-codex.ts), [`families/openai.ts`](https://github.com/earendil-works/pi/blob/d4d188646c6bbd5d103238cbd05f1e5c01feb9e4/packages/ai/catalog/families/openai.ts), and [`build.ts`](https://github.com/earendil-works/pi/blob/d4d188646c6bbd5d103238cbd05f1e5c01feb9e4/packages/ai/catalog/build.ts) confirm provider operating caps, pricing/tier rules, thinking, compat and image-resize defaults. The public endpoints are mutable; the copied snapshot is static.

The four copied objects, in source order, have SHA-256 `266fda49e5b7b7af5ae04a9652eee73894d7a56c33e471313ad9757c1f698125` when encoded as a JSON array with recursively sorted keys, compact separators and no trailing newline.

### Capability versus operating defaults

We retain Pi's operating limits, not the larger advertised capability window:

| Provider kind | Astra context | Sol context | Max output (both) |
| --- | ---: | ---: | ---: |
| `openai` | 272,000 | 272,000 | 128,000 |
| `openai-codex` | 272,000 | 500,000 | 128,000 |

Pi caps direct API context to the short-context pricing tier. The snapshot still retains long-context prices. Application-configured ceilings can further restrict these limits.

For both providers, `off` is unsupported. Direct API `minimal` is also unsupported; Codex maps `minimal` to native `low`. Pi's simple request path clamps unsupported settings to a supported level, so the application's default `off` sends `low`, never `none`. Supported native levels run from `low` through `max`. No fabricated temperature/sampling defaults are added.

## Wire compatibility and prefix changes

The installed **1.5.0** Responses implementations were inspected, not merely the newer catalog:

- They consume the copied grammar/tool-search/additional-tools and mid-conversation system-message flags. Tools and later instruction updates stay in place in the input transcript rather than being folded into an edited prefix. Optional JSON-schema properties remain optional.
- Direct API requests carry stable instructions in a leading developer message in `input`, not top-level `instructions`. The mid-conversation effort flag uses `configuration_update` items, retaining historical native effort while changing current effort. The explicit cache flag replaces legacy retention with `prompt_cache_options` (long retention uses `ttl: "30m"`).
- Codex uses its dedicated Responses transport. Pi 1.5.0 carries the **initial** system prompt in top-level `instructions`, and sends later developer updates in `input`. The pinned upstream Codex implementation does the same. This field remains supported, but GPT-6.2 appends it after input: **do not assume initial Codex instructions are prompt-cache eligible or precede input on the server**. This layer does not rewrite the Codex protocol or promise cache savings.
- Encrypted reasoning and tool-call/result pairs are replayed in order for same-model continuations. Model switches, rollbacks, compaction or other prefix edits can still cause the server to discard reasoning, with quality/token-cost implications described in the migration guide. A catalog shim cannot prevent that server behavior; no cross-model reasoning retention guarantee is made.

`test/openai-models.test.ts` checks offline discovery and session switching, both built-in and named provider dispatch, credential-kind mapping, Responses URLs, image serialization, tool calls/results, schema fidelity, unsupported effort clamping, omitted effort, append-only tool/developer updates, reasoning replay, direct cache/effort configuration, and Codex instructions. Fetch is mocked with synthetic credentials and SSE; Codex's compressed request body is decoded in the mock. These checks make **no real model calls**, and do not establish account access or live server acceptance.

## Removal

Remove the snapshot and wrapper once the application's pinned Pi release bundles both IDs for both providers with equivalent metadata **and** its Responses transports pass the focused serialization checks. Re-run those checks on any Pi upgrade, especially changes to thinking, prefix/instructions handling, cache fields or tool schemas. Do not replace this narrowly scoped compatibility layer with an unrelated live catalog refresh.
