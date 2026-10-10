import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import http, { type Server } from 'node:http';
import { isIP } from 'node:net';
import { join, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { MAX_BODY, addressList, callerAddress, fileFor, handle, hopAddress, jsonStringBytes, normalizeAddress, rateKey, serve, tokenOk } from '../serve.ts';
import { TOKEN_SHAPE, tokenWeakness } from '../bridge.ts';
import { csvField, parseArgs, quoteIdent, safeName } from '../extract-postgres.ts';

/** Property-based fuzzing of everything a caller controls: the request body
 *  and its JSON-RPC message, the resource URIs and paths, the headers that
 *  name a caller, and the HTTP request as a whole. Each property states what
 *  must hold for every input, and fast-check looks for an input that breaks
 *  it, shrinking any it finds to the smallest.
 *
 *  FUZZ_RUNS sets the runs per property: a few hundred by default, so the
 *  suite stays quick; CI runs a long pass with 20,000 (npm run fuzz). A
 *  failure prints the seed and the path that reproduce it. */

const RUNS = Number(process.env.FUZZ_RUNS ?? 300);
const SLOW = Math.max(25, Math.floor(RUNS / 10)); // properties that make an HTTP request each
const settings = { numRuns: RUNS };
const TOKEN = 'c4a1e7f09b3d2865a7c1f0e94b2d6a3c8e5f1b7d0a9c2e4f6b8d1a3c5e7f9b0d';

/** A folder with a little of everything the checks must keep out, inside a
 *  box that also holds files the server must never reach. */
function hostileBox() {
  const box = mkdtempSync(join(tmpdir(), 'bridge-fuzz-'));
  const root = join(box, 'root');
  mkdirSync(join(root, 'bi', 'deep'), { recursive: true });
  mkdirSync(join(root, '.secret'), { recursive: true });
  writeFileSync(join(root, 'bi', 'sales.csv'), 'day,amount\n2026-10-01,10\n');
  writeFileSync(join(root, 'bi', 'deep', 'notes.md'), '# deep\n');
  writeFileSync(join(root, 'bi', 'script.sh'), 'echo no\n');
  writeFileSync(join(root, '.secret', 'creds.json'), '{"outside":"SECRET-HIDDEN"}');
  writeFileSync(join(root, 'top.txt'), 'top\n');
  writeFileSync(join(box, 'outside.csv'), 'SECRET-OUTSIDE\n');
  symlinkSync(join(box, 'outside.csv'), join(root, 'bi', 'link.csv'));
  symlinkSync(box, join(root, 'bi', 'boxlink'));
  return { box, root };
}

/** Every file and folder under `dir`, with its kind, size and times: the
 *  state no request may change. */
function state(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      const st = lstatSync(p);
      out[relative(dir, p)] = `${st.mode}:${st.size}:${st.mtimeMs}:${st.isSymbolicLink() ? 'link' : ''}`;
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out;
}

const SECRETS = ['SECRET-HIDDEN', 'SECRET-OUTSIDE', 'echo no'];

// --- The pieces a URI is made of ------------------------------------------------

const SEGMENTS = ['..', '.', '', 'bi', 'deep', 'sales.csv', 'notes.md', 'link.csv', 'boxlink', 'outside.csv', '.secret', 'creds.json', 'top.txt', 'x', 'script.sh', 'etc', 'hosts.txt'];
const ENCODED = ['%2e', '%2E%2E', '%2f', '%2F', '%5c', '%00', '\0', '\\', '%252e%252e', '%', '%e0%80%ae', '..%2f', '%2e%2e%2f', '//', '~', 'sales.csv%00.txt', 'ﬁ', 'Ａ'];
const segment = fc.oneof(fc.constantFrom(...SEGMENTS), fc.constantFrom(...ENCODED), fc.string({ maxLength: 6 }));
const built = fc.tuple(fc.constantFrom('x://', 'x:/', 'x:', 'y://', 'X://', '', 'x:///', 'file://'), fc.array(segment, { maxLength: 7 }), fc.constantFrom('', '.csv', '.txt', '.md', '.json', '.sh', '%2ecsv', '/'))
  .map(([scheme, parts, ext]) => `${scheme}${parts.join('/')}${ext}`);
/** A URI the server serves, with pieces put in: most stay valid or nearly so,
 *  which is where a confinement bug would hide. */
const near = fc
  .tuple(fc.constantFrom('x://bi/sales.csv', 'x://bi/deep/notes.md', 'x://x/top.txt', 'x://bi/link.csv', 'x://bi/boxlink/outside.csv'), fc.nat(), fc.array(segment, { maxLength: 2 }))
  .map(([base, at, parts]) => {
    const segs = base.slice(4).split('/');
    const i = at % (segs.length + 1);
    return `x://${[...segs.slice(0, i), ...parts, ...segs.slice(i)].join('/')}`;
  });
const uri = fc.oneof(built, near, near);

// --- A JSON-RPC message, well-formed or not -------------------------------------

const METHODS = ['initialize', 'ping', 'resources/list', 'resources/read', 'resources/templates/list', 'tools/list', 'tools/call', 'notifications/initialized', 'resources/write', '__proto__', 'constructor', 'toString'];
const anyValue = fc.oneof(fc.jsonValue(), fc.constantFrom(undefined, null, '__proto__', { __proto__: { polluted: true } }));
const params = fc.oneof(
  anyValue,
  fc.record({ uri: fc.oneof(uri, anyValue) }, { requiredKeys: [] }),
  fc.record({ cursor: fc.oneof(fc.string(), anyValue) }, { requiredKeys: [] }),
  fc.record({ name: fc.oneof(fc.constantFrom('list_files', 'read_file', 'write_file'), fc.string()), arguments: fc.oneof(anyValue, fc.record({ uri: fc.oneof(uri, anyValue), cursor: anyValue }, { requiredKeys: [] })) }, { requiredKeys: [] }),
  fc.record({ protocolVersion: fc.oneof(fc.constantFrom('2025-06-18', '2024-11-05'), fc.string()) }, { requiredKeys: [] }),
);
const message = fc.record(
  {
    jsonrpc: fc.oneof(fc.constant('2.0'), anyValue),
    id: fc.oneof(fc.integer(), fc.string(), anyValue),
    method: fc.oneof(fc.constantFrom(...METHODS), fc.string(), anyValue),
    params,
    result: anyValue,
  },
  { requiredKeys: [] },
);
/** A request body: a message, a batch, broken JSON, or bytes that are not even UTF-8. */
const body = fc.oneof(
  message.map((m) => JSON.stringify(m)),
  fc.array(message, { maxLength: 3 }).map((b) => JSON.stringify(b)),
  message.map((m) => JSON.stringify(m).slice(0, -1)),
  fc.string({ unit: 'binary' }),
  fc.uint8Array({ maxLength: 200 }).map((b) => Buffer.from(b).toString('utf8')),
  fc.jsonValue().map((v) => JSON.stringify(v)),
);

const CODES = [-32700, -32600, -32601, -32602, -32002, -32603];

describe('fuzzing: what a caller sends', () => {
  let box: string;
  let root: string;
  let before: Record<string, string>;
  beforeAll(() => {
    ({ box, root } = hostileBox());
    before = state(box);
  });

  it('the JSON-RPC handler never throws, and answers every body with nothing or one well-formed reply', () => {
    fc.assert(
      fc.property(body, (text) => {
        const reply = handle({ root, name: 'x' }, text) as Record<string, any> | null;
        if (reply === null) return;
        expect(reply.jsonrpc).toBe('2.0');
        expect(['string', 'number'].includes(typeof reply.id) || reply.id === null).toBe(true);
        expect('result' in reply !== 'error' in reply).toBe(true);
        if (reply.error) {
          expect(CODES).toContain(reply.error.code);
          expect(typeof reply.error.message).toBe('string');
        }
        // A reply is JSON, and never holds a file from outside the folder.
        const sent = JSON.stringify(reply);
        for (const s of SECRETS) expect(sent).not.toContain(s);
      }),
      settings,
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('a URI never names a file outside the folder, a hidden one, a link out or a type that is not served', () => {
    const base = realpathSync(root);
    fc.assert(
      fc.property(uri, (u) => {
        const file = fileFor(root, 'x', u);
        if (file === null) return;
        expect(file.startsWith(base + sep)).toBe(true);
        expect(realpathSync(file)).toBe(file);
        expect(statSync(file).isFile()).toBe(true);
        expect(relative(base, file).split(sep).some((s) => s.startsWith('.'))).toBe(false);
        expect(['.csv', '.tsv', '.json', '.jsonl', '.md', '.txt'].some((e) => file.toLowerCase().endsWith(e))).toBe(true);
      }),
      settings,
    );
  });

  it('resources/read and read_file give the same answer for every URI, and never a secret', () => {
    fc.assert(
      fc.property(uri, (u) => {
        const res = handle({ root, name: 'x' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: u } })) as Record<string, any>;
        const tool = (handle({ root, name: 'x' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { uri: u } } })) as Record<string, any>).result;
        if (res.result) expect(tool.content).toEqual([{ type: 'resource', resource: res.result.contents[0] }]);
        else expect(tool).toEqual({ content: [{ type: 'text', text: res.error.message }], isError: true });
        for (const s of SECRETS) expect(JSON.stringify(res)).not.toContain(s);
      }),
      settings,
    );
  });

  it('a list cursor of any kind lists only files inside the folder', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), uri, fc.constantFrom('', '/', '..', '\uffff')), (cursor) => {
        const r = handle({ root, name: 'x' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/list', params: { cursor } })) as Record<string, any>;
        for (const f of r.result.resources) {
          expect(f.uri.startsWith('x://')).toBe(true);
          expect(fileFor(root, 'x', f.uri)).not.toBeNull();
        }
      }),
      settings,
    );
  });

  it('counts the escaped length of any text exactly as JSON.stringify writes it', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        expect(jsonStringBytes(text)).toBe(Buffer.byteLength(JSON.stringify(text)));
      }),
      settings,
    );
  });

  afterAll(() => {
    // Nothing a caller sent changed a file, a folder or a link.
    expect(state(box)).toEqual(before);
  });
});

