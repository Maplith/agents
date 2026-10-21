// Adapter: start a Claude Code routine through its API trigger.
//
//   POST https://api.anthropic.com/v1/claude_code/routines/<id>/fire
//   Authorization: Bearer <the routine's own token>
//   anthropic-version: 2023-06-01
//   {"text": "<signal ids, one per line>"}
//
// The token belongs to your claude.ai account and to that one routine. It is
// read from the environment of this relay and sent to api.anthropic.com and to
// nowhere else: the address is checked at start-up, and a redirect is never
// followed. The endpoint has no idempotency key, so this relay does the
// de-duplicating, and the service allows 30 starts an hour per routine, which
// the relay's rate guard stays under. Anthropic's documentation of the endpoint:
// https://platform.claude.com/docs/en/api/claude-code/routines-fire
export const API_BASE = 'https://api.anthropic.com';
export const MAX_FIRES_PER_HOUR = 30;
/** The beta header the routine endpoint was documented with. The endpoint
 *  accepts a request with or without it. */
export const ROUTINE_BETA = 'experimental-cc-routine-2026-04-01';

const FIRE_URL = /^https:\/\/api\.anthropic\.com\/v1\/claude_code\/routines\/(trig_[A-Za-z0-9]{8,64})\/fire\/?$/;
const ROUTINE_ID = /^trig_[A-Za-z0-9]{8,64}$/;

/** The routine's id from the address the routine page shows ("…/routines/trig_…/fire")
 *  or from the bare id; null for anything else, so the token can never be sent
 *  to another host. */
export function routineIdFrom(value) {
  const v = String(value ?? '').trim();
  if (ROUTINE_ID.test(v)) return v;
  const m = FIRE_URL.exec(v);
  return m ? m[1] : null;
}

/** How long the service asked us to wait, in seconds, clamped; a default when
 *  it said nothing we can read. */
export function retryAfterSeconds(header, fallback = 600) {
  const n = Number(header);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(3600, Math.max(10, Math.ceil(n)));
}

/** What a response means for the relay, by status. */
export function classify(status) {
  if (status >= 200 && status < 300) return 'ok';
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403 || status === 404 || status === 410) return 'auth';
  if (status === 408 || status >= 500) return 'retry';
  return 'rejected';
}

/**
 * @param {{ routineId: string, token: string, apiBase?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
export function createRoutineAdapter({ routineId, token, apiBase = API_BASE, fetchImpl = fetch, timeoutMs = 7000 }) {
  const url = `${apiBase}/v1/claude_code/routines/${routineId}/fire`;
  return {
    name: 'claude-code-routine',
    subject: 'your Claude Code routine',
    fallback: "Nothing is lost: the signals stay open in Maplith, and the routine's own hourly run picks them up.",
    maxFiresPerHour: MAX_FIRES_PER_HOUR,

    /** Starts one run of the routine with `text` as its run-specific context. */
    async fire({ text }) {
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': ROUTINE_BETA,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ text }),
          redirect: 'error',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return { ok: false, class: 'retry', status: 0 };
      }
      const raw = await res.text().catch(() => '');
      const cls = classify(res.status);
      if (cls === 'ok') {
        let session = null;
        try { session = JSON.parse(raw).claude_code_session_id ?? null; } catch { /* no id to report */ }
        return { ok: true, session: typeof session === 'string' ? session : null };
      }
      let errorType = null;
      try { errorType = JSON.parse(raw).error?.type ?? null; } catch { /* not JSON */ }
      return { ok: false, class: cls, status: res.status, errorType, retryAfterS: cls === 'rate_limited' ? retryAfterSeconds(res.headers.get('retry-after')) : undefined };
    },

    /** The words of an alert for a refusal: what happened, and what to do. */
    explain(res) {
      if (res.class === 'auth' && res.status === 401) {
        return {
          what: "Anthropic did not accept the routine's API token (HTTP 401).",
          todo: "Open the routine at claude.ai/code/routines, choose Edit, open its API trigger and press Regenerate, then put the new token into this relay's ROUTINE_TOKEN setting and restart it.",
        };
      }
      if (res.class === 'auth' && res.status === 403) {
        return {
          what: 'Anthropic says this account may not use the routine API trigger (HTTP 403).',
          todo: 'Ask an Owner of your Claude organisation whether routines are switched on, and check that the routine owner still has Claude Code on the web.',
        };
      }
      if (res.class === 'auth') {
        return {
          what: `Anthropic says the routine no longer exists (HTTP ${res.status}).`,
          todo: "Check the routine's address in this relay's ROUTINE_FIRE_URL setting. If you made a new routine, copy its address and generate its token.",
        };
      }
      if (res.class === 'rejected') {
        return {
          what: `Anthropic refused to start the routine (HTTP ${res.status}).`,
          todo: 'Open the routine and switch it on if it is paused.',
        };
      }
      return {
        what: 'Anthropic has not answered the last starts (a server error or no answer).',
        todo: 'Nothing to do yet. Maplith sends each wake-up again for several hours.',
      };
    },
  };
}
