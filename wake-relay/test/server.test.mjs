// The relay as a process, against a fake routine endpoint: what an HTTP client
// of Maplith's would see, and what the process prints.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { OLD_SECRET, SECRET, U, envelope, fakeApi, runRelay, signedRequest, signatureHeader } from './helpers.mjs';

const ID = 'trig_01ABCDEFGHJKLMNOPQRSTUVW';
const TOKEN = 'routine-token-0123456789abcdef';
const HOOK_TOKEN = 'hook-token-xyz';
let api;
let hook;
const running = [];

before(async () => {
  api = await fakeApi((call) => {
    if (call.path === `/v1/claude_code/routines/${ID}/fire`) {
      if (call.headers.authorization !== `Bearer ${TOKEN}`) return { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'bad token' } } };
      return { json: { type: 'routine_fire', claude_code_session_id: `session_${api.seen.length}` } };
    }
    return { status: 404, json: {} };
  });
  hook = await fakeApi(() => ({ json: {} }));
});
after(async () => {
  for (const r of running) await r.stop();
  await api.close();
  await hook.close();
});

async function start(extra = {}) {
  const r = await runRelay({
    MAPLITH_WAKE_SECRET: SECRET,
    ROUTINE_TOKEN: TOKEN,
    RELAY_ADAPTER: 'claude-code-routine',
    RELAY_ROUTINE_FIRE_URL: `https://api.anthropic.com/v1/claude_code/routines/${ID}/fire`,
    ANTHROPIC_API_BASE: api.url,
    ...extra,
  });
  running.push(r);
  return r;
}

async function post(r, env, { secrets = SECRET, headers = {}, body, path = '/wake' } = {}) {
  const req = signedRequest(env, secrets);
  const res = await fetch(`${r.url}${path}`, { method: 'POST', headers: { ...req.headers, ...headers }, body: body ?? req.body });
  return { status: res.status, body: await res.json() };
}
/** Waits until `fn()` is true, up to five seconds: a not-awaited alert or a log line lands when it lands. */
async function until(fn) {
  for (let i = 0; i < 100 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
}
const fires = () => api.seen.filter((c) => c.path.endsWith('/fire'));

test('answers /healthz, and 404 and 405 elsewhere', async () => {
  const r = await start();
  assert.equal(await (await fetch(`${r.url}/healthz`)).text(), 'ok');
  assert.equal((await fetch(`${r.url}/nothing`)).status, 404);
  assert.equal((await fetch(`${r.url}/wake`)).status, 405);
});

test('starts the routine for a signed wake-up, with ids only, and answers 202', async () => {
  const r = await start();
  const before = fires().length;
  const res = await post(r, envelope({ delivery_id: `wd_${U(101)}`, signals: [{ id: U(51), kind: 'support_case_opened', severity: 'attention', episode: 1 }] }));
  assert.equal(res.status, 202);
  assert.equal(res.body.started, true);
  assert.equal(fires().length, before + 1);
  const call = fires().at(-1);
  assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(call.body, { text: U(51) });
});

test('a repeat of a delivery, and the same signal in another delivery, start nothing', async () => {
  const r = await start();
  const env = envelope({ delivery_id: `wd_${U(102)}`, signals: [{ id: U(52), kind: 'support_case_opened', severity: 'info', episode: 1 }] });
  const first = fires().length;
  assert.equal((await post(r, env)).status, 202);
  assert.equal((await post(r, env)).body.reason, 'duplicate');
  assert.equal((await post(r, { ...env, delivery_id: `wd_${U(103)}` })).body.reason, 'nothing_new');
  assert.equal(fires().length, first + 1);
});

test('refuses what is not Maplith’s: a wrong secret, a changed body, an old signature, a delivery id that is not the header’s', async () => {
  const r = await start();
  const before = api.seen.length;
  const env = envelope({ delivery_id: `wd_${U(104)}` });
  assert.equal((await post(r, env, { secrets: 'mwk_some-other-secret-value-0123' })).status, 401);
  const req = signedRequest(env);
  assert.equal((await post(r, env, { body: req.body.replace('attention', 'urgent'), headers: req.headers })).status, 401);
  const old = signatureHeader(req.body, SECRET, Math.floor(Date.now() / 1000) - 600);
  assert.equal((await post(r, env, { headers: { 'x-maplith-signature': old } })).status, 401);
  assert.equal((await post(r, env, { headers: { 'x-maplith-delivery': `wd_${U(999)}` } })).status, 400);
  assert.equal((await post(r, { ...env, signals: 'x' })).status, 400);
  assert.equal(api.seen.length, before, 'nothing was started');
});

test('a body over 64 KB is refused before it is read in full', async () => {
  const r = await start();
  const res = await fetch(`${r.url}/wake`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'x'.repeat(70 * 1024) });
  assert.equal(res.status, 413);
});

test('a test wake-up is answered 200 and starts nothing', async () => {
  const r = await start();
  const before = api.seen.length;
  const res = await post(r, envelope({ type: 'test', delivery_id: `wd_${U(105)}`, signals: [], more: 0 }));
  assert.deepEqual(res, { status: 200, body: { ok: true, started: false, reason: 'test' } });
  assert.equal(api.seen.length, before);
});

