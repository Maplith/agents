import { closeSync, constants as fsc, fstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { Server } from 'node:http';
import { isLoopback, serve } from './serve.ts';
import { runCli as runExtract } from './extract-postgres.ts';
import { relayStdio } from './stdio.ts';

/** Maplith Bridge: one command for the side that holds the data.
 *
 *    maplith-bridge serve --dir <folder> [--tls-cert … --tls-key …] [--host …]
 *    maplith-bridge stdio [--dir <folder>]
 *    maplith-bridge extract postgres --out <folder> [--check]
 *    maplith-bridge rotate-token [--print-token]
 *
 *  `serve` is serve.ts behind a token FILE, never a token flag or a printed
 *  token: a flag is visible to anyone who can list processes, and the token
 *  is typed by a person into the client, never pasted into a chat with an
 *  assistant. The file is read again when it changes, so `rotate-token`
 *  takes effect on a running server. `extract postgres` is
 *  extract-postgres.ts, whose one dependency, the PostgreSQL driver, is
 *  loaded only by that command: `serve`, `stdio` and `rotate-token` run on
 *  Node.js alone (THREAT-MODEL.md, "A malicious version of a package").
 *  `stdio` is serve.ts for the one agent that started it, over stdin and
 *  stdout (stdio.ts): for an agent that runs its MCP servers as local
 *  commands, such as Claude Code, with a token only that process holds.
 *
 *  Runs on Node.js 24 or newer as it is, with no build step: the TypeScript
 *  here uses only syntax Node strips (no enums, no parameter properties).
 *  The npm package carries the same files with the types stripped
 *  (scripts/build.ts). */

export const INTEGRATIONS_URL = 'https://app.maplith.com/w/<workspace>/integrations';
export const GUIDE_URL = 'https://maplith.com/docs/mcp-template';
/** The one line about mail: printed when a server starts and after
 *  rotate-token. The Bridge never sends anything anywhere; signing up is a
 *  choice the person makes on that page, with their own address. */
export const UPDATES_LINE = 'Security notices and release news: https://maplith.com/bridge/updates';
/** One line about who makes it, printed once when a server starts: a link,
 *  nothing asked and nothing sent. The tags say a visit came from this line. */
export const ABOUT_LINE = 'Maplith Bridge is open source, made by Maplith: https://maplith.com/open-source?utm_source=bridge-cli&utm_medium=cli&utm_campaign=oss-bridge';
export const DEFAULT_TOKEN_FILE = 'maplith-bridge.token';

/** How the person started this command, so help and messages show a command
 *  they can run again. The package's command is `maplith`, whose `bridge`
 *  subcommand is this file (maplith.ts): `maplith bridge` through npm's bin
 *  (npx, npm exec, an installed package), `node maplith.js bridge` from the
 *  unpacked npm package, `node maplith.ts bridge` from a checkout. The older
 *  command `maplith-bridge` is kept as an alias of `maplith bridge`, and so
 *  are `node bridge.js` and `node bridge.ts`. */
export function program(entry: string = process.argv[1] ?? ''): string {
  const name = basename(entry);
  if (name === 'maplith' || name === 'maplith.cmd') return 'maplith bridge';
  if (name === 'maplith.js') return 'node maplith.js bridge';
  if (name === 'maplith.ts') return 'node maplith.ts bridge';
  if (name === 'maplith-bridge' || name === 'maplith-bridge.cmd') return 'maplith-bridge';
  if (name === 'bridge.js') return 'node bridge.js';
  return 'node bridge.ts';
}

/** A value an agent passed on without expanding it: a plugin's
 *  `${MAPLITH_BRIDGE_DIR:-}`, which Claude Code expands and Codex hands over
 *  as written. It names no folder, so it reads as none. */
export function unexpanded(value: string | undefined): boolean {
  return value !== undefined && /^\$\{[A-Za-z_][A-Za-z0-9_]*(:?-[^}]*)?\}$/.test(value.trim());
}

export interface Io {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}
type Env = Record<string, string | undefined>;

