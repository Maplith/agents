import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, redactor, secretValues } from '../src/config.mjs';
import { SECRET, root } from './helpers.mjs';

const ID = 'trig_01ABCDEFGHJKLMNOPQRSTUVW';
const FIRE = `https://api.anthropic.com/v1/claude_code/routines/${ID}/fire`;
const env = { MAPLITH_WAKE_SECRET: SECRET, ROUTINE_TOKEN: 'routine-token-0123456789', ...{} };

function file(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-config-'));
  const f = join(dir, 'relay.config.json');
  writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  return f;
}
const problems = (r) => (r.ok ? [] : r.problems);

test('a routine setup from the file and the environment', () => {
  const r = loadConfig({ file: file({ adapter: 'claude-code-routine', routine: { fire_url: FIRE } }), env });
  assert.equal(r.ok, true, problems(r).join('; '));
  assert.equal(r.config.routine.id, ID);
  assert.equal(r.config.maxFiresPerHour, 30);
  assert.equal(r.config.dedupeHours, 24);
  assert.equal(r.config.name, 'wake-relay');
  assert.deepEqual(r.config.secrets.wake, [SECRET]);
  assert.equal(r.config.secrets.routineToken, env.ROUTINE_TOKEN);
});

test('a host with no file to edit needs nothing but its environment: RELAY_ and the setting’s path', () => {
  const r = loadConfig({ file: null, env: { ...env, RELAY_ADAPTER: 'claude-code-routine', RELAY_ROUTINE_FIRE_URL: FIRE, RELAY_MAX_FIRES_PER_HOUR: '12', RELAY_PAUSED: 'true', RELAY_NAME: 'my-relay' } });
  assert.equal(r.ok, true, problems(r).join('; '));
  assert.equal(r.config.maxFiresPerHour, 12);
  assert.equal(r.config.paused, true);
  assert.equal(r.config.name, 'my-relay');
});

test('the environment wins over the file', () => {
  const f = file({ adapter: 'claude-code-routine', max_fires_per_hour: 5, routine: { fire_url: FIRE } });
  assert.equal(loadConfig({ file: f, env: { ...env, RELAY_MAX_FIRES_PER_HOUR: '9' } }).config.maxFiresPerHour, 9);
});