test('takes a wake-up signed with the new or the old secret while both are held', async () => {
  const r = await start({ MAPLITH_WAKE_SECRET: `${SECRET},${OLD_SECRET}` });
  assert.equal((await post(r, envelope({ delivery_id: `wd_${U(106)}`, signals: [{ id: U(53), kind: 'support_case_opened', severity: 'info', episode: 1 }] }), { secrets: OLD_SECRET })).status, 202);
  assert.equal((await post(r, envelope({ delivery_id: `wd_${U(107)}`, signals: [{ id: U(54), kind: 'support_case_opened', severity: 'info', episode: 1 }] }), { secrets: [SECRET, OLD_SECRET] })).status, 202);
});

test('a token the service refuses: 502 to Maplith, and one alert to the webhook in plain words, never with the token', async () => {
  const r = await start({ ROUTINE_TOKEN: 'a-different-token-0123456789', ALERT_WEBHOOK_URL: `${hook.url}/alert?key=${HOOK_TOKEN}` });
  const res = await post(r, envelope({ delivery_id: `wd_${U(108)}`, signals: [{ id: U(55), kind: 'support_case_opened', severity: 'info', episode: 1 }] }));
  assert.equal(res.status, 502);
  await until(() => hook.seen.length >= 1);
  assert.equal(hook.seen.length, 1);
  const sent = hook.seen[0].body;
  assert.match(sent.text, /^Your wake relay could not start your Claude Code routine, so work is not reaching it as it arrives\. Anthropic did not accept the routine's API token \(HTTP 401\)\./);
  assert.equal(sent.event, 'claude-code-routine:auth');
  assert.equal(JSON.stringify(sent).includes('a-different-token'), false);
  // A second wake-up inside the hour is refused too but does not alert again.
  assert.equal((await post(r, envelope({ delivery_id: `wd_${U(109)}`, signals: [{ id: U(56), kind: 'support_case_opened', severity: 'info', episode: 1 }] }))).status, 502);
  await new Promise((resolve) => setTimeout(resolve, 200)); // a second alert would be sent by now
  assert.equal(hook.seen.length, 1);
});

test('prints no body, header or secret', async () => {
  const r = await start({ ALERT_WEBHOOK_URL: `${hook.url}/alert?key=${HOOK_TOKEN}` });
  await post(r, envelope({ delivery_id: `wd_${U(110)}`, signals: [{ id: U(57), kind: 'support_case_opened', severity: 'info', episode: 1 }] }));
  await post(r, envelope({ delivery_id: `wd_${U(111)}` }), { secrets: 'mwk_some-other-secret-value-0123' });
  await until(() => r.output().includes(`wd_${U(111)}`) || r.output().includes(`wd_${U(110)} signals.raised: 202`));
  const out = r.output();
  assert.match(out, /listening on \d+; claude-code-routine; at most 30 starts an hour; state kept in memory/);
  assert.match(out, new RegExp(`wd_${U(110)} signals.raised: 202`));
  for (const secret of [SECRET, TOKEN, HOOK_TOKEN, 'x-maplith-signature', 'v1=']) assert.equal(out.includes(secret), false, secret);
  assert.equal(out.includes(U(57)), false, 'a signal id is not printed');
});

test('with a state file, a restart remembers what it started for', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'relay-run-')), 'state.json');
  const env = envelope({ delivery_id: `wd_${U(112)}`, signals: [{ id: U(58), kind: 'support_case_opened', severity: 'info', episode: 1 }] });
  const a = await start({ RELAY_STATE_FILE: file });
  assert.equal((await post(a, env)).status, 202);
  await a.stop();
  const before = fires().length;
  const b = await start({ RELAY_STATE_FILE: file });
  assert.equal((await post(b, env)).body.reason, 'duplicate');
  assert.equal((await post(b, { ...env, delivery_id: `wd_${U(113)}` })).body.reason, 'nothing_new');
  assert.equal(fires().length, before);
});

test('does not start with a setting wrong, and says which, without printing a secret', async () => {
  const r = await runRelay({ MAPLITH_WAKE_SECRET: SECRET, ROUTINE_TOKEN: TOKEN, RELAY_ADAPTER: 'claude-code-routine', RELAY_ROUTINE_FIRE_URL: 'https://evil.example/x', RELAY_MAX_FIRES_PER_HOUR: '99' }, { wait: false });
  const code = await r.exited;
  assert.equal(code, 1);
  const out = r.output();
  assert.match(out, /the relay cannot start/);
  assert.match(out, /routine\.fire_url must be the address/);
  assert.match(out, /max_fires_per_hour must be from 1 to 30/);
  for (const secret of [SECRET, TOKEN]) assert.equal(out.includes(secret), false);
});

test('while paused every wake-up is answered 200 and nothing is started', async () => {
  const r = await start({ RELAY_PAUSED: '1' });
  const before = fires().length;
  assert.equal((await post(r, envelope({ delivery_id: `wd_${U(114)}` }))).body.reason, 'paused');
  assert.equal(fires().length, before);
});
