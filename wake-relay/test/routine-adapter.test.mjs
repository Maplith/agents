// The routine adapter's requests and its reading of answers, against a fake
// API on a local port. Nothing here reaches the internet.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUTINE_BETA, createRoutineAdapter, retryAfterSeconds, routineIdFrom } from '../src/adapters/claude-code-routine.mjs';
import { U, fakeApi } from './helpers.mjs';

const ID = 'trig_01ABCDEFGHJKLMNOPQRSTUVW';
const TOKEN = 'routine-token-0123456789abcdef';

async function withApi(handler, fn, opts = {}) {
  const api = await fakeApi(handler);
  try {
    const adapter = createRoutineAdapter({ routineId: ID, token: TOKEN, apiBase: api.url, ...opts });
    return await fn(adapter, api);
  } finally {
    await api.close();
  }
}

test('starts a run exactly as the endpoint documents: POST, the routine path, bearer token, version, a body of text only', async () => {
  await withApi(
    () => ({ json: { type: 'routine_fire', claude_code_session_id: 'session_01X', claude_code_session_url: 'https://claude.ai/code/session_01X' } }),
    async (adapter, api) => {
      const text = `${U(1)}\n${U(2)}\nmore: 3`;
      const res = await adapter.fire({ text });
      assert.deepEqual(res, { ok: true, session: 'session_01X' });
      assert.equal(api.seen.length, 1);
      const call = api.seen[0];
      assert.equal(call.method, 'POST');
      assert.equal(call.path, `/v1/claude_code/routines/${ID}/fire`);
      assert.equal(call.headers.authorization, `Bearer ${TOKEN}`);
      assert.equal(call.headers['anthropic-version'], '2023-06-01');
      assert.equal(call.headers['anthropic-beta'], ROUTINE_BETA);
      assert.match(call.headers['content-type'], /^application\/json/);
      assert.deepEqual(call.body, { text });
      assert.deepEqual(Object.keys(call.body), ['text']);
    },
  );
});

test('reads each answer the way the documentation lists it', async () => {
  const cases = [
    [400, 'rejected'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'auth'],
    [410, 'auth'],
    [422, 'rejected'],
    [429, 'rate_limited'],
    [500, 'retry'],
    [503, 'retry'],
    [408, 'retry'],
  ];
  for (const [status, cls] of cases) {
    await withApi(
      () => ({ status, json: { type: 'error', error: { type: 'x_error', message: 'a message that must not travel' } }, headers: status === 429 ? { 'retry-after': '90' } : {} }),
      async (adapter) => {
        const res = await adapter.fire({ text: U(1) });
        assert.equal(res.ok, false, String(status));
        assert.equal(res.class, cls, String(status));
        assert.equal(res.status, status);
        assert.equal(res.errorType, 'x_error');
        assert.equal(res.retryAfterS, status === 429 ? 90 : undefined);
        assert.equal(JSON.stringify(res).includes('must not travel'), false, 'the service message is not passed on');
      },
    );
  }
});

test('how long to wait after a 429: what the service said, within bounds, else ten minutes', () => {
  assert.equal(retryAfterSeconds('90'), 90);
  assert.equal(retryAfterSeconds('1'), 10);
  assert.equal(retryAfterSeconds('99999'), 3600);
  assert.equal(retryAfterSeconds(null), 600);
  assert.equal(retryAfterSeconds('Wed, 21 Oct 2026 07:28:00 GMT'), 600);
});

test('no answer in time, or a refused connection, is a retry', async () => {
  await withApi(() => ({ hang: true }), async (adapter) => {
    assert.deepEqual(await adapter.fire({ text: U(1) }), { ok: false, class: 'retry', status: 0 });
  }, { timeoutMs: 100 });
  const adapter = createRoutineAdapter({ routineId: ID, token: TOKEN, apiBase: 'http://127.0.0.1:9', timeoutMs: 500 });
  assert.deepEqual(await adapter.fire({ text: U(1) }), { ok: false, class: 'retry', status: 0 });
});

test('never follows a redirect: the token goes to the one address and no other', async () => {
  const elsewhere = await fakeApi(() => ({ json: {} }));
  try {
    await withApi(
      () => ({ status: 307, headers: { location: `${elsewhere.url}/steal` } }),
      async (adapter) => {
        const res = await adapter.fire({ text: U(1) });
        assert.equal(res.ok, false);
        assert.equal(elsewhere.seen.length, 0);
      },
    );
  } finally {
    await elsewhere.close();
  }
});

test('takes the routine id from the address the routine page shows, or the bare id, and from nothing else', () => {
  assert.equal(routineIdFrom(`https://api.anthropic.com/v1/claude_code/routines/${ID}/fire`), ID);
  assert.equal(routineIdFrom(`  https://api.anthropic.com/v1/claude_code/routines/${ID}/fire/ `), ID);
  assert.equal(routineIdFrom(ID), ID);
  for (const bad of [
    `https://evil.example/v1/claude_code/routines/${ID}/fire`,
    `https://api.anthropic.com.evil.example/v1/claude_code/routines/${ID}/fire`,
    `http://api.anthropic.com/v1/claude_code/routines/${ID}/fire`,
    `https://api.anthropic.com/v1/claude_code/routines/${ID}/fire?x=1`,
    `https://api.anthropic.com/v1/claude_code/routines/${ID}/../x/fire`,
    `https://user:pw@api.anthropic.com/v1/claude_code/routines/${ID}/fire`,
    'https://api.anthropic.com/v1/claude_code/routines/trig_REPLACE_ME/fire',
    'trig_', '', undefined, 'routine_01ABCDEFGHJKLMNOPQRSTUVW',
  ]) assert.equal(routineIdFrom(bad), null, String(bad));
});

test('the words of an alert say what happened and what to do, and never carry the token', async () => {
  const adapter = createRoutineAdapter({ routineId: ID, token: TOKEN });
  const want = {
    401: /did not accept the routine's API token.*Regenerate.*ROUTINE_TOKEN/,
    403: /may not use the routine API trigger.*Owner/,
    404: /no longer exists \(HTTP 404\).*ROUTINE_FIRE_URL/,
    410: /no longer exists \(HTTP 410\)/,
    400: /refused to start the routine \(HTTP 400\).*paused/,
  };
  for (const [status, re] of Object.entries(want)) {
    const cls = Number(status) === 400 ? 'rejected' : 'auth';
    const { what, todo } = adapter.explain({ class: cls, status: Number(status) });
    assert.match(`${what} ${todo}`, re, status);
    assert.equal(`${what} ${todo}`.includes(TOKEN), false);
  }
  assert.match(adapter.explain({ class: 'retry', status: 503 }).what, /not answered/);
  assert.equal(adapter.maxFiresPerHour, 30);
});
