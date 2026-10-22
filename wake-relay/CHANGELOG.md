# Changelog

## Unreleased

- When the relay starts it logs one more line: that it is open source, made by
  Maplith, with a link to the page about it. Nothing is asked and nothing is
  sent.
- The package's homepage is maplith.com/open-source.
- `PORT=0` lets the system pick a free port, and the start line names the port
  the relay listens on.

## 1.0.0

First release, as Maplith Wake.

- Two adapters: start a Claude Code routine through its API trigger, or create a
  Managed Agents session.
- Checks the wake-up signature over the received bytes, with one or two secrets.
- Remembers deliveries and signal episodes, so a wake-up sent again starts nothing.
- Keeps under 30 starts an hour for a routine; what would pass the limit waits
  and goes out in the next start, with up to 50 ids in one.
- Alerts a webhook of yours when the routine's token stops working.
- A daily spending limit for Managed Agents sessions, counting only the sessions
  this relay started.
- A routine template: the saved prompt, the schedule and the setup guide.
- A recipe for n8n and Make, with the signature check as a code step.