export function version(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

class UsageError extends Error {}

// --- Help, written for the person who runs it ------------------------------------

export function helpText(command?: string): string {
  const v = version();
  if (command === 'serve') {
    return `Usage: ${program()} serve --dir <folder> [options]

Serves the files in <folder> to your AI agent and to Maplith, read-only, over
MCP (JSON-RPC over HTTP POST at /mcp). It serves CSV, TSV, JSON, JSONL,
Markdown and text files, never a hidden file and never a file outside the
folder. It accepts no upload and writes nothing. Every request needs the token
in the token file.

Options:
  --dir <folder>          The folder to serve (or EXPORT_DIR). Required.
  --token-file <path>     The token file (or MAPLITH_BRIDGE_TOKEN_FILE).
                          Default: ${DEFAULT_TOKEN_FILE} in the current folder.
                          Create it with rotate-token. It must be readable by
                          its owner only, and lie outside the served folder.
                          It takes only a token rotate-token wrote: 64 random
                          lowercase hexadecimal characters.
  --host <address>        Where to listen. Default 127.0.0.1: this machine
                          only. Any other address needs --tls-cert and
                          --tls-key, or --behind-proxy.
  --port <n>              Default 8787.
  --tls-cert <path>       A PEM certificate (with its chain): the Bridge serves
                          HTTPS itself. Give --tls-key with it.
  --tls-key <path>        The PEM private key of --tls-cert: readable by its
                          owner only, outside the served folder.
  --behind-proxy <list>   A reverse proxy ends TLS in front of the Bridge.
                          Name its addresses (IPs, or CIDR ranges no wider
                          than /12 for IPv4 or /29 for IPv6, comma-separated):
                          only they may connect,
                          and the caller's address is read from the
                          X-Forwarded-For header the proxy adds. "any" only
                          with --host 127.0.0.1, for a proxy on this machine.
  --allow <list>          Only callers from these addresses (IPs or CIDR
                          ranges, comma-separated) are served.
  --name <name>           The name files are listed under: <name>://<path>.
                          Default exports.
  --workspace <id>        Your Maplith workspace id, to print the exact
                          Integrations link (or MAPLITH_WORKSPACE).

The right token is always served. After 10 wrong tokens from one address (for
IPv6, one /64 network) within 10 minutes, wrong tokens from it get 429 for 15
minutes, and the Bridge logs one line. A request with no token at all is
refused and not counted. GET /healthz answers 204 with no body and needs no
token. The token file is read again when it changes, so rotate-token takes
effect without a restart. The token is never printed.

Guide: ${GUIDE_URL}`;
  }
  if (command === 'stdio') {
    return `Usage: ${program()} stdio [--dir <folder>] [--name <name>]

Serves the files in <folder> to the AI agent that started this command, over
its stdin and stdout (the MCP stdio transport), read-only. For an agent that
runs its MCP servers as local commands, such as Claude Code. The same server
as serve, on this machine only (127.0.0.1), behind a token that lives only in
this process: no token file, nothing to type, nothing printed. Logs go to
stderr; stdout carries MCP only. It stops when stdin ends.

Options:
  --dir <folder>          The folder to serve (or EXPORT_DIR). Without one it
                          serves an empty folder of its own, removed when it
                          stops, and says how to name one.
  --name <name>           The name files are listed under: <name>://<path>.
                          Default exports.

To share a folder with Maplith or with an agent on another machine, use serve.

Guide: ${GUIDE_URL}`;
  }
  if (command === 'rotate-token') {
    return `Usage: ${program()} rotate-token [--token-file <path>] [--print-token]

Writes a new random token (256 bits) to the token file, readable by its owner
only, in place of the old one. A running Bridge that reads this file uses the
new token from its next request, and refuses the old one from then on.

It prints where the token is, never the token itself. --print-token prints it
once, at the end, for you to copy; do that only on a screen nobody else sees,
and never paste it into a chat with an assistant.

Options:
  --token-file <path>     The token file (or MAPLITH_BRIDGE_TOKEN_FILE).
                          Default: ${DEFAULT_TOKEN_FILE} in the current folder.
  --print-token           Print the new token once.

Then, in Maplith: under Integrations, remove the connection and add it again
with the new token. Until then, Maplith's scans of this Bridge fail.`;
  }
  if (command === 'extract') {
    return `Usage: ${program()} extract postgres --out <folder> [options]

Writes one CSV file per table that a read-only PostgreSQL role may read into
<folder>, the folder serve shares. It refuses to run under a role that can do
more than read, and runs only its own statements, in one read-only transaction.
It needs the PostgreSQL client package: run "npm ci --ignore-scripts" once in
the Bridge's folder.

The connection comes from the standard variables PGHOST, PGPORT, PGDATABASE,
PGUSER, PGPASSWORD and PGSSLMODE, or DATABASE_URL. The password is never
printed or written to a file.

Options:
  --out <folder>                  The folder serve shares (or EXPORT_DIR). Required.
  --check                         Check the role and list the tables; write nothing.
  --system <name>                 Put every table under one system folder.
  --max-rows <n>                  Rows per table at most. Default 50,000.
  --statement-timeout <seconds>   The limit on each statement. Default 300.
  --deadline <minutes>            The limit on the whole run. Default 60.

Success ends with a line starting "OK:" and exit code 0. Any failure prints
one message and exits with 1. Guide: ${GUIDE_URL}`;
  }
  return `Maplith Bridge ${v}: share a folder of files with your AI agent, read-only.

The Bridge serves one folder of data files over MCP, behind a token. It never
writes, never accepts a file, and holds no database password. Maplith reads
the folder through it, and so can any MCP client you give the token to.

Commands:
  serve               Serve a folder, read-only.
  stdio               Serve a folder to the agent that started this command,
                      over stdin and stdout.
  extract postgres    Fill the folder from a PostgreSQL database, under a
                      read-only role.
  rotate-token        Write a new token to the token file; the old one stops
                      working.

Run "${program()} <command> --help" for the options of one command, and
"${program()} --version" for the version.

A typical setup:
  1. ${program()} rotate-token
  2. ${program()} extract postgres --out /srv/maplith/exports --check
     ${program()} extract postgres --out /srv/maplith/exports
  3. ${program()} serve --dir /srv/maplith/exports \\
       --host 0.0.0.0 --port 8443 --tls-cert <cert.pem> --tls-key <key.pem>
  4. In Maplith, under Integrations: Add MCP connection, with the HTTPS URL and
     the token.

Guide: ${GUIDE_URL}
Security reports: security@maplith.com (SECURITY.md)`;
}

// --- Arguments ---------------------------------------------------------------------

/** Strict flags: an unknown one is an error, every value is required. */
function flags(argv: readonly string[], known: Record<string, 'value' | 'switch'>): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const kind = known[a];
    if (!kind) throw new UsageError(`Unknown argument: ${a}`);
    if (out.has(a)) throw new UsageError(`${a} is given twice`);
    if (kind === 'switch') out.set(a, '');
    else {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      out.set(a, v);
    }
  }
  return out;
}

