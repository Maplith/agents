# Maplith Bridge

[![CI](https://github.com/Maplith/bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/Maplith/bridge/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/Maplith/bridge/badge)](https://scorecard.dev/viewer/?uri=github.com/Maplith/bridge)

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
- **Small enough to read.** Three files of TypeScript. The server runs on
  Node.js alone; the extractor has one dependency, the PostgreSQL client,
  pinned.

Any MCP client can use it: Claude Code, Claude Desktop, your own agent. It
works best with [Maplith](https://maplith.com), which reads the folder to map
how your systems fit together.

## Quick start

You need Node.js 24 or newer.

```sh
npx --yes maplith-bridge@1.0.0-rc.1 rotate-token
npx --yes maplith-bridge@1.0.0-rc.1 serve --dir ./exports
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
  npx --yes maplith-bridge@1.0.0-rc.1 extract postgres --out ./exports --check
```

`--check` verifies the role and writes nothing. Run it again without `--check`
to write one CSV file per table.

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
sha256sum -c maplith-bridge-1.0.0-rc.1.tgz.sha256
echo "sha512-$(openssl dgst -sha512 -binary maplith-bridge-1.0.0-rc.1.tgz | openssl base64 -A)"
npm view maplith-bridge@1.0.0-rc.1 dist.integrity
gh attestation verify maplith-bridge-1.0.0-rc.1.tgz --repo Maplith/bridge \
  --bundle maplith-bridge-1.0.0-rc.1.tgz.sigstore.json
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
