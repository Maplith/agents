// The decisions, against a fake adapter, a fake clock and fake timers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseEnvelope } from '../src/envelope.mjs';
import { createRelay } from '../src/relay.mjs';
import { HOUR_MS, RelayState } from '../src/state.mjs';
import { U, envelope } from './helpers.mjs';

const T0 = Date.parse('2026-10-19T09:00:00Z');

function setup({ limit = 30, results = [], precheck, paused = false } = {}) {
  const clock = { t: T0 };
  const calls = [];
  const alerts = [];
  const timers = [];
  const queued = [...results];
  const adapter = {
    name: 'fake',
    subject: 'your fake agent',
    fallback: 'Nothing is lost.',
    async fire(req) {
      calls.push({ ...req, at: clock.t });
      return queued.length ? queued.shift() : { ok: true, session: `session_${calls.length}` };
    },
    explain: (res) => ({ what: `It said ${res.status}.`, todo: 'Fix it.' }),
    precheck,
  };
  const alerter = { alert: async (key, text, extra, every) => { alerts.push({ key, text, extra, every }); } };
  const state = new RelayState();
  const fakeTimers = {
    setTimeout: (fn, ms) => { const t = { fn, ms, cleared: false, unref() {} }; timers.push(t); return t; },
    clearTimeout: (t) => { t.cleared = true; },
  };
  const relay = createRelay({ adapter, state, alerter, maxFiresPerHour: limit, paused, now: () => clock.t, timers: fakeTimers });
  const wake = (over) => relay.handle(parseEnvelope(JSON.stringify(envelope(over))));
  const sig = (n, episode = 1) => ({ id: U(n), kind: 'support_case_opened', severity: 'attention', episode });
  /** A wake-up with its own delivery id, naming signal n. */
  const raise = (n, over = {}) => wake({ delivery_id: `wd_${U(1000 + n)}`, signals: [sig(n)], ...over });
  const due = () => timers.filter((t) => !t.cleared);
  return { clock, calls, alerts, timers, state, relay, wake, sig, raise, due };
}

test('starts the agent for new work: 202, with the signal ids as the text and nothing else', async () => {
  const s = setup();
  const [status, body] = await s.raise(10);
  assert.equal(status, 202);
  assert.deepEqual(body, { ok: true, started: true, session: 'session_1' });
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].text, U(10));
  assert.deepEqual(s.calls[0].ids, [U(10)]);
});

test('a delivery it already answered starts nothing (Maplith sends a wake-up again when it hears nothing)', async () => {
  const s = setup();
  await s.raise(10);
  const [status, body] = await s.raise(10);
  assert.equal(status, 200);
  assert.equal(body.reason, 'duplicate');
  assert.equal(s.calls.length, 1);
});

test('the same signal episode in another delivery starts nothing; a new episode does', async () => {
  const s = setup();
  await s.raise(10);
  const again = await s.wake({ delivery_id: `wd_${U(2001)}`, signals: [s.sig(10)] });
  assert.equal(again[1].reason, 'nothing_new');
  assert.equal(s.calls.length, 1);
  const next = await s.wake({ delivery_id: `wd_${U(2002)}`, signals: [s.sig(10, 2)] });
  assert.equal(next[0], 202);
  assert.equal(s.calls.length, 2);
});

test('a test, a type it does not know and a pause are answered 200 and start nothing', async () => {
  const s = setup();
  assert.equal((await s.wake({ type: 'test', signals: [], more: 0 }))[1].reason, 'test');
  assert.equal((await s.wake({ type: 'something.new' }))[1].reason, 'ignored');
  const p = setup({ paused: true });
  assert.equal((await p.raise(10))[1].reason, 'paused');
  assert.equal(s.calls.length + p.calls.length, 0);
});

test('a decision names the signal it was about; one that names none starts nothing', async () => {
  const s = setup();
  const none = await s.wake({ type: 'approval.decided', signals: undefined, more: undefined, approval: { request_id: U(20), decision: 'approved' } });
  assert.equal(none[1].reason, 'no_signal');
  assert.equal(s.calls.length, 0);
  const named = await s.wake({ delivery_id: `wd_${U(3001)}`, type: 'approval.decided', signals: undefined, more: undefined, approval: { request_id: U(21), decision: 'approved', signal_id: U(10) } });
  assert.equal(named[0], 202);
  assert.equal(s.calls[0].text, U(10));
});