describe('fuzzing: who is calling', () => {
  const proxies = addressList(['10.0.0.1', '2001:db8::1'], 'behind-proxy');
  const ip = fc.oneof(fc.ipV4(), fc.ipV6(), fc.ipV4().map((a) => `::ffff:${a}`));
  const hop = fc.oneof(ip, ip.map((a) => (a.includes(':') ? `[${a}]:443` : `${a}:51234`)), fc.string(), fc.constantFrom('unknown', '', ' ', '[]', '[::1', '1.2.3.4:x'));
  const forwarded = fc.oneof(fc.constant(undefined), fc.array(hop, { maxLength: 5 }).map((h) => h.join(',')), fc.array(fc.array(hop, { maxLength: 3 }).map((h) => h.join(', ')), { maxLength: 3 }));

  it('X-Forwarded-For of any shape gives an address or a refusal, never an exception', () => {
    fc.assert(
      fc.property(ip, forwarded, fc.constantFrom<'none' | 'named' | 'any'>('none', 'named', 'any'), (peer, fwd, mode) => {
        const r = callerAddress(peer, fwd, mode === 'none' ? null : mode === 'named' ? proxies : 'any');
        if (r !== null) expect(isIP(r)).not.toBe(0);
        // Behind a named proxy, only the proxy may connect.
        if (mode === 'named' && !['10.0.0.1', '2001:db8::1'].includes(normalizeAddress(peer))) expect(r).toBeNull();
      }),
      settings,
    );
  });

  it('a hop, an address or a rate key of any text never throws', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (text) => {
        hopAddress(text);
        normalizeAddress(text);
        rateKey(text);
      }),
      settings,
    );
    fc.assert(
      fc.property(fc.ipV6(), (a) => {
        expect(rateKey(a)).toMatch(/^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}::\/64$/);
      }),
      settings,
    );
  });

  it('an address list of any text is either refused with a reason or a list of real addresses', () => {
    const entry = fc.oneof(ip, fc.tuple(ip, fc.integer({ min: -1, max: 140 })).map(([a, b]) => `${a}/${b}`), fc.string(), fc.constantFrom('0.0.0.0/0', '::/0', '::ffff:0:0/96', '1.2.3.4/32/1', '1.2.3.4/'));
    fc.assert(
      fc.property(fc.array(entry, { maxLength: 4 }), fc.boolean(), (entries, forProxy) => {
        try {
          addressList(entries, 'allow', forProxy ? { ipv4: 12, ipv6: 29 } : undefined);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
          expect((err as Error).message).toMatch(/^allow: /);
        }
      }),
      settings,
    );
  });

  it('a token header of any text is accepted only when it is exactly the token', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.string().map((s) => `Bearer ${s}`), fc.constant(`Bearer ${TOKEN}`), fc.constant(undefined)), (header) => {
        expect(tokenOk(header, TOKEN)).toBe(header === `Bearer ${TOKEN}`);
      }),
      settings,
    );
  });

  it('a token of any text passes only in the shape rotate-token writes', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.stringMatching(/^[0-9a-f]{64}$/)), (token) => {
        if (tokenWeakness(token) === null) expect(token).toMatch(TOKEN_SHAPE);
      }),
      settings,
    );
  });
});

