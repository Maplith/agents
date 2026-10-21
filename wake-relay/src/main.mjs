#!/usr/bin/env node
// Starts the wake relay: reads the settings (relay.config.json and the
// environment), builds the adapter you chose, and listens for wake-ups.
//
//   node src/main.mjs
//
// See README.md for the settings and what each does.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAlerter } from './alert.mjs';
import { createManagedAgentsAdapter } from './adapters/managed-agents.mjs';
import { createRoutineAdapter, API_BASE } from './adapters/claude-code-routine.mjs';
import { loadConfig, redactor } from './config.mjs';
import { createRelay } from './relay.mjs';
import { createWakeServer } from './server.mjs';
import { RelayState, HOUR_MS } from './state.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const log = (line) => console.log(`[wake-relay] ${line}`);
const configFile = process.env.RELAY_CONFIG || join(here, '..', 'relay.config.json');

const loaded = loadConfig({ file: configFile, env: process.env });
if (!loaded.ok) {
  console.error('[wake-relay] the relay cannot start:');
  for (const p of loaded.problems) console.error(`  - ${p}`);
  process.exit(1);
}
const config = loaded.config;
const redact = redactor(config);

const apiBase = config.apiBase ?? API_BASE;
const adapter = config.adapter === 'claude-code-routine'
  ? createRoutineAdapter({ routineId: config.routine.id, token: config.secrets.routineToken, apiBase })
  : createManagedAgentsAdapter({ cfg: config.managedAgents, name: config.name, apiKey: config.secrets.apiKey, timeZone: config.timeZone, apiBase });

const state = new RelayState({ file: config.stateFile, dedupeMs: config.dedupeHours * HOUR_MS, log });
const alerter = createAlerter({ url: config.alertUrl, log, redact, source: config.name });
const relay = createRelay({ adapter, state, alerter, maxFiresPerHour: config.maxFiresPerHour, paused: config.paused, log: (l) => log(redact(l)) });
const server = createWakeServer({ relay, secrets: config.secrets.wake, log: (l) => log(redact(l)), redact });

server.listen(config.port, () => {
  // One line about who makes it: a link, nothing asked and nothing sent.
  log('Maplith Wake is open source, made by Maplith: https://maplith.com/open-source?utm_source=wake-cli&utm_medium=cli&utm_campaign=oss-wake');
  log(`listening on ${config.port}; ${adapter.name}; at most ${config.maxFiresPerHour} starts an hour${config.paused ? '; PAUSED: wake-ups are answered and nothing is started' : ''}${config.stateFile ? '; state kept in a file' : '; state kept in memory'}`);
  // Signals that waited for a start when the relay last stopped.
  relay.resume().catch((e) => log(`restart: ${redact(e.message)}`));
});
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    relay.close();
    state.save();
    server.close(() => process.exit(0));
  });
}
