// What the relay remembers: which deliveries and which signal episodes it has
// already started your agent for, when it last started it, and the signals that
// are waiting for the next start. Ids and timestamps only, never a body, a
// header or a secret.
//
// With a state file the memory survives a restart; without one it lives in the
// process. Either way a lost memory costs at most a repeated start for work
// your agent has already taken, and the signals still wait in Maplith.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

export const HOUR_MS = 3_600_000;

export class RelayState {
  /**
   * @param {{ file?: string|null, dedupeMs?: number, maxEntries?: number, maxPending?: number, log?: (line: string) => void }} [opts]
   */
  constructor({ file = null, dedupeMs = 24 * HOUR_MS, maxEntries = 20_000, maxPending = 1000, log = () => {} } = {}) {
    this.file = file;
    this.dedupeMs = dedupeMs;
    this.maxEntries = maxEntries;
    this.maxPending = maxPending;
    this.log = log;
    /** delivery id -> when it was answered */
    this.deliveries = new Map();
    /** a work key -> when your agent was started for it */
    this.fired = new Map();
    /** when each start was attempted, oldest first; the rate guard counts these */
    this.fires = [];
    /** work waiting for the next start: `{ id, key, at }`, oldest first */
    this.pending = [];
    /** signals beyond the ones named, waiting to be mentioned in the next start */
    this.more = 0;
    /** no start before this moment (the service asked us to wait) */
    this.blockedUntil = 0;
    if (file) this.#load();
  }

  #load() {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const d = JSON.parse(readFileSync(this.file, 'utf8'));
      for (const [k, v] of Object.entries(d.deliveries ?? {})) if (Number.isFinite(v)) this.deliveries.set(k, v);
      for (const [k, v] of Object.entries(d.fired ?? {})) if (Number.isFinite(v)) this.fired.set(k, v);
      this.fires = (Array.isArray(d.fires) ? d.fires : []).filter(Number.isFinite).sort((a, b) => a - b);
      this.pending = (Array.isArray(d.pending) ? d.pending : []).filter((p) => p && typeof p.id === 'string' && typeof p.key === 'string').map((p) => ({ id: p.id, key: p.key, at: Number.isFinite(p.at) ? p.at : Date.now() }));
      this.more = Number.isInteger(d.more) && d.more > 0 ? d.more : 0;
      this.blockedUntil = Number.isFinite(d.blockedUntil) ? d.blockedUntil : 0;
    } catch (e) {
      this.log(`state file not read (${e.code ?? 'invalid'}): starting empty`);
    }
  }

  /** Writes the state beside its file and moves it into place, so a crash never
   *  leaves half a file. A failure is logged, never thrown: a wake-up is still
   *  answered. */
  save() {
    if (!this.file) return;
    const body = JSON.stringify({
      deliveries: Object.fromEntries(this.deliveries),
      fired: Object.fromEntries(this.fired),
      fires: this.fires,
      pending: this.pending,
      more: this.more,
      blockedUntil: this.blockedUntil,
    });
    try {
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (e) {
      this.log(`state file not written (${e.code ?? 'error'}): the memory is in the process only`);
    }
  }

  /** Forgets what is older than the dedupe window and what is over the size cap. */
  prune(nowMs) {
    for (const map of [this.deliveries, this.fired]) {
      for (const [k, at] of map) if (nowMs - at > this.dedupeMs) map.delete(k);
      // Maps keep insertion order: past the cap the oldest go first.
      while (map.size > this.maxEntries) map.delete(map.keys().next().value);
    }
    this.fires = this.fires.filter((t) => nowMs - t < HOUR_MS);
    // Work that waited longer than the dedupe window is stale: its signal has
    // been handled or will be found by the routine's own sweep.
    this.pending = this.pending.filter((p) => nowMs - p.at <= this.dedupeMs);
  }

  hasDelivery(id) { return this.deliveries.has(id); }
  markDelivery(id, nowMs) { this.deliveries.delete(id); this.deliveries.set(id, nowMs); }
  hasFired(key) { return this.fired.has(key); }

  /** Adds work to what waits for the next start, once each, and the count of
   *  signals beyond those named. Past the cap the oldest are dropped: they stay
   *  open in Maplith, and the routine's own sweep finds them. */
  addPending(work, more = 0, nowMs = Date.now()) {
    const have = new Set(this.pending.map((p) => p.key));
    for (const w of work) {
      if (have.has(w.key) || this.fired.has(w.key)) continue;
      have.add(w.key);
      this.pending.push({ id: w.id, key: w.key, at: nowMs });
    }
    if (this.pending.length > this.maxPending) this.pending.splice(0, this.pending.length - this.maxPending);
    this.more += more;
  }

  hasPending() { return this.pending.length > 0 || this.more > 0; }

  /** The next start's work: up to `max` entries from the front, and the `more`
   *  count only when this start empties the queue. */
  peekBatch(max) {
    const batch = this.pending.slice(0, max);
    const last = batch.length === this.pending.length;
    return { work: batch, more: last ? this.more : 0 };
  }

  /** A start went through: its work is done, and what it mentioned of `more`. */
  commit(batch, nowMs) {
    const keys = new Set(batch.work.map((w) => w.key));
    this.pending = this.pending.filter((p) => !keys.has(p.key));
    for (const k of keys) { this.fired.delete(k); this.fired.set(k, nowMs); }
    // `batch.more` is all of `more` when this start emptied the queue, else 0.
    this.more = Math.max(0, this.more - batch.more);
  }

  recordFire(nowMs) { this.fires.push(nowMs); }

  /** Takes back the last attempt when the service certainly did not start
   *  anything (a refused token), so a broken setup does not eat the hour. */
  forgetFire(nowMs) {
    const i = this.fires.lastIndexOf(nowMs);
    if (i >= 0) this.fires.splice(i, 1);
  }

  /** When the next start may happen: now when fewer than `limit` starts were
   *  attempted in the last hour, else when enough of them have aged out, and
   *  never before a wait the service asked for. */
  nextSlotAt(nowMs, limit) {
    const recent = this.fires.filter((t) => nowMs - t < HOUR_MS).sort((a, b) => a - b);
    let at = nowMs;
    if (recent.length >= limit) at = recent[recent.length - limit] + HOUR_MS;
    return Math.max(at, this.blockedUntil);
  }

  firesInLastHour(nowMs) { return this.fires.filter((t) => nowMs - t < HOUR_MS).length; }
}
