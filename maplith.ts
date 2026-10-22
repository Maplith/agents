import { basename } from 'node:path';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { helpText as bridgeHelp, runBridge, version, type Io } from './bridge.ts';

/** `maplith`: the one command of the npm package `maplith`.
 *
 *    maplith bridge <serve|stdio|extract|rotate-token> …   Maplith Bridge (bridge.ts)
 *    maplith setup <claude|codex> [--dir <folder>] …       Maplith in your agent (setup.ts)
 *
 *  `maplith-bridge` stays as the package's second command, an alias of
 *  `maplith bridge` (bridge.ts is its entry). setup.ts is loaded only by
 *  `setup`, so the Bridge's commands never load node:child_process. */

/** How the person started this command, for help they can run again. */
export function maplithProgram(entry: string = process.argv[1] ?? ''): string {
  const name = basename(entry);
  if (name === 'maplith' || name === 'maplith.cmd') return 'maplith';
  if (name === 'maplith.js') return 'node maplith.js';
  return 'node maplith.ts';
}

export function maplithHelp(): string {
  const p = maplithProgram();
  return `Maplith ${version()}: the map of your company's systems, for your AI agents.

Commands:
  setup claude        Set Maplith up in Claude Code: the plugin, with the
                      Maplith MCP server, Maplith Bridge and the maplith skill.
  setup codex         The same in OpenAI Codex, and sign in.
  bridge <command>    Maplith Bridge: share a folder of data files with your
                      agent, read-only (serve, stdio, extract postgres,
                      rotate-token).

Run "${p} setup --help" or "${p} bridge --help" for their options, and
"${p} --version" for the version.

Set-up guide: https://maplith.com/docs/own-agent`;
}

export async function runMaplith(argv: readonly string[], env: Record<string, string | undefined>, io: Io, cwd: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') {
    io.stdout(maplithHelp());
    return command === undefined ? 2 : 0;
  }
  if (command === '--version' || command === '-v') {
    io.stdout(version());
    return 0;
  }
  if (command === 'bridge') {
    if (rest.length === 0) {
      io.stdout(bridgeHelp());
      return 2;
    }
    const r = await runBridge(rest, env, io, cwd);
    // A started server keeps the process alive; its exit code is not ours to set.
    return r.server ? -1 : r.code;
  }
  if (command === 'setup') {
    const { runSetup } = await import('./setup.ts');
    return runSetup(rest, io, { prog: maplithProgram(), version: version(), cwd });
  }
  io.stderr(`Unknown command: ${command}. Run ${maplithProgram()} --help.`);
  return 2;
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) {
  runMaplith(process.argv.slice(2), process.env, { stdout: (l) => console.log(l), stderr: (l) => console.error(l) }).then((code) => {
    if (code >= 0) process.exitCode = code;
  });
}
