import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { Agent, request, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { serve } from './serve.ts';
import { version } from './bridge.ts';

/** Maplith Bridge over stdio, for MCP directories that inspect a server:
 *
 *    node glama-stdio.ts
 *
 *  A directory such as Glama builds the repository in a sandbox and talks to
 *  the server over stdio (through mcp-proxy), with no folder and no token to
 *  give it. The Bridge itself serves Streamable HTTP and needs both. This
 *  entry gives a directory what it needs to see the Bridge as it is (its
 *  initialize reply, its instructions, its two tools and its resources) and
 *  nothing else:
 *
 *   - it creates an empty folder of its own, so there is no data to share;
 *   - it draws a random token that lives only in this process: never written
 *     to a file, never printed, never in an argument or the environment;
 *   - it starts the Bridge's own server (serve.ts, unchanged) on 127.0.0.1,
 *     on a free port, serving that empty folder behind that token;
 *   - it relays JSON-RPC between stdin and stdout (one message per line, the
 *     MCP stdio transport) and the server's /mcp endpoint: each message is
 *     POSTed with the token, a JSON or an event-stream reply is written to
 *     stdout, and a session id or protocol version the server gives is sent
 *     back on the requests after it;
 *   - it logs to stderr only;
 *   - when stdin ends, or on SIGTERM, SIGINT or SIGHUP, it stops the server
 *     and removes the folder.
 *
 *  It is not a way to share files: it serves nothing but an empty folder, and
 *  takes no argument. To share a folder, run `bridge.ts serve`. */

/** What the server answers with when the relay itself cannot get a reply. */
const RELAY_ERROR = -32603;
/** How long the server may stay silent on one message. */
const REQUEST_TIMEOUT_MS = 120_000;

/** Server-sent events as they arrive: feed it text in any pieces, and it
 *  calls `onData` with the data of every event of type "message" (the
 *  default type), its data lines joined by "\n". Comments, ids and retry
 *  fields are skipped. Lines end in CRLF, LF or CR (the event-stream format).
 *  `end` dispatches an event left without its closing blank line. */
export function sseReader(onData: (data: string) => void): { push: (text: string) => void; end: () => void } {
  let buffer = '';
  let data: string[] = [];
  let type = '';
  const dispatch = () => {
    if (data.length && (type === '' || type === 'message')) onData(data.join('\n'));
    data = [];
    type = '';
  };
  const line = (l: string) => {
    if (l === '') return dispatch();
    if (l.startsWith(':')) return;
    const colon = l.indexOf(':');
    const field = colon < 0 ? l : l.slice(0, colon);
    let value = colon < 0 ? '' : l.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') type = value;
  };
  return {
    push(text: string) {
      buffer += text;
      for (;;) {
        const i = buffer.search(/[\r\n]/);
        if (i < 0) return;
        // A CR at the very end may be the first half of a CRLF: wait for more.
        if (buffer[i] === '\r' && i === buffer.length - 1) return;
        const width = buffer[i] === '\r' && buffer[i + 1] === '\n' ? 2 : 1;
        line(buffer.slice(0, i));
        buffer = buffer.slice(i + width);
      }
    },
    end() {
      if (buffer !== '') line(buffer.replace(/\r$/, ''));
      buffer = '';
      dispatch();
    },
  };
}

/** A request's id, when the message is a request (it has a method and a
 *  string or integer id), so a failed relay can still answer it. */
function requestOf(line: string): { id?: string | number; initialize: boolean } {
  try {
    const m = JSON.parse(line) as unknown;
    if (typeof m !== 'object' || m === null || Array.isArray(m)) return { initialize: false };
    const { id, method } = m as { id?: unknown; method?: unknown };
    const isRequest = typeof method === 'string' && (typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id)));
    return isRequest ? { id: id as string | number, initialize: method === 'initialize' } : { initialize: false };
  } catch {
    return { initialize: false };
  }
}

const log = (line: string): void => {
  process.stderr.write(`maplith-bridge stdio: ${line}\n`);
};

