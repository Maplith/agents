# Security policy

The relay holds the token that starts your Claude agent, so a flaw in it
matters. Thank you for reporting one.

## Reporting a vulnerability

Report it privately, in either of two ways:

- through GitHub: **Security → Report a vulnerability** on this repository;
- by email to **security@maplith.com**.

Please do not open a public issue, discussion or pull request for a
vulnerability before it is fixed.

Include what you can of:

- the version (`version` in `package.json`) and the Node.js version;
- what an attacker can do, and from where: the internet, the same network, or a
  wake-up with a valid signature;
- the steps or a proof of concept;
- whether and how you would like to be credited.

Never include a real token, key or signing secret in a report.

## What happens next

- We acknowledge your report, aiming for the same working day.
- We confirm whether it is a vulnerability and tell you what we plan to do.
- We fix it, release a new version and publish a GitHub security advisory,
  crediting you if you wish.

We ask you to keep the details private until the fix is released, or for 90
days from your report, whichever comes first.

## What the relay promises

- It acts only on a request whose signature verifies, checked over the bytes
  received, with a secret you hold, within five minutes.
- It sends the routine's token to `api.anthropic.com` and nowhere else, never
  follows a redirect, and never prints or stores it.
- What it passes to your agent is signal ids, one per line, and a count. Text
  in a wake-up cannot reach your agent: an id that is not a UUID refuses the
  whole wake-up.
- It stores only ids and times, and only if you give it a state file.
- It has no dependencies, so there is nothing else to patch.

The relay does not decide what your agent may do. That is set by your agent's
instructions, the connectors it holds and the rights of the accounts behind them
(see `routine/SETUP.md`).
