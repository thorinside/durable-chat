# Maintainer overview

durable-chat is a terminal coordinator built on @earendil-works/pi-durable 1.5.0.
The README is the user-facing reference; [RELEASING.md](RELEASING.md) describes
release verification and publication.

## Architecture

- Main is a persisted conversation whose task/fork tools create background jobs.
- A JobTask owns its child conversation and durably records submissions, job links,
  handoffs, workspace assignments and completion receipts.
- Harness startup registers providers, tools and task definitions and acquires a
  single-writer store lease. Definitions are reinstalled on restart.
- SQLite stores conversations and pending work. Closing the process pauses jobs;
  reopening with scheduling enabled resumes them. External effects are not
  exactly-once and may repeat after retry or restart.
- Optional MCP connections expose coding tools through Substrate or other configured
  servers; no Substrate account is required for the offline faux model.
- The TUI and plain chat share one runtime and model configuration.
- AGENTS.md files supply scoped repository guidance, not a filesystem sandbox.

## Development

Requires Node >=22.19.0 and npm. Git is needed for managed worktrees.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:package
node src/cli.ts help
```

Source execution is convenient for development. Releases must instead run built
JavaScript from a real installation under node_modules; Node does not natively
strip TypeScript there.

Test fixtures use temporary stores, the faux model, loopback servers and mocked
credentials rather than a real provider subscription. Never run release checks
against a personal live store or upload it in a bug report.

## Operational limits

One process owns each store. Reminders and jobs run only while scheduling is
active. Restoring/forking storage can resume unfinished work and repeat external
actions; inspect the README's durability, reboot, rollback and state-fork sections.
Provider credentials and local MCP settings belong outside the repository.

Historical personal workstation notes and unrelated generated artifacts are not
part of the public source snapshot.
