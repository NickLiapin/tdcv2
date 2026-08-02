/**
 * Install smoke test: build the tarball, install it into an empty directory,
 * and generate a name.
 *
 * This is the test whose absence let a shipping-stopper through. `files` listed
 * only `dist`, while the runtime looked for its data packs at
 * `<package>/../data/packs` — a path that resolves inside the repo and lands in
 * `node_modules/data/packs` once installed. Everything passed: unit tests,
 * integration tests, the CLI from a checkout. Only an actual install failed,
 * with `unknown template path "person.male.firstName"` — the most basic thing
 * the library does.
 *
 * Nothing checked from inside the repository can catch that class of bug, so
 * this test deliberately leaves the repository: it packs, installs and runs
 * exactly what a user would receive.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '../..');

/** A config touching the things that only work when packs shipped. */
const CONFIG = `<tdc>
  <env count="4" seed="install-smoke" inject="\${{%}}">
    <sequence name="First"><gen type="template" value="person.male.firstName"/></sequence>
    <sequence name="Last"><gen type="template" value="person.lastName"/></sequence>
    <sequence name="Key"><gen type="template" value="common.id.uuid"/></sequence>
  </env>
  <block><line><data>\${{First}}|\${{Last}}|\${{Key}}</data></line></block>
</tdc>`;

describe('the published package works after a real install', () => {
  let dir = '';
  let installed = '';

  beforeAll(() => {
    execFileSync('npm', ['run', 'build'], { cwd: pkgRoot, stdio: 'ignore' });
    // `npm pack` runs prepack/postpack, so this is the real tarball.
    const tarball = execFileSync('npm', ['pack', '--silent'], { cwd: pkgRoot, encoding: 'utf8' })
      .trim()
      .split('\n')
      .pop();
    dir = mkdtempSync(join(tmpdir(), 'tdc-install-'));
    execFileSync('npm', ['init', '-y'], { cwd: dir, stdio: 'ignore' });
    execFileSync('npm', ['install', join(pkgRoot, tarball ?? '')], { cwd: dir, stdio: 'ignore' });
    rmSync(join(pkgRoot, tarball ?? ''), { force: true });
    installed = join(dir, 'node_modules', 'tdcv2');
  }, 300_000);

  it('ships the data packs inside the package', () => {
    // Not `node_modules/data` — inside the package, where the runtime looks.
    expect(readdirSync(join(installed, 'data', 'packs')).length).toBeGreaterThan(10);
  });

  it('does not ship source maps', () => {
    // They are debug artefacts for whoever edits the library, and they were
    // half the published bytes.
    const maps = execFileSync('find', [installed, '-name', '*.map'], { encoding: 'utf8' }).trim();
    expect(maps).toBe('');
  });

  it('generates real names through the CLI', () => {
    const cfg = join(dir, 'smoke.tdc');
    writeFileSync(cfg, CONFIG);
    const out = execFileSync('node', [join(installed, 'dist', 'cli', 'main.js'), cfg], {
      encoding: 'utf8',
    });
    const rows = out.split('\n').filter(Boolean);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      const [first, last, key] = row.split('|');
      // A template that failed to resolve would leave the path or an empty
      // field, never a plausible name.
      expect(first, row).toMatch(/^\p{L}{2,}$/u);
      expect(last, row).toMatch(/^\p{L}{2,}$/u);
      expect(key, row).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  }, 60_000);

  it('generates through the library API too', () => {
    const script = join(dir, 'lib.mjs');
    writeFileSync(
      script,
      `import { TDC } from 'tdcv2';\n` +
        `const tdc = new TDC({ configString: ${JSON.stringify(CONFIG)} });\n` +
        `process.stdout.write(tdc.toString());\n`,
    );
    const out = execFileSync('node', [script], { cwd: dir, encoding: 'utf8' });
    expect(out.split('\n').filter(Boolean)).toHaveLength(4);
    expect(out).not.toContain('person.male');
  }, 60_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    // prepack copies the packs in; postpack removes them. If a run was
    // interrupted the copy could linger and shadow the real one.
    rmSync(join(pkgRoot, 'data'), { recursive: true, force: true });
  });
});
