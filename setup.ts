import { spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { resolve } from 'node:path';

/** `maplith setup claude|codex`: one command that sets Maplith up in a
 *  person's own coding agent.
 *
 *  It writes no configuration file itself and holds no key. It runs the
 *  agent's own commands, one after the other, so what lands in the agent's
 *  configuration is exactly what those commands write:
 *
 *    claude  claude plugin marketplace add Maplith/agents
 *            claude plugin install maplith@maplith
 *    codex   codex plugin marketplace add Maplith/agents
 *            codex plugin add maplith@maplith
 *            codex mcp add maplith-bridge --env EXPORT_DIR=<folder> -- npx -y maplith@<this version> bridge stdio
 *                                         (only with --dir)
 *            codex mcp login maplith      (unless --no-login)
 *
 *  The plugin brings the Maplith MCP server (HTTP, signed in with OAuth:
 *  nothing is pasted), Maplith Bridge over stdio, and the `maplith` skill,
 *  all from the one plugin in Maplith/agents. Each command can run again: an
 *  existing marketplace or plugin is left as it is.
 *
 *  Loaded only by the setup command, so `bridge serve` and `bridge stdio`
 *  never load node:child_process. */

export interface SetupIo {
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

/** Runs one command with the person's terminal attached, and gives its exit
 *  code; a command that cannot start at all gives null. */
export type Run = (command: string, args: readonly string[]) => Promise<number | null>;

export const MARKETPLACE = 'Maplith/agents';
export const PLUGIN = 'maplith@maplith';
export const SERVER = 'maplith';
export const NO_ACCOUNT = 'No account? You create one in the browser window that opens, and come straight back.';

class SetupUsage extends Error {}

export function setupHelp(prog: string): string {
  return `Usage: ${prog} setup <claude|codex> [options]

Sets Maplith up in your coding agent with the agent's own commands: the
Maplith plugin from ${MARKETPLACE}, which brings the Maplith MCP server
(you sign in in your browser; nothing is pasted, no key is written),
Maplith Bridge for a local folder of data files, and the maplith skill.
Running it again changes nothing that is already set up.

  claude    Claude Code. Then run /mcp in Claude Code, choose maplith and
            Authenticate.
  codex     OpenAI Codex. It signs you in at the end.

Options:
  --dir <folder>   Codex: the folder Maplith Bridge shares with Codex,
                   read-only. Claude Code reads it from MAPLITH_BRIDGE_DIR.
  --no-login       Codex: skip the sign-in; run "codex mcp login ${SERVER}" later.
  --print          Print the commands instead of running them.

${NO_ACCOUNT}`;
}

/** The commands for one agent, in order. */
export function setupSteps(target: 'claude' | 'codex', opts: { version: string; dir?: string; login: boolean }): [string, string[]][] {
  if (target === 'claude') {
    return [
      ['claude', ['plugin', 'marketplace', 'add', MARKETPLACE]],
      ['claude', ['plugin', 'install', PLUGIN]],
    ];
  }
  const steps: [string, string[]][] = [
    ['codex', ['plugin', 'marketplace', 'add', MARKETPLACE]],
    ['codex', ['plugin', 'add', PLUGIN]],
  ];
  // Codex starts a plugin's servers with a filtered environment and does not
  // expand ${…} in a plugin's env, so the plugin's Bridge cannot see
  // MAPLITH_BRIDGE_DIR there. A server of the same name in the person's own
  // configuration takes its place, with the folder written out.
  if (opts.dir !== undefined) {
    steps.push(['codex', ['mcp', 'add', 'maplith-bridge', '--env', `EXPORT_DIR=${opts.dir}`, '--', 'npx', '-y', `maplith@${opts.version}`, 'bridge', 'stdio']]);
  }
  if (opts.login) steps.push(['codex', ['mcp', 'login', SERVER]]);
  return steps;
}

/** A command as a person would type it. */
export function shown(command: string, args: readonly string[]): string {
  return [command, ...args.map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`))].join(' ');
}

const realRun: Run = (command, args) =>
  new Promise((done) => {
    // No shell: every argument reaches the agent's command as it is.
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });

export async function runSetup(
  argv: readonly string[],
  io: SetupIo,
  opts: { prog: string; version: string; cwd?: string; platform?: string; run?: Run },
): Promise<number> {
  const [target, ...rest] = argv;
  try {
    if (target === undefined || target === '--help' || target === '-h') {
      io.stdout(setupHelp(opts.prog));
      return target === undefined ? 2 : 0;
    }
    if (target !== 'claude' && target !== 'codex') throw new SetupUsage(`Unknown agent: ${target}. Run ${opts.prog} setup claude or ${opts.prog} setup codex.`);
    let dir: string | undefined;
    let login = true;
    let print = false;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--help' || a === '-h') return (io.stdout(setupHelp(opts.prog)), 0);
      if (a === '--print') print = true;
      else if (a === '--no-login') login = false;
      else if (a === '--dir') {
        const v = rest[++i];
        if (v === undefined || v.startsWith('--')) throw new SetupUsage('--dir needs a folder');
        dir = resolve(opts.cwd ?? process.cwd(), v);
      } else throw new SetupUsage(`Unknown argument: ${a}`);
    }
    if (dir !== undefined) {
      let isDir = false;
      try {
        isDir = statSync(dir).isDirectory();
      } catch {
        isDir = false;
      }
      if (!isDir) throw new SetupUsage(`The folder ${dir} does not exist.`);
      if (target === 'claude') {
        throw new SetupUsage(`Claude Code reads the folder from MAPLITH_BRIDGE_DIR: set MAPLITH_BRIDGE_DIR=${dir} before you start Claude Code, and run ${opts.prog} setup claude without --dir.`);
      }
    }
    const steps = setupSteps(target, { version: opts.version, dir, login });
    // On Windows the agents' commands are .cmd files, which Node.js starts
    // only through a shell; the commands are printed to run instead.
    if (print || (opts.platform ?? process.platform) === 'win32') {
      if (!print) io.stdout('Run these commands, one after the other:');
      for (const [c, a] of steps) io.stdout(shown(c, a));
      if (target === 'claude') io.stdout('Then start Claude Code, run /mcp, choose maplith and Authenticate.');
      if (target === 'codex' && !login) io.stdout(`Then sign in: codex mcp login ${SERVER}`);
      io.stdout(NO_ACCOUNT);
      return 0;
    }
    const run = opts.run ?? realRun;
    const name = target === 'claude' ? 'Claude Code' : 'Codex';
    for (const [c, a] of steps) {
      if (c === 'codex' && a[0] === 'mcp' && a[1] === 'login') {
        io.stdout(`Signing you in to Maplith: your browser opens. ${NO_ACCOUNT}`);
      }
      io.stdout(`> ${shown(c, a)}`);
      const code = await run(c, a);
      if (code === null) {
        io.stderr(`${name} was not found: "${c}" did not start. Install ${name} first, then run ${opts.prog} setup ${target} again.`);
        return 1;
      }
      if (code !== 0) {
        io.stderr(`"${shown(c, a)}" failed (exit code ${code}). Nothing after it ran; fix it and run ${opts.prog} setup ${target} again.`);
        return 1;
      }
    }
    if (target === 'claude') {
      io.stdout('Maplith is set up in Claude Code. Start Claude Code, run /mcp, choose maplith and Authenticate: your browser opens Maplith.');
      io.stdout(NO_ACCOUNT);
    } else {
      io.stdout(login ? 'Maplith is set up in Codex.' : `Maplith is set up in Codex. Sign in when you are ready: codex mcp login ${SERVER}`);
    }
    io.stdout('Then ask your agent to build your first map: https://maplith.com/docs/own-agent');
    return 0;
  } catch (err) {
    io.stderr(err instanceof Error ? err.message : String(err));
    return err instanceof SetupUsage ? 2 : 1;
  }
}
