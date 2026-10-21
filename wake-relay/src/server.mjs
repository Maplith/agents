// The HTTP side:
//
//   POST /wake      a wake-up from Maplith
//   GET  /healthz   200 "ok"
//
// For each wake-up, before anything else happens:
//   1. the body is at most 64 KB;
//   2. its X-Maplith-Signature verifies, over the bytes received, with a
//      secret this relay holds (else 401, which Maplith counts towards a failing
//      wake-up);
//   3. it parses to the shape Maplith sends, and its delivery id is the
//      X-Maplith-Delivery header (else 400).
// Then the relay decides (relay.mjs). Nothing is logged but the delivery id,
// the decision and the status: no body, no header, no secret.
import { createServer } from 'node:http';
import { MAX_BODY_BYTES, verifyWakeSignature } from './signature.mjs';
import { parseEnvelope } from './envelope.mjs';

/**
 * @param {{ relay: { handle: Function }, secrets: string[], log?: (line: string) => void, now?: () => number, redact?: (s: string) => string }} opts
 */
export function createWakeServer({ relay, secrets, log = () => {}, now = Date.now, redact = (s) => s }) {
  async function handleWake(req, raw) {
    if (!verifyWakeSignature(req.headers['x-maplith-signature'], secrets, raw, Math.floor(now() / 1000))) return [401, { error: 'signature' }];
    const env = parseEnvelope(raw.toString('utf8'));
    if (!env || req.headers['x-maplith-delivery'] !== env.deliveryId) return [400, { error: 'envelope' }];
    const [status, body] = await relay.handle(env);
    log(`${env.deliveryId} ${env.type}: ${status} ${body.reason ?? body.error ?? (body.started ? 'started' : 'ok')}`);
    return [status, body];
  }

  const server = createServer((req, res) => {
    const send = ([status, body]) => {
      res.writeHead(status, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff', ...(status >= 500 ? { 'retry-after': '120' } : {}) });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url ?? '/', 'http://relay');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    if (url.pathname !== '/wake') return send([404, { error: 'not found' }]);
    if (req.method !== 'POST') return send([405, { error: 'method' }]);
    const chunks = [];
    let size = 0;
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        over = true;
        chunks.length = 0;
        res.on('finish', () => req.destroy());
        send([413, { error: 'too large' }]);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (over) return;
      handleWake(req, Buffer.concat(chunks)).then(send, (e) => {
        log(`wake-up failed: ${redact(e.message)}`);
        send([503, { error: 'try again' }]);
      });
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  return server;
}
