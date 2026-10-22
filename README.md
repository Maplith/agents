# Maplith for your agents

[![CI](https://github.com/Maplith/agents/actions/workflows/ci.yml/badge.svg)](https://github.com/Maplith/agents/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Maplith/agents/badge)](https://scorecard.dev/viewer/?uri=github.com/Maplith/agents)
[![Built by Maplith](https://img.shields.io/badge/built%20by-Maplith-1f2937)](https://maplith.com/open-source?utm_source=github&utm_medium=profile&utm_campaign=oss-bridge)

[Maplith](https://maplith.com) maps how a company's systems fit together, so
any AI agent can find the data it needs, by which key, and how far to trust
each step. This repository holds the open-source parts that run on your side,
next to your agent and your data. One product, three parts:

| Part | What it does | Where |
|---|---|---|
| **Plugin for Claude Code and Codex** | Maplith in your coding agent with one install: the hosted map over MCP (you sign in; nothing is pasted), Maplith Bridge for a local folder, and a skill that says when and how to use them. | [`plugins/maplith/`](plugins/maplith/) |
| **Maplith Bridge** | Connect your database to your AI agent, read-only, without giving anyone your password. | this page, from [Quick start](#quick-start) |
| **Maplith Wake** | Start your own Claude agent the moment there is work for it, from a small relay in your own account. | [`wake-relay/`](wake-relay/) |

All of it is one npm package, [`maplith`](https://www.npmjs.com/package/maplith),
with one command: `maplith setup` puts Maplith in your agent, and
`maplith bridge` is Maplith Bridge.

## Set Maplith up in your agent

No account? You create one in the browser window that opens when you sign
in, and come straight back. Your agent then builds your first map with you.

**One command**, with Node.js 24 or newer. It runs your agent's own commands
and writes no key anywhere:

```sh
npx --yes maplith@1.2.0-rc.1 setup claude
npx --yes maplith@1.2.0-rc.1 setup codex
```

**Or by hand.** Claude Code:

```text
/plugin marketplace add Maplith/agents
/plugin install maplith@maplith
```

then run `/mcp`, choose **maplith** and **Authenticate**. OpenAI Codex:

```sh
codex plugin marketplace add Maplith/agents
codex plugin add maplith@maplith
codex mcp login maplith
```

Codex does not pass your environment to a plugin's servers, so to share a
folder with Codex through the Bridge, name it once:
`npx --yes maplith@1.2.0-rc.1 setup codex --dir <folder>`.

Everything here is Apache-2.0.

# Maplith Bridge

Connect your database to your AI agent, read-only, without giving anyone your
password.

The Bridge runs in your own network. It shares one folder of data files over
MCP (the Model Context Protocol), behind a token you create, and it can fill
that folder from PostgreSQL under a database role that can only read.

- **Read-only, end to end.** The server has no method that writes and accepts
  no file. The extractor refuses to run under a role that can do more than
  read.
- **Your password stays with you.** The database password never leaves the
  machine the extractor runs on, and the server that faces the network never
  holds it.
- **Small enough to read.** Four files of TypeScript, beside the `maplith`
  command and its `setup`. The server runs on Node.js alone; the extractor
  has one dependency, the PostgreSQL client, pinned.

Any MCP client can use it: Claude Code, Codex, Claude Desktop, your own agent. It
works best with [Maplith](https://maplith.com), which reads the folder to map
how your systems fit together.

## Quick start

You need Node.js 24 or newer.

```sh
npx --yes maplith@1.2.0-rc.1 bridge rotate-token
npx --yes maplith@1.2.0-rc.1 bridge serve --dir ./exports
```

The first command writes a random token to `maplith-bridge.token`, readable
by you only. The second serves the files in `./exports` at
`http://127.0.0.1:8787/mcp`, on this machine only. Point any MCP client at that
address with the header `Authorization: Bearer <the token>`. With Claude Code:

```sh
claude mcp add --transport http bridge http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $(cat maplith-bridge.token)"
```

To fill the folder from PostgreSQL, under a read-only role:

```sh
PGHOST=db.example.com PGDATABASE=shop PGUSER=bridge_reader \
  npx --yes maplith@1.2.0-rc.1 bridge extract postgres --out ./exports --check
```

`--check` verifies the role and writes nothing. Run it again without `--check`
to write one CSV file per table.

Beside the CSV files of each folder, the extractor writes `maplith-schema.json`,
which the server shares like any other file: for each table, its file, its
columns with their PostgreSQL attribute numbers and types, its keys and its
estimated row count. It holds names and numbers, never a value, and names the
database only by a digest of its identity (below). A reader can tell
from it that a renamed column is the same column (its attribute number stays)
and that a column dropped and added again is a new one (it gets a new number).

A restore keeps the relation ids and attribute numbers it had, and the next
`ADD COLUMN` can reuse a number that a later state had given another column.
So the digest is made of the server's system identifier and timeline, when
its statistics were last reset, the database's id and name, and an epoch the
extractor keeps in the folder, and it changes when the extractor sees that the
database's history did not go on from its last run: another server or
database, a new timeline (a point-in-time recovery or a promotion), a reset of
the server's statistics (every start that has to recover resets them: after a
crash, or from a restored snapshot or base backup), a table or column whose
catalog entry was written again before that run (an earlier copy restored,
then changed), or no record of that run in the folder (a first run, a new
install, another folder: its record starts with an epoch of its own, drawn at
random, so it never states the digest another folder stated). One restore goes
unseen: a copy of the data directory taken while the server was stopped and
started again as it was, changed only once its transaction counter had passed
where the original's stood at the extractor's last run (or restored together
with the extractor's folder). The same numbers can then name other columns
under the same digest.

Where the role may not read the system identifier, the timeline or when the
statistics were last reset, the file names no database (`"database": null`),
and its numbers describe that run only: a restore into a fresh server can give
the same relation ids again, and it renumbers the attribute numbers.

Run any command with `--help` for every option.

## Set it up for real

- [RUNBOOK.md](RUNBOOK.md): a server install, step by step, for the person who
  runs it: two system users, the read-only role, TLS, a systemd service.
- [INSTALL-WITH-YOUR-AGENT.md](INSTALL-WITH-YOUR-AGENT.md): one prompt that has
  your own AI agent do the same install, stopping for you at every decision,
  password and `sudo`.

## How it keeps your data safe

| Risk | What the Bridge does |
|---|---|
| Someone on the internet calls it | Every request needs the token: 256 random bits, compared in constant time. Wrong tokens are counted and slowed down. It listens on this machine only unless you give it TLS or name the reverse proxy in front of it, and it refuses plain HTTP on any other address. |
| The token leaks | It opens one folder, read-only, and nothing else. `rotate-token` replaces it in one command, without a restart. `--allow` limits who may call. |
| Something harmful is sent in | Nothing is written, uploaded or run. A request is at most 64 KB of JSON and is never evaluated. |
| A request reaches outside the folder | Not through `..`, a symbolic link or a hidden file. Only CSV, TSV, JSON, JSONL, Markdown and text files are served. |
| Your database password | It stays on the extractor's machine, is never printed or written, and is sent only to the database: over verified TLS by default when the database is on another machine. |
| A tampered package | Releases are built in public CI with provenance, and carry a checksum and a build attestation. The published package runs no install script. |
| A file tries to instruct an agent | The server tells every client that file contents are data, not instructions. |

[THREAT-MODEL.md](THREAT-MODEL.md) names the tests behind every row.

## Verify a release

Every release on GitHub carries the tarball, its SHA-256 checksum and a build
attestation. The same tarball is published to npm with provenance, so npm's
digest of it must match the file from GitHub: the two `sha512-` lines below
are equal.

```sh
sha256sum -c maplith-1.2.0-rc.1.tgz.sha256
echo "sha512-$(openssl dgst -sha512 -binary maplith-1.2.0-rc.1.tgz | openssl base64 -A)"
npm view maplith@1.2.0-rc.1 dist.integrity
gh attestation verify maplith-1.2.0-rc.1.tgz --repo Maplith/agents \
  --bundle maplith-1.2.0-rc.1.tgz.sigstore.json
```

After installing from npm, `npm audit signatures` checks the registry
signature and the provenance.

## Use it from any MCP client

The Bridge speaks MCP 2025-06-18 (and 2025-03-26, 2024-11-05) over Streamable
HTTP: JSON-RPC 2.0 requests by POST to `/mcp`. It offers:

- resources: `resources/list` (100 per page, with a cursor) and `resources/read`;
- two read-only tools on the same code path: `list_files` and `read_file`.

Each top-level folder is one system: `exports://shop/orders.csv` is the file
`orders.csv` of the system `shop`. A file is listed only when it fits in one
reply of at most 8 MB. `GET /healthz` answers 204 for a health check.

File contents come from your systems. Tell your agent to treat them as data,
never as instructions; the Bridge says the same in its `instructions`.

## Use it from an agent on this machine

An agent that starts its MCP servers as local commands, such as Claude Code,
can start the Bridge itself:

```sh
npx -y maplith bridge stdio --dir ./exports
```

`stdio` serves the folder to that one agent over its stdin and stdout: the
same server as `serve`, on `127.0.0.1` only, behind a token that lives only
in its process. There is no token file and nothing to type. The folder comes
from `--dir` or `EXPORT_DIR`; without one it serves an empty folder and says
how to name one. The Maplith plugin starts it this way: in Claude Code with
the folder from `MAPLITH_BRIDGE_DIR`, in Codex with the folder `setup codex
--dir` names. The older command `maplith-bridge` still works, as
`maplith bridge`. To share a folder with Maplith or with
an agent on another machine, use `serve`.

## For MCP directories

A directory of MCP servers, such as [Glama](https://glama.ai/mcp/servers),
builds this repository in a sandbox and inspects the server over stdio, with
no folder and no token to give it. `glama-stdio.ts` is the entry for that,
and only for that:

- it creates an empty folder of its own, so there is nothing to share;
- it draws a random token that lives only in its memory: never in a file, an
  argument, the environment or a log;
- it starts the Bridge's own server on `127.0.0.1`, on a free port, serving
  that folder behind that token;
- it relays MCP between stdin and stdout and that server, one JSON-RPC
  message per line, and logs to stderr only;
- when stdin ends, or on SIGTERM, it stops the server and removes the folder.

A directory sees the Bridge as it is: its `initialize` reply and
`instructions`, the tools `list_files` and `read_file`, and an empty list of
files. The entry takes no argument and cannot share a folder: `serve` does
that. It is in this repository, not in the npm package.

With Node.js 24 or newer, from a checkout:

```sh
npm ci --ignore-scripts
node glama-stdio.ts
```

A directory that speaks HTTP to its sandbox puts
[mcp-proxy](https://github.com/punkpeye/mcp-proxy) in front of it:
`mcp-proxy -- node glama-stdio.ts`. On Glama, the server's settings are:

| Setting | Value |
|---|---|
| Node.js version | 24 |
| Build steps | `["npm ci --ignore-scripts"]` |
| CMD | `["mcp-proxy", "--", "node", "glama-stdio.ts"]` |
| Environment variables | none |

## Limits

- PostgreSQL is the one database the extractor reads. Any other system can
  fill the folder with its own export files.
- The server reads a TLS certificate when it starts: restart it after a
  renewal.
- Behind two proxies in a row, name both with `--behind-proxy`.

## Versioning

The Bridge follows [semantic versioning](https://semver.org). Every change is
in [CHANGELOG.md](CHANGELOG.md).

## Contributing, security, licence

- [CONTRIBUTING.md](CONTRIBUTING.md): how to propose a change (with a DCO
  sign-off).
- [SECURITY.md](SECURITY.md): report a vulnerability privately, to
  security@maplith.com or through GitHub.
- Apache License 2.0 ([LICENSE](LICENSE)). "Maplith" and the Maplith logo are
  trademarks of Maplith ([TRADEMARK.md](TRADEMARK.md)).