const list = (v: string | undefined) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter((s) => s !== ''));

export function tokenFilePath(given: string | undefined, env: Env, cwd: string): string {
  return resolve(cwd, given ?? env.MAPLITH_BRIDGE_TOKEN_FILE ?? DEFAULT_TOKEN_FILE);
}

// --- The token file ----------------------------------------------------------------

/** Writes a new token to `file`, owner-only, atomically: a hidden file beside
 *  it, renamed over it, so a server reading the file sees the old token or
 *  the new one, never half of one. */
export function rotateToken(file: string): string {
  let token = randomBytes(32).toString('hex');
  while (tokenWeakness(token) !== null) token = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(6).toString('hex')}`);
  try {
    writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return token;
}

/** At most this many bytes in a token file or a TLS key file read by
 *  `secretFile`: a token is 64 characters, so anything larger is a mistake,
 *  and /dev/zero must not fill the memory. */
export const MAX_TOKEN_FILE = 1024;

/** The one token shape the Bridge takes: what rotate-token writes. */
export const TOKEN_SHAPE = /^[0-9a-f]{64}$/;

/** Why a token is too weak, or null. Wrong tokens are not
 *  throttled once the right one is always served, so a token must be
 *  unguessable on its own. Only the rotate-token shape passes — 64 lowercase
 *  hexadecimal characters, 256 random bits — and within it a patterned
 *  string is refused: fewer than 8 different characters, a string that
 *  repeats with a period of 32 or less ("0123456789abcdef" four times), or a
 *  run of 8 characters that counts up, down or stands still ("01234567").
 *  A random token meets one of those less than once in a million draws,
 *  and rotate-token draws again until it passes. */
export function tokenWeakness(token: string): string | null {
  const refuse = `The token must be one rotate-token wrote: 64 random lowercase hexadecimal characters. Make one with: ${program()} rotate-token`;
  if (!TOKEN_SHAPE.test(token)) return refuse;
  if (new Set(token).size < 8) return refuse;
  for (let p = 1; p <= 32; p++) {
    let periodic = true;
    for (let i = 0; i + p < token.length && periodic; i++) if (token[i] !== token[i + p]) periodic = false;
    if (periodic) return refuse;
  }
  const v = [...token].map((c) => parseInt(c, 16));
  let run = 1;
  let prev = NaN;
  for (let i = 1; i < v.length; i++) {
    const step = v[i] - v[i - 1];
    run = Math.abs(step) > 1 ? 1 : step === prev ? run + 1 : 2;
    prev = step;
    if (run >= 8) return refuse;
  }
  return null;
}

/** Reads a secret file the server depends on (the token file, the TLS key):
 *  a regular file, owner-only, outside the served folder, at most `max` bytes.
 *  Opened without blocking and judged on the descriptor, so a FIFO or a
 *  device swapped in is refused, never read. Returns the bytes or the reason. */
export function secretFile(file: string, servedDir: string | null, what: string, max: number): { bytes: Buffer } | { problem: string } {
  let fd: number;
  try {
    fd = openSync(file, fsc.O_RDONLY | (fsc.O_NONBLOCK ?? 0));
  } catch {
    return { problem: `There is no ${what} at ${file}.` };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { problem: `${file} is not a regular file.` };
    // Owner-only, as ssh insists for a private key. Windows has no such bits.
    if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) return { problem: `${file} can be read by other users. Run: chmod 600 ${file}` };
    if (st.size > max) return { problem: `${file} is larger than ${max} bytes: it is not a ${what}.` };
    if (servedDir !== null && realpathSync(file).startsWith(servedDir + sep)) return { problem: `${file} lies inside the served folder. Keep the ${what} outside it.` };
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    for (;;) {
      const n = readSync(fd, buf, got, buf.length - got, got);
      if (n === 0) break;
      got += n;
      if (got > max) return { problem: `${file} is larger than ${max} bytes: it is not a ${what}.` };
    }
    return { bytes: buf.subarray(0, got) };
  } finally {
    closeSync(fd);
  }
}

/** The token in a token file, or why it cannot be used. */
export function readToken(file: string, servedDir: string | null): { token: string } | { problem: string } {
  const read = secretFile(file, servedDir, 'token file', MAX_TOKEN_FILE);
  if ('problem' in read) {
    return read.problem.startsWith('There is no')
      ? { problem: `${read.problem} Create one with: ${program()} rotate-token --token-file ${file}` }
      : read;
  }
  const token = read.bytes.toString('utf8').trim();
  const weak = tokenWeakness(token);
  return weak ? { problem: `${weak} Make a new one with rotate-token.` } : { token };
}

/** Why a token file cannot be used, or null when it can. */
export function tokenFileProblem(file: string, servedDir: string | null): string | null {
  const r = readToken(file, servedDir);
  return 'problem' in r ? r.problem : null;
}

/** The token, from the file, read again whenever the file changes (its inode,
 *  size, modification or change time), so a rotation reaches a running
 *  server. Every read runs every check of the start again (readToken) and logs
 *  what it finds. A file that is missing or unusable gives no token: every
 *  request is refused. */
export function tokenFromFile(file: string, onProblem: (line: string) => void = () => {}, servedDir: string | null = null): () => string | undefined {
  let stamp = '';
  let token: string | undefined;
  let complained = false;
  return () => {
    let st;
    try {
      st = statSync(file);
    } catch {
      token = undefined;
      stamp = '';
      if (!complained) onProblem(`The token file ${file} is gone: every request is refused until it is back.`);
      complained = true;
      return undefined;
    }
    const now = `${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.mode}`;
    if (now !== stamp) {
      stamp = now;
      const r = readToken(file, servedDir);
      token = 'token' in r ? r.token : undefined;
      if ('problem' in r) onProblem(`${r.problem} Every request is refused until it is fixed.`);
      complained = !token;
    }
    return token;
  };
}

// --- The commands ------------------------------------------------------------------

export interface BridgeResult {
  code: number;
  /** Set by serve: the process keeps running while it listens. */
  server?: Server;
  url?: string;
}

const SERVE_FLAGS: Record<string, 'value' | 'switch'> = {
  '--dir': 'value',
  '--token-file': 'value',
  '--host': 'value',
  '--port': 'value',
  '--tls-cert': 'value',
  '--tls-key': 'value',
  '--behind-proxy': 'value',
  '--allow': 'value',
  '--name': 'value',
  '--workspace': 'value',
};

async function serveCommand(argv: readonly string[], env: Env, io: Io, cwd: string): Promise<BridgeResult> {
  const f = flags(argv, SERVE_FLAGS);
  const dirGiven = f.get('--dir') ?? env.EXPORT_DIR;
  if (!dirGiven) throw new UsageError('Name the folder to serve: --dir <folder> (or EXPORT_DIR).');
  const dir = resolve(cwd, dirGiven);
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new UsageError(`The folder ${dir} does not exist.`);
  }
  if (!st.isDirectory()) throw new UsageError(`${dir} is not a folder.`);
  const servedDir = realpathSync(dir);
  const tokenFile = tokenFilePath(f.get('--token-file'), env, cwd);
  const problem = tokenFileProblem(tokenFile, servedDir);
  if (problem) throw new UsageError(problem);

  const name = f.get('--name') ?? 'exports';
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new UsageError('--name takes lower-case letters, digits and hyphens, starting with a letter (at most 40).');
  const host = f.get('--host') ?? '127.0.0.1';
  if (host.trim() === '') throw new UsageError('--host needs an address: an empty one would listen on every interface.');
  const portText = f.get('--port') ?? '8787';
  if (!/^\d{1,5}$/.test(portText) || Number(portText) > 65535) throw new UsageError('--port takes a number from 0 to 65535.');
  const certPath = f.get('--tls-cert');
  const keyPath = f.get('--tls-key');
  if ((certPath === undefined) !== (keyPath === undefined)) throw new UsageError('Give --tls-cert and --tls-key together.');
  let tls: { cert: Buffer; key: Buffer } | undefined;
  if (certPath !== undefined && keyPath !== undefined) {
    // The key gets the token file's checks: owner-only, outside the served
    // folder, a regular file of a sane size. The certificate is public.
    const key = secretFile(resolve(cwd, keyPath), servedDir, 'TLS key', 64 * 1024);
    if ('problem' in key) throw new UsageError(key.problem);
    try {
      tls = { cert: readFileSync(resolve(cwd, certPath)), key: key.bytes };
    } catch (err) {
      throw new UsageError(`Could not read the certificate: ${(err as Error).message}`);
    }
  }
  const proxyText = f.get('--behind-proxy');
  const behindProxy = proxyText === undefined ? undefined : proxyText.trim() === 'any' ? ('any' as const) : list(proxyText);
  if (behindProxy === 'any' && !isLoopback(host)) {
    throw new UsageError(`--behind-proxy any needs --host 127.0.0.1, with the proxy on this machine. With --host ${host}, name the proxy's addresses: --behind-proxy <address>.`);
  }
  const workspace = f.get('--workspace') ?? env.MAPLITH_WORKSPACE;
  if (workspace !== undefined && !/^[A-Za-z0-9-]{1,64}$/.test(workspace)) throw new UsageError('--workspace takes the id from your workspace address in Maplith (letters, digits and hyphens).');

  const log = (line: string) => io.stdout(`${new Date().toISOString()} ${line}`);
  const v = version();
  const { server, url } = await serve(
    {
      root: dir,
      token: tokenFromFile(tokenFile, log, servedDir),
      name,
      info: { name: 'maplith-bridge', version: v },
      tls,
      behindProxy,
      allow: list(f.get('--allow')),
      log,
    },
    Number(portText),
    host,
  );
  const link = workspace ? INTEGRATIONS_URL.replace('<workspace>', workspace) : INTEGRATIONS_URL;
  const how = tls ? 'HTTPS in the Bridge' : behindProxy ? 'plain HTTP to the proxy that ends TLS in front of it' : 'plain HTTP, this machine only';
  io.stdout(`Maplith Bridge ${v}`);
  io.stdout(`Serving ${servedDir} read-only at ${url} (${how}).`);
  io.stdout(`The token is in ${tokenFile}. It is not printed: copy it from that file. Rotate it with: ${program()} rotate-token --token-file ${tokenFile}`);
  if (!tls && !behindProxy) {
    io.stdout('Maplith reads over HTTPS from the internet only: serve HTTPS (--tls-cert, --tls-key) or put a reverse proxy in front before you connect it.');
  }
  io.stdout('Connect it to Maplith:');
  io.stdout(`  1. Open ${link} and choose Add MCP connection.`);
  io.stdout('  2. MCP URL: the public HTTPS address that reaches this Bridge, ending in /mcp.');
  io.stdout('  3. Bearer token: type the token from the token file, in the app only, never into a chat with an assistant.');
  io.stdout('  4. Choose Test connection, then Review the scan.');
  io.stdout('Any other MCP client: the same URL and token. It offers the tools list_files and read_file.');
  io.stdout(UPDATES_LINE);
  io.stdout(ABOUT_LINE);
  return { code: 0, server, url };
}

