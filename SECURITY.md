# Security policy

The Bridge exists to share data read-only without handing over a password, so
a flaw in it matters. Thank you for reporting one.

## Reporting a vulnerability

Report it privately, in either of two ways:

- through GitHub: **Security → Report a vulnerability** on this repository;
- by email to **security@maplith.com**.

Please do not open a public issue, discussion or pull request for a
vulnerability before it is fixed.

Include what you can of:

- the Bridge version (`maplith-bridge --version`) and the Node.js version;
- what an attacker can do, and from where: the internet, the same network, the
  same machine, a file in the served folder, or the database;
- the steps or a proof of concept;
- whether and how you would like to be credited.

Never include data from a real system, or a real token, in a report.

## What happens next

- We acknowledge your report, aiming for the same working day.
- We confirm whether it is a vulnerability and tell you what we plan to do.
- We fix it, release a new version and publish a GitHub security advisory,
  crediting you if you wish.

We ask you to keep the details private until the fix is released, or for 90
days from your report, whichever comes first. If we need longer, we tell you
why and agree a date with you.

## Supported versions

| Version | Supported |
|---|---|
| 1.0.x (including its release candidates) | Yes |
| 0.x | No: upgrade to 1.0 |

Only the newest release of a supported line gets fixes. Upgrade to it before
you report, if you can.

## Scope

The Bridge's code (`bridge.ts`, `serve.ts`, `extract-postgres.ts`), its
release workflow and the dependencies pinned in its lockfile. For example:
reading a file outside the served folder, any write, getting past the token,
the rate limit, the allow-list or the binding rules, the database password
reaching a log or a file, or the extractor running under a role that can write.

[THREAT-MODEL.md](THREAT-MODEL.md) describes what the Bridge defends against,
and the tests behind each defence.

Maplith's hosted service is not part of this repository. Report a
vulnerability in it to the same address.
