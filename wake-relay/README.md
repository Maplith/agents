# Maplith Wake

[![Built by Maplith](https://img.shields.io/badge/built%20by-Maplith-1f2937)](https://maplith.com/open-source?utm_source=github&utm_medium=profile&utm_campaign=oss-wake)

Maplith Wake is a small relay you run in your own account. When something happens that your
Claude agent should handle, Maplith sends a signed wake-up to the relay, and the
relay starts your agent with **your own credential**. Maplith never holds,
brokers or routes it.

```
Maplith ──signed wake-up──▶ your relay ──start──▶ your Claude Code routine
 (signal ids only)           (checks, remembers,     or your Managed Agents agent
                              keeps under the limit)
```

The wake-up names signal ids and nothing else. Your agent then asks Maplith
for the rest with its own key, so it sees exactly what that key may see.

The relay has no dependencies and needs Node.js 24 or newer. It is short
enough to read before you run it.

## Two ways to start your agent

| Adapter | Starts | Uses | Good for |
|---|---|---|---|
| `claude-code-routine` | a run of a Claude Code routine, through its API trigger | the routine's own token, and your Claude seat's usage | Team, Enterprise and Max seats |
| `managed-agents` | a Managed Agents session | your Claude API key, with a cost limit for each session and, if you set one, a daily limit | work billed to API credits |

The routine adapter comes with a template: the prompt to save in the routine,
its schedule, the connectors it needs and a setup guide, in [routine/](routine/).

How each is started is in Anthropic's documentation:
[Trigger a routine through the API](https://platform.claude.com/docs/en/api/claude-code/routines-fire),
[Automate work with routines](https://code.claude.com/docs/en/routines) and
[Start a session](https://platform.claude.com/docs/en/managed-agents/sessions).

## Run it

**One click on Render.**
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/Maplith/agents)
asks for the settings it needs, and puts the relay in your Render account.
[render.yaml](render.yaml) says what it creates. Keep it on a paid instance: a
free one sleeps when idle.

**Anywhere with Docker.** `docker build -t wake-relay .`, then run it with the
settings below as environment variables and port 8080 open to the internet over
HTTPS (Maplith calls `https` on port 443 only).

**Anywhere with Node.js 24.** `node src/main.mjs`.

**No server at all.** [recipes/n8n-and-make.md](recipes/n8n-and-make.md) does the
same in n8n or Make, with the signature check as a code step.

Then follow [routine/SETUP.md](routine/SETUP.md) to connect it to Maplith and your
agent.

## Settings

The relay reads `relay.config.json` and its environment. Secrets live only in
the environment. Every other setting can be written in the file or set as an
environment variable named `RELAY_` followed by its path in capitals
(`max_fires_per_hour` is `RELAY_MAX_FIRES_PER_HOUR`, `routine.fire_url` is
`RELAY_ROUTINE_FIRE_URL`); the environment wins. A misspelt or wrong setting stops
the relay at start-up, with every problem listed.

| Secret (environment only) | |
|---|---|
| `MAPLITH_WAKE_SECRET` | The wake-up's signing secret, shown once when you make the wake-up in Maplith. Two, separated by a comma, while a replaced secret is still signing. |
| `ROUTINE_TOKEN` | The routine's API token (adapter `claude-code-routine`). It is sent to `api.anthropic.com` and nowhere else. |
| `ANTHROPIC_API_KEY` | Your Claude API key (adapter `managed-agents`). |
| `ALERT_WEBHOOK_URL` | Optional. An https address that takes a JSON POST: `{"text": "…", "event": "…"}`. Slack incoming webhooks, n8n, Make and Zapier all do. |
| `PORT` | The port to listen on. Default 8080. 0 lets the system pick a free one, which the start line names; for local runs, since the container's health check needs a fixed port. |

| Setting | Default | |
|---|---|---|
| `adapter` | | `claude-code-routine` or `managed-agents` |
| `name` | `wake-relay` | Names this relay. A Managed Agents session carries it, and the daily limit counts only the sessions that do. |
| `paused` | `false` | Answer every wake-up and start nothing. |
| `max_fires_per_hour` | `30` | The most starts in an hour. For a routine 30 is the most the service allows. |
| `dedupe_hours` | `24` | How long a delivery and a signal episode are remembered. |
| `state_file` | none | A file that keeps what the relay remembers across a restart. Give it a place the relay may write. |
| `timezone` | `UTC` | The time zone the daily limit counts days in, for example `Europe/Berlin`. |
| `routine.fire_url` | | The address the routine's API trigger shows. |
| `managed_agents.agent_id` | | The agent's id from the Claude Console. |
| `managed_agents.agent_version` | latest | Pin the agent's version. |
| `managed_agents.environment_id` | | The environment's id. |
| `managed_agents.vault_ids` | none | Vaults that hold the agent's credentials for Maplith and your other systems. Comma separated in the environment. |
| `managed_agents.max_cost_usd_cents` | | The most one session may cost, in US cents (`100` is one dollar). No default: you set it. |
| `managed_agents.daily_ceiling_usd_cents` | none | The most this relay's sessions may cost in a day. |
| `managed_agents.kickoff` | a short default | The first words of the session, before the signal ids. |

## What it does with a wake-up

For each `POST /wake`, in order:

1. The body is at most 64 KB.
2. The `X-Maplith-Signature` verifies, over the bytes received, with a secret you
   hold, within five minutes. Otherwise `401`.
3. The wake-up has the shape Maplith sends and its `delivery_id` is the
   `X-Maplith-Delivery` header. Otherwise `400`.
4. A `test`, a type it does not know and a paused relay are answered `200`
   and start nothing.
5. **A delivery answered before, or a signal episode already started for,
   starts nothing.** Maplith sends a wake-up again when it hears no answer, and
   the routine's start endpoint has no idempotency key of its own, so the relay
   does the de-duplicating. A new episode of the same signal is new work.
6. **At most `max_fires_per_hour` starts an hour.** A signal that would pass the
   limit waits in a queue and goes out in the next start, which can carry up to
   50 ids; a timer makes sure it does even if no further wake-up comes.
7. The start is made with the signal ids as its text: one id per line, and a last
   line `more: <n>` when there are signals the wake-up did not name. Nothing
   else is ever passed on.

What Maplith is told: `202` for a start, `200` for nothing to start or work that
waits, `503` when Anthropic had a server error or did not answer (Maplith sends
the wake-up again, over several hours), `502` when Anthropic refused in a way a
person must fix, such as a replaced token.

**When the routine cannot be started** because its token was replaced (`401`), the
routine is gone (`404`, `410`), the account may not use it (`403`) or it is paused
(`400`), the relay says so once an hour to `ALERT_WEBHOOK_URL`, in words, with
what to do. Three failed starts in a row (a server error or no answer) alert
too. An alert never holds a token, a key or anything from a wake-up.

**Limits that stay.** A start whose answer was lost on the way may be repeated
by Maplith and start a second run; your agent takes a signal on a lease, so the
second run finds it taken. Without a `state_file` a restart forgets what it
remembered and what waited: the signals are still open in Maplith, and the
routine's hourly run finds them.

Nothing is logged but a delivery id, the decision and the status: never a body,
a header, a secret or a signal id.

## The routine template

[routine/PROMPT.md](routine/PROMPT.md) is the whole prompt to save in the routine:
it treats the start's text as signal ids and nothing else, takes each signal,
reads the conversation in your helpdesk, leaves an internal note or a draft
reply, never sends, records what it did, and then sweeps for any signal it was
not given. [routine/SETUP.md](routine/SETUP.md) walks through the connectors, the
hourly schedule that is the safety net, the API trigger, the wake-up and a test.

## Develop

```sh
npm test      # node --test, no dependencies, nothing leaves your machine
```

The tests run the relay against fake services on local ports. Anthropic's address
can be replaced only by `http://127.0.0.1:<port>` in `ANTHROPIC_API_BASE`.

## Licence and reporting

Apache 2.0, see [LICENSE](LICENSE). To report a vulnerability, see
[SECURITY.md](SECURITY.md).