describe('fuzzing: the HTTP server', () => {
  let box: string;
  let root: string;
  let before: Record<string, string>;
  let server: Server;
  let url: URL;

  beforeAll(async () => {
    ({ box, root } = hostileBox());
    before = state(box);
    const s = await serve({ root, token: TOKEN, name: 'x' }, 0);
    server = s.server;
    url = new URL(s.url);
  });
  afterAll(() => server?.close());

  /** One raw request: any method, path, headers and body. The answer's status,
   *  or 0 when the server closed the connection (a body over the cap). */
  const send = (method: string, path: string, headers: Record<string, string>, payload: Buffer) =>
    new Promise<{ status: number; body: string }>((ok) => {
      const req = http.request({ host: url.hostname, port: url.port, method, path, headers, agent: false }, (res) => {
        let b = '';
        res.on('data', (c: Buffer) => (b += c.toString()));
        res.on('end', () => ok({ status: res.statusCode ?? 0, body: b }));
        res.on('error', () => ok({ status: res.statusCode ?? 0, body: b }));
      });
      req.on('error', () => ok({ status: 0, body: '' }));
      req.end(payload);
    });

  const headerValue = fc.oneof(fc.string({ maxLength: 40 }).filter((s) => /^[\t\x20-\x7e]*$/.test(s)), fc.constantFrom(`Bearer ${TOKEN}`, 'Bearer', '2025-06-18', 'application/json', 'https://evil.example', '127.0.0.1, 10.0.0.1'));
  const request = fc.record({
    method: fc.constantFrom('POST', 'POST', 'POST', 'POST', 'POST', 'GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'),
    path: fc.oneof(fc.constant('/mcp'), fc.constantFrom('/mcp', '/healthz', '/', '/mcp?x=1', '/../etc/passwd', '/%2e%2e/', '/healthz/../mcp'), fc.webPath()),
    auth: fc.constantFrom('right', 'right', 'right', 'wrong', 'none', 'garbage'),
    extra: fc.oneof(fc.constant({}), fc.dictionary(fc.constantFrom('content-type', 'mcp-protocol-version', 'x-forwarded-for', 'origin', 'accept', 'mcp-session-id', 'transfer-encoding-x'), headerValue, { maxKeys: 3 })),
    payload: fc.oneof(body.map((b) => Buffer.from(b)), fc.uint8Array({ maxLength: 300 }).map((b) => Buffer.from(b)), fc.constant(Buffer.alloc(MAX_BODY + 1, 0x20))),
  });

  it('answers every request with a known status, never crashes, and stays up', async () => {
    await fc.assert(
      fc.asyncProperty(request, async (r) => {
        const headers: Record<string, string> = { ...r.extra };
        if (r.auth === 'right') headers.authorization = `Bearer ${TOKEN}`;
        if (r.auth === 'wrong') headers.authorization = `Bearer ${'0'.repeat(64)}`;
        if (r.auth === 'garbage') headers.authorization = 'Basic Zm9vOmJhcg==';
        const res = await send(r.method, r.path, headers, r.payload);
        expect([0, 200, 202, 204, 400, 401, 403, 405, 413, 429]).toContain(res.status);
        for (const s of SECRETS) expect(res.body).not.toContain(s);
        if (res.status === 200) expect(() => JSON.parse(res.body)).not.toThrow();
      }),
      { numRuns: SLOW },
    );
    // Still up, still serving the right token.
    expect((await send('GET', '/healthz', {}, Buffer.alloc(0))).status).toBe(204);
    const ok = await send('POST', '/mcp', { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })));
    expect(JSON.parse(ok.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    // And nothing anyone sent reached the disk.
    expect(state(box)).toEqual(before);
  }, 120_000);
});

