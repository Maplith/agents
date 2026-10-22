import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSIONS } from '../serve.ts';
import { helpText, version } from '../bridge.ts';

/** `maplith-bridge stdio`: a folder served to the one agent that started the
 *  command, over its stdin and stdout, by the Bridge's own server on
 *  127.0.0.1 behind a token only the process holds (stdio.ts). Run as an
 *  agent runs it: a child process, spoken to over its stdin. */

const BRIDGE = fileURLToPath(new URL('../bridge.ts', import.meta.url));
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const TOKEN_SHAPE = /[0-9a-f]{64}/;

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: 'local-agent', version: '1' } },
});

function start(args: string[], env: Record<string, string> = {}) {
  const temp = tmp('bridge-stdio-cmd-');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BRIDGE, 'stdio', ...args], {
    env: { PATH: process.env.PATH ?? '', TMPDIR: temp, ...env },
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.setEncoding('utf8').on('data', (t: string) => (out.stdout += t));
  child.stderr.setEncoding('utf8').on('data', (t: string) => (out.stderr += t));
  const closed = new Promise<number | null>((ok) => child.on('close', (code) => ok(code)));
  const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const replies = (): any[] => out.stdout.split('\n').filter((l) => l !== '').map((l) => JSON.parse(l));
  const until = (check: () => boolean, what: string) =>
    new Promise<void>((ok, no) => {
      const timer = setTimeout(() => no(new Error(`timed out waiting for ${what}; stderr: ${out.stderr}`)), 15_000);
      const tick = () => {
        if (!check()) return;
        clearTimeout(timer);
        ok();
      };
      child.stdout.on('data', tick);
      child.on('close', () => {
        tick();
        clearTimeout(timer);
        no(new Error(`exited before ${what}; stderr: ${out.stderr}`));
      });
      tick();
    });
  return { child, temp, out, closed, send, replies, until };
}

describe('maplith-bridge stdio', () => {
  it('serves the folder it is given to the agent over stdin and stdout, and leaves the folder as it was', async () => {
    const dir = tmp('bridge-stdio-data-');
    writeFileSync(join(dir, 'orders.csv'), 'id,total\n1,10\n');
    const run = start(['--dir', dir]);
    run.send(initialize(1));
    run.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    run.send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    run.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'read_file', arguments: { uri: 'exports://exports/orders.csv' } } });
    await run.until(() => run.replies().length === 3, 'three replies');
    run.child.stdin.end();
    expect(await run.closed).toBe(0);
    const [init, resources, read] = run.replies();
    expect(init.result.serverInfo).toEqual({ name: 'maplith-bridge', version: version() });
    expect(resources.result.resources.map((r: { uri: string }) => r.uri)).toEqual(['exports://exports/orders.csv']);
    expect(JSON.stringify(read.result)).toContain('1,10');
    // Logs on stderr only, and the folder a person named is never removed.
    expect(run.out.stderr).toContain(`serving ${realpathSync(dir)}`);
    expect(run.out.stderr).toContain('stdin ended: stopping the server.');
    expect(readdirSync(dir)).toEqual(['orders.csv']);
    expect(run.out.stdout + run.out.stderr).not.toMatch(TOKEN_SHAPE);
  }, 30_000);

  it('takes the folder from EXPORT_DIR, and an empty EXPORT_DIR names none', async () => {
    const dir = tmp('bridge-stdio-env-');
    writeFileSync(join(dir, 'a.csv'), 'x\n1\n');
    const named = start([], { EXPORT_DIR: dir });
    named.send({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    await named.until(() => named.replies().length === 1, 'the list');
    named.child.stdin.end();
    expect(await named.closed).toBe(0);
    expect(named.replies()[0].result.resources.map((r: { uri: string }) => r.uri)).toEqual(['exports://exports/a.csv']);

    const empty = start([], { EXPORT_DIR: '' });
    empty.send({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    await empty.until(() => empty.replies().length === 1, 'the list');
    // While it runs: one empty folder of its own.
    expect(readdirSync(empty.temp)).toHaveLength(1);
    empty.child.stdin.end();
    expect(await empty.closed).toBe(0);
    expect(empty.replies()[0].result).toEqual({ resources: [] });
    expect(empty.out.stderr).toContain('no folder named');
    expect(empty.out.stderr).toContain('give --dir <folder> or set EXPORT_DIR');
    expect(readdirSync(empty.temp)).toEqual([]);
  }, 30_000);

  it('refuses a folder that is not there with a usage error on stderr, and nothing on stdout', async () => {
    const run = start(['--dir', join(tmpdir(), 'no-such-folder-for-bridge-stdio')]);
    expect(await run.closed).toBe(2);
    expect(run.out.stdout).toBe('');
    expect(run.out.stderr).toContain('does not exist');
    const bad = start(['--token-file', 'x']);
    expect(await bad.closed).toBe(2);
    expect(bad.out.stdout).toBe('');
    expect(bad.out.stderr).toContain('Unknown argument: --token-file');
  }, 30_000);

  it('is in the help, with what it does and does not do', () => {
    expect(helpText()).toContain('stdio               Serve a folder to the agent that started this command');
    const help = helpText('stdio');
    expect(help).toContain('stdin and stdout');
    expect(help).toContain('127.0.0.1');
    expect(help).toContain('no token file, nothing to type, nothing printed');
    expect(help).toContain('use serve');
  });
});
