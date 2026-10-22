import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

/** Builds the release of Maplith Bridge:
 *
 *    node scripts/build.ts [--out <folder>]      (default: dist)
 *
 *  writes maplith-<version>.tgz and maplith-<version>.tgz.sha256.
 *  The tarball is the npm package itself (every entry under package/), so the
 *  file published to npm and the file attached to the GitHub Release are the
 *  same bytes, with the same checksum.
 *
 *  What is in it:
 *   - maplith.js, bridge.js, serve.js, stdio.js, extract-postgres.js and
 *     setup.js: the TypeScript sources
 *     with their types replaced by spaces (Node.js's own stripTypeScriptTypes,
 *     which keeps every line and column where it was), and `./x.ts` imports
 *     pointing at `./x.js`. Node.js does not strip types inside node_modules,
 *     so an installed package must be JavaScript. Nothing else changes: the
 *     comments and the code read as in the repository;
 *   - package.json without its scripts: the published package runs no script,
 *     at install or ever;
 *   - npm-shrinkwrap.json: the lockfile, so npm installs exactly the
 *     PostgreSQL client and the packages it needs, each checked by its hash;
 *   - the documents a person needs beside the code (DOCS).
 *
 *  It is reproducible: the same sources, built with the same Node.js version,
 *  give the same bytes. The tar is written here (ustar, sorted, owner 0, fixed
 *  modes) with one timestamp, SOURCE_DATE_EPOCH or the last commit's time,
 *  and gzip's header carries no time and the same operating system on every
 *  platform. To reproduce a release:
 *
 *    SOURCE_DATE_EPOCH=$(git log -1 --format=%ct v<version>) node scripts/build.ts
 *
 *  with the Node.js version the release notes name. */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The sources, in the repository root, and their names in the package. */
export const SOURCES = ['maplith.ts', 'bridge.ts', 'serve.ts', 'stdio.ts', 'extract-postgres.ts', 'setup.ts'] as const;
/** The documents in the package, beside the code. */
export const DOCS = ['CHANGELOG.md', 'INSTALL-WITH-YOUR-AGENT.md', 'LICENSE', 'README.md', 'RUNBOOK.md', 'SECURITY.md', 'THREAT-MODEL.md', 'TRADEMARK.md'] as const;
/** The commands npm links, and their files, which need a shebang and the
 *  execute bit: `maplith`, and `maplith-bridge`, kept as an alias of
 *  `maplith bridge`. */
export const BINS: Readonly<Record<string, string>> = { maplith: 'maplith.js', 'maplith-bridge': 'bridge.js' };
const BIN_FILES = new Set(Object.values(BINS));

/** Semantic versioning: 1.0.0, or a pre-release such as 1.0.0-rc.1. */
export const VERSION = /^\d+\.\d+\.\d+(?:-(?:alpha|beta|rc)\.\d+)?$/;

interface Manifest {
  name: string;
  version: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  [key: string]: unknown;
}

export function manifest(root = ROOT): Manifest {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Manifest;
  if (typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) throw new Error('package.json needs a version like 1.0.0 or 1.0.0-rc.1');
  return pkg;
}

/** The time every entry carries: SOURCE_DATE_EPOCH, else the last commit of
 *  the repository `root` is the top of, else 0. */
export function sourceDate(root = ROOT, env: Record<string, string | undefined> = process.env): number {
  if (env.SOURCE_DATE_EPOCH !== undefined) {
    if (!/^\d+$/.test(env.SOURCE_DATE_EPOCH)) throw new Error('SOURCE_DATE_EPOCH must be whole seconds');
    return Number(env.SOURCE_DATE_EPOCH);
  }
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8' }).trim();
    if (realpathSync(top) !== realpathSync(root)) return 0;
    const out = execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim();
    return /^\d+$/.test(out) ? Number(out) : 0;
  } catch {
    return 0;
  }
}

/** One source as the package carries it: types stripped, imports of the
 *  sources beside it pointed at their .js names. */
