import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HOUR_MS, RelayState } from '../src/state.mjs';
import { U } from './helpers.mjs';

const w = (n, ep = 1) => ({ id: U(n), key: `${U(n)}:${ep}` });

test('remembers a delivery for the dedupe window and then forgets it', () => {
  const s = new RelayState({ dedupeMs: HOUR_MS });
  s.markDelivery('wd_a', 1000);
  assert.equal(s.hasDelivery('wd_a'), true);
  s.prune(1000 + HOUR_MS - 1);
  assert.equal(s.hasDelivery('wd_a'), true);
  s.prune(1000 + HOUR_MS + 1);
  assert.equal(s.hasDelivery('wd_a'), false);
});

test('a signal episode already started for is not queued again, a new episode is', () => {
  const s = new RelayState();
  s.addPending([w(1)]);
  s.commit(s.peekBatch(50), 5000);
  s.addPending([w(1), w(1, 2)]);
  assert.deepEqual(s.pending.map((p) => [p.id, p.key]), [[U(1), `${U(1)}:2`]]);
});

test('queues each piece of work once, and drops the oldest past the cap', () => {
  const s = new RelayState({ maxPending: 3 });
  s.addPending([w(1), w(2), w(1)]);
  assert.equal(s.pending.length, 2);
  s.addPending([w(3), w(4)]);
  assert.deepEqual(s.pending.map((p) => p.id), [U(2), U(3), U(4)]);
});

test('a batch is at most as long as asked, and carries the `more` count only when it empties the queue', () => {
  const s = new RelayState();
  s.addPending([w(1), w(2), w(3)], 5);
  const first = s.peekBatch(2);
  assert.equal(first.work.length, 2);
  assert.equal(first.more, 0);
  s.commit(first, 10);
  assert.equal(s.more, 5);
  const last = s.peekBatch(2);
  assert.equal(last.work.length, 1);
  assert.equal(last.more, 5);
  s.commit(last, 20);
  assert.equal(s.hasPending(), false);
});

test('a queue of nothing but `more` is still something to send', () => {
  const s = new RelayState();
  s.addPending([], 4);
  assert.equal(s.hasPending(), true);
  const b = s.peekBatch(50);
  assert.deepEqual(b, { work: [], more: 4 });
  s.commit(b, 1);
  assert.equal(s.hasPending(), false);
});

test('the rate guard: free until the limit is reached, then until the oldest start is an hour old', () => {
  const s = new RelayState();
  const t0 = 1_000_000;
  for (let i = 0; i < 30; i++) s.recordFire(t0 + i * 1000);
  assert.equal(s.nextSlotAt(t0 + 40_000, 31), t0 + 40_000);
  assert.equal(s.nextSlotAt(t0 + 40_000, 30), t0 + HOUR_MS);
  // Past the oldest start's hour a place is free again.
  assert.equal(s.nextSlotAt(t0 + HOUR_MS + 1, 30), t0 + HOUR_MS + 1);
  // Over the limit (it was lowered): the place is when enough have aged out.
  assert.equal(s.nextSlotAt(t0 + 40_000, 29), t0 + 1000 + HOUR_MS);
});

test('a wait the service asked for holds the guard, and a start taken back does not count', () => {
  const s = new RelayState();
  s.blockedUntil = 9_000_000;
  assert.equal(s.nextSlotAt(1_000_000, 30), 9_000_000);
  s.blockedUntil = 0;
  s.recordFire(5);
  s.forgetFire(5);
  assert.equal(s.firesInLastHour(100), 0);
});

test('starts older than an hour stop counting', () => {
  const s = new RelayState();
  s.recordFire(0);
  s.recordFire(HOUR_MS - 1);
  assert.equal(s.firesInLastHour(HOUR_MS), 1);
  s.prune(HOUR_MS);
  assert.deepEqual(s.fires, [HOUR_MS - 1]);
});

test('survives a restart through its file, and the file is private to its owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-state-'));
  const file = join(dir, 'state.json');
  const a = new RelayState({ file });
  a.markDelivery('wd_a', 100);
  a.addPending([w(1), w(2)], 3);
  a.recordFire(200);
  a.blockedUntil = 300;
  a.commit({ work: [w(1)], more: 0 }, 150);
  a.save();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const b = new RelayState({ file });
  assert.equal(b.hasDelivery('wd_a'), true);
  assert.equal(b.hasFired(`${U(1)}:1`), true);
  assert.deepEqual(b.pending.map((p) => [p.id, p.key]), [[U(2), `${U(2)}:1`]]);
  assert.equal(b.more, 3);
  assert.deepEqual(b.fires, [200]);
  assert.equal(b.blockedUntil, 300);
});

test('holds only ids and times: no body, header or secret', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-state-'));
  const file = join(dir, 'state.json');
  const s = new RelayState({ file });
  s.markDelivery(`wd_${U(1)}`, 100);
  s.addPending([w(1)]);
  s.save();
  const text = readFileSync(file, 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['blockedUntil', 'deliveries', 'fired', 'fires', 'more', 'pending']);
  assert.doesNotMatch(text, /secret|token|authorization|body/i);
});

test('a file it cannot read is not trusted: it starts empty and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-state-'));
  const file = join(dir, 'state.json');
  writeFileSync(file, '{ not json');
  const lines = [];
  const s = new RelayState({ file, log: (l) => lines.push(l) });
  assert.equal(s.hasPending(), false);
  assert.match(lines.join('\n'), /starting empty/);
});

test('a file it cannot write is logged and never stops a wake-up', () => {
  const lines = [];
  const s = new RelayState({ file: join(tmpdir(), 'no-such-folder-xyz', 'state.json'), log: (l) => lines.push(l) });
  s.markDelivery('wd_a', 1);
  assert.doesNotThrow(() => s.save());
  assert.match(lines.join('\n'), /not written/);
});

test('work that waited longer than the dedupe window is dropped from the queue, newer work stays', () => {
  const s = new RelayState({ dedupeMs: HOUR_MS });
  s.addPending([w(1)], 0, 1000);
  s.addPending([w(2)], 0, 1000 + HOUR_MS);
  s.prune(1000 + HOUR_MS + 1);
  assert.deepEqual(s.pending.map((p) => p.id), [U(2)]);
});
