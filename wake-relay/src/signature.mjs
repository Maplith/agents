// The wake-up signature check.
//
//   X-Maplith-Signature: t=<unix seconds>,v1=<hex>[,v1=<hex>]
//
// <hex> is HMAC-SHA256 over the bytes "<t>." followed by the raw request body,
// keyed with the wake-up's signing secret. The timestamp must be within five
// minutes of this machine's clock. During the 24 hours after a secret is
// replaced the header carries two v1 values, and the relay may hold both
// secrets: any value matching any secret is enough.
//
// Node's standard library only.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** How far a signature's timestamp may be from this clock, in seconds. */
export const SIGNATURE_TOLERANCE_S = 300;
/** The most a wake-up body may be. A real one is a few hundred bytes. */
export const MAX_BODY_BYTES = 64 * 1024;

function sameHex(a, b) {
  if (a.length !== b.length || !/^[0-9a-f]+$/.test(a) || !/^[0-9a-f]+$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** True when the header's timestamp is within the tolerance and one of its
 *  values matches one of `secrets`. The check runs over the bytes received,
 *  before any parsing, and every pair is compared in constant time. */
export function verifyWakeSignature(header, secrets, rawBody, nowS) {
  if (!header || !secrets.length) return false;
  const m = /^t=(\d{1,12})((?:,v1=[0-9a-f]{64}){1,2})$/.exec(String(header).trim());
  if (!m) return false;
  const t = Number(m[1]);
  if (!Number.isSafeInteger(t) || Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  const values = m[2].slice(1).split(',').map((v) => v.slice(3));
  let ok = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${t}.`).update(body).digest('hex');
    for (const v of values) ok = sameHex(v, expected) || ok;
  }
  return ok;
}

/** The signing secrets held in MAPLITH_WAKE_SECRET: one, or two separated by a
 *  comma while a replaced secret is still signing beside the new one. */
export function secretsFrom(value) {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 2);
}