test('what a cap held back, and what a wake-up leaves out, ride along as `more`', async () => {
  const s = setup();
  await s.raise(10, { more: 2, held_back_since: { count: 5, since: '2026-10-19T07:00:00Z' } });
  assert.equal(s.calls[0].text, `${U(10)}\nmore: 7`);
});

test('the rate guard: the 31st start in an hour is folded into the next one, not started and not lost', async () => {
  const s = setup();
  for (let i = 1; i <= 30; i++) {
    s.clock.t = T0 + i * 1000;
    assert.equal((await s.raise(i))[0], 202);
  }
  assert.equal(s.calls.length, 30);
  s.clock.t = T0 + 40_000;
  const folded = await s.raise(31);
  assert.equal(folded[0], 200);
  assert.equal(folded[1].folded, true);
  assert.equal(folded[1].reason, 'rate_guard');
  assert.equal(s.calls.length, 30, 'no 31st start inside the hour');
  assert.equal(s.state.pending.length, 1);
  // A timer is set for the moment the oldest start is an hour old.
  assert.equal(s.due().length, 1);
  assert.equal(s.due()[0].ms, T0 + 1000 + HOUR_MS - s.clock.t);
});

test('signals folded by the guard go out together in the next start, with no new wake-up to prompt it', async () => {
  const s = setup({ limit: 2 });
  await s.raise(1);
  s.clock.t += 1000;
  await s.raise(2);
  s.clock.t += 1000;
  await s.raise(3);
  await s.raise(4);
  assert.equal(s.calls.length, 2);
  assert.equal(s.state.pending.length, 2);
  // The hour passes; the timer fires.
  s.clock.t = T0 + HOUR_MS + 1;
  const timer = s.due().at(-1);
  timer.fn();
  await new Promise((r) => setImmediate(r));
  assert.equal(s.calls.length, 3);
  assert.equal(s.calls[2].text, `${U(3)}\n${U(4)}`);
  assert.equal(s.state.pending.length, 0);
});

test('a new wake-up that arrives when the guard allows takes the folded signals with it, oldest first', async () => {
  const s = setup({ limit: 1 });
  await s.raise(1);
  await s.raise(2);
  s.clock.t = T0 + HOUR_MS + 5;
  await s.raise(3);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].text, `${U(2)}\n${U(3)}`);
});

test('one start carries at most 50 ids: a longer queue goes out in batches, each its own start', async () => {
  const s = setup();
  s.state.addPending(Array.from({ length: 120 }, (_, i) => ({ id: U(500 + i), key: `${U(500 + i)}:1` })), 3);
  const [status] = await s.raise(1);
  assert.equal(status, 202);
  assert.deepEqual(s.calls.map((c) => c.ids.length), [50, 50, 21]);
  assert.match(s.calls[2].text, /\nmore: 3$/);
  assert.doesNotMatch(s.calls[0].text, /more:/);
});

test('when the service says wait (429), the signals stay queued, the attempt does not count and a timer is set', async () => {
  const s = setup({ results: [{ ok: false, class: 'rate_limited', status: 429, retryAfterS: 120 }] });
  const [status, body] = await s.raise(10);
  assert.equal(status, 200);
  assert.equal(body.reason, 'rate_limited');
  assert.equal(s.state.pending.length, 1);
  assert.equal(s.state.firesInLastHour(s.clock.t), 0);
  assert.equal(s.due()[0].ms, 120_000);
  // A wake-up inside the wait is folded without calling the service.
  s.clock.t += 30_000;
  const inside = await s.raise(11);
  assert.equal(inside[1].reason, 'rate_limited');
  assert.equal(s.calls.length, 1);
  // After the wait both go out.
  s.clock.t += 100_000;
  await s.raise(12);
  assert.equal(s.calls.at(-1).text, `${U(10)}\n${U(11)}\n${U(12)}`);
});

test('a refused token: 502, an alert in plain words, no start counted, and the delivery is tried again later', async () => {
  const s = setup({ results: [{ ok: false, class: 'auth', status: 401 }] });
  const first = await s.raise(10);
  assert.equal(first[0], 502);
  assert.equal(s.alerts.length, 1);
  assert.match(s.alerts[0].text, /^Your wake relay could not start your fake agent, so work is not reaching it as it arrives\. It said 401\. Fix it\. Nothing is lost\.$/);
  assert.equal(s.state.firesInLastHour(s.clock.t), 0);
  assert.equal(s.state.hasDelivery(`wd_${U(1010)}`), false);
  // Maplith sends the same delivery again; the fault is fixed.
  const again = await s.raise(10);
  assert.equal(again[0], 202);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].text, U(10), 'the signal is not started twice nor lost');
});

