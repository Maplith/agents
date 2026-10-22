import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { NO_ACCOUNT, runSetup, setupSteps, shown, type Run } from '../setup.ts';
import { runMaplith } from '../maplith.ts';
import { unexpanded, version } from '../bridge.ts';

/** `maplith setup claude|codex`: Maplith in a person's own coding agent with
 *  one command, by running the agent's own commands in order (setup.ts). It
 *  writes no file and no key of its own. And `maplith`, the package's one
 *  command, which hands `bridge …` to the Bridge and `setup …` to setup. */

const MAPLITH = fileURLToPath(new URL('../maplith.ts', import.meta.url));

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l) }, out, err };
}

/** A fake agent: records each command and answers with the next code. */
function agent(codes: (number | null)[] = []) {
  const calls: string[] = [];
  const run: Run = async (c, a) => {
    calls.push(shown(c, a));
    return codes.length ? (codes.shift() as number | null) : 0;
  };
  return { run, calls };
}

const V = '9.9.9-rc.1';
const setup = (argv: string[], run: Run, platform = 'linux') => {
  const c = capture();
  return runSetup(argv, c.io, { prog: 'maplith', version: V, cwd: '/', platform, run }).then((code) => ({ code, ...c }));
};

describe('the commands it runs', () => {
  it('Claude Code: the marketplace, then the plugin, and how to sign in', async () => {
    const a = agent();
    const r = await setup(['claude'], a.run);
    expect(r.code).toBe(0);
    expect(a.calls).toEqual(['claude plugin marketplace add Maplith/agents', 'claude plugin install maplith@maplith']);
    expect(r.out.join('\n')).toContain('run /mcp, choose maplith and Authenticate');
    expect(r.out).toContain(NO_ACCOUNT);
  });

  it('Codex: the marketplace, the plugin, then the sign-in, which says a new person signs up there', async () => {
    const a = agent();
    const r = await setup(['codex'], a.run);
    expect(r.code).toBe(0);
    expect(a.calls).toEqual(['codex plugin marketplace add Maplith/agents', 'codex plugin add maplith@maplith', 'codex mcp login maplith']);
    const before = r.out.findIndex((l) => l.startsWith('> codex mcp login'));
    expect(r.out[before - 1]).toContain(NO_ACCOUNT);
  });

  it('Codex with --dir names the folder in a server of its own, pinned to this version; --no-login skips the sign-in', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-dir-'));
    const a = agent();
    expect((await setup(['codex', '--dir', dir, '--no-login'], a.run)).code).toBe(0);
    expect(a.calls).toEqual([
      'codex plugin marketplace add Maplith/agents',
      'codex plugin add maplith@maplith',
      `codex mcp add maplith-bridge --env EXPORT_DIR=${dir} -- npx -y maplith@${V} bridge stdio`,
    ]);
  });

  it('hands a folder with spaces or quotes to the agent as one argument, never through a shell', () => {
    const steps = setupSteps('codex', { version: V, dir: "/tmp/my data/it's", login: false });
    expect(steps[2][1]).toContain("EXPORT_DIR=/tmp/my data/it's");
    expect(shown(...steps[2])).toContain(`'EXPORT_DIR=/tmp/my data/it'\\''s'`);
  });

  it('never puts a key, a token or a header in what it runs', () => {
    for (const t of ['claude', 'codex'] as const) {
      expect(JSON.stringify(setupSteps(t, { version: V, dir: '/x', login: true }))).not.toMatch(/token|bearer|authorization|mlk_|--header/i);
    }
  });
});

describe('when something goes wrong', () => {
  it('stops at the first command that fails, and says which', async () => {
    const a = agent([0, 3]);
    const r = await setup(['codex'], a.run);
    expect(r.code).toBe(1);
    expect(a.calls).toHaveLength(2);
    expect(r.err.join('\n')).toContain('"codex plugin add maplith@maplith" failed (exit code 3)');
  });

  it('says to install the agent first when its command does not start', async () => {
    const r = await setup(['claude'], agent([null]).run);
    expect(r.code).toBe(1);
    expect(r.err.join('\n')).toContain('Claude Code was not found');
  });

  it('refuses an unknown agent, an unknown flag and a folder that does not exist, running nothing', async () => {
    for (const argv of [['cursor'], ['codex', '--force'], ['codex', '--dir'], ['codex', '--dir', '/no/such/folder/zz']]) {
      const a = agent();
      expect((await setup(argv, a.run)).code, argv.join(' ')).toBe(2);
      expect(a.calls).toEqual([]);
    }
  });

  it('tells a Claude Code user to name the folder with MAPLITH_BRIDGE_DIR instead of --dir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'setup-dir-'));
    const r = await setup(['claude', '--dir', dir], agent().run);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain(`MAPLITH_BRIDGE_DIR=${dir}`);
  });
});

describe('printing instead of running', () => {
  it('--print, and always on Windows, prints the commands and runs none', async () => {
    for (const [argv, platform] of [[['codex', '--print'], 'linux'], [['codex'], 'win32']] as const) {
      const a = agent();
      const r = await setup([...argv], a.run, platform);
      expect(r.code).toBe(0);
      expect(a.calls).toEqual([]);
      expect(r.out).toContain('codex plugin add maplith@maplith');
      expect(r.out).toContain(NO_ACCOUNT);
    }
  });
});

describe('maplith, the one command', () => {
  it('hands bridge to the Bridge and setup to setup, and knows its version', async () => {
    const c = capture();
    expect(await runMaplith(['--version'], {}, c.io)).toBe(0);
    expect(c.out).toEqual([version()]);
    const h = capture();
    expect(await runMaplith(['bridge', 'serve', '--help'], {}, h.io)).toBe(0);
    expect(h.out.join('\n')).toMatch(/serve --dir <folder>/);
    const s = capture();
    expect(await runMaplith(['setup', '--help'], {}, s.io)).toBe(0);
    expect(s.out.join('\n')).toContain('setup <claude|codex>');
    const u = capture();
    expect(await runMaplith(['serve'], {}, u.io)).toBe(2);
  });

  it('runs as a command, with help that names it', () => {
    const out = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', MAPLITH, 'setup', 'codex', '--print'], { encoding: 'utf8' });
    expect(out).toContain('codex mcp login maplith');
  });
});

describe('an EXPORT_DIR an agent did not expand', () => {
  it('reads as no folder, as Codex passes a plugin env', () => {
    for (const v of ['${MAPLITH_BRIDGE_DIR:-}', '${MAPLITH_BRIDGE_DIR}', ' ${X:-/tmp} ', '${X-}']) expect(unexpanded(v), v).toBe(true);
    for (const v of [undefined, '', '/srv/exports', './$HOME', 'data${X}', '${1BAD}', '$X']) expect(unexpanded(v), String(v)).toBe(false);
  });
});
