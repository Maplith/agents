// A plain-words alert to a webhook of yours, when the relay cannot start your
// agent in a way that needs a person (a token that was replaced, a routine that
// was deleted). One POST of JSON, `{"text": "...", "event": "...", ...}`: Slack
// incoming webhooks, n8n, Make and Zapier all take it. The text never holds a
// token, a key, a secret, the webhook's own address or anything from a
// wake-up's body.
//
// One alert per kind of problem per hour, so a broken setup is one message and
// not one for every wake-up.
const LOOPBACK = /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/;

/** True for an address an alert may go to: https, or a local test server. */
export function isAlertUrl(value) {
  let u;
  try { u = new URL(value); } catch { return false; }
  if (u.username || u.password) return false;
  return u.protocol === 'https:' || LOOPBACK.test(String(value));
}

/**
 * @param {{ url?: string|null, fetchImpl?: typeof fetch, now?: () => number, intervalMs?: number, log?: (line: string) => void, redact?: (s: string) => string, source?: string }} opts
 */
export function createAlerter({ url = null, fetchImpl = fetch, now = Date.now, intervalMs = 3_600_000, log = () => {}, redact = (s) => s, source = 'wake-relay' } = {}) {
  const last = new Map();
  // A failed alert is tried again after five minutes, not after the interval.
  const retrySoon = (key, at, every) => last.set(key, at - every + 300_000);
  return {
    /** Sends `text` once per `key` per interval (`every` overrides the interval
     *  for this kind of alert). Never throws. */
    async alert(key, text, extra = {}, every = intervalMs) {
      const at = now();
      if (last.has(key) && at - last.get(key) < every) return false;
      last.set(key, at);
      if (!url) { log(`alert not sent (no ALERT_WEBHOOK_URL): ${key}`); return false; }
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, event: key, source, ...extra }),
          redirect: 'error',
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) { log(`alert refused by the webhook (HTTP ${res.status}): ${key}`); retrySoon(key, at, every); }
        return res.ok;
      } catch (e) {
        log(`alert failed: ${redact(e.message)}`);
        retrySoon(key, at, every);
        return false;
      }
    },
  };
}
