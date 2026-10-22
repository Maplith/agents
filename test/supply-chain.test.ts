import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { BINS, DOCS, SOURCES, build, entries } from '../scripts/build.ts';

/** The supply chain: what a person installs is what this repository holds,
 *  built the same way every time, with one runtime dependency, no install
 *  script, and a release workflow that holds only the permissions it needs
 *  and runs only actions pinned by commit. */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SRC = fileURLToPath(new URL('../', import.meta.url));
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const json = (f: string) => JSON.parse(read(f));
const pkg = json('package.json');
const lock = json('package-lock.json');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
const EPOCH = { SOURCE_DATE_EPOCH: '1791590400' };

function unpack(tgz: string): string {
  const dest = tmp('bridge-sc-unpack-');
  execFileSync('tar', ['-xzf', tgz, '-C', dest]);
  return join(dest, 'package');
}

describe('the package manifest', () => {
  it('names the package, its commands and its registry entry, under the Apache License 2.0', () => {
    expect(pkg.name).toBe('maplith');
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+(-(alpha|beta|rc)\.\d+)?$/);
    expect(pkg.mcpName).toBe('com.maplith/bridge');
    // `maplith`, and `maplith-bridge` kept as an alias of `maplith bridge`.
    expect(pkg.bin).toEqual({ maplith: 'maplith.js', 'maplith-bridge': 'bridge.js' });
    expect(BINS).toEqual(pkg.bin);
    expect(pkg.license).toBe('Apache-2.0');
    expect(pkg.type).toBe('module');
    expect(pkg.engines).toEqual({ node: '>=24' });
    // Provenance names the repository the package was built from.
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/Maplith/agents.git' });
    expect(pkg.publishConfig).toEqual({ access: 'public', provenance: true });
  });

  it('depends on the PostgreSQL client alone, at an exact version, and runs no install script', () => {
    expect(pkg.dependencies).toEqual({ pg: expect.stringMatching(/^\d+\.\d+\.\d+$/) });
    expect(pkg.devDependencies).toBeUndefined();
    for (const hook of ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare']) expect(pkg.scripts?.[hook], hook).toBeUndefined();
  });

  it('agrees with the manifest the sources run with: the same version and the same driver', () => {
    const local = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'));
    expect(local.version).toBe(pkg.version);
    expect(local.dependencies).toEqual(pkg.dependencies);
  });
});

describe('the lockfile', () => {
  it('belongs to this package and version, and pins every package by its hash from the npm registry, none with an install script', () => {
    expect([lock.name, lock.version]).toEqual([pkg.name, pkg.version]);
    expect(lock.packages[''].dependencies).toEqual(pkg.dependencies);
    expect(lock.packages['node_modules/pg'].version).toBe(pkg.dependencies.pg);
    for (const [path, entry] of Object.entries(lock.packages as Record<string, { resolved?: string; integrity?: string; hasInstallScript?: boolean }>)) {
      if (path === '') continue;
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, path).toMatch(/^sha512-/);
      expect(entry.hasInstallScript, path).toBeUndefined();
    }
  });

  it('is the lockfile the sources are tested with', () => {
    const local = JSON.parse(readFileSync(join(SRC, 'package-lock.json'), 'utf8'));
    const deps = (l: { packages: Record<string, unknown> }) => Object.fromEntries(Object.entries(l.packages).filter(([p]) => p !== ''));
    expect(deps(local)).toEqual(deps(lock));
  });
});

