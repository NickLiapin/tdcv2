#!/usr/bin/env node
/**
 * Prove the ARTEFACTS, not the sources. Run this before publishing anything.
 *
 * Every other check in this repository reads the working tree: `npm run check`,
 * `five-ways.mjs`, the documentation audits. They can all be green while the
 * thing a stranger downloads is broken, because none of them packages anything.
 *
 * That is not hypothetical. **0.1.5 shipped a Rust crate with no data packs in
 * it.** `cargo install tdcv2` produced a binary that answered every
 * `type="template"` with "no data packs found" — a release that cannot generate
 * a name. The packs live once at the repository root and are copied into the
 * crate before packaging, because a published crate has nothing above it; npm
 * does that copy in its `prepack` hook, and Cargo has no such hook, so the step
 * is manual. The step was skipped. The check that would have caught it —
 * `rust/scripts/verify-crate.mjs` — exists, was written after this exact bug
 * happened once before, and is wired into nothing.
 *
 * Java and C# were fine, and the reason is the point of this file: their
 * artefact checks run inside their publish workflows. Rust and npm have no
 * publish workflow, so their checks ran nowhere.
 *
 * So: one command, all four artefacts, and the Rust bundling done here rather
 * than remembered.
 *
 *   node scripts/verify-artefacts.mjs
 *   node scripts/verify-artefacts.mjs --only rust
 *
 * It is SLOW — cold builds outside the repository are the only way to see this
 * class of bug — which is why it is not part of `npm run check`. It is part of
 * releasing.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * `prepare` runs before the check and `cleanup` after it, whatever the verdict —
 * the Rust bundling leaves 489 data files inside `rust/src/packs/bundled/` that
 * must not stay in the working tree, where they would shadow the real ones and
 * quietly go stale.
 */
const ARTEFACTS = [
  {
    id: 'rust',
    label: 'Rust crate (crates.io)',
    cwd: 'rust',
    prepare: ['node', ['scripts/bundle-packs.mjs', 'add']],
    check: ['node', ['scripts/verify-crate.mjs']],
    cleanup: ['node', ['scripts/bundle-packs.mjs', 'remove']],
  },
  {
    id: 'java',
    label: 'Java jar (Maven Central)',
    cwd: 'java',
    prepare: ['./gradlew', ['jar', 'cliJar', '-q', '--console=plain']],
    check: ['node', ['scripts/verify-jar.mjs']],
  },
  {
    id: 'csharp-lib',
    label: 'C# library (NuGet)',
    cwd: 'csharp',
    check: ['node', ['scripts/verify-package.mjs']],
  },
  {
    id: 'csharp-cli',
    label: 'C# command line (NuGet)',
    cwd: 'csharp',
    check: ['node', ['scripts/verify-tool.mjs']],
  },
];

/** Every declared version, so a release cannot go out with them disagreeing. */
function declaredVersions() {
  const read = (p) => readFileSync(join(ROOT, p), 'utf8');
  const one = (text, re) => re.exec(text)?.[1];
  return {
    npm: one(read('typescript/package.json'), /"version":\s*"([^"]+)"/),
    'npm (VERSION)': one(read('typescript/src/version.ts'), /VERSION = '([^']+)'/),
    crates: one(read('rust/Cargo.toml'), /^version = "([^"]+)"/m),
    pypi: one(read('python/pyproject.toml'), /^version = "([^"]+)"/m),
    maven: one(read('java/build.gradle.kts'), /^version = "([^"]+)"/m),
    'nuget (lib)': one(read('csharp/Tdcv2/Tdcv2.csproj'), /<Version>([^<]+)</),
    'nuget (cli)': one(read('csharp/Tdcv2.Cli.Tool/Tdcv2.Cli.Tool.csproj'), /<Version>([^<]+)</),
  };
}

const only = process.argv.includes('--only')
  ? process.argv[process.argv.indexOf('--only') + 1].split(',')
  : null;

const versions = declaredVersions();
const distinct = [...new Set(Object.values(versions))];
console.log('Declared versions:');
for (const [k, v] of Object.entries(versions)) console.log(`  ${k.padEnd(15)} ${v ?? '??'}`);
if (distinct.length !== 1) {
  console.error(`\nThey disagree: ${distinct.join(', ')}. One number, or the release is a lie.`);
  process.exit(1);
}
console.log(`\nAll ${String(Object.keys(versions).length)} agree on ${distinct[0]}.\n`);

const run = ([command, args], cwd) =>
  spawnSync(command, args, { cwd: join(ROOT, cwd), stdio: 'inherit' }).status ?? 1;

const failed = [];
let ran = 0;
for (const a of ARTEFACTS.filter((x) => !only || only.includes(x.id))) {
  if (!existsSync(join(ROOT, a.cwd))) continue;
  ran++;
  console.log(`── ${a.label}`);
  if (a.prepare && run(a.prepare, a.cwd) !== 0) {
    failed.push(`${a.label} (could not be built)`);
    if (a.cleanup) run(a.cleanup, a.cwd);
    continue;
  }
  const code = run(a.check, a.cwd);
  // Cleanup runs whatever happened: a failed check must not leave the working
  // tree carrying a copy of the data packs.
  if (a.cleanup) run(a.cleanup, a.cwd);
  if (code !== 0) failed.push(a.label);
  console.log('');
}

if (failed.length > 0) {
  console.error(`\n${String(failed.length)} artefact(s) are not what they claim:`);
  for (const f of failed) console.error(`  ${f}`);
  console.error('\nDo not publish.');
  process.exit(1);
}
// Say what was actually done. Claiming "every artefact was verified" after
// verifying none is the shape of lie this whole file exists to stop.
console.log(
  ran === 0
    ? 'Versions agree. No artefact was selected, so none was verified.'
    : `${String(ran)} artefact(s) built the way a stranger receives them, and ran.`,
);
