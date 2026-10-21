// Shared by the tests: signed wake-ups made independently of the relay's own
// code, a fake Anthropic API on a local port, and a way to run the relay as a
// process.
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** A uuid made of a number, for readable ids. */
export const U = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export const SECRET = 'mwk_test-secret-current-0123456789';
export const OLD_SECRET = 'mwk_test-secret-previous-0123456789';

/** A wake-up as Maplith sends it. */
export function envelope(over = {}) {
  return {
    type: 'signals.raised',
    delivery_id: `wd_${U(1)}`,
    workspace_id: U(2),
    subscription_id: U(3),
    sent_at: '2026-10-19T09:00:00Z',
    signals: [{ id: U(10), kind: 'support_case_opened', severity: 'attention', episode: 1 }],
    more: 0,
    ...over,
  };
}

/** The header, made the way the docs describe it: HMAC-SHA256 over "<t>." and the body. */
export function signatureHeader(body, secrets, t = Math.floor(Date.now() / 1000)) {
  const list = Array.isArray(secrets) ? secrets : [secrets];
  return `t=${t},${list.map((s) => `v1=${createHmac('sha256', s).update(`${t}.${body}`).digest('hex')}`).join(',')}`;
}

/** A signed request: body and headers. */
export function signedRequest(env, secrets = SECRET, t) {
  const body = JSON.stringify(env);
  return { body, headers: { 'content-type': 'application/json', 'x-maplith-delivery': env.delivery_id, 'x-maplith-signature': signatureHeader(body, secrets, t) } };
}

/** A fake API on 127.0.0.1. `handler(req, body)` returns `{ status, json?, headers?, hang? }`. */
export async function fakeApi(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let json;
      try { json = raw ? JSON.parse(raw) : undefined; } catch { json = undefined; }
      const call = { method: req.method, path: req.url, headers: req.headers, raw, body: json };
      seen.push(call);
      const r = await handler(call, seen);
      if (r.hang) return; // never answers
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json', ...(r.headers ?? {}) });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, seen, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

/** Runs the relay as a process; resolves once it answers /healthz, or with the exit code if it stops. */
export async function runRelay(env, { wait = true } = {}) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(root, 'src', 'main.mjs')], {
    env: { PATH: process.env.PATH, PORT: String(port), RELAY_CONFIG: join(root, 'no-such-file.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)));
  const url = `http://127.0.0.1:${port}`;
  if (wait) {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${url}/healthz`)).ok) break; } catch { /* not yet */ }
      if (child.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return { url, child, exited, output: () => out, stop: async () => { child.kill(); await exited; } };
}
