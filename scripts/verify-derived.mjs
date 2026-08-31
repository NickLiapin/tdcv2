#!/usr/bin/env node
/**
 * Everything in this repository that is GENERATED from something else, checked
 * in about half a minute.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every red build here for a week was the same shape, and none of them was a
 * bug in the code that was pushed:
 *
 *   - 25 country packs landed; `src/quick/addresses.ts` was not regenerated
 *   - a locale pack landed; `data/bundles.json` had no entry, so it shipped to
 *     nobody
 *   - a pack shipped; three READMEs still claimed the old language count
 *   - a pack's descriptions were edited AFTER the bundles were built, so the
 *     docs catalogue recorded a byte size that no longer existed
 *   - Bambara was written; a shared diagnostics fixture had been using it as
 *     its example of a locale with NO date translations
 *   - three half-written packs were committed; the derived files had been
 *     generated from a copy that excluded them
 *
 * Each was found twenty-five minutes into CI, fixed in one line, and pushed
 * again. The information needed to catch every one of them was on the disk the
 * whole time — nobody had asked. This asks, before the push, in the time it
 * takes to read the commit message you just wrote.
 *
 * It deliberately does NOT run the test suites or the five-language gate. Those
 * take minutes and belong in CI; a pre-push hook that costs minutes is a
 * pre-push hook people learn to skip, and a check nobody runs is worse than no
 * check because it also lies about being there.
 *
 *   node scripts/verify-derived.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Each check names the command that FIXES it, because "out of date" without
 * "run this" is a puzzle, and the person hitting it is usually mid-push and
 * thinking about something else.
 */
const CHECKS = [
  {
    what: 'data packs ship, are named, and hold together',
    run: ['npm', ['run', 'packs:generated', '--silent']],
    fix: 'node typescript/scripts/refresh-bundle-manifest.mjs   (then fix any README count it names)',
  },
  {
    what: 'the Quick API address tree matches the packs',
    run: ['npm', ['--prefix', 'typescript', 'run', 'quick:check', '--silent']],
    fix: 'npm --prefix typescript run quick:types',
  },
  {
    what: 'the Quick API vectors still hold',
    run: ['npm', ['--prefix', 'typescript', 'run', 'quick:vectors', '--silent']],
    fix: 'npm --prefix typescript run fixtures:quick',
  },
  {
    what: 'the docs catalogue and the exported markdown match the source',
    run: ['npm', ['--prefix', 'webdoc', 'run', 'docs:check', '--silent']],
    fix: 'node webdoc/scripts/build-pack-catalogue.mjs && npm --prefix webdoc run docs:export',
  },
  {
    what: 'the shared diagnostics fixtures match the reference',
    run: ['npm', ['--prefix', 'typescript', 'run', 'diagnostics', '--silent']],
    fix: 'npm --prefix typescript run diagnostics:update',
  },
  {
    what: 'the shared cases match the reference',
    run: ['npm', ['--prefix', 'typescript', 'run', 'cases', '--silent']],
    fix: 'npm --prefix typescript run cases:update',
  },
  {
    what: 'the runtime fixtures match the reference',
    run: ['npm', ['--prefix', 'typescript', 'run', 'fixtures', '--silent']],
    fix: 'npm --prefix typescript run fixtures:update',
  },
  {
    what: 'the engine fixtures match the reference',
    run: ['npm', ['--prefix', 'typescript', 'run', 'engines', '--silent']],
    fix: 'npm --prefix typescript run engines:update',
  },
];

const failures = [];
const started = Date.now();

for (const check of CHECKS) {
  const [command, args] = check.run;
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  const ok = result.status === 0;
  process.stdout.write(`${ok ? '  ok  ' : '  --  '}${check.what}\n`);
  if (!ok) {
    failures.push({
      ...check,
      output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
    });
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(0);

if (failures.length === 0) {
  process.stdout.write(`\nevery generated file is up to date (${seconds}s)\n`);
  process.exit(0);
}

process.stderr.write(`\n${String(failures.length)} generated file(s) are out of date:\n`);
for (const failure of failures) {
  process.stderr.write(`\n── ${failure.what}\n`);
  const lines = failure.output.split('\n').filter((l) => l.trim().length > 0);
  // The tail is where these tools put the verdict; the head is npm's noise.
  for (const line of lines.slice(-8)) process.stderr.write(`   ${line}\n`);
  process.stderr.write(`   FIX: ${failure.fix}\n`);
}
process.stderr.write(
  '\nRegenerate, commit the result, and push again. To push anyway: git push --no-verify\n',
);
process.exit(1);
