#!/usr/bin/env node
/**
 * Prove the npm TARBALL, from a clean clone, the way npm hands it to a stranger.
 *
 * npm is the one artefact that had never been checked here. It survived where
 * the Python wheel did not, and the reason is a single line in
 * `typescript/package.json`:
 *
 *   "prepack": "node scripts/bundle-packs.mjs add"
 *
 * npm runs that hook on `npm pack` and `npm publish`, so the starter packs are
 * copied in whatever state the tree was in. Python has no equivalent hook, which
 * is why its packs — and its parser — were simply absent for three releases.
 * "It works" and "it is checked" are different claims, and only the second one
 * survives a change to the build.
 *
 * Same shape as `python/scripts/verify-wheel.mjs`: build from `git archive HEAD`
 * so the working tree cannot stand in for a clean clone, install the packed
 * tarball into a directory of its own, then use it.
 *
 *   node typescript/scripts/verify-tarball.mjs
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The names the run must produce — the same three every other implementation gives. */
const EXPECTED = 'Williams Smith Johnson';

const CONFIG =
  '<tdc><env count="3" seed="s" local="en"><sequence name="V">' +
  '<gen type="template" value="person.lastName"/></sequence></env>' +
  '<block><line><data>${{V}}</data></line></block></tdc>';

function run(command, args, cwd, label) {
  const r = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) {
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n');
    throw new Error(`${label} failed:\n${out}`);
  }
  return (r.stdout ?? '').trim();
}

const work = mkdtempSync(join(tmpdir(), 'tdc-tarball-'));
let ok = false;
try {
  console.log('  clean clone       git archive HEAD');
  execFileSync('sh', ['-c', `git archive HEAD | tar -x -C ${JSON.stringify(work)}`], { cwd: ROOT });

  console.log('  install + build   npm ci && npm run build');
  run('npm', ['ci', '--silent'], work, 'npm ci');
  run('npm', ['run', 'build', '--workspace=typescript', '--silent'], work, 'npm run build');

  // `npm pack` fires `prepack`, which is what puts the starter packs in. Packing
  // rather than reading the directory is the whole point: the tarball is the
  // artefact, and its file list is decided by `files` and the hook together.
  console.log('  pack              npm pack');
  run('npm', ['pack', '--silent'], join(work, 'typescript'), 'npm pack');
  const tarballs = readdirSync(join(work, 'typescript')).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1) throw new Error(`expected one tarball, found ${tarballs.length}`);
  console.log(`  built             ${tarballs[0]}`);

  const probe = join(work, 'probe');
  mkdirSync(probe);
  writeFileSync(join(probe, 'package.json'), '{"name":"probe","private":true,"type":"module"}\n');
  console.log('  install           npm install <tarball> into a directory of its own');
  run('npm', ['install', '--silent', join(work, 'typescript', tarballs[0])], probe, 'install');

  writeFileSync(
    join(probe, 'probe.mjs'),
    `import { TDC } from 'tdcv2';\n` +
      `console.log(new TDC({ configString: ${JSON.stringify(CONFIG)} }).toString().trim());\n`,
  );
  const printed = execFileSync('node', ['probe.mjs'], { cwd: probe, encoding: 'utf8' })
    .trim()
    .split('\n')
    .join(' ');
  if (printed !== EXPECTED) {
    throw new Error(
      `the library printed ${JSON.stringify(printed)}, expected ${JSON.stringify(EXPECTED)}`,
    );
  }
  console.log(`  library           ${printed}`);

  const cfg = join(probe, 'probe.tdc');
  writeFileSync(cfg, CONFIG);
  const cli = execFileSync(join(probe, 'node_modules', '.bin', 'tdcv2'), [cfg], {
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .join(' ');
  if (cli !== EXPECTED) {
    throw new Error(`the CLI printed ${JSON.stringify(cli)}, expected ${JSON.stringify(EXPECTED)}`);
  }
  console.log(`  command line      ${cli}`);
  ok = true;
} catch (e) {
  console.error(`\n  ${e.message}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