/** `stdio`: the folder to the agent that started this process, relayed over
 *  stdin and stdout (stdio.ts). Nothing on stdout but MCP: a usage error goes
 *  to stderr like every other. */
async function stdioCommand(argv: readonly string[], env: Env, cwd: string): Promise<BridgeResult> {
  const f = flags(argv, { '--dir': 'value', '--name': 'value' });
  // An empty EXPORT_DIR is no folder: a plugin passes the variable through
  // whether or not the person set it. Nor is one an agent did not expand
  // (unexpanded): Codex passes a plugin's `${MAPLITH_BRIDGE_DIR:-}` as it is.
  const given = f.get('--dir') ?? (env.EXPORT_DIR?.trim() && !unexpanded(env.EXPORT_DIR) ? env.EXPORT_DIR : undefined);
  const name = f.get('--name') ?? 'exports';
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(name)) throw new UsageError('--name takes lower-case letters, digits and hyphens, starting with a letter (at most 40).');
  let root: string;
  if (given !== undefined) {
    const dir = resolve(cwd, given);
    let st;
    try {
      st = statSync(dir);
    } catch {
      throw new UsageError(`The folder ${dir} does not exist.`);
    }
    if (!st.isDirectory()) throw new UsageError(`${dir} is not a folder.`);
    root = realpathSync(dir);
  } else {
    root = mkdtempSync(join(tmpdir(), 'maplith-bridge-stdio-'));
  }
  const temporary = given === undefined;
  const v = version();
  await relayStdio({
    root,
    name,
    version: v,
    temporary,
    started: (url) =>
      temporary
        ? `Maplith Bridge ${v}: no folder named, so an empty one is served at ${url} (this machine only). To share files, give --dir <folder> or set EXPORT_DIR.`
        : `Maplith Bridge ${v}: serving ${root} read-only at ${url} (this machine only), relayed over stdin and stdout.`,
  });
  return { code: 0 };
}

