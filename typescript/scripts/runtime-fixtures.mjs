#!/usr/bin/env node
/**
 * The captured `.out` baselines: rewrite them, or verify them.
 *
 * These are the oldest fixtures in the repository — whole configs rendered
 * end to end, kept byte for byte. Several tests read them, and every one of
 * those renders the same way: `mode="memory"` with the clock pinned, because
 * the in-memory engine is the cross-language reference and a fixture that
 * reads the wall clock passes today and fails tomorrow. This script renders
 * them exactly that way too, so a re-record cannot quietly disagree with the
 * tests it is supposed to satisfy.
 *
 *   --update   rewrite every baseline from current behaviour. The diff is the
 *              review: a file that moved after an unrelated edit is a
 *              behaviour change nobody asked for.
 *   (default)  verify.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TDC } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(here, '..', '..', 'fixtures', 'cross-language');
const manifest = JSON.parse(readFileSync(resolve(SHARED, 'manifest.json'), 'utf8'));
const fixedNow = Date.parse(manifest.fixedNow);

const update = process.argv.includes('--update');

let changed = 0;
let stale = 0;
for (const fixture of manifest.runtimeFixtures) {
  const source = resolve(SHARED, fixture.source);
  const target = resolve(SHARED, fixture.expected);
  const actual = new TDC({ configFile: source, now: fixedNow, mode: 'memory' }).toString();
  const before = readFileSync(target, 'utf8');
  if (actual === before) continue;
  if (update) {
    writeFileSync(target, actual);
    console.log(`updated ${fixture.name}`);
    changed++;
  } else {
    console.error(`STALE  ${fixture.name} (${fixture.expected})`);
    stale++;
  }
}

const total = manifest.runtimeFixtures.length;
if (update) {
  console.log(`${String(total)} runtime fixtures, ${String(changed)} updated`);
} else if (stale > 0) {
  console.error(
    `\n${String(stale)} of ${String(total)} runtime fixtures no longer match the engine. ` +
      'Re-record with `npm run fixtures:update` and review the diff.',
  );
  process.exitCode = 1;
} else {
  console.log(`${String(total)} runtime fixtures match`);
}
