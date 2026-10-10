# Changelog

Every notable change to Maplith Bridge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org).

## [Unreleased]

## [1.0.0-rc.1] - 2026-10-10

The first public release candidate.

### Added

- An npm package, `maplith-bridge`, with the command of the same name:
  `npx --yes maplith-bridge@1.0.0-rc.1 --help`. The package is JavaScript
  built from the TypeScript sources by stripping their types, with a
  shrinkwrap that pins every dependency by its hash, and no install script.
- Releases on GitHub with the tarball, its SHA-256 checksum and a build
  attestation; the same tarball on npm with provenance. Builds are
  reproducible.
- `INSTALL-WITH-YOUR-AGENT.md`: one prompt for an AI agent to install the
  Bridge on a Linux server, stopping for a person at every decision, password
  and `sudo`.
- `THREAT-MODEL.md`, naming the tests behind every defence.
- Tests: conformance with MCP 2025-06-18, property-based fuzzing of
  everything a caller sends, and byte-for-byte determinism of the extractor
  on a real PostgreSQL server.
- An entry for the MCP Registry, `com.maplith/bridge`.

### Changed

- The server follows JSON-RPC 2.0 and MCP 2025-06-18 more strictly: a batch,
  a request without `jsonrpc: "2.0"`, or an id that is not a string or an
  integer is refused with -32600; a message without an id is a notification
  and gets 202; a `MCP-Protocol-Version` header the server does not speak gets
  400; parameters that are not an object, and `resources/read` without a uri,
  get -32602.
- The extractor fixes `lc_monetary`, so a `money` column is written the same
  whatever the role's or the server's locale.
- The extractor orders a table by its own columns, also when a column is
  named like one of its output columns (`c0`, `c1`).
- The extractor refuses a role with a default privilege that would grant it
  more than reading on new objects, and prints database names as plain text.
- A file list reads a large file once per change instead of on every page.
- Help and messages name the command as you ran it: `maplith-bridge`,
  `node bridge.js` or `node bridge.ts`.

## 0.1.0 - 2026-10-10

The first version: the read-only MCP server (`serve`), the PostgreSQL
extractor (`extract postgres`), and `rotate-token`.

[Unreleased]: https://github.com/Maplith/bridge/compare/v1.0.0-rc.1...HEAD
[1.0.0-rc.1]: https://github.com/Maplith/bridge/releases/tag/v1.0.0-rc.1