function rotateCommand(argv: readonly string[], env: Env, io: Io, cwd: string): BridgeResult {
  const f = flags(argv, { '--token-file': 'value', '--print-token': 'switch' });
  const file = tokenFilePath(f.get('--token-file'), env, cwd);
  const token = rotateToken(file);
  io.stdout(`Wrote a new token to ${file} (readable by its owner only).`);
  io.stdout('A running Bridge that reads this file uses it from its next request; the old token is refused from then on.');
  io.stdout('Next, in Maplith: under Integrations, remove the connection and add it again with the new token.');
  io.stdout(UPDATES_LINE);
  if (f.has('--print-token')) {
    io.stderr('The new token follows, printed once because you asked. Type it into Maplith only, never into a chat with an assistant.');
    io.stdout(token);
  }
  return { code: 0 };
}

/** The command line, as a function: what it would print, and the exit code.
 *  Usage errors exit 2, failures 1. A started server keeps the process alive. */
export async function runBridge(argv: readonly string[], env: Env, io: Io, cwd: string = process.cwd()): Promise<BridgeResult> {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
      io.stdout(helpText());
      return { code: command === undefined ? 2 : 0 };
    }
    if (command === '--version' || command === '-v') {
      io.stdout(version());
      return { code: 0 };
    }
    const wantsHelp = rest.includes('--help') || rest.includes('-h');
    if (command === 'serve') {
      if (wantsHelp) return (io.stdout(helpText('serve')), { code: 0 });
      return await serveCommand(rest, env, io, cwd);
    }
    if (command === 'stdio') {
      if (wantsHelp) return (io.stdout(helpText('stdio')), { code: 0 });
      return await stdioCommand(rest, env, cwd);
    }
    if (command === 'rotate-token') {
      if (wantsHelp) return (io.stdout(helpText('rotate-token')), { code: 0 });
      return rotateCommand(rest, env, io, cwd);
    }
    if (command === 'extract') {
      const [source, ...args] = rest;
      if (wantsHelp) return (io.stdout(helpText('extract')), { code: 0 });
      if (source !== 'postgres') throw new UsageError(source === undefined ? 'Name the source: extract postgres' : `This version extracts from postgres only, not ${source}.`);
      return { code: await runExtract(args, env, io) };
    }
    throw new UsageError(`Unknown command: ${command}. Run ${program()} --help.`);
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return { code: err instanceof UsageError ? 2 : 1 };
  }
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) {
  runBridge(process.argv.slice(2), process.env, { stdout: (l) => console.log(l), stderr: (l) => console.error(l) }).then((r) => {
    if (!r.server) process.exitCode = r.code;
  });
}
