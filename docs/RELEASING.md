# Releasing durable-chat

## Public-history boundary

The initial public repository starts with a reviewed source snapshot. Earlier
local development history intentionally remains private because it contains
workstation and session notes. The original local repository and branches are
preserved; the public repository is an independent clean-history Git repository.

After the initial release, use a fresh clone of
https://github.com/thorinside/durable-chat for ongoing work. Do **not** merge,
push or attach old private branches/tags, use --mirror, or connect the original
development checkout as a push source. Transfer any later changes as reviewed
patches without legacy history. Public source provenance and upstream copyright
notices are documented in THIRD_PARTY_NOTICES.md.

## Verify a release

Use a clean checkout and an appropriate Node version. CI checks Node 22.19.0,
24 and 26 on Linux, plus Node 26 on macOS. Windows has not been validated.

```sh
npm ci --ignore-scripts
npm run check
npm test
npm run build
npm run test:package
npm pack --dry-run --ignore-scripts --json
```

The package smoke test packs without lifecycle scripts, validates the allowlisted
archive contents and preserved licenses, installs the actual archive in a
temporary project without lifecycle scripts, invokes both installed binary names,
and creates/completes/reopens an offline background job. It isolates configuration,
credentials and SQLite data from the developer's home.

Production dependencies with lifecycle hooks are installed without running those
hooks in CI and package smoke tests. The tested application works with that install;
do not enable arbitrary dependency hooks without reviewing an actual need.

Review tracked files, all proposed public commits and the final tarball for keys,
tokens, auth/MCP configs, private hosts, absolute personal paths, transcripts,
SQLite files, archives and logs. A .gitignore or npm files allowlist does not scrub
history. Run an independent secret scanner when available; heuristic checks are
not proof that no secret exists. Rotate any exposed credentials before publication.

## GitHub release

Only use the verified thorinside GitHub account/namespace. Refuse unrelated
existing repositories and never force-push. Release from the clean public clone
after checks pass:

```sh
npm run build
npm pack --ignore-scripts
# Inspect the archive again, then replace 1.0.0 for subsequent versions:
git tag -a v1.0.0 -m "durable-chat 1.0.0"
git push origin main
git push origin v1.0.0
gh release create v1.0.0 durable-chat-1.0.0.tgz \
  --repo thorinside/durable-chat --verify-tag --title "durable-chat 1.0.0" \
  --notes "Initial release. See README for setup, safety and durability limits."
```

Retain a SHA-256 checksum of the tested archive as a release asset. A GitHub
release is not an npm registry publication.

## npm registry publication

The intended package name is durable-chat. An unauthenticated registry 404 does
not establish ownership or reserve the name. Before publishing:

```sh
npm whoami --registry=https://registry.npmjs.org
npm view durable-chat name version maintainers --registry=https://registry.npmjs.org
```

If the package exists, verify the authenticated npm account is an authorized
maintainer; otherwise stop rather than overwrite unrelated content or guess a
scope. If it does not exist, confirm that the authenticated account is the
intended owner and can register the name. Do not assume a GitHub username is
also an npm username. Enable account 2FA or configure a narrowly scoped trusted
publisher through the account owner's normal flow; never put tokens in Git.

After explicit account/ownership verification, publish the **same tested
archive**, avoiding unreviewed lifecycle scripts:

```sh
npm publish ./durable-chat-1.0.0.tgz --access public --ignore-scripts \
  --registry=https://registry.npmjs.org
npm view durable-chat@1.0.0 dist.integrity --registry=https://registry.npmjs.org
```

Versions are immutable. Do not publish a replacement under an unintended scope.
If authentication or ownership is unavailable, report that blocker and keep the
GitHub release usable without claiming the package is on npm.
