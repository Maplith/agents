# Maplith for your coding agent

Maplith maps how your company's systems fit together: what each thing is,
where it lives, which records match across systems, the rules your documents
state, and the work that needs doing. This plugin gives Claude Code or Codex
that map, Maplith Bridge for a local folder of data files, and a skill that
tells the agent when and how to use them.

Maplith keeps the map, never your rows. Your agent reads the rows in your own
systems, with its own access, and asks Maplith before it changes anything.

No account? You create one in the browser window that opens when you sign in,
and come straight back. Your agent then builds your first map with you.

## One command

With Node.js 24 or newer:

```sh
npx --yes maplith@1.2.0-rc.1 setup claude
npx --yes maplith@1.2.0-rc.1 setup codex
```

It runs your agent's own commands, shown below, and writes no key anywhere.
Add `--print` to see them without running them.

## Claude Code

```text
/plugin marketplace add Maplith/agents
/plugin install maplith@maplith
```

Then run `/mcp`, choose **maplith** and **Authenticate**. Your browser opens
Maplith's sign-in and consent page; nothing is pasted. On the consent page you
choose what the connection may do: read only (the default), act with approval,
or act directly within the action policy your admin sets.

## OpenAI Codex

```sh
codex plugin marketplace add Maplith/agents
codex plugin add maplith@maplith
codex mcp login maplith
```

The last command opens Maplith's sign-in and consent page in your browser.
Codex does not pass your environment to a plugin's servers, so name the
Bridge's folder once with `npx --yes maplith@1.2.0-rc.1 setup codex --dir
<folder>`; without one the Bridge serves an empty folder.

## What the plugin adds

- the Maplith MCP server, `https://app.maplith.com/api/mcp`;
- Maplith Bridge as the `maplith-bridge` server: it shares one local folder of
  data files with your agent, read-only, over stdin and stdout. In Claude Code,
  name the folder with the `MAPLITH_BRIDGE_DIR` environment variable before
  you start it; in Codex, with `setup codex --dir`. It needs Node.js 24 or
  newer, and `npx` fetches the pinned version the first time it starts;
- the `maplith` skill: when to reach for the map, the order of calls, ask
  before acting, never rows, ask you when the map is unsure, and keep the map
  current as your agent works.

Wake-ups, which start your agent when there is work, run outside your agent
in your own account: see the `wake-relay` folder of this repository and
https://maplith.com/docs/wake-your-agent.

## Claude (claude.ai and Claude Desktop) and ChatGPT

Add Maplith as a custom connector with the address
`https://app.maplith.com/api/mcp` and sign in. In Claude, then add the skill:
download `dist/maplith-skill.zip` and upload it under **Settings →
Capabilities → Skills**.

## More

- Set-up guide: https://maplith.com/docs/own-agent
- Privacy: https://maplith.com/privacy
- Support: support@maplith.com
