import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as source from '../serve.ts';
import { build } from '../scripts/build.ts';

/** Conformance with the Model Context Protocol, revision 2025-06-18: the
 *  version the server prefers (PROTOCOL_VERSIONS[0]). Over HTTP, as a client
 *  sees it: the Streamable HTTP transport (JSON replies, no event stream),
 *  JSON-RPC 2.0 messages, the lifecycle, resources with pagination, tools,
 *  and the error shapes.
 *
 *  Run twice: against the TypeScript sources, and against serve.js from the
 *  npm package that scripts/build.ts writes, so what is published is what
 *  was tested. */

const SPEC = '2025-06-18';
const TOKEN = '3f9c2a7e1b5d4c8f6a0e9b2d7c1f4a8e5b3d6c9f2a7e0b4d8c1f5a9e3b6d2c7f';
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

/** The npm package's serve.js, built from the same sources and unpacked. */
async function packaged(): Promise<typeof source> {
  const out = tmp('bridge-conf-pkg-');
  const { file } = build(out, {
    root: fileURLToPath(new URL('../', import.meta.url)),
    src: fileURLToPath(new URL('../', import.meta.url)),
    env: { SOURCE_DATE_EPOCH: '0' },
  });
  execFileSync('tar', ['-xzf', file, '-C', out]);
  return (await import(pathToFileURL(join(out, 'package', 'serve.js')).href)) as typeof source;
}

