# Changelog

## 1.0.1

- Support HTTP MCP entries with `auth: "bearer"` and a literal or `${NAME}`-expanded
  `bearerToken`. Explicit `headers.Authorization` remains supported and takes
  precedence case-insensitively, including an explicitly empty header.
- Reject missing, empty, whitespace-containing bearer tokens and malformed HTTP
  headers before connecting. Invalid config diagnostics omit JSON source excerpts;
  connection failure notes redact configured header and bearer-token values.
- Document the supported dchat MCP config subset and the separate
  [pi-mcp-adapter shared-file convention](https://github.com/nicobailon/pi-mcp-adapter/blob/1382423d353a06146f1b720631dccbfe81a1905d/docs/configuration.md).
  Bearer shorthand is limited dchat compatibility with adapter-style entries,
  not native Pi 1.5.0 or a universal MCP config standard. No new config discovery,
  field-wise merging, project trust prompts, secret-command execution, script
  tools, credential stores, or OAuth/provider login is introduced. See README
  for exact differences and pinned source references.

## 1.0.0

Initial public GitHub and npm release, with compiled JavaScript CLI aliases,
durable background jobs, offline faux-model support, preserved license notices,
and isolated installed-package smoke coverage.
