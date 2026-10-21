// What the relay decides for a wake-up that has already been verified and
// parsed: whether to start your agent now, later or not at all, and what to
// answer Maplith. No network of its own: the adapter starts your agent, the
// state remembers, the alerter speaks. One wake-up is decided at a time.
//
// For each wake-up, in order:
//   1. a test, a type this relay does not know and a paused relay are answered
//      200 and start nothing;
//   2. a delivery already answered, or work (a signal and its episode) already
//      started for, starts nothing: Maplith sends a wake-up again when it hears
//      no answer, and the start endpoint has no idempotency key of its own;
//   3. what is new waits in a queue, and the queue is started in batches of at
//      most 50 ids, as often as the rate guard allows. Past the guard the
//      signals stay queued and go out in the next start ("folded"), and a
//      timer makes sure they do even if no further wake-up comes;
//   4. a start that fails is answered by what it means: 503 for a server
//      error or no answer (Maplith sends the wake-up again), 502 for a refusal
//      that needs a person (and an alert), 200 for a wait the service asked
//      for.
import { MAX_IDS, idsText, moreOf, workOf } from './envelope.mjs';

const RETRY_ALERT_AFTER = 3;
const TIMER_RETRY_MS = 60_000;
const TIMER_RETRIES = 5;

/**
 * @param {{
 *   adapter: { name: string, subject: string, fallback: string, fire: Function, explain: Function, precheck?: Function },
 *   state: import('./state.mjs').RelayState,
 *   alerter: { alert: Function },
 *   maxFiresPerHour: number,
 *   paused?: boolean,
 *   log?: (line: string) => void,
 *   now?: () => number,
 *   timers?: { setTimeout: Function, clearTimeout: Function },
 * }} opts
 */
