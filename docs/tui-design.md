# durable-chat TUI — design

Status: implemented in `src/tui/` (alt-screen dashboard, phases 1–4). Keyboard-only v1. See
"Implementation notes" at the end for the choices made and small deviations from this proposal.

## Goal

Drive the existing durable runtime from one terminal dashboard without shelling out between commands:
keep the coordinator conversation visible, start and supervise background jobs, inspect any job's
transcript, and run compact/reset/cancel against the selected target.

Non-goals for the first version: multi-user/remote access, a second model provider UI, editing job
settings after creation, or replacing the CLI for scripts. The TUI and CLI share `AppRuntime`; the CLI
stays for one-shot commands and automation.

## Why the current pieces fit

The runtime already exposes everything a dashboard needs:

- `Conversation.watch()` / `pi.live` — streamed main answer, tool slots, inbox, run failures.
- `Harness.watchTaskGraph()` — live job nodes with status, owner edge, owned conversations, blocked reason.
- `scanJobs()` / `getTask()` — job brief, checkpoint, terminal receipt, answer text.
- `Conversation.entries()` / `readLog()` — transcript history and pagination.
- `root.submit()`, job `Conversation.submit()`, `abortTask()`, `compact()`, `reset()` — actions.
- `Harness.usage()`, config, and MCP notes — status surfaces.

The single-writer store rule becomes an advantage: the TUI is the one writer, so there is no conflict
with the current chat+watch split. The existing CLI remains usable when the TUI is closed.

## Layout

Full-screen alt-screen dashboard, keyboard first.

```text
┌ durable-chat ─ local/nemotron-bolt ─ substrate ✓ ─ 2 jobs live ───────────────┐
│ MAIN                                                              JOB #13   │
│ you   Use a job to inspect src/ and summarize the modules.        running   │
│ ai    Started job #13. I'll report when it answers.               12s       │
│                                                                              │
│ ─ tool · task ────────────────────────────────────────────────────────────   │
│   ✓ Started job #13 in conversation #14                                       │
│                                                                              │
│ ai    Job #13 is still reading. I can queue another task meanwhile.           │
│                                                                              │
│ ───────────────────────────────────────────────────────────────────────────  │
│ JOBS                         │ TRANSCRIPT              │ CONTEXT           │
│ ▸ Live (2)                   │ [main] [job #13]        │ model  local/...  │
│   #13 running   12s          │ user: inspect src/ …    │ turns  34/40      │
│   #14 sleeping  3s           │ tool: bash ls src/ ✓    │ tokens 18.2k      │
│ Finished (3)                 │ asst: src/chat.ts — …   │                   │
│   #11 completed              │                         │ MCP substrate ✓   │
│   #10 failed                 │                         │ store ~/.local/…  │
├──────────────────────────────────────────────────────────────────────────────┤
│ to main › _                                                                  │
│ enter send · ctrl-t target · ctrl-j newline · n new job · m compact · R reset│
└──────────────────────────────────────────────────────────────────────────────┘
```

At 120+ columns this is the three-pane form. At 80–119 columns the right pane folds into an `i`
inspector overlay; below 80 columns the top strip becomes `Main | Jobs` tabs with the composer pinned.

## Panes

### Jobs (left)

Two groups: **Live** (pending, running, waiting, sleeping, completing) and **Finished** (completed,
failed, aborted). Each row shows id, status, age, and a truncated brief. Blocked jobs show their reason
and a warning color. Selecting with ↑/↓ or `j/k` previews the transcript and context panes immediately;
`Enter` pins the selection and focuses the composer immediately. A pending transcript load cannot steal
focus when it completes. Tab/Shift-Tab still reach transcript scrolling.

The list is fed by one `watchTaskGraph`; the brief and receipt come from `scanJobs`/`getTask` and are
refreshed only when a graph node appears, changes status, or disappears. No polling.

### Transcript (center)

Shows the selected target: `main` by default, or the selected job conversation. It renders:

- user/assistant messages, with streamed assistant partials from `pi.live.generation`
- tool calls collapsed to one line (`✓ bash ls src/ 42ms`); `Enter` expands the tool result
- job-task answer receipt in a card when a finished job is selected
- reset, compaction, and run-failure markers as separators
- an inbox/queue strip when main inputs are waiting

