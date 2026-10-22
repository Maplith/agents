# Threat model

What Maplith Bridge defends against, what holds against each threat, and the
tests that prove it. Every test named here runs in CI on every change. A
change to a defence changes its tests in the same pull request.

The Bridge has two parts, and they face different threats:

- **the server** (`serve`): reachable over the network, holds a token and
  reads one folder;
- **the extractor** (`extract postgres`): runs on a schedule inside your
  network, holds the database password and writes that folder.

They run as two different system users ([RUNBOOK.md](RUNBOOK.md)), so the
process the network can reach never holds the database password.

Test files are in [`test/`](test). A test is named by its file and its title.

## 1. Someone on the internet calls the server

**What holds.** Every request needs the bearer token: 256 random bits,
compared in constant time through SHA-256 digests, so neither its bytes nor
its length show in the timing. Only the shape `rotate-token` writes is
accepted. Ten wrong tokens from one address (an IPv6 /64) within ten minutes
put it in a fifteen-minute cool-off of 429 answers, logged once; the right
token is always served, so the limit cannot lock out a client that has it. The
server listens on 127.0.0.1 unless it is given TLS or told which reverse proxy
is in front of it, and it refuses any other address in plain HTTP. A request
from a web page (an `Origin` header) is refused before the token is checked,
which also closes DNS rebinding.

**Tests.**

- `serve.test.ts` › "binding: this machine only, unless TLS or a proxy is stated"
- `serve.test.ts` › "TLS in the Bridge"
- `serve.test.ts` › "failed token attempts are rate-limited per caller, with a cool-off"
- `serve.test.ts` › "who may call: the allow-list and the stated proxy"
- `serve.test.ts` › "compares tokens by digest: the same answer for every length, and no length check in the code"
- `serve.test.ts` › "refuses a request from a browser page, before the token is asked for"
- `serve.test.ts` › "takes only the rotate-token shape, and no patterned string in it"
- `fuzz.test.ts` › "a token header of any text is accepted only when it is exactly the token"
- `fuzz.test.ts` › "X-Forwarded-For of any shape gives an address or a refusal, never an exception"
- `fuzz.test.ts` › "an address list of any text is either refused with a reason or a list of real addresses"

## 2. The token leaks

**What holds.** The token opens one folder, read-only, and nothing else: no
method writes, and no path leads out of the folder (section 4). `rotate-token`
replaces it in one command and a running server takes the new one at once,
refusing the old. `--allow` limits the addresses that may call. The token
lives in a file the server checks at start and on every change: a regular
file of at most 1 KB, readable by its owner only, outside the served folder.
It is never printed unless `--print-token` asks for it once, and never taken
on the command line, where other users could see it. `stdio` (the command,
for an agent on the same machine) and the stdio entry for MCP directories
(`glama-stdio.ts`) draw a token of their own that only their process holds,
for a server on `127.0.0.1`: they never write, print or log that token, and
the server still refuses any request without it. The agent that started the
process is the only one that can talk to it, over its stdin and stdout.

**Tests.**

- `serve.test.ts` › "rotate-token: one command, the token never printed unless asked"
- `serve.test.ts` › "refuses a missing, shared or misplaced token file, and takes no token on the command line"
- `serve.test.ts` › "prints the version, the address, where the token is and the Integrations steps, never the token"
- `serve.test.ts` › "serves only callers on the allow-list, with or without the token"
- `serve.test.ts` › "has no method that writes: anything unknown is refused"
- `glama-stdio.test.ts` › "never shows its token on stdout or stderr, and its server takes no request without it"
- `stdio.test.ts` › "serves the folder it is given to the agent over stdin and stdout, and leaves the folder as it was"

## 3. Something harmful is sent in

**What holds.** The server accepts no file, no upload and no write of any
kind. A request body is at most 64 KB of JSON; it is parsed, never executed or
evaluated, and nothing a caller sends reaches the disk, a shell or the
database: the server imports Node.js alone, starts no process and opens no
connection. Every request, well-formed or not, gets one well-formed answer.

**Tests.**

- `serve.test.ts` › "nothing is sent in"
- `serve.test.ts` › "no runtime dependency for the server"
- `fuzz.test.ts` › "the JSON-RPC handler never throws, and answers every body with nothing or one well-formed reply"
- `fuzz.test.ts` › "answers every request with a known status, never crashes, and stays up" (which also proves that no request changed a file, a folder or a link)
- `mcp-conformance.test.ts` › "errors"

## 4. A request reaches outside the folder

**What holds.** Every read resolves the path through `realpath` and must land
inside the folder, so neither `..`, an encoded `..`, nor a symbolic link
reaches a file outside it. No hidden file or folder is listed or read. Only
CSV, TSV, JSON, JSONL, Markdown and text files are served, judged on the file
a link points to as well as the name asked for. The file is opened without
following a link and checked on the open descriptor: a file swapped for a
link, another file or a FIFO after the check is refused.

**Tests.**

- `serve.test.ts` › "read_file returns what resources/read returns, and refuses what it refuses, with the same reason"
- `serve.test.ts` › "list_files returns what resources/list returns, page by page"
- `serve-fs.test.ts` › "the resources server reads only the file it checked"
- `fuzz.test.ts` › "a URI never names a file outside the folder, a hidden one, a link out or a type that is not served"
- `fuzz.test.ts` › "resources/read and read_file give the same answer for every URI, and never a secret"
- `fuzz.test.ts` › "a list cursor of any kind lists only files inside the folder"

