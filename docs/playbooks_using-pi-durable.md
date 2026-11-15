# Using Pi Durable — standalone playbook

Build an embedded, persistent, collaborative agent system using this document and ordinary public npm dependencies. No Substrate account, private repository, internal artifact, experiment script or other playbook is needed. Public links at the end are optional contract/upgrade references, not missing implementation steps.

This document describes Pi Durable **1.5.0**, AI/Chord/schema **1.5.0**, upstream revision **f9a26365568127461c47a07a37dcb42c140a3ac5**. The API is experimental: recheck installed declarations on upgrade. Package prerequisite: Node **>=22.19.0**; historical experiments used **24.11.0**. Use a Node release supporting the built-in SQLite and TypeScript-stripping features used below.

## Reading and evidence labels

- **HISTORICALLY TESTED:** bounded synthetic native-SDK behavior observed before this document; not a new execution, exhaustive guarantee, production certification or proof on your model.
- **SOURCE-SUPPORTED:** specified or implemented at the pinned revision, but not exercised for this revision of the document.
- **ADAPTATION / RECOMMENDATION:** application code or design assembled from those contracts; requires your own validation.
- **UNVERIFIED:** insufficient execution evidence. In particular, the complete real-model background spawn/send/status/report/failure/peer-stop loop is unverified here.

**Every new code block is unexecuted and not compiler-verified by this documentation task.** Complete files are labeled; other snippets state their surrounding variables/call site. Commands are future instructions for a separately authorized, owned directory—not receipts of work performed. Nothing here grants permission to touch an existing agent, run a provider request, change credentials, kill a shared process or deploy software.

Route: §§1–3 orient and start; §§4–7 configure, persist and branch; §§8–11 coordinate messages/workers; §§12–14 compact and recover; §§15–17 verify, diagnose and audit portability. Appendix A provides optional public contracts.

## 1. Choose the integration plane and responsibility boundary

**Native TypeScript SDK:** `@earendil-works/pi-durable` embeds Harness, Conversations, Tasks, Submissions and storage in your application process. `pi-ai` supplies model/provider services; Chord supplies cancellation context and tracked JSON documents. A library method is not automatically an HTTP/MCP endpoint.

**Pi coding-agent CLI/RPC:** a separate coding-agent session/process API. It is not the Durable Harness API. Installing a CLI skill or extension does not register a Durable Registry extension. `pi --mode rpc --no-session` starts a CLI subprocess using strict LF-framed JSON records on stdin/stdout. Correlate responses with unique command IDs, not response order. Read stdout continuously; diagnostics belong on stderr. A prompt acknowledgment means accepted/queued/handled, not model completion. Subscribe before sending; `agent_end` can precede automatic follow-up, while `agent_settled` is the settled boundary. CLI abort/clear-queue/session commands must not be substituted for native Task/Conversation operations.

**Your application/control plane:** authentication, resource/tenant authorization, human approval, budgets, process supervision, runner routing, deployment, single-writer ownership and external-effect reconciliation remain yours. In a host such as Substrate, Services/Jobs/attempts/workflows are additional application records, not native Task IDs. This playbook requires none of those services.

Choose the smallest seam: embedded durable execution when you own state; CLI/RPC when you intentionally need a coding-agent subprocess. Do not create a second queue, scheduler or notification mechanism merely because an example contains background Reporters. Identify one authoritative owner and return path for every unit of work.

## 2. Mental model and lifecycle contracts

| Object | Contract | Common mistake |
|---|---|---|
| Harness | Runtime over one storage/Session and one atomic mutation line | Opening competing writable instances on one physical store |
| Conversation | Stateless handle to a transcript scope; compare by id | Treating a transcript boundary as an ACL or OS process |
| Entry | Immutable record; may contribute provider messages | Confusing all retained entries with active model context |
| Document | Mutable strict JSON changed through commits | Saving a closure, promise, secret or host service as durable state |
| Task | Named/versioned state machine with persisted input/checkpoint/outcome | Assuming local variables or Promise.all form a durable restartable join |
| Submission | Admitted input, write or continue; has its own settlement | Calling an admission acknowledgment a completed answer |
| Registry/Extension | Process-local definitions of tools/tasks/hooks/prompt sections | Expecting definitions to be serialized with their stored names |
| Agent configuration | Conversation's persisted model/thinking/tools/extensions/instructions/cwd choices | Confusing configuration with loaded provider identity or permissions |

Normal input flow: admit Submission → queue or place user entry → generation Task → committed assistant/tool-call intent → owned tool Tasks/results → successor generation(s) → final assistant entry → Submission done/unanswered. A run spans model turns through its answer. An `afterRun` hook can keep the Conversation busy after the answer; input settlement and complete ordinary idle are then different boundaries.

Task states include pending, running, waiting, sleeping and completing before a terminal outcome. A decided outcome can remain completing until owned work finishes. After a restart, unfinished running work may appear pending before scheduling resumes. Preserve the same Task ID/checkpoint; a newly created task doing equivalent work is not a recovery demonstration.

A commit atomically changes native entries/documents/task state. External calls do not run inside that mutation transaction. Drafts are revoked when the callback ends. Stored commits are durable under the chosen backend's contract; deferred progress can be observed before it is stored. Never derive a durable business claim from a UI progress value alone.

Keep IDs qualified by logical store identity and record kind. Different stores can both contain Conversation2/Task40. Numeric IDs are not globally unique. Provider-facing `pi.provider` session identity is distinct from Conversation identity and authorization identity; source says it survives reopen/reset/compaction/model changes, while children/forks receive fresh provider identities.

## 3. Setup and a complete minimal persistent chat

### 3.1 Prerequisites and commands

Use a new directory you own. Obtain approval before paid/network operations, not by virtue of these commands. No npm install, test or model request was run while authoring this document.

```sh
npm init -y
npm pkg set type=module
npm install --save-exact @earendil-works/pi-durable@1.5.0 @earendil-works/pi-ai@1.5.0 @earendil-works/chord@1.5.0 @earendil-works/pi-schema@1.5.0
npm ls @earendil-works/pi-durable @earendil-works/pi-ai @earendil-works/chord
# Save the complete block below as minimal.ts:
node --experimental-strip-types minimal.ts
```

No source checkout or hidden testing helper is required. Keep the resulting lock file. On upgrade record resolved SDK, AI, Chord, schema, Node and loaded application build separately; a CLI inventory/version is not attestation of an embedded server SDK.

### 3.2 Complete `minimal.ts` — faux model, persistent SQLite

**SOURCE-SUPPORTED assembly; unexecuted.** This uses a deterministic faux provider, not an external model endpoint. Do not interpret a faux success as real-model orchestration proof.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";

