# Maplith for Claude

Maplith maps how your company's systems fit together: what each thing is,
where it lives, which records match across systems, the rules your documents
state, and the work that needs doing. This plugin gives Claude Code that map,
Maplith Bridge for a local folder of data files, and a skill that tells Claude
when and how to use them.

Maplith keeps the map, never your rows. Claude reads the rows in your own
systems, with its own access, and asks Maplith before it changes anything.

## Claude Code

```text
/plugin marketplace add Maplith/agents
/plugin install maplith@maplith
```

Then run `/mcp`, choose **maplith** and **Authenticate**. Your browser opens
Maplith's sign-in and consent page; nothing is pasted. On the consent page you
choose what the connection may do: read only (the default), act with approval,
or act directly within the action policy your admin sets.

The plugin adds:

- the Maplith MCP server, `https://app.maplith.com/api/mcp`;
- Maplith Bridge as the `maplith-bridge` server: it shares one local folder of
  data files with Claude, read-only, over stdin and stdout. Name the folder
  with the `MAPLITH_BRIDGE_DIR` environment variable before you start Claude
  Code; without one it serves an empty folder. It needs Node.js 24 or newer,
  and `npx` fetches the pinned version the first time it starts;
- the `maplith` skill: when to reach for the map, the order of calls, ask
  before acting, never rows, ask you when the map is unsure, and keep the map
  current as Claude works.

Wake-ups, which start your agent when there is work, run outside Claude in
your own account: see the `wake-relay` folder of this repository and
https://maplith.com/docs/wake-your-agent.

## Claude (claude.ai and Claude Desktop)

Add Maplith as a custom connector with the address
`https://app.maplith.com/api/mcp` and sign in. Then add the skill: download
`dist/maplith-skill.zip` and upload it under **Settings → Capabilities →
Skills**.

## More

- Set-up guide: https://maplith.com/docs/own-agent
- Privacy: https://maplith.com/privacy
- Support: support@maplith.com
