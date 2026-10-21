import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { verifyWakeSignature, secretsFrom, SIGNATURE_TOLERANCE_S } from '../src/signature.mjs';
import { OLD_SECRET, SECRET, signatureHeader } from './helpers.mjs';

const NOW = 1_792_400_000;
const body = JSON.stringify({ type: 'test', hello: 'world' });

test('accepts what the docs describe: HMAC-SHA256 over "<t>." and the body', () => {
  assert.equal(verifyWakeSignature(signatureHeader(body, SECRET, NOW), [SECRET], body, NOW), true);
});

test('accepts either secret during a rotation, and either value in the header', () => {
  const both = signatureHeader(body, [SECRET, OLD_SECRET], NOW);
  assert.equal(verifyWakeSignature(both, [OLD_SECRET], body, NOW), true);
  assert.equal(verifyWakeSignature(both, [SECRET], body, NOW), true);
  // A relay still holding only the old secret takes a wake-up signed with the old one alone.
  assert.equal(verifyWakeSignature(signatureHeader(body, OLD_SECRET, NOW), [SECRET, OLD_SECRET], body, NOW), true);
});

test('refuses a wrong secret, a changed body and no secret at all', () => {
  const header = signatureHeader(body, SECRET, NOW);
  assert.equal(verifyWakeSignature(header, ['mwk_some-other-secret-value'], body, NOW), false);
  assert.equal(verifyWakeSignature(header, [SECRET], `${body} `, NOW), false);
  assert.equal(verifyWakeSignature(header, [], body, NOW), false);
  assert.equal(verifyWakeSignature(null, [SECRET], body, NOW), false);
  assert.equal(verifyWakeSignature('', [SECRET], body, NOW), false);
});

test('refuses a timestamp more than five minutes from this clock, either way', () => {
  assert.equal(SIGNATURE_TOLERANCE_S, 300);
  assert.equal(verifyWakeSignature(signatureHeader(body, SECRET, NOW - 300), [SECRET], body, NOW), true);
  assert.equal(verifyWakeSignature(signatureHeader(body, SECRET, NOW - 301), [SECRET], body, NOW), false);
  assert.equal(verifyWakeSignature(signatureHeader(body, SECRET, NOW + 301), [SECRET], body, NOW), false);
});

test('refuses a header of the wrong shape', () => {
  const mac = 'a'.repeat(64);
  for (const header of [
    `t=${NOW}`,
    `v1=${mac}`,
    `t=${NOW},v1=${mac},v1=${mac},v1=${mac}`,
    `t=${NOW},v1=${'g'.repeat(64)}`,
    `t=${NOW},v1=${mac.slice(1)}`,
    `t=-5,v1=${mac}`,
    `t=${NOW};v1=${mac}`,
    `t=${NOW},v2=${mac}`,
  ]) assert.equal(verifyWakeSignature(header, [SECRET], body, NOW), false, header);
});

test('checks the bytes received, not a re-reading of them', () => {
  const bytes = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]); // not valid UTF-8
  const t = NOW;
  const header = signatureHeader(bytes.toString('latin1'), SECRET, t);
  // A header made over a different byte sequence must not verify over these bytes...
  assert.equal(verifyWakeSignature(header, [SECRET], bytes, t), false);
  // ...and one made over exactly these bytes does.
  const mac = createHmac('sha256', SECRET).update(`${t}.`).update(bytes).digest('hex');
  assert.equal(verifyWakeSignature(`t=${t},v1=${mac}`, [SECRET], bytes, t), true);
});

test('a string body and the same bytes as a Buffer give the same answer', () => {
  const header = signatureHeader(body, SECRET, NOW);
  assert.equal(verifyWakeSignature(header, [SECRET], Buffer.from(body, 'utf8'), NOW), true);
  assert.equal(verifyWakeSignature(header, [SECRET], body, NOW), true);
});

test('reads one or two secrets from the environment value, no more', () => {
  assert.deepEqual(secretsFrom(` ${SECRET} , ${OLD_SECRET} ,x`), [SECRET, OLD_SECRET]);
  assert.deepEqual(secretsFrom(SECRET), [SECRET]);
  assert.deepEqual(secretsFrom(undefined), []);
  assert.deepEqual(secretsFrom(' , '), []);
});