Only the visible conversation is watched; switching selection stops the old watch and attaches the new
one with a bounded window. Scrolling above the window pages older entries through `Conversation.entries`.
The transcript keeps a bounded in-memory window; raw history stays in SQLite.

### Context (right)

A compact facts pane for the selected target: model, thinking level, maxTurns, job turns, token usage,
context-fork source/cutoff and workspace/branch when present,
started/ended times, conversation id, job status/checkpoint, blocked reason, MCP connection and notes. For
main it also shows the configured store, config path, and queued input count. Not editable here.

### Composer (bottom)

One editor with a visible target: `to main ›` or `to job #13 ›`.

- `Enter` sends; `Shift-Enter` inserts a newline (`Ctrl-J` or `Alt-Enter` fallback); `Ctrl-T` toggles the target.
- For the current target, a `(steer)` badge shows that Enter steers a live job.
  Main defaults to `followUp`; live jobs default to `steer`, completed conversations to `followUp`.
  Command-Shift-Enter queues one follow-up from the composer when CSI-u/Kitty reports Super+Shift;
  `/send <id> <text>` is the fallback for intercepted/legacy/modifyOtherKeys input. There is no sticky
  mode override. The durable job status is checked at admission; steering races/idle jobs reject
  without clearing the draft. Shift-Enter remains newline; Option-S remains text.
- In job-brief mode (`n`), the target reads `new job ›`; `Enter` admits the job and pins it.
- While an action is in flight, the composer remains usable for main; the status line shows the action.

## Keymap

Actions apply to the **selected target**, named in every confirmation.

| Key | Action |
| --- | --- |
| `Tab` / `Shift-Tab` | Cycle focus: composer → jobs → transcript |
| `↑/↓` or `j/k`, `g/G`, `PgUp/PgDn` | Move/scroll outside the composer |
| `Enter` | Send, pin highlighted job and focus composer, or confirm |
| `Esc` | Close overlay, stop scrolling, return target to main |
| `n` | New job brief |
| `Ctrl-T` | Toggle composer target main/selected job |
| `Command-Shift-Enter` | Composer: queue one follow-up if reported (CSI-u/Kitty); `/send <id> <text>` fallback |
| `m` | Compact selected target (optional focus prompt) |
| `R` | Reset selected target (optional handoff prompt, confirm) |
| `c` | Cancel selected job (confirm) |
| `a` | Abort the main run (confirm; does not cancel jobs) |
| `s` | Compose; in jobs, pin the highlighted job first (no auto-send) |
| `y` | Copy the selected message/answer |
| `/` | Composer: enter a slash command; jobs/transcript: filter by id, brief, or status |
| `f` | Show or hide finished jobs |
| `i` | Inspector: config, usage, MCP notes, blocked jobs |
| `e` | In the inspector: suspend, edit config, validate, restart the TUI |
| `[` / `]` | Shrink/grow the jobs pane |
| `{` / `}` | Shrink/grow the context pane (shows it on narrow terminals) |
| `0` | Reset pane widths |
| `?` | Help overlay with the live keymap |
| `Ctrl-N` | New-job brief |
| `Ctrl-C` | Stop waiting / clear prompt / close overlay; arm quit for 1.5 seconds |
| `Ctrl-C` twice / `q` outside composer | Quit; confirm if live jobs exist |

`Ctrl-C` cancelling a wait leaves the run durably alive; the UI says so. Quitting pauses jobs, which is
already the runtime's behavior.

## Actions and confirmations

- **New job**: `createJobInCommit` in the same transaction as today; the job starts because the TUI has
  scheduling enabled; the new job is selected. No model turn is spent in main for a TUI-created job.
- **Message job**: default live-job steering uses the same atomic native admission and `JobLink`
  tracking as Main’s task tool, without waiting for the worker. `whenBusy: "steer", whenIdle: "reject"`
  admits only an active run and lands at a supported boundary, not by interrupting a tool. Explicit
  `Command-Shift-Enter` one-shot follow-up uses `whenBusy: "followUp"` and waits until the final boundary.
  Completed conversations can still be continued with follow-up. Admission notices say queued, not delivered or completed.
  Drafts/attachments clear only after successful admission; failed sends keep them editable.
- **Compact**: `compactConversation`; wait through the compaction task and the placement, then show the
  summary entry id or the no-op reason. The TUI is blocked only for that action, not for input.
