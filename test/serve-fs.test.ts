import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** The resources server under a folder that changes while it is read.
 *  node:fs is wrapped so the test can place a change exactly where a real
 *  one would land: between the size a file had and the bytes read from it,
 *  and between the walk seeing a folder and reading it. */
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return {
    ...fs,
    // A file that grew after its size was taken: the size reported is the
    // one before, the bytes on disk are the ones after.
    statSync: ((p: string, ...rest: unknown[]) => {
      const st = (fs.statSync as (...a: unknown[]) => import('node:fs').Stats)(p, ...rest);
      if (String(p).endsWith('grows.csv')) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 10 });
      // The file checked is not the file opened. moved.csv was
      // replaced by another file after the check (another inode); pipe.csv
      // was a file at the check and is a FIFO at the open.
      if (String(p).endsWith('moved.csv')) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino: st.ino + 1 });
      if (String(p).endsWith('pipe.csv')) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { isFile: () => true });
      return st;
    }) as typeof fs.statSync,
    // swap.csv was a regular file when realpath checked it, and is a link by
    // the time it is opened: realpath reports it as it was.
    realpathSync: ((p: string, ...rest: unknown[]) => {
      if (String(p).endsWith('swap.csv')) return String(p);
      return (fs.realpathSync as (...a: unknown[]) => string)(p, ...rest);
    }) as typeof fs.realpathSync,
    // A folder removed after the walk listed it.
    readdirSync: ((p: string, ...rest: unknown[]) => {
      if (String(p).endsWith('/gone')) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      return (fs.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    }) as typeof fs.readdirSync,
  };
});

const { MAX_REPLY, handle, listFiles } = await import('../serve.ts');
const { execFileSync } = await import('node:child_process');
const { symlinkSync } = await import('node:fs');

const read = (root: string, uri: string) =>
  handle({ root, name: 'x' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri } })) as {
    result?: { contents: { text: string }[] };
    error?: { code: number; message: string };
  };

describe('the resources server reads what it measures', () => {
  it('judges a read on the bytes it read, not on the size the file had before', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ls-grow-')), 'root');
    mkdirSync(join(root, 'bi'), { recursive: true });
    writeFileSync(join(root, 'bi', 'grows.csv'), 'a'.repeat(MAX_REPLY + 1));
    expect(read(root, 'x://bi/grows.csv').error?.message).toBe('Resource too large');
    writeFileSync(join(root, 'bi', 'small.csv'), 'a\n1\n');
    expect(read(root, 'x://bi/small.csv').result?.contents[0].text).toBe('a\n1\n');
  });

  it('leaves out a folder removed while it is walked, rather than failing the list', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ls-gone-dir-')), 'root');
    mkdirSync(join(root, 'bi'), { recursive: true });
    mkdirSync(join(root, 'gone'), { recursive: true });
    writeFileSync(join(root, 'bi', 'a.csv'), 'a\n1\n');
    expect(listFiles(root)).toEqual(['bi/a.csv']);
  });
});

describe('the resources server reads only the file it checked', () => {
  const tool = (root: string, uri: string) =>
    handle({ root, name: 'x' }, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: { uri } } })) as {
      result: { isError?: boolean; content: { text?: string }[] };
    };

  it('refuses a file swapped for a link between the check and the open (O_NOFOLLOW)', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ls-swap-')), 'root');
    mkdirSync(join(root, 'bi'), { recursive: true });
    writeFileSync(join(root, 'bi', 'real.csv'), 'a\n1\n');
    symlinkSync(join(root, 'bi', 'real.csv'), join(root, 'bi', 'swap.csv'));
    expect(read(root, 'x://bi/swap.csv').error?.message).toBe('Resource not found');
    expect(tool(root, 'x://bi/swap.csv').result).toEqual({ content: [{ type: 'text', text: 'Resource not found' }], isError: true });
    expect(read(root, 'x://bi/real.csv').result?.contents[0].text).toBe('a\n1\n');
  });

  it('refuses a file replaced by another one between the check and the open (device and inode)', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ls-moved-')), 'root');
    mkdirSync(join(root, 'bi'), { recursive: true });
    writeFileSync(join(root, 'bi', 'moved.csv'), 'a\n1\n');
    expect(read(root, 'x://bi/moved.csv').error?.message).toBe('Resource not found');
  });

  it('refuses a FIFO swapped in, without waiting on it', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'ls-fifo-')), 'root');
    mkdirSync(join(root, 'bi'), { recursive: true });
    execFileSync('mkfifo', [join(root, 'bi', 'pipe.csv')]);
    // A blocking open would hang this test until its timeout.
    expect(read(root, 'x://bi/pipe.csv').error?.message).toBe('Resource not found');
    expect(listFiles(root)).toEqual([]);
  });
});
