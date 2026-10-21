# Start your routine from n8n or Make

Use this when you would rather not run a server. A workflow tool receives the
wake-up, checks its signature in a code step, and starts your Claude Code
routine with the routine's API trigger. The signature check is the same one
the relay makes, and the text sent to the routine is the same: signal ids and
nothing else.

What this recipe does not do, and the relay does: it does not fold wake-ups past
the routine's limit of 30 starts an hour into the next start, it remembers a
delivery only after the routine was started, and it does not alert you when the
routine's token stops working. Keep the wake-up's daily cap and its wait in
Maplith low enough that the starts stay under 30 an hour, and turn on your
tool's own alert for a failed run. The routine's hourly schedule picks up
whatever a failed start left open.

## The check

Paste this function into the code step. It needs Node's `crypto`.

```js
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
```

It returns `{ ok: false, status: 401, start: false }` for a request that is not from Maplith,
`{ ok: false, status: 400, start: false }` for one whose shape is wrong, `start: false` for a
wake-up that needs no start (a test), and `start: true` with the `text` to send.

## In n8n

1. **Webhook** node. Method `POST`, a long random path. **Respond:** *Using
   'Respond to Webhook' Node*. Under Options turn on **Raw Body**: the signature
   is made over the bytes Maplith sent, so the check needs them as they
   arrived (they are in the binary property the Webhook node's *Binary Property*
   option names, `data` by default). Use the production URL
   (`https://<your n8n>/webhook/<path>`) as the wake-up's address in Maplith.
2. **Code** node, named `Verify`, *Run Once for All Items*, JavaScript. Paste
   the function above, then this under it:

   ```js
   const raw = await this.helpers.getBinaryDataBuffer(0, 'data');
   const secrets = String($env.MAPLITH_WAKE_SECRET || '').split(',').map((s) => s.trim()).filter(Boolean);
   const result = verifyAndBuild($input.first().json.headers, raw, secrets, Math.floor(Date.now() / 1000));

   // A delivery already started is not started again (Maplith sends it again when it hears nothing).
   const seen = $getWorkflowStaticData('global');
   seen.deliveries = seen.deliveries || {};
   for (const [id, at] of Object.entries(seen.deliveries)) if (Date.now() - at > 24 * 3600 * 1000) delete seen.deliveries[id];
   if (result.start && seen.deliveries[result.deliveryId]) return [{ json: { ok: true, status: 200, start: false, reason: 'duplicate' } }];
   return [{ json: result }];
   ```

   Keep the signing secret in the environment variable `MAPLITH_WAKE_SECRET` of
   your n8n. On a self-hosted n8n the Code node may only use `crypto` when
   `NODE_FUNCTION_ALLOW_BUILTIN=crypto` is set, and an n8n that blocks
   environment access in nodes needs the secret kept another way, for example
   as an n8n variable read as `$vars.MAPLITH_WAKE_SECRET`.
3. **IF** node: condition *Boolean* `{{ $json.start }}` is true.
   - **false** → **Respond to Webhook** node. Response Code `{{ $json.status }}`, body
     `{{ { ok: $json.ok } }}` as JSON. This is what answers a bad signature with
     401 and a test with 200.
   - **true** → the next node.
4. **HTTP Request** node: `POST` to the address your routine's API trigger
   shows. Authentication: *Header Auth* with a credential named `Authorization`
   and the value `Bearer <your routine token>`, so the token stays in n8n's
   credential store. Add the header `anthropic-version: 2023-06-01`. Send the
   body as JSON with one field, `text`, set to `{{ $json.text }}`. Nothing else.
5. **Code** node, named `Remember`, after the HTTP Request succeeded:

   ```js
   const seen = $getWorkflowStaticData('global');
   seen.deliveries = seen.deliveries || {};
   seen.deliveries[$('Verify').first().json.deliveryId] = Date.now();
   return $input.all();
   ```
6. **Respond to Webhook** node: Response Code `202`.

If the HTTP Request fails, the workflow ends in an error before it answers, the
wake-up is not remembered, and Maplith sends it again within minutes.

## In Make

The scenario has the same shape, in this order:

1. **Webhooks → Custom webhook.** In its settings turn on **Get request
   headers** and **JSON pass-through**, so the headers are available and the body
   arrives as one piece of text, which is what the signature is made over. Use
   the webhook's address as the wake-up's address in Maplith.
2. A **code** step that runs the function above with the `x-maplith-signature`
   and `x-maplith-delivery` headers, the body text, and your signing secret.
   It needs a code module that can use Node's `crypto`; if your plan has none,
   run the relay instead.
3. A **filter** on `start` being true. On the other branch, a **Webhook response**
   with the `status` the step returned.
4. **HTTP → Make a request:** `POST` to the address your routine's API trigger
   shows, headers `Authorization: Bearer <your routine token>` (kept in Make's
   keys, not typed into the module) and `anthropic-version: 2023-06-01`, body
   type JSON with one field, `text`, set to the step's `text`.
5. A **Webhook response** with status `202`.

Store delivery ids in a data store and drop a delivery already in it, as the n8n
steps do.

## The rest

The wake-up's secret, the routine and its prompt are set up as in
`routine/SETUP.md`; only step 4 there, deploying the relay, is replaced by this
workflow.