## 5. The database password

**What holds.** The password stays on the extractor's machine, read by the
PostgreSQL client from `~/.pgpass` or the environment. It is never printed,
logged or written to a file: every line the extractor prints is redacted of
it, a driver error included. It is sent to the database and nowhere else, over
TLS with a verified certificate whenever the database is on another machine,
unless the operator chooses a mode. The extractor refuses to run under a role
that can do more than read, checked in every way a role can write or hand on
access that the tests below name, and reads in one read-only transaction. It
runs no SQL of anyone else's: table and column names come from the catalog,
quoted. No cell value leaves a table's own CSV file: the schema file it writes
beside them (`maplith-schema.json`) and the hidden catalog hold names, numbers
(transaction ids among them, in the hidden catalog) and types, and the
database is named only by a digest of its identity, or not at all where the
role may not read the server's system identifier, its timeline or when its
statistics were last reset.

**Tests.**

- `extract-postgres.test.ts` › "the schema file"
- `extract-postgres.test.ts` › "the credential: never logged, never written, never sent"
- `extract-postgres.test.ts` › "what the extractor must never do"
- `extract-postgres-server.test.ts` › "what the extractor must never do, one login role per case"
- `extract-postgres-server.test.ts` › "the credential"
- `fuzz.test.ts` › "an identifier of any text is quoted so it reads back as itself, and one with NUL is refused"
- `fuzz.test.ts` › "a table or schema name of any text becomes a safe file name"
- `fuzz.test.ts` › "a command line of any words is parsed strictly, or refused with a reason"

## 6. A tampered package

**What holds.** The server, `stdio`, `rotate-token` and `setup` use Node.js alone. The extractor
has one dependency, the PostgreSQL client, at an exact version, with every
installed package pinned by its hash, and none runs an install script; the
published package has no scripts at all. A release is built by the release
workflow in this repository, in a job that installs no package and runs no
test tool: reproducibly, with a SHA-256 checksum and a build attestation on
the GitHub Release, and published to npm with provenance
through trusted publishing, so no npm token exists to steal. Publishing needs
a maintainer's approval. Every action in every workflow is pinned by commit,
every job holds only the permissions it needs, and Dependabot proposes every
update as a reviewed pull request. No container image is published.

**Tests.**

- `supply-chain.test.ts` › "depends on the PostgreSQL client alone, at an exact version, and runs no install script"
- `supply-chain.test.ts` › "belongs to this package and version, and pins every package by its hash from the npm registry, none with an install script"
- `supply-chain.test.ts` › "is reproducible: the same sources give the same bytes, with the checksum beside them"
- `supply-chain.test.ts` › "publishes the manifest without scripts, and the lockfile as the shrinkwrap"
- `supply-chain.test.ts` › "strips the types and nothing else: every line where it was, every import pointing at the .js beside it"
- `supply-chain.test.ts` › "pin every action by a full commit, with its version beside it"
- `supply-chain.test.ts` › "grant nothing at the top, and each job only what it needs: id-token only where something is signed or published"
- `supply-chain.test.ts` › "never run on pull_request_target, never keep the checkout's token, and never put event data straight into a script"
- `supply-chain.test.ts` › "install with --ignore-scripts only, and publish with provenance from the protected environment"
- `supply-chain.test.ts` › "let Dependabot keep the driver, the test tools and the actions current"

## 7. A file tries to instruct an agent

**What holds.** The files hold whatever your systems hold, and an agent reads
them. The server tells every client, in its `instructions` and in the
description of `read_file`, that file contents are data, not instructions,
and `read_file` returns a file as an embedded resource, never as loose text.
The README tells you to give your own agent the same rule.

**Tests.**

- `serve.test.ts` › "initialize advertises resources and tools, negotiates the version, and says file content is data"
- `serve.test.ts` › "lists exactly two tools, both read-only, with strict schemas"
- `supply-chain.test.ts` › "tell every client to treat file contents as data, never as instructions"

## 8. The setup command runs other programs

**What holds.** `maplith setup claude|codex` runs your agent's own commands,
`claude` or `codex`, the ones its documentation gives for adding a plugin and
signing in. It starts them without a shell, so every argument, a folder name
included, reaches the agent as written. It writes no file of its own, holds
no key and sends nothing anywhere; what your agent's configuration ends up
holding is what those commands write, and the sign-in happens in your
browser. `--print` shows the commands instead of running them, and on Windows
it only prints them. The code is loaded only by `setup`: the server, `stdio`
and `rotate-token` never load it.

**Tests.**

- `setup.test.ts` › "hands a folder with spaces or quotes to the agent as one argument, never through a shell"
- `setup.test.ts` › "never puts a key, a token or a header in what it runs"
- `setup.test.ts` › "--print, and always on Windows, prints the commands and runs none"

## Outside this model

- **A client that reads a hostile server** defends itself. Maplith's own
  connector does, with its own checks; other clients have their own.
- **The machine the Bridge runs on.** Anyone who controls it, or the account
  that runs the extractor, controls the Bridge.
- **What you choose to share.** The Bridge serves what is in the folder, and
  the extractor reads what the role may read. Grant table by table.

Found a way around any of this? See [SECURITY.md](SECURITY.md).