- **Reset**: prompt for an optional handoff, confirm, then `reset()`. Main reset does not touch jobs.
- **Cancel**: confirm `cancel job #13`, then `abortTask`; show `aborted` when the task settles. Bounded
  cleanup wait as today.
- **Job completion**: a toast `job #13 completed — /task` plus a status-bar marker. Every job sends a
  native `[host]` completion/failure/abort follow-up input to main by default (`autoContinue: true`),
  so main automatically continues; user-started jobs also write a start notice. Set `autoContinue:
  false` for passive write notices. Main’s prompt is event-driven: it does not poll `task list/show`;
  notices carry the summary, and status reads are only for an explicit user request.
- **Failure surfaces**: run failures, blocked jobs, MCP connection notes, and storage errors are always
  visible in the status bar/inspector, not just in logs.

## State and rendering

```text
TaskGraphWatch ─┐
ConversationWatch(main) ─┼─> reducer ─> ViewModel ─> App component ─> pi-tui diff renderer
ConversationWatch(job) ──┤
Job scans/getTask ───────┘
User keys ──> actions ──> Harness APIs ──> commits (watchers deliver next state)
```

- Watcher callbacks only enqueue updates; rendering is coalesced to ~20 fps.
- The reducer is a pure module: selection, focus, filters, toasts, composer target, queue mode, and
  transcript windows. This is the main unit-test surface.
- `@earendil-works/pi-tui` is the recommended renderer: `TuiAltScreen`, `ScrollView`, `Editor`,
  `Markdown`, `Box`/`VStack`/`HStack`, `matchesKey`, width helpers, IME/clipboard handling. Do not build
  a second renderer or hand-roll ANSI width logic.
- Tool output is collapsed by default and rendered on expansion; markdown renders lazily for visible
  messages only.
- The header/status line is one line at the top and one at the bottom; the rest is panes.

## Files

```text
src/tui/main.ts          runTui(): open runtime, mount TuiAltScreen, close on exit
src/tui/app.ts           root component, focus, panes, overlays
src/tui/state.ts         pure ViewModel + reducer
src/tui/transcript.ts    conversation watch + window/pagination adapter
src/tui/jobs.ts          job list adapter (graph + records)
src/tui/composer.ts      editor, target, mode, validation
src/tui/actions.ts       submit/send/cancel/compact/reset wrappers over existing modules
src/tui/confirm.ts       confirmation and prompt overlays
src/tui/format.ts        line/width helpers, status badges, tool summaries
```

Reuse `config.ts`, `harness.ts`, `jobs.ts`, `commands.ts` action helpers, and `tasks.ts`; the TUI adds
presentation and input, not durable semantics. `attachStreamer`'s delta logic generalizes to a
`TranscriptModel` used for both main and jobs.

## Phases

1. **Skeleton** — open runtime, main transcript with streaming, composer, header/status, quit/cancel.
2. **Jobs** — graph watch, list, selection, job transcript, completion toasts.
3. **Actions** — new job, send, cancel, compact, reset, confirmations, inspector.
4. **Polish** — pagination, tool expansion, filters, responsive layout, config editor handoff, help.
5. **Optional** — read-only viewer mode, mouse, themes/keybinding config, session picker.

Each phase should be usable on its own; phase 1 alone already replaces the basic chat loop.

## Testing

- Pure reducer tests for selection, target routing, queue mode, status transitions, and filter/close
  behavior. Name each test after the requirement it protects.
- Headless integration with `MemoryStorage`/faux: drive `actions.ts` as the TUI would, assert durable
  outcomes, and feed watcher updates into the reducer.
- One pseudo-TTY smoke test for key parsing and clean shutdown; do not snapshot incidental colors or
  borders.

## Risks and decisions

- **pi-tui dependency**: adds a package but provides diffing, key protocols, width/IME handling, and
  editor/scroll components. Hand-rolled ANSI would cost more than it saves.
- **Huge transcripts**: windowed watches plus collapsed tools bound memory; paging fetches history.
- **Watcher volume**: task graph and one conversation only; coalesced renders; no per-job watches except
  the selected job.
- **Config changes need a restart** because the runtime captures provider/store settings at open. The
  inspector should say so explicitly.