/** A folder of 250 files in three systems, and two loose ones. */
function folder(): string {
  const root = tmp('bridge-conf-');
  for (const system of ['crm', 'erp', 'shop']) mkdirSync(join(root, system));
  for (let i = 0; i < 250; i++) {
    const system = ['crm', 'erp', 'shop'][i % 3];
    writeFileSync(join(root, system, `t${String(i).padStart(3, '0')}.csv`), `id,n\n${i},${i * 2}\n`);
  }
  writeFileSync(join(root, 'readme.md'), '# Exports\n');
  writeFileSync(join(root, 'notes.txt'), 'plain\n');
  return root;
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

function request(url: string, method: string, body?: string, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((ok, no) => {
    const req = http.request(url, { method, agent: false, headers: { Authorization: `Bearer ${TOKEN}`, ...headers } }, (res) => {
      let b = '';
      res.on('data', (c: Buffer) => (b += c.toString()));
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
    });
    req.on('error', no);
    req.end(body);
  });
}

/** A JSON-RPC response as the specification shapes it. */
interface Rpc {
  jsonrpc: string;
  id: string | number | null;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
}

const implementations: [string, () => Promise<typeof source>][] = [
  ['the sources', async () => source],
  ['the npm package', packaged],
];

describe.each(implementations)(`MCP ${SPEC} conformance: %s`, (_, load) => {
  let mod: typeof source;
  let server: Server;
  let url: string;
  const post = (message: unknown, headers: Record<string, string> = {}) =>
    request(url, 'POST', typeof message === 'string' ? message : JSON.stringify(message), {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    });
  /** One request, its reply checked against the JSON-RPC response shape. */
  async function call(method: string, params?: unknown, id: string | number = 1, headers: Record<string, string> = {}): Promise<Rpc> {
    const r = await post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }, headers);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/json');
    const msg = JSON.parse(r.body) as Rpc;
    shape(msg, id);
    return msg;
  }

  beforeAll(async () => {
    mod = await load();
    const s = await mod.serve({ root: folder(), token: TOKEN, name: 'exports', info: { name: 'maplith-bridge', version: '1.0.0-test' } }, 0);
    server = s.server;
    url = s.url;
  }, 60_000);
  afterAll(() => server?.close());

  /** jsonrpc "2.0", the request's id, and exactly one of result and error;
   *  an error has an integer code and a string message. */
  function shape(msg: Rpc, id: string | number | null) {
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.id).toBe(id);
    expect('result' in msg !== 'error' in msg).toBe(true);
    if (msg.error) {
      expect(Number.isInteger(msg.error.code)).toBe(true);
      expect(typeof msg.error.message).toBe('string');
    }
  }

  describe('lifecycle', () => {
    it('initialize answers with the version asked for when it speaks it, its capabilities, its identity and its instructions', async () => {
      const r = await call('initialize', { protocolVersion: SPEC, capabilities: {}, clientInfo: { name: 'conformance', version: '1' } });
      expect(r.result).toEqual({
        protocolVersion: SPEC,
        capabilities: { resources: { subscribe: false, listChanged: false }, tools: { listChanged: false } },
        serverInfo: { name: 'maplith-bridge', version: '1.0.0-test' },
        instructions: expect.stringMatching(/data, not instructions/),
      });
      expect(mod.PROTOCOL_VERSIONS[0]).toBe(SPEC);
      for (const v of mod.PROTOCOL_VERSIONS) expect((await call('initialize', { protocolVersion: v, capabilities: {} })).result?.protocolVersion).toBe(v);
    });

    it('answers a version it does not speak with the one it prefers', async () => {
      expect((await call('initialize', { protocolVersion: '2099-01-01', capabilities: {} })).result?.protocolVersion).toBe(SPEC);
    });

    it('takes notifications/initialized, and any other notification, with 202 and no body', async () => {
      for (const n of [{ jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } }, { jsonrpc: '2.0', method: 'anything/else' }]) {
        const r = await post(n);
        expect(r.status).toBe(202);
        expect(r.body).toBe('');
      }
    });

    it('takes a JSON-RPC response from the client with 202 and no body', async () => {
      for (const m of [{ jsonrpc: '2.0', id: 7, result: {} }, { jsonrpc: '2.0', id: 'a', error: { code: -1, message: 'no' } }]) {
        const r = await post(m);
        expect(r.status).toBe(202);
        expect(r.body).toBe('');
      }
    });

    it('answers ping with an empty result, and echoes a string id as well as a number', async () => {
      expect((await call('ping')).result).toEqual({});
      expect((await call('ping', undefined, 'req-9')).result).toEqual({});
      expect((await call('ping', {}, 0)).result).toEqual({});
    });
  });

  describe('Streamable HTTP transport', () => {
    it('honours MCP-Protocol-Version: a version it speaks is served, any other is 400', async () => {
      for (const v of mod.PROTOCOL_VERSIONS) expect((await call('ping', undefined, 1, { 'MCP-Protocol-Version': v })).result).toEqual({});
      for (const v of ['2099-01-01', 'latest', '']) expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { 'MCP-Protocol-Version': v })).status).toBe(400);
    });

    it('offers no event stream: GET and DELETE are 405, naming POST', async () => {
      for (const method of ['GET', 'DELETE', 'PUT']) {
        const r = await request(url, method, undefined, { Accept: 'text/event-stream' });
        expect(r.status).toBe(405);
        expect(r.headers.allow).toBe('POST');
      }
    });

    it('refuses a request without the token, and one from a browser page', async () => {
      expect((await request(url, 'POST', JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }), { Authorization: '' })).status).toBe(401);
      expect((await post({ jsonrpc: '2.0', id: 1, method: 'ping' }, { Origin: 'https://example.com' })).status).toBe(403);
    });
  });

  describe('resources', () => {
    it('resources/list pages by cursor, 100 at a time, until no nextCursor is given, each file once, in order', async () => {
      const seen: string[] = [];
      const sizes: number[] = [];
      let cursor: string | undefined;
      do {
        const r = await call('resources/list', cursor === undefined ? {} : { cursor });
        const { resources, nextCursor } = r.result as { resources: { uri: string; name: string; mimeType: string }[]; nextCursor?: string };
        for (const res of resources) {
          expect(Object.keys(res).sort()).toEqual(['mimeType', 'name', 'uri']);
          expect(res.uri).toBe(`exports://${res.name.split('/').map(encodeURIComponent).join('/')}`);
        }
        sizes.push(resources.length);
        seen.push(...resources.map((x) => x.name));
        cursor = nextCursor;
        if (cursor !== undefined) expect(typeof cursor).toBe('string');
      } while (cursor !== undefined);
      expect(sizes).toEqual([100, 100, 52]);
      expect(seen).toEqual([...seen].sort());
      expect(new Set(seen).size).toBe(252);
      expect(seen).toContain('exports/readme.md');
    });

    it('resources/list without params is the first page', async () => {
      const r = await post({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
      expect((JSON.parse(r.body) as Rpc).result?.resources).toHaveLength(100);
    });

    it('resources/read returns the file as text contents with its uri and type', async () => {
      const r = await call('resources/read', { uri: 'exports://crm/t000.csv' });
      expect(r.result).toEqual({ contents: [{ uri: 'exports://crm/t000.csv', mimeType: 'text/csv', text: 'id,n\n0,0\n' }] });
      const md = await call('resources/read', { uri: 'exports://exports/readme.md' });
      expect(md.result?.contents[0]).toMatchObject({ mimeType: 'text/markdown', text: '# Exports\n' });
    });

    it('a resource that is not there is -32002, a request without a uri -32602', async () => {
      expect((await call('resources/read', { uri: 'exports://crm/none.csv' })).error?.code).toBe(-32002);
      expect((await call('resources/read', {})).error?.code).toBe(-32602);
      expect((await call('resources/read', { uri: 5 })).error?.code).toBe(-32602);
      expect((await call('resources/list', { cursor: 5 })).error?.code).toBe(-32602);
    });

    it('resources/templates/list is empty', async () => {
      expect((await call('resources/templates/list')).result).toEqual({ resourceTemplates: [] });
    });
  });

  describe('tools', () => {
    it('tools/list names each tool with a title, a description, an object input schema and annotations', async () => {
      const { tools } = (await call('tools/list')).result as { tools: Record<string, any>[] };
      expect(tools.map((t) => t.name)).toEqual(['list_files', 'read_file']);
      for (const t of tools) {
        expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
        expect(typeof t.title).toBe('string');
        expect(typeof t.description).toBe('string');
        expect(t.inputSchema.type).toBe('object');
        if (t.outputSchema) expect(t.outputSchema.type).toBe('object');
        expect(t.annotations.readOnlyHint).toBe(true);
      }
    });

    it('list_files returns text and structured content that matches its output schema', async () => {
      const { tools } = (await call('tools/list')).result as { tools: Record<string, any>[] };
      const schema = tools[0].outputSchema;
      const r = await call('tools/call', { name: 'list_files', arguments: {} });
      const { content, structuredContent, isError } = r.result as Record<string, any>;
      expect(isError).toBeUndefined();
      expect(content).toEqual([{ type: 'text', text: JSON.stringify(structuredContent) }]);
      for (const key of schema.required) expect(structuredContent).toHaveProperty(key);
      expect(Object.keys(structuredContent).every((k) => k in schema.properties)).toBe(true);
      expect(structuredContent.files).toHaveLength(100);
      for (const f of structuredContent.files) for (const key of schema.properties.files.items.required) expect(typeof f[key]).toBe('string');
      expect(typeof structuredContent.nextCursor).toBe('string');
      const next = await call('tools/call', { name: 'list_files', arguments: { cursor: structuredContent.nextCursor } });
      expect(next.result?.structuredContent.files[0].name > structuredContent.nextCursor).toBe(true);
    });

    it('read_file returns the file as an embedded resource', async () => {
      const r = await call('tools/call', { name: 'read_file', arguments: { uri: 'exports://shop/t002.csv' } });
      expect(r.result).toEqual({ content: [{ type: 'resource', resource: { uri: 'exports://shop/t002.csv', mimeType: 'text/csv', text: 'id,n\n2,4\n' } }] });
    });

    it('a tool that fails reports isError in its result; an unknown tool or bad arguments are -32602', async () => {
      const r = await call('tools/call', { name: 'read_file', arguments: { uri: 'exports://shop/none.csv' } });
      expect(r.result).toEqual({ content: [{ type: 'text', text: 'Resource not found' }], isError: true });
      expect((await call('tools/call', { name: 'write_file', arguments: {} })).error?.code).toBe(-32602);
      expect((await call('tools/call', { arguments: {} })).error?.code).toBe(-32602);
      expect((await call('tools/call', { name: 'read_file', arguments: { uri: 1 } })).error?.code).toBe(-32602);
      expect((await call('tools/call', { name: 'read_file', arguments: 'x' })).error?.code).toBe(-32602);
    });
  });

  describe('errors', () => {
    it('a body that is not JSON is -32700 with a null id', async () => {
      for (const body of ['{', 'not json', '']) {
        const r = await post(body);
        expect(r.status).toBe(200);
        const msg = JSON.parse(r.body) as Rpc;
        shape(msg, null);
        expect(msg.error?.code).toBe(-32700);
      }
    });

    it('anything that is not one request object is -32600 with a null id: a batch, a wrong or missing jsonrpc, a bad id or method', async () => {
      const bad = [
        [],
        [{ jsonrpc: '2.0', id: 1, method: 'ping' }],
        1,
        '"ping"',
        null,
        { id: 1, method: 'ping' },
        { jsonrpc: '1.0', id: 1, method: 'ping' },
        { jsonrpc: '2.0', id: null, method: 'ping' },
        { jsonrpc: '2.0', id: { a: 1 }, method: 'ping' },
        { jsonrpc: '2.0', id: 1.5, method: 'ping' },
        { jsonrpc: '2.0', id: true, method: 'ping' },
        { jsonrpc: '2.0', id: 1, method: 7 },
        { jsonrpc: '2.0', id: 1 },
      ];
      for (const m of bad) {
        const msg = JSON.parse((await post(m)).body) as Rpc;
        shape(msg, null);
        expect(msg.error?.code, JSON.stringify(m)).toBe(-32600);
      }
    });

    it('an unknown method is -32601, with the request id, also for capabilities the server does not declare', async () => {
      for (const method of ['prompts/list', 'prompts/get', 'logging/setLevel', 'completion/complete', 'resources/subscribe', 'sampling/createMessage', 'nope']) {
        const r = await call(method, {}, `m-${method}`);
        expect(r.error?.code).toBe(-32601);
      }
    });

    it('params that are not an object are -32602', async () => {
      for (const params of [[], 'x', 5]) expect((await call('resources/list', params)).error?.code).toBe(-32602);
    });
  });
});