test('a server error or no answer: 503, the delivery is not marked, the attempt counts, and three in a row alert', async () => {
  const bad = { ok: false, class: 'retry', status: 503 };
  const s = setup({ results: [bad, bad, bad, { ok: true, session: 'ok' }] });
  for (let i = 0; i < 3; i++) {
    const r = await s.raise(10);
    assert.equal(r[0], 503);
    assert.equal(s.alerts.length, i < 2 ? 0 : 1);
  }
  assert.equal(s.state.firesInLastHour(s.clock.t), 3);
  const r = await s.raise(10);
  assert.equal(r[0], 202);
  assert.equal(s.state.pending.length, 0);
});

test('an alert is sent without holding up the answer', async () => {
  let release;
  const slow = new Promise((r) => { release = r; });
  const state = new RelayState();
  const relay = createRelay({
    adapter: { name: 'fake', subject: 's', fallback: '', fire: async () => ({ ok: false, class: 'auth', status: 401 }), explain: () => ({ what: 'w', todo: 't' }) },
    state,
    alerter: { alert: () => slow },
    maxFiresPerHour: 30,
  });
  const answered = await Promise.race([relay.handle(parseEnvelope(JSON.stringify(envelope()))), new Promise((r) => setTimeout(() => r('held'), 500))]);
  release();
  assert.notEqual(answered, 'held');
  assert.equal(answered[0], 502);
});

test('a daily spending limit reached: folded until the day starts again, one alert a day', async () => {
  const retryAt = T0 + 5 * HOUR_MS;
  const s = setup({ precheck: async () => ({ ok: false, class: 'ceiling', status: 0, retryAt }) });
  const [status, body] = await s.raise(10);
  assert.equal(status, 200);
  assert.equal(body.reason, 'daily_ceiling');
  assert.equal(s.calls.length, 0);
  assert.equal(s.state.pending.length, 1);
  assert.equal(s.alerts.length, 1);
  assert.equal(s.alerts[0].every, 24 * HOUR_MS);
  assert.equal(s.due()[0].ms, 5 * HOUR_MS);
});

test('a check that the service refuses for now (429, no wait given) holds the queue for ten minutes', async () => {
  const s = setup({ precheck: async () => ({ ok: false, class: 'rate_limited', status: 429 }) });
  const [status, body] = await s.raise(10);
  assert.equal(status, 200);
  assert.equal(body.reason, 'rate_limited');
  assert.equal(body.next_start_in_s, 600);
  assert.equal(s.state.blockedUntil, T0 + 600_000);
  assert.equal(s.calls.length, 0);
});

test('a failed check before the start is answered by what it means', async () => {
  const s = setup({ precheck: async () => ({ ok: false, class: 'retry', status: 0 }) });
  assert.equal((await s.raise(10))[0], 503);
  const a = setup({ precheck: async () => ({ ok: false, class: 'auth', status: 401 }) });
  assert.equal((await a.raise(10))[0], 502);
  assert.equal(a.alerts.length, 1);
});

test('wake-ups are decided one at a time: two at once never start overlapping calls', async () => {
  let running = 0;
  let overlap = false;
  const state = new RelayState();
  const relay = createRelay({
    adapter: {
      name: 'fake', subject: 's', fallback: '', explain: () => ({ what: '', todo: '' }),
      async fire() { running++; if (running > 1) overlap = true; await new Promise((r) => setTimeout(r, 20)); running--; return { ok: true, session: 'x' }; },
    },
    state, alerter: { alert: async () => {} }, maxFiresPerHour: 30,
  });
  const mk = (n) => parseEnvelope(JSON.stringify(envelope({ delivery_id: `wd_${U(n)}`, signals: [{ id: U(n), kind: 'support_case_opened', severity: 'info', episode: 1 }] })));
  const out = await Promise.all([relay.handle(mk(1)), relay.handle(mk(2)), relay.handle(mk(3))]);
  assert.equal(overlap, false);
  assert.deepEqual(out.map((o) => o[0]), [202, 202, 202]);
});

test('a restart with a state file starts what was waiting', async () => {
  const s = setup();
  s.state.addPending([{ id: U(7), key: `${U(7)}:1` }]);
  await s.relay.resume();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].text, U(7));
  await s.relay.resume();
  assert.equal(s.calls.length, 1, 'nothing left to start');
});
