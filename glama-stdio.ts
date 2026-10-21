import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { log, relayStdio } from './stdio.ts';
import { version } from './bridge.ts';

export { sseReader } from './stdio.ts';

/** Maplith Bridge over stdio, for MCP directories that inspect a server:
 *
 *    node glama-stdio.ts
 *
 *  A directory such as Glama builds the repository in a sandbox and talks to
 *  the server over stdio (through mcp-proxy), with no folder and no token to
 *  give it. This entry gives a directory what it needs to see the Bridge as
 *  it is (its initialize reply, its instructions, its two tools and its
 *  resources) and nothing else: it creates an empty folder of its own, so
 *  there is no data to share, and relays MCP over stdin and stdout to the
 *  Bridge's own server (stdio.ts: a token only this process holds, 127.0.0.1
 *  only, logs on stderr). When stdin ends, or on a signal, it stops the
 *  server and removes the folder.
 *
 *  It is not a way to share files: it serves nothing but an empty folder, and
 *  takes no argument. To share a folder, run `bridge.ts serve`, or
 *  `bridge.ts stdio --dir <folder>` for an agent on this machine. */

async function main(): Promise<void> {
  if (process.argv.length > 2) {
    log('takes no argument. It serves an empty folder over stdio, for MCP directories that inspect a server. To share a folder, run: node bridge.ts serve --dir <folder>');
    process.exitCode = 2;
    return;
  }
  const v = version();
  await relayStdio({
    root: mkdtempSync(join(tmpdir(), 'maplith-bridge-stdio-')),
    name: 'exports',
    version: v,
    temporary: true,
    started: (url) => `Maplith Bridge ${v}: an empty folder, served at ${url} (this machine only), relayed over stdin and stdout. It shares no data.`,
  });
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) void main();
