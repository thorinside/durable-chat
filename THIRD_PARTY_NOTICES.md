# Third-party notices

Original durable-chat code is MIT licensed; see LICENSE. Dependency and adapted
documentation copyrights remain with their respective owners. No dependencies
are bundled into the durable-chat npm archive; npm installs them separately.

## Pi / Pi Durable

The actual dependency is **@earendil-works/pi-durable 1.5.2**, not "PyDurable".
It and the direct @earendil-works/chord, pi-ai, pi-codemode, pi-coding-agent,
pi-mcp, pi-schema and pi-tui 1.5.2 dependencies declare MIT in their published
package metadata.

Upstream: https://github.com/earendil-works/pi

The full upstream MIT text (Copyright 2025 Mario Zechner) is preserved in
[LICENSES/pi-MIT.txt](LICENSES/pi-MIT.txt), verified against the upstream
revision referenced by the integration playbook:
https://github.com/earendil-works/pi/blob/f9a26365568127461c47a07a37dcb42c140a3ac5/LICENSE

The integration playbook in docs/playbooks_using-pi-durable.md includes
reference-derived examples and public source citations. Retain the upstream
notice when redistributing it or substantial adapted portions. Public package
metadata does not include a gitHead; the cited revision is a documentation
reference, not an assertion of byte-identical npm build provenance.

## Upstream adaptations

These notices are additionally retained from the installed upstream packages:

- @earendil-works/pi-mcp THIRD_PARTY_NOTICES/modelcontextprotocol-typescript-sdk.txt:
  Model Context Protocol TypeScript SDK, MIT, Copyright 2024 Anthropic, PBC.
  Full text: [LICENSES/mcp-sdk-MIT.txt](LICENSES/mcp-sdk-MIT.txt).
- @earendil-works/pi-schema THIRD_PARTY_NOTICES/typebox-LICENSE:
  TypeBox, MIT, Copyright 2017–2026 Haydn Paterson.
  Full text: [LICENSES/typebox-MIT.txt](LICENSES/typebox-MIT.txt).

## YAML and transitive dependencies

yaml 2.9.0 is ISC licensed. Its full notice is preserved in
[LICENSES/yaml-ISC.txt](LICENSES/yaml-ISC.txt).

The locked production/development dependency graph also declares Apache-2.0,
BlueOak-1.0.0, BSD-3-Clause, ISC, 0BSD and Unlicense terms in addition to MIT. Dependencies
remain separately licensed; this application's MIT license does not replace
their notices. Re-audit package license texts and any NOTICE requirements before
upgrading, vendoring or bundling dependencies.
