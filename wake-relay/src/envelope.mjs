// What a wake-up says, and what the relay passes on of it.
//
// A wake-up names ids and nothing else: a type, a delivery id, signal ids with
// their kind, severity and episode, and for a person's decision the request id
// and the decision. The relay copies only validated ids and whole numbers into
// what it sends on, so no text from the wake-up can reach your agent.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KIND = /^[a-z][a-z_]{0,63}$/;
const SEVERITIES = new Set(['info', 'attention', 'urgent']);
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/** Most signals one wake-up names, and most ids one start carries. */
export const MAX_IDS = 50;

/** The wake-up, held to the shape Maplith sends, or null. Unknown extra
 *  top-level keys are ignored (they are never passed on); every key the relay
 *  uses must have its exact shape. */
export function parseEnvelope(raw) {
  let e;
  try { e = JSON.parse(raw); } catch { return null; }
  if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
  if (typeof e.type !== 'string') return null;
  if (typeof e.delivery_id !== 'string' || !/^wd_[0-9a-f-]{36}$/.test(e.delivery_id) || !UUID.test(e.delivery_id.slice(3))) return null;
  if (typeof e.workspace_id !== 'string' || !UUID.test(e.workspace_id)) return null;
  if (typeof e.sent_at !== 'string' || !ISO.test(e.sent_at)) return null;
  let heldBack = 0;
  if (e.held_back_since !== undefined) {
    const h = e.held_back_since;
    if (!h || typeof h !== 'object' || !Number.isInteger(h.count) || h.count < 0 || typeof h.since !== 'string' || !ISO.test(h.since)) return null;
    heldBack = h.count;
  }
  if (e.type === 'approval.decided') {
    const a = e.approval;
    if (!a || typeof a !== 'object') return null;
    if (typeof a.request_id !== 'string' || !UUID.test(a.request_id) || !['approved', 'denied'].includes(a.decision)) return null;
    if (a.signal_id !== undefined && (typeof a.signal_id !== 'string' || !UUID.test(a.signal_id))) return null;
    return { type: e.type, deliveryId: e.delivery_id, approval: { requestId: a.request_id, decision: a.decision, signalId: a.signal_id ?? null }, signals: [], more: 0, heldBack };
  }
  if (e.type !== 'signals.raised' && e.type !== 'test') return { type: 'unknown', deliveryId: e.delivery_id, signals: [], more: 0, heldBack };
  if (!Array.isArray(e.signals) || e.signals.length > MAX_IDS || !Number.isInteger(e.more) || e.more < 0) return null;
  const signals = [];
  for (const s of e.signals) {
    if (!s || typeof s !== 'object') return null;
    if (typeof s.id !== 'string' || !UUID.test(s.id) || typeof s.kind !== 'string' || !KIND.test(s.kind)) return null;
    if (!SEVERITIES.has(s.severity) || !Number.isInteger(s.episode) || s.episode < 1) return null;
    signals.push({ id: s.id, episode: s.episode });
  }
  return { type: e.type, deliveryId: e.delivery_id, signals, more: e.more, heldBack };
}

/** The work a wake-up asks for, as `{ id, key }` entries: `id` is the signal
 *  to work, `key` what makes it the same work again (a signal's id and episode:
 *  a new episode is new work). A person's decision names the signal it was
 *  about, if any, keyed by the request. */
export function workOf(env) {
  if (env.type === 'approval.decided') {
    return env.approval.signalId ? [{ id: env.approval.signalId, key: `approval:${env.approval.requestId}` }] : [];
  }
  return env.signals.map((s) => ({ id: s.id, key: `${s.id}:${s.episode}` }));
}

/** How many more signals there are than the work names: what the wake-up says
 *  it left out, and what a cap held back. Your agent reads them itself. */
export const moreOf = (env) => env.more + env.heldBack;

/** What one start carries as text: signal ids, one per line, and a last line
 *  `more: <n>` when there is more than the ids name. Nothing else. */
export function idsText(ids, more = 0) {
  const lines = [...new Set(ids)];
  if (more > 0) lines.push(`more: ${more}`);
  return lines.join('\n');
}