const context = BACKGROUND_CONTEXT;
const faux = fauxProvider({ tokensPerSecond: 50 });
faux.setResponses([() => fauxAssistantMessage([fauxText("hello durable")])]);
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
const harness = await Harness.open(
  await openNodeSqliteStorage("./durable-quickstart.sqlite"),
  { models, registry, settings: {
    retry: { maxRetries: 0 },
    stream: { maxRetries: 0, timeoutMs: 30000 },
    compaction: { enabled: false },
  } },
  context,
);
try {
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" }, maxTurns: 4 },
  });
  const submission = await root.submit({
    type: "input", content: "Say hello", requestId: "quickstart:greeting:1",
  }, context);
  const settled = await submission.wait(context);
  if (settled.status !== "done" || settled.type !== "input") {
    throw new Error(`Input did not answer: ${JSON.stringify(settled)}`);
  }
  const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
  console.log({ conversationId: root.id, submissionId: submission.id, answer: entry?.model?.[0] });
} finally {
  await harness.close(context);
}
```

Expected from contracts: first invocation admits/answers; same store plus same requestId reacquires the original Submission. A changed operation needs a new application request key; do not assume duplicate keys compare/update payloads. `root(context, { agent })` initializes absent root state; use `configure()` for a deliberate change to an existing root. MemoryStorage can replace SQLite for disposable examples but cannot persist across process death.

`BACKGROUND_CONTEXT` never cancels. The stream timeout is not a whole-operation deadline. A real host needs cancellation-aware external tools and bounded supervision; task code ignoring cancellation can delay close indefinitely.

### 3.3 Validation you can perform later

When authorized, run the supplied files with Node and inspect actual receipts. For an additional compile check, install a compatible TypeScript compiler and Node typings as normal dev dependencies; the pinned upstream metadata used TypeScript7.0.2 and @types/node22.19.19. An example command, not executed here:

```sh
npx tsc --noEmit --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --allowImportingTsExtensions minimal.ts
```

TypeScript stripping executes code without proving type correctness. Do not weaken compiler settings or silently add skipLibCheck to make a result green; record any deliberate limitation. Node SQLite availability and dependency type compatibility must be confirmed in your environment.

## 4. Providers, model selection and agent configuration

### 4.1 Provider configuration recipe

1. Create an explicit Models collection; register only required provider factories.
2. Resolve a `ModelRef` as `{ provider, modelId }`. `models.getModel(provider, modelId)` is a synchronous last-known catalog lookup, not endpoint/auth/loaded-model proof.
3. Bind only an allowed endpoint/model; do not fall back to a paid/shared route to make a test pass.
4. Record actual context/output capabilities and policy overrides separately from backend capacity.
5. Bound BOTH retry layers: `settings.stream.maxRetries` is provider/SDK retry within a request attempt; `settings.retry.maxRetries` is Durable generation retry. Historical synthetic cases set both zero. Provider-overflow compaction/retry is another path to account for.
6. Keep keys in provider/approved secret resolution. Never include their values in documents, prompts, logs or examples.

Real OpenAI registration, inside a program before Harness.open, requires these imports and approved environment credentials:
```ts
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
const models = createModels();
models.setProvider(openaiProvider());
const modelId = process.env.PI_MODEL_ID;
if (!modelId || !models.getModel("openai", modelId)) throw new Error("Set an allowed catalog PI_MODEL_ID");
// Use { provider: "openai", modelId } as root's agent.model.
```
This replaces, rather than duplicates, the faux Models setup in §3. Credentials normally resolve through OPENAI_API_KEY. Do not print them or invoke auth refresh as diagnosis. `getAuth()`, `getAvailable()` and dynamic catalog refresh can resolve credentials, refresh OAuth or contact endpoints; they are not inherently inert reads.

### 4.2 Custom/local OpenAI-compatible provider

**SOURCE-SUPPORTED configuration block; unexecuted.** Insert before Harness.open, instead of the faux provider setup. The example addresses/model metadata are illustrative, not a discovery of a server on your machine. Replace them with the explicitly allowed, actually available model/capacities; the code below itself sends no completion.

```ts
import { createModels, createProvider, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
const localModel: Model<"openai-completions"> = {
  id: "llama-3.1-8b", name: "Local model", api: "openai-completions",
  provider: "local", baseUrl: "http://localhost:11434/v1",
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000, maxTokens: 32000,
};
const models = createModels();
models.setProvider(createProvider({
  id: "local", name: "Local", baseUrl: localModel.baseUrl,
  auth: { apiKey: { name: "Keyless local", resolve: async () => ({ auth: {} }) } },
  models: [localModel], api: openAICompletionsApi(),
}));
// Root model reference: { provider: "local", modelId: localModel.id }.
```

For a protected proxy, public AI exports `envApiKeyAuth(displayName, [envVariableName])`; use legitimate secret provisioning, not a placeholder. Compatible servers may need model `compat.supportsDeveloperRole: false` or `compat.supportsReasoningEffort: false`; set them only for established wire capabilities.

**Historically tested transport failure/recovery:** a keyless endpoint was reachable but the selected client arrangement rejected “No API key for provider” before sending. A non-secret per-run placeholder such as `local-no-auth` fixed that client's field requirement. The public custom-provider example above instead declares empty auth. These are not a universal requirement or guarantee: inspect your exact provider/API configuration. A real401 is an access blocker, never authorization to bypass authentication or reuse a paid key.

Local smoke procedure: confirm allowed endpoint/catalog and exact model without loading/changing it; configure a new owned store; disable fallbacks/retries; submit through Durable, not a substitute direct HTTP completion; await done/unanswered; inspect committed AssistantEntry and finish reason. An unavailable endpoint should fail closed, ideally before opening a store when your approved preflight detects it. Preserve failed store/trace; a later successful fresh attempt does not rewrite the failure.

Check answer completeness: a committed answer can be truncated mid-JSON. Historical256-token output produced invalid JSON; a scenario-local1024 allowance succeeded. Other models exhausted hidden thinking even at768/1024. Parse/validate what actually arrived; never fabricate missing text. These numbers are failure examples, not global output defaults.

### 4.3 Agent, system, tool and identity configuration

`await root.configure(change, context)` persists choices; `await root.agent(context)` resolves them against current process Registry/settings. Supported change fields include model, thinkingLevel, extensions, tools, modelTools, instructions, cwd and maxTurns. Example inside §3's try block:
```ts
await root.configure({ instructions: "Answer the bounded request; do not delegate.", maxTurns: 8 }, context);
```
Arrays select exact extensions/tools; `{ add: [...] }`/`{ remove: [...] }` edits defaults. `tools: null` clears that field to the HOST DEFAULT, not to zero tools. To grant none use an explicit empty enabled list as supported by the installed declaration. Do not confuse typed configure-null with unsupported null arguments to positional compact/reset.

System sections from selected extensions render in order before requests; instructions renders last. Positional `pi.system` entries retain changes. Stable sections cache better than changing timestamps. Prepared request model/prompt/tools are fixed; a configuration change affects future request preparation. Tool phases resolve agent/environment at their phase boundary, so cwd/extension changes can affect calls the model already issued. Avoid changing privileges mid-work without a clear policy.

Registry definitions/closures, Models and environments are NOT persisted copies. On reopen install the same named task/tool extensions and rebuild provider/environment services. Harness wraps Models for client identity; do not test reference identity against the host object as a fork guarantee. Provider attribution headers/session affinity are not authorization or provider-billing identity.

## 5. Tools, environments and input validation

Register code BEFORE opening/resuming work that requires it. The following complete registration fragment replaces `const registry = createRegistry()` in §3 (add its imports; retain the other §3 imports):
```ts
import { obj, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
const echo = defineTool({
  name: "echo", description: "Echo short synthetic text",
  parameters: obj({ text: str() }), replay: "safe",
  execute: async (args) => {
    if (args.text.length > 2000) throw new Error("text too long");
    return { output: [{ type: "text" as const, text: args.text }] };
  },
});
const EchoTools = defineExtension({ name: "echo-tools", tools: [echo] });
const registry = createRegistry();
registry.install(EchoTools);
```
The faux response in §3 does not invoke this tool; registration alone is not a tool-execution test.

Tool contract essentials:
- Harness coerces/validates tool arguments against JSON Schema before execute. Validate semantic bounds, resource ownership, allowed paths/operations and authorization too. Schema is not an ACL; positional SDK methods are not automatically JSON tools.
- Return **output** for model content, **structuredOutput** for program callers (declare structuredOutputSchema), **details** for UI attribution. Output is an array of content blocks. Transcript toolResult messages eventually use a content field, but ToolExecutionResult does not use content. See §11's known upstream mismatch.
- Default replay unsafe; safe is appropriate for pure echo, not arbitrary external writes. A thrown tool error is a tool error result, not automatically fatal storage failure.
- tools controls enabled operations; modelTools narrows which are offered to the model without necessarily removing nested-call access. callers can restrict `["model"]` or `["tools"]`. Remove delegating capabilities from workers, not merely an instruction asking them not to use them.
- Selected later same-name tools replace earlier ones; wrappers decorate the winner. Inspect resolved tools/callable lists and current Registry, not only installation logs.
- Built-in read/write/edit/bash need an execution environment. A fragment for a trusted local host, added to Harness options, is `env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? process.cwd() })`, with import from `@earendil-works/pi-durable/env/node`. cwd is NOT a sandbox. Supply an isolated environment for untrusted work. Equal environment id/path identifies shared files for serialization; it is not application-wide writer ownership.
- api.executeTool invokes nested validated Tasks with their own hooks, limits, replay policy and key-based reattachment. Unfinished nested calls are aborted before the caller settles. Nested replay keys do not deduplicate uncertain remote effects. Do not add nested usage to the caller again.
- Hooks can block/rewrite requests/arguments/results. An observer-only beforeRequest/beforeCompact hook must return undefined. Redact structuredOutput as well as output when necessary. Error messages and details can leak caller data.

Optional source-supported features: deferred tool search reduces offered tools; Codemode runs deterministic QuickJS with journaled nested results, bounded memory/time and a pinned sandbox fingerprint. Those are not permission escapes or external-effect exactly-once. Codemode is used by `src/codemode.ts`; the other features are not needed by any file in this playbook. Do not infer an AgentEvent/watchEvents API from an obsolete table-of-contents link: those root exports were absent at the pin; use structural watches and committed observations.

## 6. Tasks, checkpointing and reopen

### 6.1 Complete model-free `checkpoint.ts`

With §3 dependencies in an owned directory, save this file and later run `node --experimental-strip-types checkpoint.ts`. It closes BEFORE scheduling and then reopens pending work; it does not simulate an unplanned crash. Source-grounded assembly, unexecuted here.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, defineTask, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
const context = BACKGROUND_CONTEXT;
type Input = { a: number; b: number; add: number };
type State = { phase: "multiply" } | { phase: "add"; product: number };
const Arithmetic = defineTask<Input, State, number>({
  name: "app.arithmetic", version: 1, initial: () => ({ phase: "multiply" }),
  phases: {
    multiply: (task, runtime, ctx) => runtime.commit(() => ({
      status: "running", checkpoint: { phase: "add", product: task.input.a * task.input.b },
    }), ctx),
    add: (task, runtime, ctx) => runtime.commit(() => ({
      status: "terminal", outcome: { status: "completed", result: task.state.checkpoint.product + task.input.add },
    }), ctx),
  },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({
    status: "terminal", outcome: { status: "aborted" },
  }), ctx),
});
async function open() {
  const registry = createRegistry();
  registry.install(defineExtension({ name: "arithmetic", tasks: [Arithmetic] }));
  return Harness.open(await openNodeSqliteStorage("./checkpoint.sqlite"), {
    models: createModels(), registry,
  }, context);
}
const id = await (async () => {
  const first = await open();
  try {
    const root = await first.root(context);
    return await root.commit((tx) => tx.createTask(Arithmetic,
      { a: 17, b: 19, add: 23 }, { ownership: { kind: "conversation" } }), context);
  } finally { await first.close(context); }
})();
const second = await open();
try {
  const finished = await second.waitForTask(id, context);
  console.log(finished.state.outcome); // expected completed/result346; not a fresh test result
} finally { await second.close(context); }
```