export function createRelay({ adapter, state, alerter, maxFiresPerHour, paused = false, log = () => {}, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  let queue = Promise.resolve();
  const serial = (fn) => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  };
  let timer = null;
  let timerAt = 0;
  let retries = 0;
  let timerRetries = 0;

  /** Makes sure the queue is looked at again at `atMs`, with nothing else to prompt it. */
  function schedule(atMs) {
    const t = now();
    if (timer && timerAt > t && timerAt <= atMs) return;
    if (timer) timers.clearTimeout(timer);
    const delay = Math.min(2 ** 31 - 1, Math.max(1000, atMs - t));
    timerAt = t + delay;
    timer = timers.setTimeout(() => {
      timer = null;
      timerAt = 0;
      if (paused) return;
      serial(() => drain('timer', 'timer')).catch((e) => log(`timer: ${e.message}`));
    }, delay);
    timer.unref?.();
  }

  function alertFor(res, everyMs) {
    const { what, todo } = adapter.explain(res);
    const text = `Your wake relay could not start ${adapter.subject}, so work is not reaching it as it arrives. ${what} ${todo} ${adapter.fallback}`;
    // Not awaited: a slow alert must never hold up the answer to Maplith.
    void alerter.alert(`${adapter.name}:${res.class}`, text, { adapter: adapter.name, class: res.class, status: res.status }, everyMs);
  }

  /** Starts the queue in batches while the guard and the adapter allow. */
  async function drain(trigger, deliveryId) {
    let started = 0;
    let session = null;
    while (state.hasPending()) {
      const t = now();
      const slot = state.nextSlotAt(t, maxFiresPerHour);
      if (slot > t) {
        schedule(slot);
        state.save();
        return { kind: 'folded', reason: state.blockedUntil > t ? 'rate_limited' : 'rate_guard', started, session, nextInS: Math.ceil((slot - t) / 1000) };
      }
      if (adapter.precheck) {
        const pre = await adapter.precheck(t);
        if (!pre.ok) {
          if (pre.class === 'ceiling') {
            alertFor(pre, 24 * 3_600_000);
            schedule(pre.retryAt);
            state.save();
            return { kind: 'folded', reason: 'daily_ceiling', started, session, nextInS: Math.ceil((pre.retryAt - t) / 1000) };
          }
          return failure(pre, t, trigger, started, session);
        }
      }
      const batch = state.peekBatch(MAX_IDS);
      const ids = batch.work.map((w) => w.id);
      state.recordFire(t);
      const res = await adapter.fire({ text: idsText(ids, batch.more), ids, more: batch.more, refs: batch.work.map((w) => w.key), deliveryId });
      if (!res.ok) return failure(res, t, trigger, started, session);
      state.commit(batch, t);
      state.save();
      retries = 0;
      timerRetries = 0;
      started += 1;
      session = res.session;
      log(`${deliveryId}: started ${adapter.name}${res.session ? ` (${res.session})` : ''} for ${ids.length} signal${ids.length === 1 ? '' : 's'}`);
    }
    return { kind: started ? 'started' : 'idle', started, session };
  }

  function failure(res, t, trigger, started, session) {
    if (res.class === 'rate_limited') {
      // The service said wait: not a start, so it does not count; the queue waits.
      const waitS = Number.isFinite(res.retryAfterS) ? res.retryAfterS : 600;
      state.forgetFire(t);
      state.blockedUntil = t + waitS * 1000;
      schedule(state.blockedUntil);
      state.save();
      log(`start refused for now (HTTP ${res.status}); waiting ${waitS}s`);
      return { kind: 'folded', reason: 'rate_limited', started, session, nextInS: waitS };
    }
    if (res.class === 'auth' || res.class === 'rejected') {
      // Certainly nothing was started: it does not count against the hour.
      state.forgetFire(t);
      state.save();
      alertFor(res);
      log(`start refused (HTTP ${res.status}, ${res.class})`);
      return { kind: 'refused', status: res.status, started, session };
    }
    // A server error or no answer: a start may or may not have happened. It stays counted.
    retries += 1;
    if (retries >= RETRY_ALERT_AFTER) alertFor({ class: 'retry', status: res.status ?? 0 });
    log(`start failed (${res.status ? `HTTP ${res.status}` : 'no answer'}); ${retries} in a row`);
    if (trigger === 'timer' && ++timerRetries <= TIMER_RETRIES) schedule(t + TIMER_RETRY_MS * timerRetries);
    state.save();
    return { kind: 'retry', status: res.status ?? 0, started, session };
  }

  async function handleNow(env) {
    const t = now();
    state.prune(t);
    const answer = (status, body) => {
      if (status < 300) { state.markDelivery(env.deliveryId, t); state.save(); }
      return [status, { ok: status < 300, ...body }];
    };
    if (env.type === 'test') return [200, { ok: true, started: false, reason: 'test' }];
    if (env.type === 'unknown') return [200, { ok: true, started: false, reason: 'ignored' }];
    if (paused) return [200, { ok: true, started: false, reason: 'paused' }];
    if (state.hasDelivery(env.deliveryId)) return [200, { ok: true, started: false, reason: 'duplicate' }];

    const work = workOf(env);
    const more = moreOf(env);
    if (env.type === 'approval.decided' && !work.length) return answer(200, { started: false, reason: 'no_signal' });
    // Work already started for is not queued again (the queue checks), so a wake-up
    // of nothing but known work leaves nothing to start and is answered below.
    state.addPending(work, more, t);

    const r = await drain('wake', env.deliveryId);
    switch (r.kind) {
      case 'started': return answer(202, { started: true, session: r.session });
      case 'idle': return answer(200, { started: false, reason: 'nothing_new' });
      case 'folded': return answer(200, { started: r.started > 0, folded: true, reason: r.reason, next_start_in_s: r.nextInS });
      case 'refused': return [502, { ok: false, error: 'the start was refused' }];
      default: return [503, { ok: false, error: 'try again' }];
    }
  }

  return {
    /** Decides one verified, parsed wake-up. Resolves to `[status, body]`. */
    handle: (env) => serial(() => handleNow(env)),
    /** Starts what was waiting when the relay last stopped (a restart with a state file). */
    resume: () => serial(() => (!paused && state.hasPending() ? drain('timer', 'restart') : null)),
    /** Stops the timer (a shutdown). */
    close() { if (timer) timers.clearTimeout(timer); timer = null; },
    /** What the relay holds right now, for a log line. */
    snapshot: () => ({ pending: state.pending.length, startsLastHour: state.firesInLastHour(now()) }),
  };
}