export function toJavaScript(source: string, bin = false): string {
  let js = stripTypeScriptTypes(source, { mode: 'strip' });
  js = js.replace(/(from '\.\/[a-z-]+)\.ts';/g, "$1.js';");
  // A command's own module, loaded only when it runs (maplith.ts: setup.ts).
  js = js.replace(/(import\('\.\/[a-z-]+)\.ts'\)/g, "$1.js')");
  if (/'\.\/[^']*\.ts'/.test(js)) throw new Error('A relative .ts import is left after the rewrite');
  return bin ? `#!/usr/bin/env node\n${js}` : js;
}

const octal = (n: number, width: number) => `${n.toString(8).padStart(width - 1, '0')}\0`;

/** One ustar header block for a regular file. */
function header(name: string, size: number, mtime: number, mode: number): Buffer {
  if (Buffer.byteLength(name) > 100) throw new Error(`A name too long for a ustar header: ${name}`);
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100, 8, 'ascii');
  h.write(octal(0, 8), 108, 8, 'ascii'); // uid
  h.write(octal(0, 8), 116, 8, 'ascii'); // gid
  h.write(octal(size, 12), 124, 12, 'ascii');
  h.write(octal(mtime, 12), 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // the checksum, counted as spaces
  h.write('0', 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

export interface Entry {
  name: string;
  data: Buffer;
  mode: number;
}

/** A gzipped ustar of `entries` under package/, sorted by name. */
export function tarGz(entries: readonly Entry[], mtime: number): Buffer {
  const blocks: Buffer[] = [];
  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    blocks.push(header(`package/${e.name}`, e.data.length, mtime, e.mode), e.data, Buffer.alloc((512 - (e.data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(blocks), { level: 9 });
  // The header's operating-system byte is the platform zlib was built for
  // (3 on Linux, 19 on macOS): fixed to 3, Unix, so a build on any system
  // can match the release byte for byte. No checksum covers the header.
  gz[9] = 3;
  return gz;
}

/** What the package holds, file by file. `src` is where the three sources
 *  are: the repository root, unless a caller keeps them elsewhere. */
export function entries(root = ROOT, src = root): Entry[] {
  const pkg = manifest(root);
  const published: Manifest = { ...pkg };
  delete published.scripts;
  delete published.devDependencies;
  for (const [command, file] of Object.entries(BINS)) {
    if (published.bin?.[command] !== file) throw new Error(`package.json must link the ${command} command to ${file}`);
  }
  if (Object.keys(published.bin ?? {}).length !== Object.keys(BINS).length) throw new Error('package.json links a command build.ts does not know');
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as { name?: string; version?: string };
  if (lock.name !== pkg.name || lock.version !== pkg.version) throw new Error('package-lock.json names another package or version: run npm install --package-lock-only');
  const out: Entry[] = [
    { name: 'package.json', data: Buffer.from(`${JSON.stringify(published, null, 2)}\n`), mode: 0o644 },
    { name: 'npm-shrinkwrap.json', data: readFileSync(join(root, 'package-lock.json')), mode: 0o644 },
  ];
  for (const s of SOURCES) {
    const name = s.replace(/\.ts$/, '.js');
    const bin = BIN_FILES.has(name);
    out.push({ name, data: Buffer.from(toJavaScript(readFileSync(join(src, s), 'utf8'), bin)), mode: bin ? 0o755 : 0o644 });
  }
  for (const d of DOCS) out.push({ name: d, data: readFileSync(join(root, d)), mode: 0o644 });
  return out;
}

export interface Built {
  file: string;
  sha256: string;
  version: string;
}

export function build(out: string, opts: { root?: string; src?: string; env?: Record<string, string | undefined> } = {}): Built {
  const root = opts.root ?? ROOT;
  const { name: pkgName, version } = manifest(root);
  const name = `${pkgName}-${version}.tgz`;
  const bytes = tarGz(entries(root, opts.src ?? root), sourceDate(root, opts.env ?? process.env));
  mkdirSync(out, { recursive: true });
  const file = join(out, name);
  writeFileSync(file, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(`${file}.sha256`, `${sha256}  ${name}\n`);
  return { file, sha256, version };
}

const entry = process.argv[1];
let isMain = false;
try {
  isMain = Boolean(entry) && import.meta.url === pathToFileURL(realpathSync(entry)).href;
} catch {
  isMain = false;
}
if (isMain) {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || (args.length === 2 && args[0] === '--out' && args[1] !== ''))) {
    console.error('Usage: node scripts/build.ts [--out <folder>]');
    process.exit(2);
  }
  const { file, sha256, version } = build(resolve(args.length ? args[1] : join(ROOT, 'dist')));
  console.log(`Maplith ${version}: ${file}`);
  console.log(`sha256 ${sha256} (also in ${file}.sha256)`);
  console.log(`Built with Node.js ${process.version}.`);
}