Task procedure:
1. Persist all resumable phase input/state as strict JSON. Use stable task name/version. Do not rename an old live task out of existence instead of providing compatible definitions/migration.
2. Use runtime.commit to save next checkpoint or terminal outcome atomically with related native writes. Do effects outside the mutation transaction.
3. Creation admits; resume or a progress operation such as waitForTask enables scheduling. An unscheduled barrier timeout proves no concurrency failure.
4. For real restart, retain store address plus Conversation/Task/Submission IDs outside ephemeral process variables. Reacquire with harness.conversation(id, context), getTask(id, context), submission(id, context). A same requestId can recover admission. Handle undefined/not-found explicitly.
5. Inspect through getTask/inspect before asking for progress. A true readOnly Harness rejects writes/recovery/progress; merely not calling resume on a normal Harness is not that guarantee.
6. Durable sleep is a stored phase transition via runtime.sleepUntil(until, nextCheckpoint, context), not a promise held halfway through a phase. An evicted host must arrange wakeup.

### 6.2 Owned-process crash verification recipe

This is a future controlled-test procedure, NOT a command to kill existing agents:
1. Use a disposable store and a supervisor that spawned and positively identifies its own calculation child. Freeze one writer, unique attempt root, all prior-file hashes and finite timeout before execution.
2. In phase1 commit both multiplication receipt323 and checkpoint `{ phase: "add", product: 323 }`. Save IDs and flush an IPC/stdout gate receipt AFTER that commit. Show the Task unfinished, not a cached terminal result.
3. Keep only that child alive at the gate. A pending top-level Promise alone may not keep Node alive. A deliberately owned foreground fixture used Atomics.wait after the commit; this blocks the event loop and is NOT production scheduling advice.
4. Only under explicit crash-test authority, supervisor sends SIGKILL to that owned PID, waits for confirmed death and restarts one new child on the SAME store/task. Never signal a runner/server/process group/machine or an unknown PID.
5. Inspect retained checkpoint and running→pending/restart count before progress; then resume/join same Task. Verify result346, exactly one committed multiplication and one addition, their byTaskId and checkpoint counters.
6. Reject wrong Task, duplicate multiplication, wrong result, missing addition and a completed-cache substitute. Await phase/telemetry settlement where necessary rather than confusing an early terminal receipt with a missing span.
7. Compare every prior hash and preserve failed trials. A supervisor bound is not causal overlap evidence. Actual supervisor exit/signal/new PID plus retained checkpoint establish the cut.

Historically tested: retained-local-disk process death at that committed cut resumed the same task correctly. Supervisor owned resurrection; SDK owned recovery. No power/disk/machine loss, suspended provider request recovery or arbitrary external-effect atomicity was proved.

## 7. Documents, multiple Conversations, forks and handoff

### 7.1 Per-Conversation state fragment

Inside §3's program add this import and definition before use, then put the commit/snapshot inside its try block:
```ts
import { defineDoc } from "@earendil-works/pi-durable";
const Notes = defineDoc<{ items: string[] }>({
  kind: "app.notes", version: 1, scope: "conversation", history: "latest",
  fork: "initial", initial: () => ({ items: [] }), checkpointWhen: () => false,
});
// After root has been acquired:
await root.commit(async (tx) => {
  (await tx.doc(Notes, root.id)).items.push("a durable note");
}, context);
console.log(await harness.snapshot(Notes, root.id, context));
```
Choose latest versus rewindable history; choose initial/current/asOf fork policy compatible with the installed token type. checkpointWhen controls document bases/replay, not Task phases. Initial state can be lazy: a fork may have no raw snapshot until typed tx.doc access creates its default. Keep drafts within the transaction; store no closures/handles/secrets.

