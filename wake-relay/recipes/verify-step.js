// Checks a Maplith wake-up and builds the text for your routine. Paste it into
// a code step (an n8n Code node, a Make code module) that can use Node's
// `crypto`, or run it in any JavaScript runtime.
//
//   headers  the request headers, names in lower case
//   rawBody  the request body exactly as received (a Buffer or a string),
//            before any JSON parsing
//   secrets  your signing secret, or two while a replaced one still signs
//   nowSeconds  the time now, in Unix seconds
//
// Returns { ok: false, status: 401 | 400 } for something that is not a wake-up
// from Maplith, and { ok: true, status: 200, start: false } for one that needs no
// start. For work to start it returns { ok: true, status: 202, start: true,
// deliveryId, ids, text }: `text` is signal ids, one per line, and nothing
// else; send it as the routine's `text`.
function verifyAndBuild(headers, rawBody, secrets, nowSeconds) {
  const { createHmac, timingSafeEqual } = require('crypto');
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const header = String(headers['x-maplith-signature'] || '').trim();
  const m = /^t=(\d{1,12})((?:,v1=[0-9a-f]{64}){1,2})$/.exec(header);
  if (!m || Math.abs(nowSeconds - Number(m[1])) > 300) return { ok: false, status: 401, start: false, reason: 'signature' };
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');
  let valid = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(`${m[1]}.`).update(body).digest();
    for (const value of m[2].slice(1).split(',')) {
      valid = timingSafeEqual(Buffer.from(value.slice(3), 'hex'), expected) || valid;
    }
  }
  if (!valid) return { ok: false, status: 401, start: false, reason: 'signature' };

  let e;
  try { e = JSON.parse(body.toString('utf8')); } catch { return { ok: false, status: 400, start: false, reason: 'shape' }; }
  const deliveryId = e && e.delivery_id;
  if (typeof deliveryId !== 'string' || !/^wd_[0-9a-f-]{36}$/.test(deliveryId) || deliveryId !== headers['x-maplith-delivery']) {
    return { ok: false, status: 400, start: false, reason: 'shape' };
  }
  let ids = [];
  let more = 0;
  if (e.type === 'signals.raised') {
    if (!Array.isArray(e.signals) || !Number.isInteger(e.more) || e.more < 0) return { ok: false, status: 400, start: false, reason: 'shape' };
    ids = e.signals.map((s) => (s && typeof s.id === 'string' ? s.id : ''));
    more = e.more;
  } else if (e.type === 'approval.decided') {
    const id = e.approval && e.approval.signal_id;
    ids = id === undefined ? [] : [id];
  } else {
    return { ok: true, status: 200, start: false, reason: e.type === 'test' ? 'test' : 'ignored', deliveryId };
  }
  if (!ids.every((id) => UUID.test(id))) return { ok: false, status: 400, start: false, reason: 'shape' };
  if (!ids.length && !more) return { ok: true, status: 200, start: false, reason: 'nothing_to_do', deliveryId };
  const unique = [...new Set(ids)];
  const lines = more > 0 ? [...unique, `more: ${more}`] : unique;
  return { ok: true, status: 202, start: true, deliveryId, ids: unique, text: lines.join('\n') };
}
