// The relay's settings: one plain file (relay.config.json) plus environment
// variables. Secrets live only in the environment. Every other setting can be
// written in the file or set as an environment variable named RELAY_ followed
// by the setting's path in capitals (`max_fires_per_hour` is
// RELAY_MAX_FIRES_PER_HOUR, `routine.fire_url` is RELAY_ROUTINE_FIRE_URL); the
// environment wins. That way a host that deploys straight from the repository,
// with no file to edit, needs nothing but its environment.
//
// A mistake stops the relay at start-up with every problem listed, never a
// guess: a misspelt setting is refused, not ignored.
import { existsSync, readFileSync } from 'node:fs';
import { isAlertUrl } from './alert.mjs';
import { DEFAULT_KICKOFF } from './adapters/managed-agents.mjs';
import { MAX_FIRES_PER_HOUR, routineIdFrom } from './adapters/claude-code-routine.mjs';
import { isTimeZone } from './day.mjs';
import { secretsFrom } from './signature.mjs';

/** The settings the file and RELAY_* variables may carry, with their types. */
export const SCHEMA = {
  adapter: 'string',
  name: 'string',
  paused: 'boolean',
  max_fires_per_hour: 'integer',
  dedupe_hours: 'integer',
  state_file: 'string',
  timezone: 'string',
  routine: { fire_url: 'string' },
  managed_agents: {
    agent_id: 'string',
    agent_version: 'integer',
    environment_id: 'string',
    vault_ids: 'list',
    max_cost_usd_cents: 'integer',
    daily_ceiling_usd_cents: 'integer',
    kickoff: 'string',
  },
};

const ADAPTERS = ['claude-code-routine', 'managed-agents'];
const LOOPBACK = /^http:\/\/127\.0\.0\.1:\d+$/;
const API_ID = /^[A-Za-z0-9_-]{3,80}$/;

function coerce(type, raw, path, problems) {
  const v = String(raw).trim();
  if (type === 'string') return v;
  if (type === 'boolean') {
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off|)$/i.test(v)) return false;
    problems.push(`${path} must be true or false`);
    return undefined;
  }
  if (type === 'integer') {
    if (/^\d{1,9}$/.test(v)) return Number(v);
    problems.push(`${path} must be a whole number`);
    return undefined;
  }
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

/** The file's settings with the environment's laid over them, and the unknown
 *  settings reported. */
function merge(file, env, problems) {
  const out = {};
  const walk = (schema, from, into, path) => {
    for (const key of Object.keys(from ?? {})) {
      if (!(key in schema)) problems.push(`${[...path, key].join('.')} is not a setting of this relay`);
    }
    for (const [key, type] of Object.entries(schema)) {
      const p = [...path, key];
      if (typeof type === 'object') {
        into[key] = {};
        const sub = from?.[key];
        if (sub !== undefined && (sub === null || typeof sub !== 'object' || Array.isArray(sub))) problems.push(`${p.join('.')} must be a group of settings`);
        walk(type, sub && typeof sub === 'object' && !Array.isArray(sub) ? sub : {}, into[key], p);
        continue;
      }
      const envName = `RELAY_${p.join('_').toUpperCase()}`;
      if (env[envName] !== undefined && env[envName] !== '') {
        const v = coerce(type, env[envName], envName, problems);
        if (v !== undefined) into[key] = v;
        continue;
      }
      const v = from?.[key];
      if (v === undefined || v === null) continue;
      const ok = (type === 'string' && typeof v === 'string')
        || (type === 'boolean' && typeof v === 'boolean')
        || (type === 'integer' && Number.isInteger(v))
        || (type === 'list' && Array.isArray(v) && v.every((x) => typeof x === 'string'));
      if (ok) into[key] = v;
      else problems.push(`${p.join('.')} must be ${type === 'list' ? 'a list of text' : type === 'integer' ? 'a whole number' : type === 'boolean' ? 'true or false' : 'text'}`);
    }
  };
  walk(SCHEMA, file, out, []);
  return out;
}

/**
 * Reads and checks the settings. Returns `{ ok: true, config }` or
 * `{ ok: false, problems }` with every problem found.
 * @param {{ file?: string|null, env?: Record<string, string|undefined> }} opts
 */