### 7.2 Scope decision table

| Need | Choice | Limit |
|---|---|---|
| Separate transcripts/config in one trusted application | Multiple Conversations in one Harness | Shared store/commit line, not tenant isolation |
| Independent persistence owners | Multiple Harnesses with DIFFERENT stores | Host routing/correlation/permissions required; no built-in cross-Harness transport |
| Branch shared history through a cutoff | Fork | New provider identity; no running Task clone or automatic state merge |
| Replace active context and keep answering same input | Tool control.handoff | Same Submission continues with successor generation |
| End old context deliberately | Standalone reset | Busy reset ends current run; raw history remains |

Inside §3 after root exists:
```ts
const other = await harness.createConversation({ ownership: { kind: "ownerless" } }, context);
const entryId = (await root.context(context)).entries.at(-1)?.id;
if (entryId !== undefined) {
  const branch = await root.fork(entryId, { ownership: { kind: "ownerless" } }, context);
  console.log({ parent: root.id, branch: branch.id });
}
```
Use a real visible entry cutoff, not a guessed number. Owner edges express lifecycle, not authorization. A trusted Harness can cross-read Conversations; an application must enforce users/tenants/resources separately. Forks copy declared documents according to policy and agent configuration at the cut, not Registry objects, Models, env instances or arbitrary host state.

Fork verification: record cutoff/current parent config; test initial/current/asOf separately, branch-only entries/state absent from parent/sibling active context, provider identity fresh, and a parent Task ALREADY running before fork not cloned. Invoke an allowed tool in each scope to record conversationId/taskId/callId and resolved tool/config/environment. Do not equate wrapped Models object identity with serialization or independence.

### 7.3 Reset and native self-handoff

Inside a host with root/context, standalone operations are positional:
```ts
await root.reset(undefined, context); // empty new active context
await root.reset("Objective, verified partial, next action, constraints, output schema", context);
```
reset returns void after admission; it gives no new Task/Submission ID. When queued behind busy work and placed, the current run ends unanswered/reset; later inputs run in new context. To keep the SAME input running, a registered tool's execute result can instead be:
```ts
return { output: [], control: {
  handoff: "Stage2. Verified partial323. Add23, return {result:number}. Do not repeat stage1.",
} };
```
This return belongs INSIDE execute, not at module top level. It is intentional transfer of actual partial state, not a way to inject oracle answers into a test. Selected system sections and tools reappear after reset; it is not revocation or raw-history deletion. Bound stages and remove inappropriate tools/configurations if enforcing no repeated handoff.

Historically tested faults: omitting the output schema produced prose; still-offered handoff tool repeated to a turn limit; a verifier wrongly expected no re-emitted pi.system. Carry full next-stage contract, inspect active versus retained context, await eventual Submission answer and independently check arithmetic afterward. Negative checks should detect wrong partial/state/correlation and loops.

## 8. Message ingress, busy queues and continuation

Within a live §3-style program, assuming root is genuinely busy:
```ts
const steer = await root.submit({ type: "input", content: "New constraint",
  whenBusy: "steer", whenIdle: "reject", requestId: "operation:late:1" }, context);
const follow = await root.submit({ type: "input", content: "Next task",
  whenBusy: "followUp", requestId: "operation:follow:1" }, context);
```
These fragments require the stated busy condition; they are not standalone busy fixtures.

- Default input mode is followUp. Both durably queue while busy in pi.inbox.
- Steer lands at the post-tool boundary and joins current work; it does not rewrite a sent provider request or interrupt an executing tool.
- Follow-up lands at final boundary for successor work. Explicit steeringMode/followUpMode select all or one-at-a-time. Mixed-mode/global FIFO/fairness needs its own proof.
- whenBusy reject throws ConversationBusy; whenIdle reject plus steer throws ConversationIdle without starting a run. AfterRun tasks can keep a conversation busy after its answer; late input can then await successor work.
- Model-less passive writes can append immediately; writes with model/head/edits wait for a boundary. Do not assume all write/input classes share FIFO.
- submission.abort withdraws queued ingress, not already-placed work. Inspect the result/status.
- afterFailedRun policy defaults keep; continue and withdraw are options. A `{ type: "continue" }` input is idle-only, never queued, can join retained queued input or fail nothing_to_answer. It is not replay of the old request.
- submit(tx, draft) admits in your own commit, once, before table writes; documents may surround it. ReadAfterWrite is a real ordering constraint. Admission is provisional until that commit stores. Bind authorization/application receipts to the same authoritative admission boundary where appropriate.

**Busy queue verification recipe:** establish committed placed Submission, live run, generation waiting on a RUNNING tool gate, empty inbox. Only then generate late marker strings, solely in new ingress. Initial prompt/system/tools/results must not contain them. An observer-only beforeRequest records messages and returns undefined. Check both late Submissions queued and absent from already-sent request; release gate; show correct boundary, run identity, placement order, subsequent provider visibility/use and complete settlement. For explicit all mode, steer belongs to same run and followUp to successor work. Compare an idle rejected steer before/after: no new entries, Submissions, Tasks, inbox items or model requests. Use false-busy, reversed-order, early-leakage and missing-settlement negatives.

Historically tested homogeneous explicit-all behavior satisfied that procedure, not mixed/default/global ordering. A512-token allowance yielded hidden thinking and no visible output. Another answer was semantically correct but added spaces around a separator: preserve it and narrowly normalize whitespace if the contract permits, rather than buying another generation solely for formatting.

## 9. Parallel work, joins, observation and status

Independent Tasks/Conversations can progress concurrently in one Harness. Async overlap does not prove CPU threads, provider parallelism, fairness or a public task maxConcurrency guarantee. Tool rounds support toolExecution parallel/sequential; one tool's sequential executionMode makes its round sequential. Application pool/aggregate limits are a different responsibility.

Persistent join pattern: inside a Task phase's runtime.commit, create owned child Tasks and return `{ status: "waiting", checkpoint: { phase: "decide", childIds }, on: childIds, policy: "allSettled" }`; in decide use `runtime.outcomes(childIds, context)` before committing the parent's decision. The named child definition/input, State union and decide handler must be supplied by your application, following §6. failFast instead aborts peers on failure—choose deliberately, because that is NOT peer-failure isolation. Promise.all local state is not a durable join.

Diagnostic operations: harness.inspect(context) reads live Tasks/unsettled Submissions and blocked definitions without running code; getTask(id, context) retrieves a receipt; waitForTask(id, context) enables progress and joins terminal state. LiveDoc.run means a Conversation is busy; task graph live nodes/ownership edges disappear when terminal. A completed background anchor can still own a usable Conversation: retain ConversationRecord.owner links, not only current graph shape.

Observation fragment within §3's try block, after root exists:
```ts
const watch = await root.watch(context);
console.log(watch.value);
watch.start(async (call) => {
  if (call.kind === "value") console.log(call.value);
});
// Stop this watch before leaving its owning lifecycle:
await watch.stop();
```
This attaches and immediately stops for illustration; keep it attached for the actual period you supervise. It is not historical replay. Watches expose bounded windows; use entries paging/ConversationTranscript gap handling for full raw history and context(context) for active provider context. Synchronous observers must stay fast and must not await/re-enter the Harness. Deferred progress can be ahead of storage; stored-commit observation is required for disk-durability claims.