describe('fuzzing: the extractor\'s names and cells', () => {
  /** A CSV field read back as a CSV reader would. */
  const unquote = (field: string): string | null => {
    if (field === '') return null;
    if (field.startsWith('"')) {
      expect(field.endsWith('"')).toBe(true);
      const inner = field.slice(1, -1);
      expect(inner.replace(/""/g, '')).not.toContain('"');
      return inner.replace(/""/g, '"');
    }
    expect(field).not.toMatch(/[",\r\n]/);
    return field;
  };

  it('a cell of any text is written so a CSV reader gets it back, and NULL apart from the empty string', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.constant(null), fc.constantFrom('', '\\.', '"', ',', '\r\n')), (cell) => {
        expect(unquote(csvField(cell))).toBe(cell);
      }),
      settings,
    );
  });

  it('a table or schema name of any text becomes a safe file name', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ unit: 'binary' }), fc.constantFrom('..', '.', '../../etc', '.hidden', '/abs', 'a/b', 'CON', '')), (name) => {
        const s = safeName(name);
        expect(s.length).toBeGreaterThan(0);
        expect(s.length).toBeLessThanOrEqual(120);
        expect(s).not.toMatch(/[/\\\0]/);
        expect(s.startsWith('.')).toBe(false);
        expect(s).not.toContain('..');
      }),
      settings,
    );
  });

  it('an identifier of any text is quoted so it reads back as itself, and one with NUL is refused', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary' }), (name) => {
        if (name.includes('\0')) {
          expect(() => quoteIdent(name)).toThrow();
          return;
        }
        const q = quoteIdent(name);
        expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
        expect(q.slice(1, -1).replace(/""/g, '')).not.toContain('"');
        expect(q.slice(1, -1).replace(/""/g, '"')).toBe(name);
      }),
      settings,
    );
  });

  it('a command line of any words is parsed strictly, or refused with a reason', () => {
    const word = fc.oneof(fc.constantFrom('--out', '--system', '--max-rows', '--statement-timeout', '--deadline', '--check', '--sql', '-c', '5', '0', '-1', '/tmp/x', ''), fc.string());
    fc.assert(
      fc.property(fc.array(word, { maxLength: 8 }), (argv) => {
        try {
          const a = parseArgs(argv, {});
          expect(a.out).not.toBe('');
          for (const n of [a.maxRows, a.statementTimeoutMs, a.deadlineMs]) if (n !== undefined) expect(Number.isSafeInteger(n) && n > 0).toBe(true);
        } catch (err) {
          expect(err).toBeInstanceOf(Error);
        }
      }),
      settings,
    );
  });
});