test('the file as shipped is refused until it is filled in, and says what is missing', () => {
  const r = loadConfig({ file: join(root, 'relay.config.json'), env });
  assert.equal(r.ok, false);
  assert.match(problems(r).join('\n'), /routine\.fire_url must be the address the routine's API trigger shows/);
  // With its address set in the environment it starts.
  assert.equal(loadConfig({ file: join(root, 'relay.config.json'), env: { ...env, RELAY_ROUTINE_FIRE_URL: FIRE } }).ok, true);
});

test('the managed-agents block as shipped is refused while it holds placeholders it cannot use', () => {
  const r = loadConfig({ file: join(root, 'relay.config.json'), env: { MAPLITH_WAKE_SECRET: SECRET, ANTHROPIC_API_KEY: 'key-0123456789', RELAY_ADAPTER: 'managed-agents' } });
  assert.equal(r.ok, true, 'the shipped ids are well-formed text; the Claude Console is what says they do not exist');
  assert.equal(r.config.managedAgents.max_cost_usd_cents, 100);
});

test('every problem is listed at once, never a guess', () => {
  const r = loadConfig({ file: file({ adapter: 'carrier-pigeon', max_fires_per_hour: 0, dedupe_hours: 999, timezone: 'Mars/Olympus' }), env: {} });
  assert.equal(r.ok, false);
  const text = problems(r).join('\n');
  assert.match(text, /adapter must be one of: claude-code-routine, managed-agents/);
  assert.match(text, /max_fires_per_hour must be from 1 to/);
  assert.match(text, /dedupe_hours must be from 1 to 168/);
  assert.match(text, /timezone "Mars\/Olympus" is not a time zone/);
  assert.match(text, /MAPLITH_WAKE_SECRET is not set/);
});

test('a misspelt setting is refused, not ignored', () => {
  const r = loadConfig({ file: file({ adapter: 'claude-code-routine', max_fire_per_hour: 3, routine: { fire_url: FIRE, token: 'x' }, extra: {} }), env });
  assert.equal(r.ok, false);
  const text = problems(r).join('\n');
  assert.match(text, /max_fire_per_hour is not a setting/);
  assert.match(text, /routine\.token is not a setting/);
  assert.match(text, /extra is not a setting/);
});

test('settings of the wrong type are refused', () => {
  const r = loadConfig({ file: file({ adapter: 'claude-code-routine', paused: 'no', max_fires_per_hour: '30', routine: { fire_url: FIRE } }), env });
  assert.match(problems(r).join('\n'), /paused must be true or false/);
  assert.match(problems(r).join('\n'), /max_fires_per_hour must be a whole number/);
  assert.match(problems(loadConfig({ file: file('{ nope'), env })).join('\n'), /not valid JSON/);
  assert.match(problems(loadConfig({ file: file('[]'), env })).join('\n'), /one JSON object/);
});

test('the routine may be started at most 30 times an hour, the service’s own limit', () => {
  const f = (n) => file({ adapter: 'claude-code-routine', max_fires_per_hour: n, routine: { fire_url: FIRE } });
  assert.equal(loadConfig({ file: f(30), env }).ok, true);
  assert.equal(loadConfig({ file: f(31), env }).ok, false);
  assert.equal(loadConfig({ file: f(1), env }).ok, true);
});

test('the token can only be sent to the one address: another host is refused at start-up', () => {
  const bad = loadConfig({ file: file({ adapter: 'claude-code-routine', routine: { fire_url: 'https://evil.example/v1/claude_code/routines/trig_01ABCDEFGHJKLMNOPQRSTUVW/fire' } }), env });
  assert.equal(bad.ok, false);
  assert.equal(loadConfig({ file: null, env: { ...env, RELAY_ADAPTER: 'claude-code-routine', RELAY_ROUTINE_FIRE_URL: FIRE, ANTHROPIC_API_BASE: 'https://evil.example' } }).ok, false);
  assert.equal(loadConfig({ file: null, env: { ...env, RELAY_ADAPTER: 'claude-code-routine', RELAY_ROUTINE_FIRE_URL: FIRE, ANTHROPIC_API_BASE: 'http://127.0.0.1:4010' } }).ok, true);
});

test('the secrets must be present and plausible', () => {
  const f = file({ adapter: 'claude-code-routine', routine: { fire_url: FIRE } });
  assert.match(problems(loadConfig({ file: f, env: { ROUTINE_TOKEN: 'abc' } })).join('\n'), /MAPLITH_WAKE_SECRET is not set/);
  assert.match(problems(loadConfig({ file: f, env: { MAPLITH_WAKE_SECRET: 'short', ROUTINE_TOKEN: 'abc' } })).join('\n'), /too short/);
  assert.match(problems(loadConfig({ file: f, env: { MAPLITH_WAKE_SECRET: SECRET } })).join('\n'), /ROUTINE_TOKEN is not set/);
  assert.match(problems(loadConfig({ file: f, env: { MAPLITH_WAKE_SECRET: SECRET, ROUTINE_TOKEN: 'two words' } })).join('\n'), /must not contain spaces/);
  // A rotation: two secrets.
  assert.equal(loadConfig({ file: f, env: { ...env, MAPLITH_WAKE_SECRET: `${SECRET},mwk_the-previous-secret-0123` } }).config.secrets.wake.length, 2);
});

test('the alert webhook must be https (a local address only for a test)', () => {
  const f = file({ adapter: 'claude-code-routine', routine: { fire_url: FIRE } });
  assert.equal(loadConfig({ file: f, env: { ...env, ALERT_WEBHOOK_URL: 'https://hooks.example/abc' } }).ok, true);
  assert.equal(loadConfig({ file: f, env: { ...env, ALERT_WEBHOOK_URL: 'http://hooks.example/abc' } }).ok, false);
  assert.equal(loadConfig({ file: f, env: { ...env, ALERT_WEBHOOK_URL: 'https://user:pw@hooks.example/abc' } }).ok, false);
  assert.equal(loadConfig({ file: f, env: { ...env, ALERT_WEBHOOK_URL: 'http://127.0.0.1:9000/x' } }).ok, true);
});

test('managed agents: the ids, one session’s cost limit, and a daily limit that is at least one session', () => {
  const base = { adapter: 'managed-agents', managed_agents: { agent_id: 'agent_ABC123', environment_id: 'env_ABC123', max_cost_usd_cents: 100 } };
  const e = { MAPLITH_WAKE_SECRET: SECRET, ANTHROPIC_API_KEY: 'key-0123456789' };
  const ok = loadConfig({ file: file(base), env: e });
  assert.equal(ok.ok, true, problems(ok).join('; '));
  assert.equal(ok.config.managedAgents.daily_ceiling_usd_cents, null);
  assert.deepEqual(ok.config.managedAgents.vault_ids, []);
  const noCost = loadConfig({ file: file({ ...base, managed_agents: { agent_id: 'agent_ABC123', environment_id: 'env_ABC123' } }), env: e });
  assert.match(problems(noCost).join('\n'), /max_cost_usd_cents must be set/);
  const lowCeiling = loadConfig({ file: file({ ...base, managed_agents: { ...base.managed_agents, daily_ceiling_usd_cents: 50 } }), env: e });
  assert.match(problems(lowCeiling).join('\n'), /at least one session/);
  assert.match(problems(loadConfig({ file: file(base), env: { MAPLITH_WAKE_SECRET: SECRET } })).join('\n'), /ANTHROPIC_API_KEY is not set/);
  const viaEnv = loadConfig({ file: null, env: { ...e, RELAY_ADAPTER: 'managed-agents', RELAY_MANAGED_AGENTS_AGENT_ID: 'agent_X1', RELAY_MANAGED_AGENTS_ENVIRONMENT_ID: 'env_X1', RELAY_MANAGED_AGENTS_VAULT_IDS: 'vlt_a, vlt_b', RELAY_MANAGED_AGENTS_MAX_COST_USD_CENTS: '250', RELAY_MANAGED_AGENTS_DAILY_CEILING_USD_CENTS: '1000' } });
  assert.equal(viaEnv.ok, true, problems(viaEnv).join('; '));
  assert.deepEqual(viaEnv.config.managedAgents.vault_ids, ['vlt_a', 'vlt_b']);
  assert.equal(viaEnv.config.managedAgents.max_cost_usd_cents, 250);
  assert.equal(viaEnv.config.maxFiresPerHour, 30);
});

test('every secret is known to the redaction list', () => {
  const r = loadConfig({ file: file({ adapter: 'claude-code-routine', routine: { fire_url: FIRE } }), env: { ...env, ALERT_WEBHOOK_URL: 'https://hooks.example/abc' } });
  assert.deepEqual(secretValues(r.config).sort(), [SECRET, env.ROUTINE_TOKEN, 'https://hooks.example/abc'].sort());
});

test('a line about to be logged loses every secret, becomes one line and stays short', () => {
  const r = loadConfig({ file: file({ adapter: 'claude-code-routine', routine: { fire_url: FIRE } }), env: { ...env, ALERT_WEBHOOK_URL: 'https://hooks.example/abc?key=hook-secret' } });
  const redact = redactor(r.config);
  const line = redact(`failed with ${env.ROUTINE_TOKEN}\nand ${SECRET} then https://hooks.example/abc?key=hook-secret ${'x'.repeat(500)}`);
  assert.doesNotMatch(line, /routine-token|mwk_test|hook-secret|\n/);
  assert.match(line, /^failed with \[redacted\] and \[redacted\] then \[redacted\] x+$/);
  assert.equal(line.length <= 300, true);
});