To prove overlap, require committed starts and a Task graph showing both tasks nonterminal before releasing deterministic gates. Include target abort and a healthy peer still live before release and successful afterward. Cancelling only a wait must leave work live. These component behaviors were historically tested; they do not establish the entire real-model background-management integration.

## 10. Cancellation, supervision and collaboration ownership

| Intent | Operation | Completion proof |
|---|---|---|
| Stop waiting | Cancel that wait's Chord Context | Work may still run; retain owner/return path |
| Withdraw queued input | submission.abort(context) | Confirm withdrawn versus placed/settled |
| Abort exact Task | harness.abortTask(id, context) | Mark is not terminal; join waitForTask |
| Stop Conversation ordinary scope | conversation.abort(context) | Queued inputs withdrawn, queued writes stay; ordinary scope idle |
| Include background work | conversation.abort(context, { background: true }) | Verify intended subtree; this is not peer-targeted cancellation |
| Close runtime | harness.close(context) | Recoverable pending work differs from business cancellation |
| Stop outer application process/job | Host's actual lifecycle API | Native abort is not a substitute for host permissions/attempt fencing |

Abort is bottom-up through ownership; cleanup can delay settlement. Wrong, completed, foreign and stale targets need explicit handling. Closing does not compensate uncertain external effects. Retry/recovery of whole workflows must preserve completed work, not blindly execute every child again.

**Application supervision recipe (recommendation):** one coordinator owns the user outcome and durable work ledger; persist task/correlation IDs before losing local context; give bounded independent work isolated write targets; agree result schema and verification obligation before dispatch; establish a supported return path; inspect terminal state AND semantic outcome; independently verify substantial changes; then record acceptance. Delivery, review and owner acceptance are separate. A callback/notification or successful checkout/transport is not business success. Deduplicate exact completed returns by work identity plus attempt/owner epoch, not name alone; never let a stale return settle newer work. Do not add polling watchers when an existing durable completion path exists. During claim-based scheduling, validate dependencies and actual claimant: claimed work can cease appearing in an unclaimed frontier list without becoming invalid.

## 11. Background worker management — self-contained reference-derived module

Pi Durable has no built-in spawnAgent API. The following complete **ADAPTATION** is application code composed from native documents/tasks/ownership. It is uncompiled/unexecuted here and NOT proof of the real-model integrated loop. It inlines the essential public reference rather than requiring its repository example.

### 11.1 Known source issue and limits before use

At the pinned upstream background example, reply returns content; public ToolExecutionResult and inspected finalResult/appendToolResult read output. No mapping was found in that result path. That is a source-supported EMPTY MODEL-RESULT RISK, not a freshly reproduced runtime failure. This adaptation explicitly returns output, omits undefined checkpoint fields, and adds small input/worker-count checks. Those adaptations are NOT independently validated fixes of the entire loop. Typecheck AND exercise actual model-visible results before real use; structural typing alone may admit extra content when details also matches.

Background Tasks are ownership boundaries, not detached OS processes. Main ordinary idle/abort skips them; explicit background abort can reach them. Reporter completion proves report admission, not parent consumption. A queued report can be withdrawn by parent abort, while a later report can start another turn. Request IDs do not promise exactly-once main consumption.

### 11.2 Complete `background-tools.ts`

Save this sibling file beside minimal.ts. It imports ONLY public installed packages and has no private helper dependencies.