- **Single writer**: the TUI holds the store; `durable-chat` commands fail with the existing lock message
  while it runs. A read-only viewer is future work, not a v1 promise.
- **Alt-screen vs inline**: alt-screen is the right default for a dashboard; a `--inline` fallback can
  reuse `TuiMainScreen` later.
- **Auto-continuation is configurable.** The default is now on: completion/failure/abort continue main
  automatically. `autoContinue: false` restores passive writes for hosts that want no extra turns.

## Implementation notes

Implemented choices:

- Full-screen **alt-screen** dashboard; default focus is the **composer** so chat is immediate.
- **Tab** is the action boundary: plain `n/c/m/R/s/a` work outside the composer, so typing never triggers
  an action. `Ctrl-N` opens a new-job brief from anywhere.
- `m`/`R`/`c` act on the **pinned target**; `Enter` pins the highlighted job and focuses the composer;
  `Ctrl-T` toggles main ↔ job.
- Entering jobs focus and moving with ↑/↓, `j/k`, or `g/G` previews the highlighted job immediately,
  including its live watch. This does not change the composer/action target or draft. Tab to transcript
  keeps the preview for scrolling; returning to composer restores the pinned target's transcript.
  New arrivals do not steal a preview selection. Switching rows resets to the latest messages, stops
  the old job watch, and reloads fresh history; late reads cannot replace a newer selection.
  Startup rows without a conversation retry on graph-driven job refresh. Main stays subscribed.
- Tool output is collapsed by default and toggled with `t` (rather than per-entry expansion).
- `f` toggles finished jobs; `/` filters by id, brief, or status only outside the composer. In the
  composer, slash commands dispatch to native TUI actions without becoming model input; `/filter`
  opens the filter explicitly.
- `y` copies the displayed job's answer/last assistant message via OSC 52 (including previews).
- The inspector's `e` suspends the TUI, opens the config in `$VISUAL`/`$EDITOR`, validates it, and
  restarts the TUI; provider/store changes need a process restart to take effect.
- Steering and host notices use native submissions: `Conversation.submit` with `whenBusy: "steer"` or
  `"followUp"`, and native write entries (`app.job-notice`). There is no second queue or event log.
- Main is event-driven and does not poll. The task tool still enforces a host-side anti-poll guard: a
  second `show` on a live job within 30s, or a repeated `list` within 10s, terminates the run with a
  “do not poll” result. Turn limits are 60 tool rounds for main and 120 for jobs.
- Job handoffs use one native conversation document (`app.job-handoff`), a native tool result with
  `control.terminate`, and native task/submission commits. Job→main admits a main input; job→job creates
  a successor task and child conversation. The job row shows `handed off → …`, and main sees
  `[job #N handoff]` entries in its transcript.
- Job completion is a toast and list transition; auto-continuation makes main run next.
- The status line always shows the estimated active context (`ctx ~tokens/window`); the context pane adds
  `context`, `compact` threshold and cumulative `spent`.
- Below 64 columns the jobs pane is hidden; below 110 columns the context pane is hidden. The design's
  tabbed narrow layout was not needed for the first version.
- A job row uses two lines (status/id/age, then brief) so the brief stays readable in a narrow pane.
- The TUI calls `resume()` at startup, so pending jobs and interrupted phases from a previous process
  continue without requiring another command.
- The composer uses the toolkit multiline editor: drafts grow and scroll, and bracketed paste preserves normalized line breaks. Large pastes fold into markers that expand on submission.
- Mouse input is disabled in v1; every action has a keyboard path.
- A first `Ctrl-C` stops a wait, clears a prompt, or closes an overlay. A second consecutive press within
  1.5 seconds requests quit (with confirmation while work is live). Other input resets the sequence.

Tests cover the pure job-list/selection/target model, live-tool filtering, and the durable job behavior
through the existing harness tests. A pseudo-TTY smoke run covers startup, key handling, job creation,
cancellation, compaction, reset, config editing, and clean shutdown; rendering itself is not
snapshot-tested.

## Open questions

- Should the default focus on launch be the composer (fast chat) or the job list (supervision)?
- Should `m`/`R` follow the selected target, or always mean main with job actions only in the jobs pane?
  The proposal follows the selected target and names it in the prompt.
- Is a full-screen alt-screen acceptable, or is an inline TUI that preserves terminal scrollback preferred?