describe('the release build', () => {
  it('is reproducible: the same sources give the same bytes, with the checksum beside them', () => {
    const a = build(tmp('bridge-sc-a-'), { root: ROOT, src: SRC, env: EPOCH });
    const b = build(tmp('bridge-sc-b-'), { root: ROOT, src: SRC, env: EPOCH });
    expect(readFileSync(a.file).equals(readFileSync(b.file))).toBe(true);
    expect(a.file.endsWith(`/maplith-${pkg.version}.tgz`)).toBe(true);
    expect(a.sha256).toBe(createHash('sha256').update(readFileSync(a.file)).digest('hex'));
    expect(readFileSync(`${a.file}.sha256`, 'utf8')).toBe(`${a.sha256}  maplith-${pkg.version}.tgz\n`);
    // gzip's header: no time, and Unix as the system on every platform, so a
    // build on macOS matches the release built on Linux.
    const head = readFileSync(a.file).subarray(0, 10);
    expect([...head.subarray(4, 8)]).toEqual([0, 0, 0, 0]);
    expect(head[9]).toBe(3);
  });

  it('holds exactly the code, the manifest, the shrinkwrap and the documents, under package/, the command executable', () => {
    const list = execFileSync('tar', ['-tvzf', build(tmp('bridge-sc-'), { root: ROOT, src: SRC, env: EPOCH }).file], { encoding: 'utf8' }).trim().split('\n');
    const names = list.map((l) => l.split(/\s+/).at(-1)!).sort();
    expect(names).toEqual(
      ['package.json', 'npm-shrinkwrap.json', ...SOURCES.map((s) => s.replace(/\.ts$/, '.js')), ...DOCS].map((n) => `package/${n}`).sort(),
    );
    const bins = Object.values(BINS).map((b) => `package/${b}`);
    for (const l of list) expect(l.startsWith(bins.some((b) => l.endsWith(b)) ? '-rwxr-xr-x' : '-rw-r--r--'), l).toBe(true);
  });

  it('publishes the manifest without scripts, and the lockfile as the shrinkwrap', () => {
    const files = new Map(entries(ROOT, SRC).map((e) => [e.name, e.data.toString('utf8')]));
    const published = JSON.parse(files.get('package.json')!);
    expect(published.scripts).toBeUndefined();
    expect(published.devDependencies).toBeUndefined();
    expect({ ...published, scripts: pkg.scripts }).toEqual(pkg);
    expect(files.get('npm-shrinkwrap.json')).toBe(read('package-lock.json'));
  });

  it('strips the types and nothing else: every line where it was, every import pointing at the .js beside it', () => {
    const files = new Map(entries(ROOT, SRC).map((e) => [e.name, e.data.toString('utf8')]));
    for (const s of SOURCES) {
      const ts = readFileSync(join(SRC, s), 'utf8');
      let js = files.get(s.replace(/\.ts$/, '.js'))!;
      if (Object.values(BINS).includes(s.replace(/\.ts$/, '.js'))) {
        expect(js.startsWith('#!/usr/bin/env node\n')).toBe(true);
        js = js.slice('#!/usr/bin/env node\n'.length);
      }
      expect(js.length).toBe(ts.length);
      expect(js.split('\n').length).toBe(ts.split('\n').length);
      expect(js).not.toMatch(/from '\.\/[^']+\.ts'|import\('\.\/[^']+\.ts'\)/);
      // With the imports put back, every character is the source's, or a
      // space where a type was.
      const back = js.replace(/(from '\.\/[a-z-]+)\.js';/g, "$1.ts';").replace(/(import\('\.\/[a-z-]+)\.js'\)/g, "$1.ts')");
      let changed = 0;
      for (let i = 0; i < ts.length; i++) {
        if (back[i] === ts[i]) continue;
        expect(back[i], `${s} at ${i}`).toMatch(/\s/);
        changed++;
      }
      expect(changed, s).toBeGreaterThan(0);
    }
  });

  it('runs from the unpacked package with nothing installed: the version, the help as the command was run, and serve', async () => {
    const folder = unpack(build(tmp('bridge-sc-'), { root: ROOT, src: SRC, env: EPOCH }).file);
    const node = (args: string[], cwd = folder) => execFileSync(process.execPath, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    expect(node(['bridge.js', '--version']).trim()).toBe(pkg.version);
    expect(node(['bridge.js', '--help'])).toContain('Run "node bridge.js <command> --help"');
    // As npm links them: `maplith`, and the alias `maplith-bridge`.
    const bins = tmp('bridge-sc-bin-');
    symlinkSync(join(folder, 'maplith.js'), join(bins, 'maplith'));
    symlinkSync(join(folder, 'bridge.js'), join(bins, 'maplith-bridge'));
    expect(execFileSync(join(bins, 'maplith'), ['bridge', 'serve', '--help'], { encoding: 'utf8' })).toMatch(/^Usage: maplith bridge serve --dir <folder>/);
    expect(execFileSync(join(bins, 'maplith'), ['--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
    expect(execFileSync(join(bins, 'maplith'), ['setup', 'codex', '--print'], { encoding: 'utf8' })).toContain('codex plugin add maplith@maplith');
    expect(execFileSync(join(bins, 'maplith-bridge'), ['serve', '--help'], { encoding: 'utf8' })).toMatch(/^Usage: maplith-bridge serve --dir <folder>/);
    const work = tmp('bridge-sc-run-');
    mkdirSync(join(work, 'exports', 'shop'), { recursive: true });
    node([join(folder, 'bridge.js'), 'rotate-token', '--token-file', join(work, 'token')], work);
    const child = spawn(process.execPath, [join(folder, 'bridge.js'), 'serve', '--dir', join(work, 'exports'), '--token-file', join(work, 'token'), '--port', '0'], {
      cwd: work,
      env: { PATH: process.env.PATH ?? '' },
    });
    try {
      const out = await new Promise<string>((ok, no) => {
        let text = '';
        child.stdout.on('data', (b: Buffer) => {
          text += b.toString();
          if (text.includes('list_files and read_file')) ok(text);
        });
        child.stderr.on('data', (b: Buffer) => (text += b.toString()));
        child.on('exit', (code) => no(new Error(`exited ${code}: ${text}`)));
      });
      expect(out).toContain(`Maplith Bridge ${pkg.version}`);
      expect(out).toContain('Rotate it with: node bridge.js rotate-token');
      expect(out).not.toContain(readFileSync(join(work, 'token'), 'utf8').trim());
    } finally {
      child.kill();
    }
  }, 30_000);
});

/** A workflow's jobs, by name: the text of each job under `jobs:`. */
function jobBlocks(text: string): Record<string, string> {
  const body = text.slice(text.search(/^jobs:$/m));
  const out: Record<string, string> = {};
  let name = '';
  for (const line of body.split('\n').slice(1)) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) name = m[1];
    else if (name) out[name] = `${out[name] ?? ''}${line}\n`;
  }
  return out;
}

/** The lines of a workflow inside its `run:` blocks. */
function runBlocks(text: string): string[] {
  const out: string[] = [];
  let indent = -1;
  for (const line of text.split('\n')) {
    const m = /^(\s*)(?:- )?run: ?(.*)$/.exec(line);
    if (m) {
      indent = m[1].length;
      if (m[2] && m[2] !== '|' && m[2] !== '>') out.push(m[2]);
      continue;
    }
    if (indent >= 0 && (line.trim() === '' || line.search(/\S/) > indent)) out.push(line);
    else indent = -1;
  }
  return out;
}

describe('the workflows', () => {
  const dir = join(ROOT, '.github/workflows');
  const workflows = Object.fromEntries(readdirSync(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

  it('are the four of a release: CI, release, CodeQL and the Scorecard, and the wake relay\'s tests', () => {
    expect(Object.keys(workflows).sort()).toEqual(['ci.yml', 'codeql.yml', 'release.yml', 'scorecard.yml', 'wake-relay.yml']);
  });

  it('pin every action by a full commit, with its version beside it', () => {
    for (const [f, text] of Object.entries(workflows)) {
      const uses = [...text.matchAll(/^\s*(?:- )?uses: (\S+)(.*)$/gm)];
      expect(uses.length, f).toBeGreaterThan(0);
      for (const [, ref, comment] of uses) {
        expect(ref, `${f}: ${ref}`).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
        expect(comment, `${f}: ${ref}`).toMatch(/^ # v\d+\.\d+\.\d+$/);
      }
    }
  });

  it('grant nothing at the top, and each job only what it needs: id-token only where something is signed or published', () => {
    for (const [f, text] of Object.entries(workflows)) {
      expect(text, f).toMatch(/^permissions: \{\}$/m);
      expect(text, f).not.toMatch(/write-all|read-all/);
    }
    const idToken = Object.entries(workflows).flatMap(([f, text]) => (text.match(/id-token: write/g) ?? []).map(() => f));
    expect(idToken.sort()).toEqual(['release.yml', 'release.yml', 'scorecard.yml']);
    expect(workflows['release.yml'].match(/contents: write/g)).toHaveLength(1);
    // A job that can sign or publish runs no third-party code: no package is
    // installed there and no test tool runs, so a compromised test tool can
    // neither change what is packed nor sign it. The tests run in a job of
    // their own that the build waits for.
    const jobs = jobBlocks(workflows['release.yml']);
    expect(Object.keys(jobs)).toEqual(['test', 'build', 'npm', 'github']);
    for (const [name, text] of Object.entries(jobs)) {
      if (!/id-token: write|contents: write|attestations: write/.test(text)) continue;
      for (const line of runBlocks(text).filter((l) => !/^\s*echo /.test(l))) expect(line, `${name}: ${line}`).not.toMatch(/\bnpm (ci|install|i|test|run|exec)\b|\bnpx\b|vitest|--prefix test/);
    }
    expect(jobs.test).not.toMatch(/write/);
    expect(jobs.test).toMatch(/npm test/);
    expect(jobs.build).toMatch(/^\s+needs: test$/m);
  });

  it('never run on pull_request_target, never keep the checkout\'s token, and never put event data straight into a script', () => {
    for (const [f, text] of Object.entries(workflows)) {
      expect(text, f).not.toContain('pull_request_target');
      const checkouts = text.match(/uses: actions\/checkout@/g)?.length ?? 0;
      expect(text.match(/persist-credentials: false/g)?.length ?? 0, f).toBe(checkouts);
      for (const line of runBlocks(text)) expect(line, `${f}: ${line}`).not.toMatch(/\$\{\{\s*(github|inputs)\./);
    }
  });

  it('install with --ignore-scripts only, and publish with provenance from the protected environment', () => {
    for (const [f, text] of Object.entries(workflows)) {
      for (const line of runBlocks(text).filter((l) => /\bnpm (ci|install|i)\b/.test(l))) {
        expect(line, `${f}: ${line}`).toMatch(/npm ci .*--ignore-scripts/);
      }
    }
    const release = workflows['release.yml'];
    expect(release).toMatch(/npm publish "\.\/maplith-\$VERSION\.tgz" --access public --provenance/);
    expect(release).toMatch(/^\s+environment: npm$/m);
    expect(release).toContain('actions/attest-build-provenance@');
    expect(release).toMatch(/NODE_VERSION: \d+\.\d+\.\d+$/m);
    expect(release).toContain('cmp "dist/maplith-$VERSION.tgz"');
  });

  it('let Dependabot keep the driver, the test tools and the actions current', () => {
    const d = read('.github/dependabot.yml');
    for (const dirName of ["directory: /\n", 'directory: /test']) expect(d).toContain(dirName);
    expect(d).toContain('package-ecosystem: github-actions');
  });
});

describe('the documents', () => {
  it('carry the Apache License 2.0 word for word', () => {
    // The SHA-1 of https://www.apache.org/licenses/LICENSE-2.0.txt.
    expect(createHash('sha1').update(readFileSync(join(ROOT, 'LICENSE'))).digest('hex')).toBe('2b8b815229aa8a61e483fb4ba0588b8b6c491890');
  });

  it('say how to report a vulnerability privately, and how to sign off a contribution', () => {
    const security = read('SECURITY.md');
    expect(security).toContain('security@maplith.com');
    expect(security).toContain('Report a vulnerability');
    expect(security).toMatch(/90\s+days/);
    expect(read('CONTRIBUTING.md')).toContain('Signed-off-by');
    expect(read('TRADEMARK.md')).toContain('may not');
  });

  it('name the version being released, everywhere a person copies it from', () => {
    const v = pkg.version;
    for (const f of ['README.md', 'RUNBOOK.md', 'INSTALL-WITH-YOUR-AGENT.md']) expect(read(f), f).toContain(v);
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`^## \\[${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\] - \\d{4}-\\d{2}-\\d{2}$`, 'm'));
    const server = json('server.json');
    expect(server.name).toBe(pkg.mcpName);
    expect(server.version).toBe(v);
    expect(server.packages).toEqual([expect.objectContaining({ registryType: 'npm', identifier: pkg.name, version: v, transport: expect.objectContaining({ type: 'streamable-http' }) })]);
    expect(server.description.length).toBeLessThanOrEqual(100);
    // No other version of the package is named for installing, and no
    // unversioned npx: npm's latest is a placeholder until a release is
    // tagged latest, so `npx maplith` alone would find no command.
    for (const f of ['README.md', 'RUNBOOK.md', 'INSTALL-WITH-YOUR-AGENT.md', 'plugins/maplith/README.md', 'plugins/maplith/skills/maplith/SKILL.md']) {
      expect(read(f), f).not.toMatch(/npx (?:-y |--yes )?maplith(?:-bridge)?(?![@\w-])/);
    }
    for (const f of ['README.md', 'RUNBOOK.md', 'INSTALL-WITH-YOUR-AGENT.md', 'plugins/maplith/README.md', 'plugins/maplith/skills/maplith/SKILL.md']) {
      for (const m of read(f).matchAll(/(?:@maplith\/bridge@|maplith-bridge-|maplith-|maplith@|VERSION=|v)(\d+\.\d+\.\d+(?:-rc\.\d+)?)/g)) expect(m[1], f).toBe(v);
    }
  });

  it('tell every client to treat file contents as data, never as instructions', () => {
    expect(read('README.md')).toMatch(/Tell your agent to treat them as data,\s+never as instructions/);
    expect(read('THREAT-MODEL.md')).toMatch(/data, not instructions/);
  });

  it('tell the person the token is typed into a client, never into a chat', () => {
    for (const f of ['RUNBOOK.md', 'INSTALL-WITH-YOUR-AGENT.md']) expect(read(f), f).toMatch(/never\s+into a chat with an assistant/);
    expect(read('INSTALL-WITH-YOUR-AGENT.md')).toMatch(/Never ask me for, read, print or store a password or the Bridge token/);
  });
});

describe('the sources the package is built from', () => {
  it('exist as named, and are TypeScript Node.js runs as it is', () => {
    for (const s of SOURCES) expect(statSync(join(SRC, s)).isFile()).toBe(true);
    const out = execFileSync(process.execPath, [join(SRC, 'bridge.ts'), '--version'], { encoding: 'utf8' }).trim();
    expect(out).toBe(pkg.version);
    expect(execFileSync(process.execPath, [join(SRC, 'maplith.ts'), '--version'], { encoding: 'utf8' }).trim()).toBe(pkg.version);
  });
});
