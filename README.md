# durable-chat

A small terminal coordinator for durable pi agents.

One main conversation stays available to you. It delegates longer work to **background jobs**: separate
persisted agent conversations with a minimal covering tool set and the Substrate MCP gateway. Jobs keep
running while you keep chatting, survive process restarts, and can be inspected, continued, compacted,
reset, or cancelled. A job can hand its remaining work to a successor job or back to the coordinator.

Built on `@earendil-works/pi-durable` 1.5.0 (SQLite storage), `pi-ai`, `pi-schema`, and `pi-mcp`.

Maintainer overview: [docs/HANDOFF.md](docs/HANDOFF.md).
Release process: [docs/RELEASING.md](docs/RELEASING.md).

## Install and run

Requires Node >= 22.19 (developed on Node 26).

Install from [npm](https://www.npmjs.com/package/durable-chat):

```sh
npm install -g durable-chat
dchat help
dchat --provider faux --no-mcp ask "hello"  # offline; no model account required
```

Alternatively, install the reviewed archive from the [GitHub release](https://github.com/thorinside/durable-chat/releases):

```sh
npm install --global https://github.com/thorinside/durable-chat/releases/download/v1.0.0/durable-chat-1.0.0.tgz
```

For a source checkout:

```sh
git clone https://github.com/thorinside/durable-chat.git
cd durable-chat
npm ci --ignore-scripts
npm run build
npm link --ignore-scripts
```

Then configure a provider before interactive use:

```sh
dchat config init   # only if ~/.config/durable-chat/config.yaml is missing
dchat config set baseUrl http://127.0.0.1:1234/v1  # your local inference server
dchat              # full-screen TUI
dchat --plain      # line-oriented chat
```

Published packages contain built JavaScript, not TypeScript entrypoints. Node refuses native
TypeScript stripping inside `node_modules`, so a working source checkout or `npm link` alone does
not verify an npm release. No compiler is required to run an installed release.
Git is required for managed worktrees; a compatible terminal is required for the interactive TUI.

Defaults live in `~/.config/durable-chat/config.yaml` (or `$XDG_CONFIG_HOME/durable-chat/config.yaml`).
The generated file points the store at `~/.local/share/durable-chat/store.sqlite` and selects local
inference. One process owns a store; a lock file (`<store>.lock`) enforces that and reclaims a lock left
by a dead pid.

On macOS in Ghostty, an interactive `dchat`, `dchat tui`, or `dchat chat` launch for an already-open
store focuses its existing terminal (including its tab/split) and exits successfully. The owner is
matched by PID or TTY; the single-writer lock stays in place. Batch commands and SSH sessions retain
the normal lock error. If Ghostty cannot focus the terminal, or Automation permission is denied,
the original error is shown. This uses Ghostty's `macos-applescript` support (enabled by default);
macOS may ask for Automation permission on the first use.

## ACP attachment to an already-running Main

An open dchat runtime exposes only Main through a user-private Unix socket. The
lightweight frontend uses the same effective configuration/database selection as
normal dchat; it never opens another runtime, launches dchat, or forks state:

```sh
dchat acp                 # standard ACP JSON-RPC over stdio; normally started by the runner
# Explicit configuration is also supported:
dchat acp --config /absolute/path/to/config.yaml
```

The socket lives in a private `/tmp/dchat-<uid>` directory regardless of `TMPDIR` or
`XDG_RUNTIME_DIR`, so a frontend started by a service finds the terminal's owner. If the
endpoint cannot be served, dchat itself still starts; `dchat info` reports ACP as unavailable
and why.

Start the ordinary TUI/plain owner first. No existing owner means unavailable,
not auto-start. Multiple instances may own different databases; cwd alone is not
instance identity. Main input/output, reported tools, and Main's normal job notices
are shared with the terminal. Job conversations cannot be listed or addressed by ACP.
Remote input uses native follow-up ordering. Disconnecting a frontend only detaches;
Stop Main cancels Main and queued input from either interface while background jobs survive.

This is an attach-only ACP v1 profile: use advertised `session/list` and `session/load`
for complete replay. `session/resume` is not advertised in this first slice.
`session/new`, client-supplied MCP servers and
changes to the existing owner's model/instructions are refused explicitly. It is not
claimed to satisfy every general ACP client's new-session/MCP expectations. Shared-Main
metadata and request correlation are defined by `src/acp.ts`; no custom content RPC
methods or ACP network listener are introduced. Existing tool/terminal permissions
remain unchanged; the frontend never approves on the user's behalf.

## Future wake-ups

Main can use its `reminder` tool to schedule a one-shot check of a long-running process,
then reply immediately instead of waiting or polling:

```json
{"action":"schedule","at":"2030-06-15T14:30:00Z","message":"Check the deployment status and report the next step."}
```

`at` must be in the future, within 365 days, with seconds and an explicit timezone.
Messages are limited to 4000 characters; at most 100 reminders may be pending.
`{"action":"list"}` lists pending IDs; `{"action":"cancel","id":"123"}` suppresses an
undelivered reminder. Cancellation cannot retract an input already admitted to Main's inbox.

Deadlines and delivery receipts persist in SQLite. While the session is running, the
Harness wakes a sleeping task at its deadline and queues a normal Main input, behind any
active turn. Restarting recovers pending reminders, including overdue ones, without
re-admitting already delivered reminders. This does **not** launch dchat or wake a sleeping
computer: keep an interactive session running, or overdue reminders run when scheduling
next resumes (for example, opening the TUI). Batch/read-only status commands do not keep a
reminder service running. Cancellation is durable immediately; its now-inert sleeping task
settles at the original deadline. Reminders do not check a process themselves or imply it
has completed; Main decides what to do when the reminder arrives.

## Configuration

Configuration is YAML, loaded on every run. Global defaults come from
`$XDG_CONFIG_HOME/durable-chat/config.yaml`, or `~/.config/durable-chat/config.yaml` when XDG is unset.
If the launch folder contains `.durable-chat/config.yaml`, its values override the global file.
Both locations accept `config.yml` as a fallback; `config.yaml` wins when both exist.
Only the launch folder is checked, not its parents.

Precedence is **CLI flag > environment variable > folder-local config > global config > built-in**.
Local files can contain just the keys you want to change. Nested `mcp` settings merge by key;
lists replace inherited lists (use `[]` to clear one). Relative paths still resolve against the launch
folder, not the config file's directory.

`--config <path>` or `DURABLE_CHAT_CONFIG` selects a **standalone** file instead of automatic global/local
layering; CLI `--config` wins over the environment selector. Missing explicit files are errors.
There is no implicit `.env` loading; `.env.example` lists equivalent environment overrides.

```sh
durable-chat config path
durable-chat config show
durable-chat config keys
durable-chat config set maxTurns 20
durable-chat config set mcp.servers '["substrate", "nt_helper"]'
durable-chat config unset jobMaxTurns
durable-chat config edit            # $VISUAL/$EDITOR
durable-chat config init --force    # rewrite the template
```

`set`/`unset` edit the YAML document in place, preserving comments and key order, and type-check the whole
file before writing. Secrets are not accepted in the file; `apiKeyEnv` names an environment variable.
`config show` prints effective values and loaded layers, never the secret itself.
`path`, `set`, `unset`, `init`, and `edit` target an existing folder-local file, otherwise the global
file. Use `--local` to target the folder even before a local file exists.
Unsetting a local key restores the inherited value. Use `--config <path>` to explicitly edit another
file. `--local` cannot be combined with `--config` or `DURABLE_CHAT_CONFIG`.

### Folder-local overrides

```sh
dchat config init --local                 # creates an empty override file, preserving global defaults
dchat config set maxTurns 30              # edits .durable-chat/config.yaml now that it exists
dchat config set store .durable-chat/store.sqlite
dchat config show                         # shows the merged settings
```

For example, a project's `.durable-chat/config.yaml` could contain only:

```yaml
maxTurns: 30
store: .durable-chat/store.sqlite
mcp:
  servers: [substrate, nt_helper]
```

Model and other unspecified settings still come from the global file. A local config does **not**
automatically switch databases; set `store` explicitly for folder-local state. Existing database contents
are not migrated. Ignore `.durable-chat/` in Git when it contains local state, and only load project
configs you trust. Without a local config, existing shared-store behavior is unchanged.

### Fork the current state into a folder

```sh
cd /path/to/project
dchat state fork
dchat
```

`state fork` snapshots the currently selected database (normally the global store) into
`.durable-chat/store.sqlite` and sets `store` in the folder's local config, creating that config if
needed. Other local overrides and comments are preserved; global configuration and source state are
unchanged. To choose a different source explicitly:

```sh
dchat state fork --store ~/.local/share/durable-chat/store.sqlite
```

This is a consistent SQLite snapshot, including committed WAL data, not a raw file copy. It can read
a running source, but does not open a Harness, connect MCP, call a model, or resume work while copying.
Existing local databases or SQLite sidecars are never overwritten, even with `--force`.
`config show` shows the selected database; persistent `DURABLE_STORE` or `DURABLE_CHAT_CONFIG` overrides
must be unset to let the new local config take effect.

The fork retains conversations, task identities, and pending work. Subsequent changes are independent.
**Both copies can resume the same unfinished work and repeat external actions**; leave the original
stopped if you want only the fork to continue. Existing jobs retain their saved working directories:
forking storage does not move files or rewrite those job locations. Saved worktree assignments are
copied as-is; main's context-fork tool can create new worktrees for independent code variants.

The generated global defaults:

```yaml
provider: local
model: nemotron-bolt
baseUrl: http://dev.local:1234/v1
contextWindow: 262144
maxTokens: 32768
streamTimeoutMs: 600000     # cold local start
retries: 1
thinkingLevel: "off"
maxTurns: 60
jobMaxTurns: 120
autoContinue: true
codemode: true                # scripts that call the conversation's tools
# More than one provider can be configured; provider selects the active entry by name.
# providers:
#   codex: { kind: openai-codex, model: gpt-6.1-sol }
#   local: { kind: local, model: nemotron-bolt, baseUrl: http://127.0.0.1:1234/v1, contextWindow: 131072 }
store: ~/.local/share/durable-chat/store.sqlite
mcp:
  enabled: true
  servers: [substrate]
  tools: []
  config: ~/.pi/agent/mcp.json
```

### ChatGPT / Codex subscription

Use your ChatGPT/Codex subscription (OAuth) rather than an API key:

```sh
durable-chat config set provider openai-codex
durable-chat config set model gpt-6.1-sol
durable-chat config set thinkingLevel medium
durable-chat config set contextWindow 500000
durable-chat config set maxTokens 128000
# An entry can hold its own settings, as providers.codex.model or providers.local.baseUrl.
```

It reads the OAuth credential already stored by pi at `~/.pi/agent/auth.json` (override with
`DURABLE_AUTH_FILE`) and refreshes it in place. If that file has no `openai-codex` credential, sign in
with `pi` first. This is a subscription quota path, not `OPENAI_API_KEY`; never copy the token into this
repository.

### OpenAI API key and local servers

Switch to the OpenAI API by setting `provider: openai`, `model: <listed id>`, and exporting
`OPENAI_API_KEY`. Set `provider: faux` for the offline scripted model.

The local provider declares `supportsDeveloperRole: false` and a chat-template thinking toggle because
llama.cpp-compatible servers commonly reject the OpenAI `developer` role. Agents run with
`thinkingLevel: "off"` to keep coordinator turns fast; change it in the config for reasoning models.

The file is read when a process starts; edits apply after restarting the process. Main and every job
use one session-wide model, initially selected at startup and changeable with `/model`. This includes
existing conversations, context forks, and handoff successors; there are no per-job model overrides.
An unfinished request retains its prepared model; it never blocks model selection. `/thinking [level]`
changes the thinking level for the run — main, existing jobs, and jobs created afterwards — without
writing the config file, so the next process starts from `thinkingLevel` again. `jobMaxTurns` remains a
creation-time job setting. Changing `store` selects another database; it does not migrate the old one.

## Repository instructions (AGENTS.md)

Main, background jobs, forks and handoff successors automatically receive applicable `AGENTS.md`
files, from filesystem ancestors through their configured working directory. Files apply only to
that directory's subtree; more-specific files override ancestor rules within their own scope.
Sibling directories are not scanned. Paths are canonicalized, including symlinks and new write paths.
Managed worktrees use their own checked-out instructions, not changes in the source checkout.

Repository text is supplied as scoped **user context**, never trusted system policy. Each model
request gets one fresh, deduplicated snapshot, without appending instruction copies to durable
history. Forks rediscover instructions for their assigned directory rather than inheriting the
source's active scopes. Existing jobs are upgraded on startup.

When `read`, `write` or `edit` targets another scope, new or changed instructions automatically
pause the operation **before it executes**. The next model request loads them; the agent can then
review and retry. This also applies to coding tools called through codemode. Up to 16 recently
discovered target directories are retained per conversation for the current runtime; changing the
conversation cwd clears them. Files are refreshed on each request and checked again before coding
operations. Unreadable, invalid or oversized instruction files fail visibly (128 KiB per file).

`bash` accepts an optional `cwd` argument for directory-aware shell work, with the same instruction
check. It affects that command only. A `cd` inside a shell command does not change the conversation's
working directory. Arbitrary shell scripts, paths embedded in commands and external/MCP tools cannot
be statically inspected: agents should use explicit `bash` cwd or a coding-tool path to discover the
scope first. Instructions are guidance, not a filesystem sandbox. Files may change concurrently;
this is not a transactional security boundary.

## Context and compaction

The context pane and `info`/`task show` show two different numbers:

- **context** — estimated size of the model request, using the same estimator Pi Durable uses
  for compaction. It counts the newest assistant usage plus estimated messages after it.
- **spent** — cumulative recorded usage (`pi.usage`), not the current context.

For `gpt-6.1-sol` the window is 500k. Pi Durable’s default compaction policy reserves 16,384 tokens,
so blocking automatic compaction starts above **~483,616** tokens; background compaction starts
32,768 tokens earlier (~450,848) when a selectable old prefix exists. It keeps about 20,000 recent
tokens, summarizes the older prefix, and places a `pi.compaction` head entry. A summary only counts
after its placement is stored.

Manual compaction: `m` on the selected target in the TUI, or `durable-chat compact [focus]` /
`durable-chat task compact <id> [focus]`. It runs a compaction task and waits for both the task and
the summary placement. A short conversation, or one with no selectable old prefix, is a no-op.

## TUI

The default interface is a three-pane dashboard: jobs on the left, the selected conversation in the
middle, and live context on the right. The composer sends to `main` by default; open a job to target it.

**Ctrl-X** toggles the context pane from any dashboard focus; `/context [on|off|toggle]` does the same
from the composer (for example, `/context off` hides it). Ctrl-X works with legacy control-byte,
CSI-u/Kitty, and xterm modifyOtherKeys input without changing macOS Option-key settings. Option-C
continues to type `ç` when the terminal sends it as text. Alt-C remains an optional alias only in
terminals sending literal `ESC c` (Meta-C).

The choice is saved as `contextPanel: true|false` using the same targeted YAML editor as
`dchat config set contextPanel false`: it edits the active config (folder-local if present, otherwise
`$XDG_CONFIG_HOME/durable-chat/config.yaml` or `~/.config/durable-chat/config.yaml`; `.yml` discovery is
also supported). With `--config` or `DURABLE_CHAT_CONFIG`, only that standalone file is edited. Local
values override global values; an explicit file stands alone. No conversation state or credential files
are touched. If saving fails, the preference stays unchanged and an error is shown.

Enabled (the default) means “show when there is room”: at least **140 terminal columns**, with at least
**80 transcript columns** and **26 context columns** after the jobs pane and separators. Manual pane
resizing obeys those limits too. Narrow-window hiding never changes the saved choice; an explicitly
hidden pane stays hidden across resizing and restarts. `0` resets widths only, not visibility.

The mouse wheel, Magic Mouse and trackpad scroll the pane under the pointer, keeping keyboard focus,
the composer draft and the selected job unchanged. Pane headings stay fixed; keyboard job navigation
brings the selection back into view. Alt+wheel scrolls faster.

Command-click transcript URLs on macOS (Ctrl-click in terminals that use that modifier) to open them
in the default browser. Markdown links and bare URLs keep their complete destinations when wrapped.
Clicks routed to the app also open web links; dragging across a link still selects text.

Drag in the transcript to copy selected text; double-click copies a word, triple-click a line.
Selection stays inside the transcript and excludes blank speaker gutters and right-side cell fill,
while preserving code indentation, internal spaces and selected line breaks. Visible speaker labels
are included when selected. Code blocks use source indentation without an extra decorative indent.
This copies rendered lines, not byte-for-byte Markdown; `y` outside the composer copies the full
answer instead. On local macOS (Apple Terminal, Ghostty, or tmux), both paths use the native clipboard
writer, with `/usr/bin/pbcopy` as fallback. The highlight clears only after a successful local write.

Over SSH, dchat never writes the remote Mac's clipboard. Other hosts and remote sessions use OSC 52,
which depends on terminal clipboard permissions and, in tmux, passthrough configuration. Sending an
escape sequence does **not** confirm delivery: dchat reports it as unconfirmed and retains selection.
Apple Terminal does not support OSC 52. As a native-selection workaround, toggle **Allow Mouse
Reporting** with **Command-R**, select text, copy with **Command-C**, then restore mouse reporting.
Apple documents **Option-drag** as rectangular selection, not ordinary linear selection. Native
selection copies screen cells and may include pane padding. See [copy verification](docs/transcript-copy.md)
for limitations and opt-in manual checks.

The terminal title includes the launch folder, for example `durable-chat — ~/projects/example`.
The previous title is restored on startup failure or exit using the terminal's title stack.
Folders outside home remain absolute. Allow program-controlled titles in your terminal; Ghostty's
`--title` option or a fixed `title` setting overrides title updates from apps.

```text
┌ durable-chat ─ local/nemotron-bolt ─ substrate ─ 2 live ─────────────────────┐
│ JOBS 2 live          │ TRANSCRIPT main        ● live  │ CONTEXT              │
│ ▸ #13 running   12s  │ you  Read src/ …             │ target: main          │
│   #14 sleeping   3s  │ ai   Started job #13.         │ status: busy          │
│   #11 completed      │   ↳ ✓ bash · 18ms  src/…     │ turns: 3              │
│   #10 failed         │                               │ tokens: 18.2k         │
├──────────────────────┴───────────────────────────────┴──────────────────────┤
│ to main › _                                                                  │
│ ENTER send · ? help · TAB focus · SHIFT-ENTER newline                    │
└──────────────────────────────────────────────────────────────────────────────┘
```

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | cycle composer → jobs → transcript |
| `Ctrl-T` | switch composer target main ↔ selected job |
| `Ctrl-N` | new job brief |
| `Ctrl-X` | toggle context pane; saved in the active config (`Alt-C` alias for literal `ESC c` input) |
| `Command-Shift-Enter` | queue one follow-up from the composer, if the terminal reports it (`/send <id> <message>` fallback) |
| `Ctrl-V` | paste an image into the composer (main only) |
| `Enter` | send, or pin the highlighted job and focus the composer; confirm prompts |
| `Shift-Enter` | insert a newline in the composer (`Ctrl-J` or `Alt-Enter` fallback) |
| `↑/↓` or `j/k`, `g/G`, `PgUp/PgDn` | move selection or scroll outside the composer |
| Mouse wheel / trackpad | scroll the pane under the pointer without moving keyboard focus |
| Cmd-click / Ctrl-click | open transcript links using the terminal's link modifier |
| `n / c / m / R` | new job · cancel · compact · reset (selected target) |
| `s / t / f / y` | compose (jobs: pin highlighted job) · expand tools · show finished · copy |
| `/` | start a slash command in the composer; filter jobs when focus is on jobs/transcript |
| `[` / `]` | shrink / grow the jobs pane |
| `{` / `}` | shrink / grow the context pane when there is room (does not enable a hidden pane) |
| `0` | reset pane widths |
| `i` | inspector (config, MCP notes, usage); `e` edits the config |
| `a` | abort the main run (jobs survive) |
| `?` | full help outside the composer or with an empty draft; `Tab` then `?` preserves a draft |
| `Ctrl-C` | stop waiting / clear the prompt / close an overlay; arms quitting for 1.5 seconds |
| `Ctrl-C` twice | quit; small floating confirmation over the dashboard while live work exists |

The footer shows primary actions for the focused pane and a route to full help, not the entire keymap.
With a draft, **Tab then ?** opens help without changing the text; **/help** also opens it from the
composer. Context visibility and less-common shortcuts are listed in full help and the table above.

`Ctrl-V` attaches an image to the next message to main. It reads the native clipboard (macOS and
Windows prebuilds, Linux with X11); `/image <path>` is the fallback where that helper is unavailable.
Images are prepared with Photon on a worker thread to the model's image limits, and paste is refused
when the model declares text-only input, because providers drop image blocks for those models.
Attachments go to main only; jobs keep text input.

Transcript prose supports lightweight Markdown: headings, emphasis, lists, links, quotes, tables, and code
blocks, including streaming replies. Tool output stays literal; code blocks use plain styling without
syntax highlighting. The plain-chat interface is unchanged.

The multiline composer grows from a dark-grey three-row background and scrolls longer drafts while
keeping the cursor visible. **Shift-Enter inserts a line break; plain Enter sends.** If your terminal
does not distinguish Shift-Enter from Enter, use **Ctrl-J** (or Alt-Enter) to insert a newline instead.
Arrow keys navigate the draft; Backspace/Delete can join lines. Bracketed text pastes keep actual
line breaks (CRLF and CR normalize to LF) without sending. Large pastes appear as folded paste
markers; their complete text, not the marker, is sent. Visual wrapping adds no newline characters,
and text copied without line breaks cannot have its original layout reconstructed.
Pane headings, the target/status line, and individual jobs have spacer rows; the transcript has a solid
black background. Tab to jobs, then Up/Down (or `j/k`) to preview the highlighted job's latest transcript
and live updates without pressing Enter. `g/G` preview the first/last row. Previewing never changes the
composer or action target: **Enter pins the job and focuses the composer**, ready to type immediately.
It preserves the draft and attachments without submitting them. `s` in jobs does the same; `Ctrl-T`
explicitly toggles the target. Tab from jobs to transcript keeps the preview for scrolling; returning to
the composer restores the pinned target's transcript and keeps your draft. `Shift-Tab` from the composer goes straight
to transcript scrolling (`↑/↓` or `j/k`). Confirmations still name the pinned target.
While targeting `main`, newly arriving jobs are highlighted automatically unless you are browsing a
preview. Returning to `main` selects the newest visible job; manual browsing and pinned targets are
preserved. A single `Ctrl-C` clears the input or stops waiting as before; a second consecutive press
within 1.5 seconds requests quit. Typing, navigation, or expiry resets that sequence. Live work still
gets the floating confirmation; `Ctrl-Q` is no longer a quit shortcut.

The status line always shows `ctx ~tokens/window`; wide layouts add `context` (estimated active request),
`compact` (the default automatic-compaction threshold) and `spent` (cumulative recorded usage). Pane
widths are adjustable from the jobs or transcript focus with `[`/`]`, `{`/`}`, and `0`; resizing is
per-run.

Jobs run in the background and main stays usable. The TUI is the single store writer; closing it pauses
jobs, and the next run resumes them. `durable-chat --plain` or `durable-chat chat` is the old
line-oriented interface over the same runtime.

**Messages to live jobs default to steering.** Tab to jobs, select with ↑/↓ (or j/k), press Enter,
then type and Enter to submit. A `(steer)` badge identifies the mode. Admission returns immediately:
native steering queues at the next supported boundary (for example, after the executing tool round),
without aborting a tool or starting a concurrent turn. It cannot change a model request already in flight.
The job stays live through its steering response, using the same durable admission/tracking as Main's
`task` steer action; a "steering queued" notice is not a delivery or completion claim.

**Command-Shift-Enter** queues a one-shot follow-up instead: it waits until the current run ends,
preserving queued message order. The next plain Enter still steers a running job; there is no sticky
input-mode toggle. Main Enter still sends follow-up, and completed job conversations default to
follow-up/continuation. Explicit steering of an idle, finished, or finishing job is refused and leaves
the draft intact. A just-starting job without an active run may also refuse steering; retry once it is
running. Images remain Main-only and are retained if a job send is refused. Failed admissions retain
text for correction/retry.

The shortcut requires the terminal to transmit Command as Super plus Shift in CSI-u/Kitty input.
macOS or terminal key bindings may intercept it; legacy input cannot distinguish it, and xterm
modifyOtherKeys has no distinct Super modifier. dchat does not change terminal settings or infer
Command from ordinary Enter. Use `/send` below when the gesture is unavailable. Shift-Enter remains
newline; Option-S (`ß`) remains text. Alt-S no longer toggles an input mode.

`/send <id> <message>` explicitly queues follow-up; `/steer <id> <message>` explicitly requests
steering without changing the pinned target. The CLI equivalent is `task send <id> "<message>" --steer`.

Starting a job from the TUI or `task add` writes a native, model-visible `[host]` start notice into
main's conversation. Every job reports completion, failure, or abort as a native follow-up input by
default, including jobs started by main's `task` tool (whose tool result already covers the start).
That means **main automatically continues**: it runs, reviews the result, and tells the user what
changed. A handoff to main is also an input and starts a run. Main is event-driven: it is told not to
poll, and `task list`/`task show` are for an explicit status request or a specific detail, not for
checking whether work is done.

Set `autoContinue: false` in the config for passive notices (a write that main sees on its next turn
without spending tokens immediately). The default is `true`. The setting is captured when a job is
created, so changing it affects new jobs and their handoff successors.

Turn limits are tool rounds per run: `maxTurns: 60` for main and `jobMaxTurns: 120` for jobs. Main’s
`task` tool also enforces a host-side anti-poll guard: the first `show` on a live job is allowed, but a
second within 30 seconds returns a “do not poll” result and ends the run; a repeated `list` within 10
seconds does the same. This protects a model that ignores the prompt.

All durable state goes through Pi Durable — `Harness`, `Conversation`, `Task`, `Submission`, native
documents, `watchTaskGraph`, `conversation.watch`, `entries`, `compact`, `reset`, `abortTask`, and
native `control.terminate` handoffs. The only host files are configuration, the MCP server config, and
the store lock.

## Commands

| Command | Meaning |
| --- | --- |
| `durable-chat` | full-screen TUI dashboard (`--plain` for the line chat) |
| `durable-chat tui` | force the TUI |
| `durable-chat chat` | line-oriented chat |
| `durable-chat ask "<text>" [--wait]` | one-shot main-agent turn; `--wait` joins live jobs afterwards |
| `durable-chat task add "<brief>" [--detach]` | start a background job agent (waits unless `--detach`) |
| `durable-chat tasks` | list live and finished jobs |
| `durable-chat task <id>` | job status, answer, and recent job transcript |
| `durable-chat task log <id>` | recent job transcript |
| `durable-chat task send <id> "<message>" [--steer]` | continue the job conversation, or steer its current run |
| `durable-chat task cancel <id>` | abort the job and its active job conversation |
| `durable-chat task compact <id> [focus]` | compact the job conversation |
| `durable-chat task reset <id> [handoff]` | reset the job context |
| `durable-chat watch [--follow]` | live job board until jobs settle (or until Ctrl-C with `--follow`) |
| `durable-chat compact [focus]` | compact the main conversation |
| `durable-chat reset [handoff]` | reset the main context |
| `durable-chat info` | config, store, model, limits, tools, and MCP status |
| `durable-chat config ...` | `path`, `show`, `keys`, `init`, `edit`, `get`, `set`, `unset` |
| `durable-chat state fork [--store <source>]` | snapshot the selected state into this folder and configure the fork |

Global flags: `--config <path>`, `--store <path>`, `--provider faux|openai|local`, `--model <id>`,
`--verbose`, `--plain`, `--no-mcp`, `--force` (for `config init`).

Inside the plain chat or TUI composer:

```text
/tasks                  list jobs
/task <id>              show a job
/log <id>               recent job transcript
/new <brief>            start a job and let it run
/send <id> <message>    continue a job (follow-up)
/steer <id> <message>   steer the job's current run
/cancel <id>            abort a job
/compact [focus]        compact the main conversation
/reset [handoff]        reset the main context
/model [id]             pick the session-wide model, across configured providers
/provider [name]        list configured providers, or make one active for this session
/thinking [level]       session thinking level for main and jobs; the config file decides the next run
/context [on|off|toggle] TUI only: show/hide context when there is room; saved in the active config
/image <path>           attach an image to the next message to main
/reboot                 archive all app state and start a fresh database (confirmation required)
/rollback [path]        select saved state, archive current state, restore a copy, and relaunch
/wait                   join live jobs (Ctrl-C stops waiting only)
/info
/quit
```

In the TUI, these are local actions, not model messages: `/help` opens help, `/info` opens the inspector,
`/tasks` focuses the jobs pane, and `/task`/`/log` open the job transcript. `/new` without a brief opens
the brief prompt. `/compact` and `/reset` apply to the current target; reset, cancel, and quitting with
live work retain their confirmations. `/send` and `/steer` address the specified job without changing
the current target. `/wait` joins a snapshot of current jobs, and Ctrl-C cancels only the wait.
Use `/filter [query]` in the TUI composer to filter jobs, or press `/` while focused on jobs/transcript.
Unknown or malformed commands report a local error rather than being sent to the model.

The main agent is never blocked by a job: jobs are background tasks in the main conversation and run in
their own conversations. Closing the process does not delete work; unfinished task phases resume on the
next open.

### Model picker

Use `/model` to browse the models of **every configured provider**, the active entry first. In the
TUI, type to filter, use Up/Down to select, and press Enter to apply; Esc cancels. Plain chat offers a
numbered list and accepts a number, exact ID, or `provider/id`. `/model <exact-id>` selects directly.
When two entries list the same ID, the picker shows the provider-qualified `provider/id` so the choice
cannot be ambiguous.

OpenAI/Codex use their installed chat-model catalog. Local servers are queried at the configured
OpenAI-compatible `/models` endpoint, using the configured API key when present, with a five-second
timeout. If discovery fails, the configured model remains available. Browsing sends no generation
requests or OAuth refreshes.

Selection applies to main, existing jobs, future jobs/forks, and handoff successors. It keeps the
database, conversations, and tags, and restarts the runtime under the continuously held store lock.
Configured context/output ceilings are retained and capped to the selected model's catalog limits.
Compact large conversations before moving to a smaller context window.

Switching closes the current runtime and leaves prepared requests intact. Resumed requests and deferred
polls use their checkpoint model; ordinary retries prepare again using the current selection. If a pinned
model is unavailable, that turn ends with `no_model`; subsequent inputs use the selected model. Built-in
provider IDs remain available for checkpoints saved before named entries were configured. A failed restart
recovers the previous runtime.

Named OpenAI/Codex entries use the existing Pi credentials for their provider kind. Renaming an entry
keeps the same login, and refreshed tokens are saved back under the original Pi credential key.

Selection is **session-only**: it survives `/reboot` and `/rollback` in the same process, while a normal
process restart uses your configured default. To resume unfinished work on the selected model after
quitting, start with `dchat --model <id>`. Use `dchat config set model <id>` to explicitly change the
configured default.

`/provider [name]` lists the configured entries and makes one active, applying that entry's model,
endpoint, ceilings, timeout, and thinking level through the same reopen path as `/model`. Only the
active entry is contacted for a dynamic list; the others show their configured model. Like `/model`,
the switch is session-only: the config file still decides the next run.

### Safe reboot

Use `/reboot` in the TUI or plain chat to start fresh at the **same database path**. It always asks for
confirmation: **Y reboots; Enter, N, or Esc cancels** in the TUI (`y` at the plain-chat prompt).
This applies to the entire store, even when a job is selected.

Reboot stops UI observers, closes the runtime and MCP connections, checkpoints SQLite's committed WAL,
and moves the database into a private, uniquely named archive directory beside the original:

```text
<store>.reboot-<UTC timestamp>-<unique suffix>/<database filename>
```

A fresh database then opens at the original path, with empty conversations, jobs, and tags. The active
session settings and model remain in use; restart the process to apply config-file edits.
Project files and Git worktrees stay in place. The archive retains old conversations and unfinished jobs,
which resume only when that archive is reopened.

The archive path appears in the TUI inspector, plain-chat banner, and `dchat info`, and survives
subsequent restarts. Archives stay available until you explicitly remove them. Use `/rollback` below
to restore a copy while preserving the archive.

The store lock stays held throughout rotation and reopening. Close other SQLite clients before
rebooting; aliased database files (symlinks or additional hard links) are refused. If fresh startup
fails, recovery preserves the partial replacement and restores the original when its journals can be
closed safely. Otherwise the error identifies the preserved archive and replacement for recovery.

### Rollback

Use `/rollback` in the TUI or plain chat to select a saved database. It lists up to five recent archives,
with the last backup first. Enter a number or a file path; an explicit path also works directly:

```text
/rollback
/rollback "/path/to/saved state/store.sqlite"
```

After selecting a file, **Y confirms; Enter cancels**. The current runtime closes, its database is
archived under another unique name, and a consistent SQLite snapshot of the selected file is restored
at the **original active database path**. The runtime then relaunches with the active session settings.
The selected file stays unchanged, including when committed data must be read from its WAL.

The inspector and `dchat info` show both the selected source and the newly archived previous state.
Another `/rollback` can select that previous state to undo the restore. The source must be closed and
lockable; selecting the active database is refused. Failed replacement/reopening uses the same
preserving recovery as reboot.

Restored unfinished jobs resume automatically. Their saved workspaces, and all project files, retain
their current filesystem contents; rollback restores app state. Reopening another copy of the same
pending work can repeat external actions.

For advanced use, `dchat --store "/path/to/archive/store.sqlite"` opens an archive **in place** rather
than copying it to the active path.

The TUI design and its implementation notes are in [docs/tui-design.md](docs/tui-design.md).

## What each agent can do

**Main agent** — `task` (`create`, `list`, `show`, `result`, `tag`, `steer`) and `fork`. It primes context through scouting jobs,
creates fresh jobs or context-forked variants, redirects running jobs, and waits for native notices instead of polling.

```javascript
task({ action: "steer", id: "13", message: "Focus on the regression fix; preserve the existing API." })
```

Steering returns as soon as the message is durably queued. The worker receives it at its next native
boundary; an executing tool continues until that boundary. The job stays live through the steering
response and reports the updated result, including when steering arrives during a final answer.
Queued steering survives a restart. Idle and completed jobs reject steering; create or fork a job for new work.

**Job agents** — a minimal covering set:

- `read`, `write`, `edit`, `bash` from pi-durable's coding tools
- `substrate_search`, `substrate_describe`, `substrate_call` when Substrate MCP is connected
- `handoff` — return the work to main or create a successor job
- `codemode` — a QuickJS script that calls this conversation's tools; only the script's output comes back

`substrate_call` is deliberately a gateway rather than 249 separate tool schemas: search the catalog,
describe the exact tool, then invoke it with a JSON args object. Jobs cannot start arbitrary jobs; a handoff creates at most one successor.

### Codemode scripts

`codemode: true` (default, `DURABLE_CODEMODE`) gives main and every job the `codemode` tool. A script
runs in QuickJS on a worker thread and reaches only the tools of its own conversation, so main's
scripts can call `task` and `fork` while job scripts keep the coding tools and the MCP gateway.

- Only the script's output reaches the model, so a script can batch calls with `Promise.allSettled()`
  and filter large output first.
- A script survives a restart: its calls are journaled, and a rerun replays them without running
  finished calls again. Tools marked unsafe on replay (`task`, `fork`, `handoff`, `substrate_call`)
  are not rerun, so scripts should not create jobs.
- The prompt section lists tool declarations up to a token budget; scripts find the rest with
  `searchTools()`, `describeTool()`, and `describeNamespace()`.
- `store()`/`load()` keep small JSON per conversation, and a fork sees them as of its fork point.
- Tool `control` applies only to model-issued calls, so the anti-poll guard in the task tool returns
  its text to a script but cannot end a run started by one.

### Complete job response pages

The durable receipt now keeps the **entire final text response** instead of a 6,000-character tail.
Completion notices deliver page 1, not an 800-character summary. A `PAGED` suffix gives the remaining
page/byte counts, estimated remaining tokens, and the **exact next tool call**, including its revision.
Follow those calls until `remainingPages` is zero before reviewing the whole response. Reading settled
pages is retrieval, not status polling; `list` remains compact and never includes response bodies.

Main's `task({ action: "show", id: "13" })` returns status and the first response page once a job is
terminal. `task({ action: "result", id: "13" })` also starts at page 1. Later pages require `page` (a
positive integer) and the `revision` copied from the preceding page. Invalid/out-of-range pages and
revision mismatches return errors; no pages are silently skipped. The revision and boundaries are
stable across restarts and repeated reads of the same completed response. Live jobs explicitly reject
`result`: wait for their completion notice rather than combining pages of changing output.

Each page holds up to **~5,000 estimated tokens** using `ceil(UTF-8 bytes / 4)`, **not a tokenizer or a
true token upper bound**. A 20,000-byte and 1,400-newline content budget leaves room for the paging
suffix under native tool caps (50 KiB / 2,000 lines). Code, long lines, non-ASCII and whitespace are
preserved exactly; boundaries never split a surrogate pair. Pages can be smaller to meet the line
budget. No model-independent exact token count is claimed.

In codemode, the `task` result is a string for ordinary actions, or a page object for completed
`show`/`result`. Print **one page's `display` per script**, using the default 10,000 output-token budget
(or at least 6,000); batching displays or reducing the script budget can trigger codemode's own
truncation. For exact programmatic reassembly concatenate the structured `text` fields in page order,
not the display wrappers. The object also includes `page`, `totalPages`, `remainingPages`, `revision`,
UTF-16 `start`/`end` offsets, `totalBytes`, `remainingBytes`, `remainingEstimatedTokens`, and optional
`nextCall` arguments:

```javascript
const result = await tools.task({ action: "result", id: "13" });
text(result.display); // suffix supplies the next call; fetch it in the next script
```

This retrieves the final response, **not** thinking, images, or the whole job transcript. A handoff's
stored response is its handoff summary; failed/aborted receipts expose their recorded reason when
there is no answer. Pre-pagination completed jobs recover the full response from `answerEntry` when
available. If that entry is gone and only a known truncated legacy tail remains, retrieval reports
that limitation instead of presenting the tail as a complete response. CLI/TUI transcript and detail
views remain separate inspection surfaces; their presentation previews are not the paging source.

## Context forks (main-only)

Ask main to investigate once, then fork the prepared scout into independently briefed variants. Main's
tool calls look like:

```text
fork({ source: "13", brief: "Implement the minimal fix", workspace: "worktree" })
fork({ source: "13", brief: "Try the alternative design", workspace: "worktree" })
fork({ source: "13", brief: "Review the risks without editing", workspace: "shared" })
fork({ source: "main", brief: "Explore another direction", workspace: "shared" })
```

- `source` is `main`, a job ID as a string, or `tag:reviewer` for a uniquely tagged job. The cutoff is the latest completed assistant turn in
  the source's active context. Prime a source before forking it; an in-flight tool round is excluded.
- Each fork is a new durable job and a native conversation fork. It inherits visible history and tool
  evidence through the cutoff, with a fresh provider identity and independent subsequent entries.
  Existing running tasks are left with the source. All new jobs report to main.
- The worker gets the job toolset and current brief, rather than main's coordinator tools. Only main
  is offered `fork`, and the tool also checks the calling conversation. Jobs retain `handoff`.
- The Jobs pane shows `↳ #13` or `↳ main`. The context pane and `task <id>` details show the source
  entry and assigned workspace/branch. Lineage and workspace plans survive restart.
- Inherited context is still model input; provider caching determines any processing-cost savings.

### Reusable context tags

Main can name prepared contexts by purpose rather than remembering task numbers:

```text
task({ action: "create", brief: "Learn the review conventions and inspect the architecture", tags: ["reviewer"] })
task({ action: "tag", id: "13", tags: ["reviewer", "primed"] })
fork({ source: "tag:reviewer", brief: "Review the new variant; recheck the changed files", tags: ["review-a"] })
```

Tags are persisted independently of a job's lifecycle and can be changed after it completes.
`task tag` replaces the tag set; `tags: []` clears it. Tags normalize to lowercase, support letters,
digits, dots, hyphens and underscores, and are limited to eight tags of at most 48 characters per job.
Task lists/details and the Jobs pane show tags; the job filter matches them.

A tagged fork source must resolve to exactly one job with a completed turn. Missing or ambiguous
matches return a local tool error with candidate IDs; the app never silently chooses a different
context. Forks receive only their explicitly supplied tags, keeping the prepared source's label stable.
A tag identifies reusable context, not proof that its findings are still current.

### Fork workspaces

`shared` (the default) uses the source conversation's directory recorded at the cutoff. `worktree` requires Git and a clean
source checkout, including untracked files, and records an exact base commit. The host creates a unique
`dchat/<uuid>` branch and worktree under the repository's Git common directory
(`dchat-worktrees/<uuid>`), preserving a source subdirectory as the worker's `cwd`.

The plan is committed with the job before filesystem setup. Setup finishes before the first worker
request; restart reconciles the same branch/path and reacquires the same brief submission. Setup
errors become job failures reported to main. Existing dirty worktrees and later variant commits are
retained; incomplete, locked, or mismatched workspaces are preserved and reported for inspection. Saved
workspace assignments also guard later tool environments after the job task finishes. A handoff
successor continues in its predecessor's assigned workspace.

Worktrees contain the recorded Git tree: ignored files, dependencies, credentials, and dirty edits are
not copied. The host runs no project setup hooks or dependency installation. Worktrees and branches
remain after completion, cancellation, and failure for explicit review/integration/cleanup. Main
decides which results to combine; the app performs no automatic merge. Worktrees provide separate edit
directories; jobs still share the host and retain their normal tool access.

This context-fork tool is distinct from `dchat state fork`, which copies the entire SQLite store.
Filesystem snapshots of dirty workspaces remain a separate future option.

## Handoffs

A job can call the `handoff` tool instead of finishing:

```text
handoff({ target: "main", brief: "Finish the release notes", summary: "Tests pass; changelog drafted." })
handoff({ target: "job",  brief: "Publish the release",      summary: "Notes reviewed; tag prepared." })
```

- **Job → main**: the coordinator receives a native input (`[job #N handoff] …`) and starts a run.
  The current job ends `handed_off`; main can inspect it with the task tool.
- **Job → job**: a successor job is created in main's conversation with the same model, cwd, turn limit,
  and selected extensions. Its brief carries the summary and continuation. The current job ends
  `handed_off`; the successor runs independently. Chains are capped at 8 handoffs.
- **Awareness**: user-started job chains keep writing `[host]` notices to main. A handoff to main is
  itself the message; no extra completion notice is written.
- Both directions are native: a conversation document records the intent, the task creates the
  successor or admits the main input, and terminal state is committed through `runtime.commit()`.

## Substrate MCP

Job agents read MCP servers from `~/.pi/agent/mcp.json` (and `.pi/mcp.json` for project overrides), the
same format pi uses. The config keys are:

- `mcp.enabled` — `true` by default
- `mcp.servers` — default `[substrate]`
- `mcp.tools` — optional extra direct tools to expose (server tool names)
- `mcp.config` — default `~/.pi/agent/mcp.json`

Environment equivalents: `DURABLE_MCP_ENABLED`, `DURABLE_MCP_SERVERS`, `DURABLE_MCP_TOOLS`,
`DURABLE_MCP_CONFIG`. `--no-mcp` disables MCP for one run.

The `substrate` server gets the three-tool gateway. Other servers expose selected tools directly (all
tools up to 20 if no filter is set). If the server is missing, disabled, or unreachable, job agents get a
`mcp_substrate_unavailable` tool that explains why; jobs still have the coding tools. `durable-chat info`
shows the connection state and notes. Tokens are read from the config and never printed.

## Durability notes

- Every job is a durable `durable-chat.job` task plus its own conversation. The task submits the brief,
  joins the answer, and records the receipt (answer entry, capped answer text) on the task.
- Inputs use stable request IDs (`job:<taskId>:run`), so a restart reacquires the admission instead of
  duplicating the brief. A generation cut off mid-request retries; an aborted partial answer is retained
  as an aborted entry next to the retried answer.
- Cancelling a job marks its task, aborts the job conversation with a bounded cleanup wait, then commits
  an `aborted` terminal outcome.
- Compaction is joined through the compaction task **and** its summary placement. A no-op (no selectable
  old prefix, declined summary) is reported as a no-op, not as success.
- Reset is admitted immediately; while the conversation is busy it lands at the next boundary. Raw history
  is retained.
- Jobs are background tasks, so `Conversation.abort()` on the main conversation does not cancel them;
  `task cancel` targets one job.
- External effects are not exactly-once. Model/tool retries and process cuts can repeat a bash command;
  `read`/`write`/`edit`/MCP calls are marked replay-unsafe where appropriate. Check the job transcript
  before re-running a job with side effects.

## Limits

- The config file selects a user-level store; everything is still one SQLite file.
- One writer per store. Do not run two `durable-chat` processes on one store (chat + watch included).
- Jobs only run while some process has the store open and scheduling enabled. Closing the process pauses
  them; the next command resumes them.
- `task add --detach` admits the job and exits without starting it. Use `watch` (or another command that
  resumes scheduling) to run it.
- The answer stored on a task is capped at 6000 characters; the full answer remains in the job
  conversation (`task log <id>`).
- Automatic compaction uses pi-durable defaults. Manual compaction of a short conversation is a no-op by
  design.

## Development

```sh
npm run check     # tsc --noEmit
npm test          # source regression tests
npm run build     # clean dist/ build, rewriting relative .ts imports to .js
npm run test:package  # pack, inspect and install into a temporary node_modules, then offline smoke
```

`tsconfig.json` sets `skipLibCheck: true` deliberately: `@google/genai`'s published declarations import
an optional `@modelcontextprotocol/sdk` path that is not installed here. Our own sources are checked with
`strict`; the limitation is the third-party declaration, not a weakened check of this project.

## Layout

```text
src/cli.ts        argument parsing, interactive REPL, slash commands
src/models.ts     provider model discovery and picker selection
src/reboot.ts     closed-database checkpoint, unique archival, and failed-startup recovery
src/rollback.ts   saved-state discovery, source selection, and read-only SQLite snapshot installation
src/config.ts     YAML defaults, precedence, path resolution, typed editing
src/config-commands.ts  config path/show/keys/init/edit/get/set/unset
src/harness.ts    store lock, providers, registry, root configuration, lifecycle
src/tasks.ts      durable job task (workspace/run/report/abort), job links and handoffs
src/forks.ts      completed-turn source selection for main-only context forks
src/tags.ts       durable job tags and unambiguous prepared-context lookup
src/workspaces.ts Git worktree planning, persisted assignment, and restart-safe setup
src/jobs.ts       job creation, scanning, answers, logs, compaction, messaging
src/tool.ts       the main agent's `task` tool
src/mcp.ts        MCP config, connections, Substrate gateway
src/chat.ts       streaming and one-shot main turns
src/watch.ts      live job board over the task graph
src/format.ts     job views and text formatting
src/faux.ts       offline scripted model for demos and tests
src/tui/main.ts   run the alt-screen dashboard
src/tui/app.ts    panes, keymap, actions, live updates
src/tui/state.ts  pure job list/selection/target helpers
src/tui/transcript.ts  windowed conversation history + live state
src/tui/format.ts terminal-friendly entry and tool formatting
```

## Safety and privacy

Agents can run shell commands and read/write files as your user; repository instructions and
QuickJS codemode are not an operating-system sandbox for the exposed tools. Use a trusted
working directory and review model/tool actions. Real providers can send prompts, source files
and tool output to their services and consume paid quota. MCP servers have their own access
and credential requirements; Substrate is optional (`--no-mcp`).

SQLite stores, archives, transcripts, credentials and project-local configuration can contain
private data. Keep `.durable-chat/`, `.pi/`, `.env`, auth files and database/log artifacts out of
Git and release archives. Do not upload a live store when reporting a bug.

## License

Original durable-chat code is [MIT licensed](LICENSE). The actual upstream dependency is
`@earendil-works/pi-durable`, part of [earendil-works/pi](https://github.com/earendil-works/pi),
not a package named “PyDurable”. Its MIT license and relevant third-party notices are preserved
in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and `LICENSES/`. Dependencies retain their own licenses.