/** One line on stdout, waiting while the pipe is full. */
const write = (message: string) =>
  new Promise<void>((ok) => {
    if (process.stdout.write(`${message}\n`)) ok();
    else process.stdout.once('drain', () => ok());
  });

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    log('takes no argument. It serves an empty folder over stdio, for MCP directories that inspect a server. To share a folder, run: node bridge.ts serve --dir <folder>');
    process.exitCode = 2;
    return;
  }
  // Removed on any exit, a crash included; rmSync with force does nothing
  // when it is already gone.
  const dir = mkdtempSync(join(tmpdir(), 'maplith-bridge-stdio-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  const token = randomBytes(32).toString('hex');
  const v = version();
  // An agent of its own, so a proxy named in the environment is never used:
  // every request goes to 127.0.0.1, where the server listens.
  const agent = new Agent({ keepAlive: true });
  let server: Server | undefined;

  let stopping = false;
  const stop = (code: number, why: string) => {
    if (stopping) return;
    stopping = true;
    log(`${why}: stopping the server and removing the folder.`);
    agent.destroy();
    server?.closeAllConnections();
    server?.close();
    rmSync(dir, { recursive: true, force: true });
    // Exit once what stdout holds is written; if that never comes (a broken
    // pipe), exit anyway.
    process.exitCode = code;
    process.stdout.write('', () => process.exit(code));
    setTimeout(() => process.exit(code), 2000).unref();
  };
  // Registered before the server starts, so a signal at any point removes the folder.
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, () => stop(0, signal));
  // A reader that went away (EPIPE): nobody is left to answer.
  process.stdout.on('error', () => stop(0, 'stdout closed'));

  let url: string;
  try {
    ({ server, url } = await serve({ root: dir, token, name: 'exports', info: { name: 'maplith-bridge', version: v }, log }, 0, '127.0.0.1'));
  } catch (err) {
    log(`could not start the server: ${err instanceof Error ? err.message : String(err)}`);
    stop(1, 'no server');
    return;
  }
  if (stopping) return;
  log(`Maplith Bridge ${v}: an empty folder, served at ${url} (this machine only), relayed over stdin and stdout. It shares no data.`);

  let session: string | undefined;
  let protocol: string | undefined;

  const post = (body: string) =>
    new Promise<IncomingMessage>((ok, no) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': String(Buffer.byteLength(body)),
      };
      if (session !== undefined) headers['Mcp-Session-Id'] = session;
      if (protocol !== undefined) headers['MCP-Protocol-Version'] = protocol;
      const req = request(url, { method: 'POST', agent, headers }, ok);
      // A server that goes quiet for this long fails the message, not the relay.
      req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
      req.on('error', no);
      req.end(body);
    });

  const fail = async (id: string | number | undefined, message: string) => {
    log(message);
    if (id !== undefined) await write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: RELAY_ERROR, message } }));
  };

  /** A reply from the server, as one line on stdout. */
  const emit = async (text: string, asked: { id?: string | number; initialize: boolean }): Promise<boolean> => {
    let reply: unknown;
    try {
      reply = JSON.parse(text);
    } catch {
      return false;
    }
    const result = (reply as { result?: { protocolVersion?: unknown } } | null)?.result;
    if (asked.initialize && typeof result?.protocolVersion === 'string') protocol = result.protocolVersion;
    await write(JSON.stringify(reply));
    return true;
  };

  const forward = async (line: string) => {
    const asked = requestOf(line);
    if (asked.initialize) {
      session = undefined;
      protocol = undefined;
    }
    let res: IncomingMessage;
    try {
      res = await post(line);
    } catch (err) {
      return fail(asked.id, `the server did not answer (${(err as NodeJS.ErrnoException).code ?? 'error'})`);
    }
    const sid = res.headers['mcp-session-id'];
    if (typeof sid === 'string' && sid !== '') session = sid;
    const status = res.statusCode ?? 0;
    if (status === 202) return void res.resume();
    if (status !== 200) {
      res.resume();
      return fail(asked.id, `the server answered HTTP ${status}`);
    }
    res.setEncoding('utf8');
    const type = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (type === 'text/event-stream') {
      const events: string[] = [];
      const sse = sseReader((data) => events.push(data));
      const flush = async () => {
        for (let e = events.shift(); e !== undefined; e = events.shift()) {
          if (!(await emit(e, asked))) log('skipped an event that is not JSON');
        }
      };
      for await (const chunk of res) {
        sse.push(chunk as string);
        await flush();
      }
      sse.end();
      return flush();
    }
    let body = '';
    for await (const chunk of res) body += chunk as string;
    if (body.trim() === '') return;
    if (!(await emit(body, asked))) return fail(asked.id, 'the server sent a reply that is not JSON');
  };

  // One message at a time, in order: each reply is written before the next
  // message is sent.
  let queue = Promise.resolve();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    queue = queue.then(() => forward(line)).catch((err) => log(`relay failed: ${err instanceof Error ? err.message : String(err)}`));
  });
  lines.on('close', () => {
    void queue.then(() => stop(0, 'stdin ended'));
  });
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) void main();
