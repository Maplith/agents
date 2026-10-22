# Changelog

Every notable change to Maplith Bridge. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [semantic versioning](https://semver.org).

## [Unreleased]

## [1.2.0-rc.1] - 2026-10-22

The package is now called `maplith`, with one command, `maplith`. Maplith
Bridge is `maplith bridge`; `maplith-bridge` stays in the package as an alias
of it, so `maplith-bridge serve` and the rest work as before.

### Added

- `maplith setup claude` and `maplith setup codex`: one command that puts
  Maplith in Claude Code or OpenAI Codex. It runs the agent's own commands to
  add the plugin from this repository (the Maplith MCP server, Maplith Bridge
  and the `maplith` skill) and, in Codex, signs you in. It writes no key and no
  configuration file of its own; `--print` shows the commands instead of
  running them, and `setup codex --dir <folder>` names the folder the Bridge
  shares with Codex.

- `stdio`: serves a folder to the agent that started the command, over its
  stdin and stdout, for agents that run their MCP servers as local commands,
  such as Claude Code. It is the same server as `serve`, on `127.0.0.1` only,
  behind a token that lives only in its process: no token file, nothing to
  type, nothing printed. The folder comes from `--dir` or `EXPORT_DIR`;
  without one it serves an empty folder of its own. A folder you name is never
  changed or removed.
- When a server starts it prints one more line: that the Bridge is open source,
  made by Maplith, with a link to the page about it. Nothing is asked and
  nothing is sent.

### Changed

- The package's homepage is maplith.com/open-source.
- The npm package is `maplith`; its tarball is `maplith-<version>.tgz`.

### Fixed

- `stdio` reads an `EXPORT_DIR` an agent passed on without expanding it (such
  as `${MAPLITH_BRIDGE_DIR:-}`) as no folder, and serves an empty one, instead
  of refusing to start. Codex starts a plugin's servers this way.

## [1.1.0-rc.1] - 2026-10-17

### Added

- A schema file. Beside the CSV files of each folder it fills, the extractor
  writes `maplith-schema.json` (format `maplith-schema/1`), which the server
  shares like any other file: the database's identity, and for each table its
  file, its relation id, its columns with their attribute numbers, declared
  types and whether they may be empty, its primary, unique and foreign keys,
  and its estimated row count. Names, numbers and types only, never a value.
  PostgreSQL keeps a column's attribute number through `RENAME COLUMN` and
  gives a column dropped and added again a new one, so a reader can tell a
  renamed column from a new one.
- The database's identity in the schema file is a digest of the server's
  system identifier and timeline, when its statistics were last reset, the
  database's id and its name, and an epoch the extractor draws at random
  where a folder's record begins and moves on when its run finds the
  database's history gone back. A restore keeps the relation ids and
  attribute numbers it had, and the next `ADD COLUMN` can reuse a number
  that a later state had given another column, so the identity changes with
  another server or database, a new timeline (a point-in-time recovery or a
  promotion), a reset of the statistics (every start that has to recover
  resets them: after a crash, or from a restored snapshot or base backup), a
  table or column whose catalog entry was written again before the previous
  run, and a folder with no record of a previous run (its epoch is its own,
  so it never states the identity another folder stated). One restore goes
  unseen: a copy taken while the server was stopped and started again as it
  was, changed only once its transaction counter had passed where the
  original's stood at the previous run (or restored together with the
  extractor's folder).
  Where the role may not read the system identifier, the timeline or when
  the statistics were last reset (some managed servers revoke
  `pg_control_system()`), the schema file names no database
  (`"database": null`) and the extractor says so once: nothing else a
  read-only role can read tells a restored database apart, since a fresh
  server can hand out the same relation ids again and `pg_dump` renumbers
  the attribute numbers without the gaps that dropped columns left. The
  file's relation ids and attribute numbers then describe that run only.
- The hidden catalog records each table's relation id and attribute count,
  each column's attribute number, the transaction ids that last wrote their
  catalog entries and the run's snapshot horizon, for the next run's check
  that the history went on.
- `rotate-token`, and `serve` when it starts, print one line:
  "Security notices and release news: https://maplith.com/bridge/updates".
  Signing up there is optional and done by a person with their own address;
  the Bridge still sends nothing anywhere. RUNBOOK.md and
  INSTALL-WITH-YOUR-AGENT.md carry the same line, and the install prompt asks
  the person instead of filling in an address.
- `glama-stdio.ts`, for MCP directories that build the repository and
  inspect a server over stdio, such as Glama: it serves an empty folder of
  its own with the Bridge's own server on `127.0.0.1`, behind a random token
  that only the process holds and never shows, and relays MCP between stdin
  and stdout and that server. It takes no argument, shares no data, and
  removes its folder when stdin ends or on SIGTERM. It is in the repository,
  not in the npm package. README.md, "For MCP directories", has the settings.

### Security

- The PostgreSQL client `pg` moves from 8.23.0 to 8.23.1. When the database
  is reached by IP address over TLS, the driver now checks the server's
  certificate against that IP address. Version 8.23.0 checked it against
  `localhost`, so a certificate issued for another server could be accepted.

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

[Unreleased]: https://github.com/Maplith/agents/compare/v1.2.0-rc.1...HEAD
[1.2.0-rc.1]: https://github.com/Maplith/agents/releases/tag/v1.2.0-rc.1
[1.1.0-rc.1]: https://github.com/Maplith/agents/releases/tag/v1.1.0-rc.1
[1.0.0-rc.1]: https://github.com/Maplith/agents/releases/tag/v1.0.0-rc.1