```ts
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { bool, obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  AssistantEntry, configure, defineDoc, defineExtension, defineTask, defineTool,
  LiveDoc, type ConversationId, type EntryId, type TaskId,
} from "@earendil-works/pi-durable";

type Worker = { conversationId: ConversationId; reported: EntryId[] };
export const Workers = defineDoc<{
  agents: Record<string, Worker>; reporters: Record<string, TaskId>;
}>({
  kind: "app.workers", version: 1, scope: "conversation", history: "latest",
  fork: "initial", initial: () => ({ agents: {}, reporters: {} }),
  checkpointWhen: () => false,
});
const Anchor = defineTask<null, { phase: "done" }, null>({
  name: "app.worker-anchor", version: 1, initial: () => ({ phase: "done" }),
  phases: { done: (_task, runtime, ctx) => runtime.commit(() => ({
    status: "terminal", outcome: { status: "completed", result: null },
  }), ctx) },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({
    status: "terminal", outcome: { status: "aborted" },
  }), ctx),
});
type ReporterInput = { name: string; conversationId: ConversationId; message: string; followUp: boolean };
type ReporterState = { phase: "deliver" } | { phase: "report"; report?: string };
function textOf(message: AssistantMessage | undefined): string {
  return (message?.content ?? []).flatMap((part) => part.type === "text" ? [part.text] : []).join("");
}
const Reporter = defineTask<ReporterInput, ReporterState, null>({
  name: "app.worker-reporter", version: 1, initial: () => ({ phase: "deliver" }),
  phases: {
    deliver: async (task, runtime, ctx) => {
      const { name, conversationId, message, followUp } = task.input;
      const worker = await runtime.conversation(conversationId, ctx);
      if (worker === undefined) throw new Error("Missing owned worker");
      const submission = await worker.submit({ type: "input", content: message,
        whenBusy: followUp ? "followUp" : "steer", requestId: `worker:${task.id}` }, ctx);
      const settled = await submission.wait(ctx);
      await runtime.commit(async (tx) => {
        const next = (report?: string) => ({ status: "running", checkpoint: {
          phase: "report", ...(report === undefined ? {} : { report }),
        } }) as const;
        if (settled.status === "unanswered") {
          return next(settled.reason === "aborted" ? undefined : `[worker ${name} failed: ${settled.reason}]`);
        }
        if (settled.type !== "input") return next();
        const index = await tx.doc(Workers, runtime.conversationId);
        const workerState = index.agents[name];
        if (workerState === undefined || workerState.conversationId !== conversationId) {
          throw new Error("Worker attribution changed");
        }
        if (workerState.reported.includes(settled.answer)) return next();
        workerState.reported.push(settled.answer);
        const entry = await tx.entry(AssistantEntry, settled.answer);
        const answer = entry?.model?.[0] as AssistantMessage | undefined;
        return next(`[worker ${name} answered, no reply needed] ${textOf(answer)}`);
      }, ctx);
    },
    report: async (task, runtime, ctx) => {
      const report = task.state.checkpoint.report;
      if (report !== undefined) {
        const main = await runtime.conversation(runtime.conversationId, ctx);
        if (main === undefined) throw new Error("Missing main conversation");
        await main.submit({ type: "input", content: report,
          whenBusy: "followUp", requestId: `worker-report:${task.id}` }, ctx);
      }
      await runtime.commit(() => ({ status: "terminal",
        outcome: { status: "completed", result: null } }), ctx);
    },
  },
  abort: (_task, runtime, ctx) => runtime.commit(() => ({
    status: "terminal", outcome: { status: "aborted" },
  }), ctx),
});
const management = defineTool({
  name: "subagent", description: "Spawn/send/status/stop named background workers. Replies arrive later.",
  parameters: obj({ action: oneOf(["spawn", "send", "status", "stop"]),
    name: opt(str()), message: opt(str()), followUp: opt(bool()) }),
  replay: "unsafe", // replayed stop could stop newer work
  execute: async (args, api, ctx) => {
    const { action, name, message, followUp } = args;
    const reply = (text: string, conversationId?: ConversationId) => ({
      output: [{ type: "text" as const, text }],
      ...(conversationId === undefined || name === undefined ? {} : { details: { name, conversationId } }),
    });
    if (name !== undefined && !/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(name)) return reply("Invalid name");
    if (message !== undefined && (message.length === 0 || message.length > 4000)) return reply("Invalid message length");
    const index = (await api.snapshot(Workers, api.conversationId, ctx)) ?? { agents: {}, reporters: {} };
    if (action === "status") {
      const names = name === undefined ? Object.keys(index.agents) : [name];
      const lines: string[] = [];
      for (const each of names) {
        const worker = Object.hasOwn(index.agents, each) ? index.agents[each] : undefined;
        if (worker === undefined) continue;
        const busy = (await api.snapshot(LiveDoc, worker.conversationId, ctx))?.run !== undefined;
        lines.push(`${each}: ${busy ? "working" : "idle"}`);
      }
      return reply(lines.length ? lines.join("\n") : "No workers");
    }
    if (name === undefined) return reply("Name required");
    const existing = Object.hasOwn(index.agents, name) ? index.agents[name] : undefined;
    if (action !== "spawn" && existing === undefined) return reply("Unknown worker");
    if (action === "stop") {
      const worker = await api.conversation(existing!.conversationId, ctx);
      if (worker === undefined) return reply("Worker no longer available");
      await worker.abort(ctx);
      return reply(`Stopped ${name}`, existing!.conversationId);
    }
    if (message === undefined) return reply("Message required");
    const result = await api.commit(async (tx) => {
      const state = await tx.doc(Workers, api.conversationId);
      const background = { ownership: { kind: "conversation" }, background: true } as const;
      if (action === "spawn") {
        if (Object.hasOwn(state.agents, name)) return "Name exists; use send";
        if (Object.keys(state.agents).length >= 2) return "Worker limit reached";
        const anchor = await tx.createTask(Anchor, null, background);
        const child = await tx.createConversation({ ownership: { kind: "task", taskId: anchor } });
        await configure(tx, child.id, { extensions: { remove: [BackgroundTools] },
          instructions: `You are worker ${name}. Answer only the main agent's bounded requests.`, maxTurns: 8 });
        state.agents[name] = { conversationId: child.id, reported: [] };
      }
      const conversationId = state.agents[name]!.conversationId;
      state.reporters[api.taskId] = await tx.createTask(Reporter,
        { name, conversationId, message, followUp: action === "send" && followUp === true }, background);
      return action === "spawn" ? `Started ${name}` : `Sent to ${name}`;
    }, ctx);
    const current = (await api.snapshot(Workers, api.conversationId, ctx))?.agents[name];
    return reply(result, current?.conversationId);
  },
});
export const BackgroundTools = defineExtension({
  name: "background-tools", tasks: [Anchor, Reporter], tools: [management],
});
```

### 11.3 Host wiring and correct interpretation

In minimal.ts add `import { BackgroundTools, Workers } from "./background-tools.ts";` and `registry.install(BackgroundTools)` immediately after creating registry and BEFORE Harness.open. Those are the only extra local-file dependencies, and the entire file is provided above. For actual model-issued calls, use an approved tool-capable provider and root model as §4 explains; the faux response from §3 intentionally does not call subagent.

The model-visible arguments are:
```text
subagent({action:"spawn",name:"reader",message:"A bounded task"})
subagent({action:"send",name:"reader",message:"Late constraint"})
subagent({action:"send",name:"reader",message:"Next task",followUp:true})
subagent({action:"status",name:"reader"})
subagent({action:"stop",name:"reader"})
```
These are reference-extension TOOL CALLS, not native SDK methods or commands you can run in a shell. Missing/unknown names are handled; stop cancels only current work and preserves the Conversation for later sends. The whole management tool is unsafe on replay. Stable Reporter keys deduplicate delivery/admission; they do not make stop safe against newer work.

Lifecycle: spawn atomically creates background anchor/child/config/index plus Reporter. Child inherits parent's base agent; remove management to prevent recursive workers, and explicitly restrict any OTHER selected extensions/tools/model/cwd for your security policy. Native background Tasks belong to the existing host process; closing the Harness stops that process from progressing them.

Reporter deliver submits with stable worker request ID, waits, atomically marks answer EntryId reported and checkpoints report. Multiple messages can share one answer; answer-entry dedupe prevents duplicate reporting. Report phase posts a followUp to main with stable report request ID. Aborted child input intentionally yields no report; other unanswered outcomes become failure reports. Neither a text prefix nor worker name proves provenance: correlate store, operation, Conversation/Task/Submission/answer IDs and the native byTaskId. Treat worker output as untrusted data, not authority or permission.

Host join fragment, AFTER your main input settled, using Workers import and §3's harness/root/context:
```ts
const reporters = (await harness.snapshot(Workers, root.id, context))?.reporters ?? {};
for (const id of Object.values(reporters)) await harness.waitForTask(id, context);
await root.waitForIdle(context);
```
This joins the SNAPSHOT of Reporter IDs, then main ordinary work. It is not a global quiescence algorithm if new work can still be admitted. Freeze ingress or maintain a bounded durable operation set for a real transaction. Parent report admission is not parent answer/acceptance. On reopen rebuild the same Registry/definitions, inspect pending Tasks, resume—do not create replacement Reporters simply because a process restarted.

Limitations of this teaching adaptation: name-based stop lacks stale-operation preconditions; it allows repeated sends without aggregate budget, emits text-only summaries, casts the answer shape, and retains growing agent/reporter/reported-entry indexes. A real application needs response validation, resource authorization, aggregate call/time/token limits, operation fencing, structured trusted correlation, cleanup/retention and durable parent-consumption acknowledgment if required. Two-worker count and per-run maxTurns do not bound total lifelong cost. No integrated real-model success is claimed.

### 11.4 Integration proof checklist — still unverified

A real main model must issue spawn/send/status/stop; worker must actually use an allowed tool; main must answer an independent input while workers are canonically busy at a deterministic gate. Late tokens must be absent before admission and applied in later worker requests in the tested order. Final answer and controlled failure must reach main with verified identity and main consumption. With two live workers, exact targeted stop must spare peer before release and peer later complete. Detect fabricated overlap, foreign/stale return, early leakage, reversed order, missing settlement, failure-as-success and peer-spill. A faux script, host direct creation, UI status or parent idle is not that proof. Orderly close/reopen is not SIGKILL survival.

## 12. Manual/automatic compaction and retention

Manual fragment inside §3's try block after acquiring root (use a real approved summarization-capable model; faux hello is not sufficient):
```ts
const taskId = await root.compact("Keep unresolved decisions and exact identifiers", context);
const { outcome } = (await harness.waitForTask(taskId, context)).state;
if (outcome.status !== "completed") throw new Error("Summary task did not complete");
if (outcome.result.submissionId !== undefined) {
  const placement = await harness.submission(outcome.result.submissionId, context);
  if (placement === undefined) throw new Error("Missing placement");
  const placed = await placement.wait(context);
  if (placed.status !== "done") throw new Error(`Placement failed: ${JSON.stringify(placed)}`);
}
```
No placement ID can mean a legitimate no-op. Task success, placed summary and summary usefulness are separate claims. Placement may be stale; manual abort, declined/noop, successful summary and instruction contrast should be separate controls. reset returns void, compact returns a TaskId; neither should be treated as an invented JSON endpoint. Omit positional note with undefined, not untyped null.

Automatic policy lives in Harness settings, read dynamically. Fields: enabled, reserveTokens, keepRecentTokens, backgroundTokens and modelOverrides keyed by exact provider/modelId. Background distance0 disables background initiation, not all blocking/manual/overflow paths; enabled false disables automatic policy but not manual compact. Smaller client windows are policy fixtures, not backend exhaustion.

Budget calculation before requests:
- summary output cap = min(floor(0.8 × reserveTokens), model.maxTokens)
- strict background pressure threshold = contextWindow − reserveTokens − backgroundTokens
- blocking threshold = contextWindow − reserveTokens
- keepRecentTokens must leave an actual selectable old prefix.

Historical successful synthetic settings context12288/output8192/reserve8192/keep700/background1024 gave3072/4096 thresholds and6553 summary cap. These are NOT production defaults. A1024 reserve capped summaries at819; raising ordinary output alone did not raise that cap. Source supports provider-overflow compaction and one retry as a distinct path; failure of a blocking waited summary can fail generation before another request.

**Automatic proof procedure:** hash all old evidence, freeze finite calls/inputs/output/turns/wall/summaries/placements before effects; bind only the actual allowed model and disable retries/fallback in controlled experiments. Plant facts once in separate early ordinary inputs; grow history only through normal submissions. Observer hooks record request pressure, compaction Task/trigger/selection but return undefined and never inject summary. Correlate threshold crossing with native background Task, selected IDs/first-kept and actual model summary. Await Task AND placement; require pi.compaction/head. Compare active summary/tail with raw history, independent continuation, conditional unknown recall and a matched automatic-disabled control crossing equivalent pressure. An orderly read-only reopen tests persistence, not crash.

For repeated-summary retention, one store/Conversation must traverse multiple actual placements; second selection must include the first summary and its messages. Before recall, scan active entries AND provider messages: every planted value must occur only in current summary. Tail/system/assistant/tool/host/prior-recall copies invalidate exclusive-retention claims. Old raw entries/old summaries may remain stored. Historical reviewer-supported two-summary observations are bounded and not universal retention or completed integration acceptance. Authoritative exact facts should live in documents or external records, not only a lossy summary.

## 13. Recover from summary failure and avoid false proof

1. Preserve original failed Task, error/finish reason, trace/store and compactionFailure. Check no result/placement/pi.compaction exists and all selected prefix IDs remain raw AND active.
2. Diagnose reserve/output/selection together. Do not manually inject a summary, silently retry or rename a failed run successful.
3. If authorized to continue ordinary work, change only owned dynamic policy (for example a getter-backed compaction.enabled=false) after failure. A historical same-Conversation case remained useful after that explicit change. This proves non-poisoning after policy action—not automatic self-healing.
4. Verify useful same-Conversation settlement and empty intended live scope; compare a separate healthy summary/placement control. Keep provider/session/store identity and policy action explicit.
5. Plan any new correction prospectively with finite cumulative budgets; repeated failures with one premise require diagnosis, not cosmetic regeneration. Reuse unaffected proof rather than rerun it.

**Absence oracle failure and correction:** “No bird was provided; return null” tests formatting. Ask conditionally for an explicitly assigned field, otherwise null, WITHOUT asserting absence or leaking expected value. After null settles, plant a new value via ordinary input and repeat the IDENTICAL conditional query; require non-null. Reject a blind-null countercontrol, original oracle-fed wording, missing failure, false placement, wrong Conversation and unsettled continuation. Historical conflicting PASS/HOLD reviews were preserved; the false negative was corrected rather than waived.

**Store-correlation failure:** separate stores reused numeric IDs; a shared observer incorrectly cross-joined them after model work completed. Tag every event with fixture/store or slice arrays at boundaries. Correct a host-only observer from retained canonical state where sufficient; do not buy another live run to conceal an observer error.

## 14. External effects, backend durability and restart

### 14.1 Effect safety and reconciliation

Historical deliberate counterexample: replay-safe incorrectly declared for non-idempotent append, process killed after fsync but before native result → TWO effects/ONE result. Truthful default unsafe → ONE effect plus interrupted/failed ambiguity. Completed-safe reopen stayed1/1. Stored AND current safe policy governed replay permission; it did not deduplicate external actions.

Procedure: classify pure/read-only/idempotent-with-durable-key/unsafe; persist intent+stable operation key; perform effect OUTSIDE transaction; persist actual receipt/result; if effect/result cut is uncertain, query/reconcile the SAME key at the external system. An absent durable dedupe service/receipt is an actionable dependency, not permission to resend. Cancellation/timeout/compensation can all be ambiguous additional effects. Never claim exactly-once from native request IDs, task memos or nested replay keys alone.

Teaching-example cautions: an in-memory payments Map is not cross-process dedupe; memo-before-print can suppress duplicates but can lose the print if the process dies after memo and before effect. Atomic native checkpoints do not make arbitrary outside effects atomic.

### 14.2 Backend and supervisor selection

- MemoryStorage: disposable, no process persistence.
- JSONL: public `openNodeJsonlStorage(directory, context, options?)` from `@earendil-works/pi-durable/storage/jsonl/node`; append-only directory, optional `{ fsync: true }`. Whole retained history is also in memory. Compaction does not erase it or guarantee low startup/memory cost.
- SQLite: openNodeSqliteStorage(path, options?) from the import used above. Pinned source describes WAL+synchronous NORMAL: process crash survival, but newest commits can be lost on power/host failure. Not replication/backup.
- Browser IndexedDB/custom/Cloudflare: require their own persistence/owner/wake integration and conformance checks. A table prefix is not migration or tenant authorization. Shared DB work must use the adapter's operation/transaction queue, not bypass it.

One process owns a physical store; native storage has no cross-process writer locking. Host enforces exclusivity before opening. Close before reopen and do not treat two Harnesses on one store as distributed collaboration.

On storage failure, the Harness fails/closes; pending waits reject SessionFailed, watches fail and task code is signaled. Do not keep writing through the failed instance. A supervisor must preserve storage/IDs, restore compatible definitions and reopen: durable-but-unpublished commits can be recovered, so reuse request/operation IDs. Invalid read errors can be local to that read; commit/storage failures are not interchangeable.

SDK does not resurrect an OS process. Host owns restart/backoff and avoiding overlapping writers. onReport/harness.closed and wake/onWake are signals, not deployment policy. settings.restartLimit bounds repeated interrupted task phases; model retry and normal close have distinct semantics. For evictable hosts, stored sleep deadlines require host alarms/wakes, armed before work-starting operations; missing alarms strand work. Bound repeated continuations/Reporter feedback loops across runs, not only each run's maxTurns.

## 15. Verification, evidence preservation and recovery checklist

Future authorized implementation checks—not tests executed for this document:

1. Record exact SDK/runtime and loaded application build. Inspect actual exports/declarations, not stale TOC. Classify behavior used/partial/unwired in a NAMED consumer/unsupported at this release/unverified, rather than claiming global availability/absence.
2. Before each attempt hash ALL then-current prior evidence; use unique roots and exclusive-create receipts. Actually enter/assert isolated cwd before fixed-path scripts. Merely making a directory is not isolation. Do not use private test scripts from another workspace: supplied files and your own explicitly defined tests are the starting point.
3. Record admission/placement/answer or unanswered settlement/acceptance separately. Raw failure/HOLD/conflicting review and procedural misses remain immutable historical evidence.
4. Independently verify arithmetic/result schemas after receipt; wrong state/value/IDs and fake completed cache must fail. Strict parsing must reject truncated structured text.
5. Use the gate-based queue, fork, abort/healthy-peer, compaction selection/placement/failure/retention and background integration controls in §§6–13. A timed delay/host boolean is not canonical causality. Global FIFO, fairness, ACL, physical overflow, power loss and broad-model behavior require their own tests.
6. Compare before/after every baseline file. Equal file sizes are NOT equal hashes. Earlier overwrite without a baseline cannot be repaired retroactively by a later manifest. Inspect manifest schema: a hashes ARRAY is not a path-keyed object. Never reuse an old file count as the current inventory.
7. On EEXIST from an exclusive-create finalizer, inspect the existing receipt. Use a NEW unique path for independent comparison; do not delete/overwrite evidence to make a command succeed. Prefer pure stored-result validation over rerunning side effects.
8. If machine-validated result receipts are required: construct one whole current-purpose JSON object, omit undefined, serialize/parse/identically reserialize, write exclusively, read identical bytes and hash them. Do not claim this was done by merely reading storage or borrow a previous test's receipt.
9. Review exact delivered revision and actual native/provider/effect proof. Compilation proves compilation; a test proves exercised cases; semantic PASS is not full procedure compliance. A transport/checkout/notification success is not owner acceptance.
10. Stop at real safety/resource boundaries. Correct reversible implementation faults within existing authority, but do not generate new tests/models/crashes during a documentation-only request or restart unrelated work.

Useful record fields for your own ledger: store identity, operation/request key, Conversation/Task/Submission/answer IDs, owner/attempt epoch, model route and actual response evidence, policy/budget, timestamps, commands/exits, result, raw failure and verification limitations. Sanitize credentials/prompts/private data. Request counts/tokens/catalog prices/percentage allowances are different units; ordinary investigation inference has overhead.

## 16. Diagnostic decisions

| Symptom | Inspect | Recovery/prevention |
|---|---|---|
| Empty tool acknowledgment | ToolExecutionResult.output, actual toolResult entry | Fix content/output contract in application code; test actual model visibility |
| Task never reaches gate | resume/progress enabled, pending/blocked state | Restore scheduling/definition under owner; do not claim concurrency failure |
| Tool returns after invocation ended | Invocation-bound api lifetime | Keep work in durable owned Tasks; do not retain api handles in detached promises |
| Summary Task done but context unchanged | no-op/stale/placement/head | Await placement separately; do not count unplaced summaries |
| Empty length response | Hidden thinking/output and summary cap | Recompute coupled budgets; retain failure and bound new attempt |
| Late constraint seems ignored | Inbox/mode and sent-request chronology | Check next eligible request; no immediate interruption guarantee |
| Wait cancelled, work lives | Which Context/API and owner subtree | Abort actual intended work if authorized, then join; preserve peer |
| Parent idle, worker active | Background anchor/Reporter indexes | Explicitly join intended operation set, not ordinary idle alone |
| Reporter done, parent silent | Parent admission/withdrawal/settlement | Dedupe admission is not consumption; inspect abort chronology |
| Restart repeats effect | Effect versus native-result cut, external receipt | Reconcile same key; never mark unsafe action safe to silence fault |
| Wrong retention attribution | Store labels, all active/provider occurrences | Fix joins and contamination controls without fabricating missing evidence |
| Missing definition after reopen | Registry name/version/migration | Install compatible definitions, not a duplicate task/store reset |
| Close hangs | Completing/owned work, cancellation cooperation | Bound external I/O; supervisor owns final process policy |

## 17. Portability checklist and use limits

- [x] Core lifecycle, API distinctions and trust boundaries defined without internal record access.
- [x] Public dependencies and version/runtime prerequisites stated.
- [x] Every executable filename referenced in setup is supplied here; optional background-tools.ts is supplied in full and its host integration is explicit.
- [x] Other snippets name required imports/variables/call sites and are labeled fragments, not standalone files.
- [x] Local provider example includes endpoint/catalog/auth contract; endpoint existence/capacities are explicit external prerequisites, not assumed discoveries.
- [x] All eight specialist procedures have essential steps/gotchas/controls inlined: API audit, transport, crash/checkpoints, handoff, forks/tasks, manual/reset, busy queues and automatic-compaction recovery.
- [x] Private commands, testing-source paths, active campaign state and internal IDs are not needed by main instructions. Private historical locators are intentionally omitted.
- [x] Tested versus source-supported versus unexecuted adaptation distinguished; content/output issue, loss windows and integrated-loop gap preserved.
- [x] Documentation review/readback is not a claim of new compilation, tests, hash computation or exhaustive API verification.

External prerequisites: supported Node/npm, installed pinned packages and an owned writable directory for SQLite examples. Normal network/package-registry access may be needed to install. Real inference additionally needs an approved tool-capable endpoint/model, accurate capability metadata, legitimate credentials when required and budget. Production requires your own supervision, authorization, sandboxing, external-effect reconciliation and tests. No Substrate access or private artifacts are required. The faux/pure examples need no provider credentials. Copy this entire document, including public link definitions if retaining citations.

Documentation revision procedure: preserve one canonical file; re-pin on upgrade; compare actual exported/declaration/implementation contracts; keep failed historical evidence qualified; audit every internal reference and every use of “see”, “run”, or a relative path for a missing dependency; read final persisted text through EOF at one revision. Do not use a greedy `.*` search across escaped JSON tool results: use bounded literal headings/targeted pages to avoid accidentally returning a whole document.

## Appendix A — optional public contracts and read coverage

All links use upstream revision f9a26365568127461c47a07a37dcb42c140a3ac5/version1.5.0; installed declarations remain authoritative for your environment. These support checking/upgrading, not hidden required steps.

- [Durable README](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/README.md): complete content inspected previously; lifecycle, tools, settings, queue/reset/compaction/ownership/state/storage/errors used here.
- [Normative specification](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/docs/spec.md): initial12000-character prefix inspected, not the entire specification.
- [Public Harness contracts](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/src/harness/types.ts): selected Submission/Conversation/ToolExecutionResult/Harness/settings declarations inspected, not exhaustive.
- [Tool implementation](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/src/harness/tool.ts): finalResult/appendToolResult/output path inspected, not full implementation.
- [Package metadata](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/package.json) plus public source index and Node SQLite/JSONL adapters inspected for exports/version/prerequisites.
- [AI README](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/ai/README.md): initial provider/auth material and later Custom Providers section inspected; whole AI reference not read exhaustively. No endpoint/auth availability probe performed.
- [RPC overview](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/coding-agent/docs/rpc.md): framing/lifecycle overview read; detailed linked commands/events not exhaustively audited.
- [Background worker example](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/test/examples/22-subagent-background.ts), [Task example](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/test/examples/11-tasks.ts), [Recovery example](https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/packages/durable/test/examples/12-recovery.ts): complete content inspected in the earlier research pass. Their private repository-relative imports/launch commands are NOT needed by the files supplied here. Web extraction can omit TypeScript generics; do not infer changed APIs from text-extraction loss.

No new compilation, tests, model probes, source edits, provisioning, installs, retries, workers, config/auth changes or external publication were performed for this portability edit. No exhaustive API verification, raw-store re-audit, loaded-production-build attestation, security certification, physical-overflow/power-loss proof or arbitrary external exactly-once is claimed.