export function loadConfig({ file = null, env = process.env } = {}) {
  const problems = [];
  let fromFile = {};
  if (file && existsSync(file)) {
    try {
      fromFile = JSON.parse(readFileSync(file, 'utf8'));
      if (!fromFile || typeof fromFile !== 'object' || Array.isArray(fromFile)) { problems.push('the settings file must hold one JSON object'); fromFile = {}; }
    } catch (e) {
      problems.push(`the settings file is not valid JSON (${e.message})`);
    }
  }
  const s = merge(fromFile, env, problems);

  const adapter = s.adapter;
  if (!ADAPTERS.includes(adapter)) problems.push(`adapter must be one of: ${ADAPTERS.join(', ')}`);
  const name = s.name ?? 'wake-relay';
  if (!/^[a-z][a-z0-9-]{1,39}$/.test(name)) problems.push('name must be 2 to 40 lowercase letters, digits and hyphens, starting with a letter');
  const maxFiresCap = adapter === 'claude-code-routine' ? MAX_FIRES_PER_HOUR : 600;
  const maxFiresPerHour = s.max_fires_per_hour ?? 30;
  if (maxFiresPerHour < 1 || maxFiresPerHour > maxFiresCap) problems.push(`max_fires_per_hour must be from 1 to ${maxFiresCap}${adapter === 'claude-code-routine' ? ' (the routine API trigger allows 30 an hour)' : ''}`);
  const dedupeHours = s.dedupe_hours ?? 24;
  if (dedupeHours < 1 || dedupeHours > 168) problems.push('dedupe_hours must be from 1 to 168');
  const timeZone = s.timezone ?? 'UTC';
  if (!isTimeZone(timeZone)) problems.push(`timezone ${JSON.stringify(timeZone)} is not a time zone this system knows (for example UTC or Europe/Berlin)`);

  const wake = secretsFrom(env.MAPLITH_WAKE_SECRET);
  if (!wake.length) problems.push("MAPLITH_WAKE_SECRET is not set: it is the wake-up's signing secret, shown once when the wake-up is made in Maplith");
  else if (wake.some((x) => x.length < 16)) problems.push('MAPLITH_WAKE_SECRET looks too short to be a signing secret');
  const alertUrl = env.ALERT_WEBHOOK_URL ? String(env.ALERT_WEBHOOK_URL).trim() : null;
  if (alertUrl && !isAlertUrl(alertUrl)) problems.push('ALERT_WEBHOOK_URL must be an https address');
  const apiBase = env.ANTHROPIC_API_BASE ? String(env.ANTHROPIC_API_BASE).trim() : null;
  if (apiBase && !LOOPBACK.test(apiBase)) problems.push('ANTHROPIC_API_BASE may only name a local test server (http://127.0.0.1:<port>)');
  const port = env.PORT ? Number(env.PORT) : 8080;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT must be a port number');

  const out = {
    adapter, name, paused: s.paused ?? false, maxFiresPerHour, dedupeHours, timeZone,
    stateFile: s.state_file || null, port, alertUrl, apiBase,
    secrets: { wake },
  };

  if (adapter === 'claude-code-routine') {
    const id = routineIdFrom(s.routine?.fire_url);
    if (!id) problems.push("routine.fire_url must be the address the routine's API trigger shows (https://api.anthropic.com/v1/claude_code/routines/trig_…/fire)");
    const token = String(env.ROUTINE_TOKEN ?? '').trim();
    if (!token) problems.push("ROUTINE_TOKEN is not set: it is the routine's API token, shown once when it is generated");
    else if (/\s/.test(token)) problems.push('ROUTINE_TOKEN must not contain spaces or line breaks');
    out.routine = { id };
    out.secrets.routineToken = token;
  }
  if (adapter === 'managed-agents') {
    const m = s.managed_agents ?? {};
    for (const key of ['agent_id', 'environment_id']) if (!m[key] || !API_ID.test(m[key])) problems.push(`managed_agents.${key} must be set to the id from the Claude Console`);
    for (const v of m.vault_ids ?? []) if (!API_ID.test(v)) problems.push('managed_agents.vault_ids must be vault ids from the Claude Console');
    if (m.agent_version !== undefined && m.agent_version < 1) problems.push('managed_agents.agent_version must be 1 or more');
    if (!Number.isInteger(m.max_cost_usd_cents) || m.max_cost_usd_cents < 1 || m.max_cost_usd_cents > 100_000) problems.push('managed_agents.max_cost_usd_cents must be set: the most one session may cost, in US cents (100 is one dollar)');
    if (m.daily_ceiling_usd_cents !== undefined && (m.daily_ceiling_usd_cents < (m.max_cost_usd_cents ?? 1))) problems.push('managed_agents.daily_ceiling_usd_cents must be at least one session\'s limit');
    const kickoff = m.kickoff ?? DEFAULT_KICKOFF;
    if (kickoff.length > 2000) problems.push('managed_agents.kickoff must be at most 2000 characters');
    const key = String(env.ANTHROPIC_API_KEY ?? '').trim();
    if (!key) problems.push('ANTHROPIC_API_KEY is not set: it is the Claude API key of the workspace your agent lives in');
    else if (/\s/.test(key)) problems.push('ANTHROPIC_API_KEY must not contain spaces or line breaks');
    out.managedAgents = {
      agent_id: m.agent_id, agent_version: m.agent_version ?? null, environment_id: m.environment_id, vault_ids: m.vault_ids ?? [],
      max_cost_usd_cents: m.max_cost_usd_cents, daily_ceiling_usd_cents: m.daily_ceiling_usd_cents ?? null, kickoff,
    };
    out.secrets.apiKey = key;
  }
  return problems.length ? { ok: false, problems } : { ok: true, config: out };
}

/** Every secret value in a loaded configuration. */
export function secretValues(config) {
  return [...config.secrets.wake, config.secrets.routineToken, config.secrets.apiKey, config.alertUrl].filter(Boolean);
}

/** A function that takes every secret out of a line, flattens it to one line and
 *  keeps it short, for anything about to be logged. */
export function redactor(config) {
  const values = secretValues(config);
  return (s) => {
    let t = String(s ?? '');
    for (const v of values) t = t.split(v).join('[redacted]');
    return t.replace(/\s+/g, ' ').slice(0, 300);
  };
}
