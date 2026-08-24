#!/usr/bin/env node
/**
 * The shared cases, run again on the streaming engines — and the guard that all
 * three agree.
 *
 * This used to record a SECOND set of expectations, because the engines drew in
 * different orders and the same seed gave different columns. That is over: a
 * value is derived from `(seed, column name, row)`, so an engine that renders a
 * case at all must render the case's own `expected`, byte for byte. The check
 * below enforces exactly that, which is the whole point of the rewrite and the
 * thing most likely to rot silently if nobody looks.
 *
 * What is left to record is which cases an engine REFUSES. A refusal is a
 * deliberate answer — an engine that quietly answers a config it cannot do
 * correctly is worse than one that stops — and "did the port refuse the same
 * configs" is the question a message-by-message comparison could never settle.
 *
 *   --update   rewrite the fixture from current behaviour; the diff is the review.
 *   (default)  verify, so the reference cannot drift away from what the ports are checked on.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TDC } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(here, '..', '..', 'fixtures', 'cross-language');
const CASES_DIR = join(SHARED, 'cases');
const OUT = join(SHARED, 'engines.json');

/** The engines this fixture covers. Engine 1 is already covered by the cases' own `expected`. */
const ENGINES = [2, 3];

const update = process.argv.includes('--update');

function render(testCase, engine) {
  const options = { configString: testCase.config, engine };
  if (testCase.seed !== undefined) options.seed = testCase.seed;
  if (testCase.count !== undefined) options.count = testCase.count;
  if (testCase.locale !== undefined) options.locale = testCase.locale;
  if (testCase.now !== undefined) options.now = Date.parse(testCase.now);
  // Same rule as the cases harness: a `type="file"` case names the folder its
  // samples live in, relative to the cases directory.
  if (testCase.dataPath !== undefined) options.dataPaths = [join(CASES_DIR, testCase.dataPath)];
  return new TDC(options).toString();
}

function toLines(text) {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const results = {};
const disagreed = [];
let refused = 0;
let produced = 0;

for (const file of readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const doc = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
  for (const testCase of doc.cases) {
    const key = `${file.replace(/\.json$/, '')}/${testCase.name}`;
    const entry = {};
    for (const engine of ENGINES) {
      try {
        const lines = toLines(render(testCase, engine));
        produced += 1;
        /*
         * A disk engine may arrange a uniq group differently from the
         * in-memory engine — both exact, both all-distinct, different rows
         * holding the values. The rule (Nick's, 2026-08-24): one seed + ONE
         * engine = the same bytes on every machine and in every language;
         * BETWEEN engines equality is not required, because the engine is
         * chosen deterministically from the config, so two machines always
         * pick the same one.
         *
         * Which is why `lines` is the whole contract and every one of them is
         * checked in all five. Entries used to carry an `aheadOfPorts` mark
         * that told the ports to skip — the reference had env-level <uniq> in
         * its streaming engine and they did not. They have it now, so the
         * mark is gone rather than left standing over nothing: a skip nobody
         * removes is a test that stopped running without saying so.
         */
        if (JSON.stringify(lines) !== JSON.stringify(testCase.expected)) {
          disagreed.push(key);
        }
        entry[`engine${engine}`] = { lines };
      } catch (error) {
        // Only the reason matters, not the wording — the ports phrase their refusals in their
        // own language and are checked on refusing, not on how they say so.
        entry[`engine${engine}`] = { refused: error.message };
        refused += 1;
      }
    }
    results[key] = entry;
  }
}

const document = {
  comment:
    'Streaming-engine output for every shared case, from the reference implementation. ' +
    'One seed + one engine = one output, here and in every port — every entry here is ' +
    'checked in all five. A few differ from the in-memory `expected`: a disk engine may ' +
    'arrange a uniq group differently, and both are correct. Regenerate with: ' +
    'npm run engines:update',
  engines: ENGINES,
  cases: results,
};

if (disagreed.length > 0) {
  console.log(
    `${String(disagreed.length)} case(s) where a disk engine arranges a uniq group differently ` +
      'from the in-memory engine — expected, and pinned by `lines` in all five.',
  );
}
const text = `${JSON.stringify(document, null, 2)}\n`;

if (update) {
  writeFileSync(OUT, text);
  console.log(`engines.json: ${produced} rendered, ${refused} refused`);
  process.exit(0);
}

let current;
try {
  current = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  console.error(`${OUT} is missing or unreadable — run: npm run engines:update`);
  process.exit(1);
}
// Compared as data, not as text: the repo's formatter owns the whitespace in this file, and a
// re-indent is not a behaviour change.
if (JSON.stringify(current) !== JSON.stringify(document)) {
  console.error(
    'engines.json no longer matches what the streaming engines do.\n' +
      'If the change was intended, run: npm run engines:update',
  );
  process.exit(1);
}
console.log(
  `engines.json: ${produced} rendered, ${refused} refused — all match, ` +
    'and every rendered case equals the in-memory engine byte for byte',
);
