#!/usr/bin/env node
/**
 * Build the crate the way a stranger receives it, and run one.
 *
 * Every test in this repository runs INSIDE the repository, where `data/packs`
 * is a few directories up and the pack loader finds it by walking. A published
 * crate has nothing above it — `~/.cargo/registry/src/…/tdcv2-0.1.3/` and then
 * the registry cache — so the whole suite can be green while the artefact a user
 * downloads answers every `type="template"` with "no data packs found". That is
 * exactly what it did, and nothing caught it.
 *
 * So this packages the crate, unpacks it OUTSIDE the repository, builds it
 * there, runs a config that touches three different packs, and compares the
 * output against the TypeScript reference. It is slow — a full cold build — and
 * it is the only check that can see this class of bug.
 *
 *   node scripts/verify-crate.mjs
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const crateDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(crateDir, '..');

/** Three packs, three shapes: a plain list, a check-digited id, a composed one. */
const CONFIG = `<tdc>
  <env count="3" seed="crate-check" local="en">
    <sequence name="Name"><gen type="template" value="person.lastName"/></sequence>
    <sequence name="Ssn"><gen type="template" value="usa.docs.ssn"/></sequence>
    <sequence name="Iban"><gen type="template" value="common.finance.iban"/></sequence>
  </env>
  <block><line><data>\${{Name}} | \${{Ssn}} | \${{Iban}}</data></line></block>
</tdc>
`;

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts });

// Somewhere with no repository above it. `os.tmpdir()` is outside the checkout on
// every platform this builds on, which is the whole point of the exercise.
const work = mkdtempSync(join(tmpdir(), 'tdcv2-crate-'));
const config = join(work, 'check.tdc');
writeFileSync(config, CONFIG);

try {
  console.log('bundling the starter packs…');
  run('node', [join(crateDir, 'scripts', 'bundle-packs.mjs'), 'add'], { cwd: crateDir });

  console.log('packaging…');
  run('cargo', ['package', '--allow-dirty', '--quiet'], { cwd: crateDir });

  // By NAME, not "the first .crate in the folder". `target/package` keeps every
  // crate ever packaged here, so picking the first one verified whatever version
  // happened to sort earliest — which meant a release could be checked by
  // building yesterday's crate and calling it green. Reading the version out of
  // Cargo.toml and demanding that exact file is what makes this able to fail.
  const declared = /^version\s*=\s*"([^"]+)"/m.exec(
    readFileSync(join(crateDir, 'Cargo.toml'), 'utf8'),
  )?.[1];
  if (!declared) {
    throw new Error('could not read the version from rust/Cargo.toml');
  }
  const crate = `tdcv2-${declared}.crate`;
  if (!existsSync(join(crateDir, 'target', 'package', crate))) {
    throw new Error(`cargo package produced no ${crate}`);
  }
  console.log(`unpacking ${crate} into ${work}`);
  run('tar', ['-xzf', join(crateDir, 'target', 'package', crate), '-C', work]);

  const unpacked = join(work, crate.replace(/\.crate$/, ''));
  console.log('building it there (cold, so this takes a minute)…');
  run('cargo', ['build', '--quiet', '--bin', 'tdcv2'], { cwd: unpacked });

  const fromCrate = run(join(unpacked, 'target', 'debug', 'tdcv2'), [config]);
  const fromReference = run('node', [join(repo, 'typescript', 'dist', 'cli', 'main.js'), config]);

  if (fromCrate !== fromReference) {
    console.error('the packaged crate does not agree with the reference.\n');
    console.error(`crate:\n${fromCrate}\nreference:\n${fromReference}`);
    process.exit(1);
  }

  const rows = fromCrate.trimEnd().split('\n').length;
  console.log(`the packaged crate runs outside the repository and matches the reference (${rows} rows)`);
} finally {
  run('node', [join(crateDir, 'scripts', 'bundle-packs.mjs'), 'remove'], { cwd: crateDir });
  rmSync(work, { recursive: true, force: true });
}
