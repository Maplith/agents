# Contributing

Thank you for helping. Issues and pull requests are welcome.

For a security problem, do not open an issue: follow [SECURITY.md](SECURITY.md).

## What is where

- **Maplith Bridge**: the repository root (`bridge.ts`, `serve.ts`,
  `stdio.ts`, `extract-postgres.ts`, `glama-stdio.ts`, `test/`).
- **The Claude plugin**: `.claude-plugin/marketplace.json` and
  `plugins/maplith/`. After a change to the skill, rebuild its zip with
  `node plugins/maplith/scripts/build-skill-zip.mjs`, and check the plugin
  with `claude plugin validate plugins/maplith`.
- **Maplith Wake**: `wake-relay/`, with `render.yaml` at the root because
  Render reads it there. It has no dependencies: `cd wake-relay && npm test`.

## Before you start

The Bridge is small on purpose, and its security depends on staying small:

- The server (`serve.ts`), the command line (`bridge.ts`), the stdio relay
  (`stdio.ts`) and the stdio entry for MCP directories (`glama-stdio.ts`)
  use Node.js alone. The
  extractor (`extract-postgres.ts`) has one dependency, the PostgreSQL
  client. A change that adds a runtime dependency will not be merged.
- Nothing writes, uploads or runs anything a caller sends.
- The sources are TypeScript that Node.js 24 runs as it is: only syntax Node
  can strip (no `enum`, no parameter properties, no namespaces).

For anything larger than a fix, open an issue first, so we can agree on the
approach before you spend time on it.

## Develop

```sh
cd test
npm ci --ignore-scripts
npm test            # every test; the PostgreSQL server tests skip without a server
npm run typecheck
npm run fuzz        # the fuzz tests with 20,000 runs each
```

The tests against a real PostgreSQL server run when `MAPLITH_PG_TEST_URL`
names a superuser on a throwaway server, for example:

```sh
docker run --rm -e POSTGRES_PASSWORD=test -p 5432:5432 postgres:18
npm ci --ignore-scripts                 # in the repository root: the driver
MAPLITH_PG_TEST_URL=postgres://postgres:test@localhost:5432/postgres npm --prefix test test
```

## Pull requests

- Add or change tests with every change in behaviour. A change that touches a
  row of [THREAT-MODEL.md](THREAT-MODEL.md) updates that row's tests.
- Keep the CI green: tests on Node.js 24, PostgreSQL 14 and 18, the fuzz run,
  type checking and CodeQL.
- Add a line to the "Unreleased" section of [CHANGELOG.md](CHANGELOG.md)
  (the Bridge) or of [wake-relay/CHANGELOG.md](wake-relay/CHANGELOG.md).
- Pull requests are merged by squashing: one commit per pull request on
  `main`.
- Write in plain English, in the code comments as in the documents.

## Developer Certificate of Origin

Every commit must be signed off: by adding a `Signed-off-by` line, you certify
the [Developer Certificate of Origin 1.1](https://developercertificate.org):
that you wrote the change, or otherwise have the right to submit it under the
project's licence.

```sh
git commit -s -m "Explain what changes"
```

The line carries your real name and an email address you use:
`Signed-off-by: Jane Doe <jane@example.com>`. A pull request whose commits are
not all signed off cannot be merged.

## Releases

Maintainers release by pushing a tag `v<version>` that matches `package.json`.
The release workflow builds the tarball, publishes it to npm with provenance,
and attaches it, its checksum and a build attestation to a GitHub Release. The
build is reproducible: see `scripts/build.ts`.
