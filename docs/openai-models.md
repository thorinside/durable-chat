# OpenAI model discovery

OpenAI and Codex model catalogs come from Pi's bundled definitions plus its native
remote catalog overlay. The implementation is `src/openai-models.ts`; the pinned
Pi dependencies in `package.json` define the protocol, refresh policy and model
metadata. No copied model snapshot or invented model ID is registered.

Startup performs a bounded refresh of the configured canonical provider kinds
before validating the exact configured model ID. Named providers are registered
afterward, retaining their existing identities and credential-kind mapping.
Remote entries retain Pi's API, base URL, compatibility flags, thinking mappings,
input limits, context and output limits. Missing IDs fail without a fallback.

The application uses the public coding-agent `ModelRuntime.create/getProvider`
API only to obtain remote-decorated providers. It supplies empty in-memory
credentials, disables refresh during factory creation and sets `modelsPath: null`;
the factory never loads personal Pi profiles. Actual refresh and generation use
the existing durable-chat `PiAuthStore` and provider authentication. Public
catalog refresh uses Pi's configured-auth policy, so an expired OAuth token can
enable metadata discovery without refreshing or writing that token. Model
discovery does not grant account access or establish model entitlement.

Catalog state is in memory. Pi's native freshness window prevents repeated
downloads during model switches; no automatic refresh scheduler is installed.
A process restart fetches again. Refresh errors/timeouts are reported on stderr,
and Pi retains its bundled/previous catalog. `PI_OFFLINE` disables network refresh.
The picker reads the shared catalog without downloading it or refreshing OAuth.

Configured local/faux providers are unchanged. There is no model allowlist in
this application. Existing named OpenAI OAuth transport limitations are not
changed by catalog discovery: use the built-in provider name for OpenAI OAuth,
or the existing dedicated Codex transport. Listing is not a live entitlement test.
