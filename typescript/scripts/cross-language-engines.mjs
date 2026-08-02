#!/usr/bin/env node
/**
 * The shared cases, run again on the streaming engines.
 *
 * The `expected` in each case file is what the in-memory engine produces. That is not what the
 * streaming engines produce — they draw by row index rather than in order, so the same seed
 * gives a different column. Both are correct and neither is the other's reference.
 *
 * What must hold across languages is that TypeScript's Engine 2 and Java's Engine 2 agree with
 * each other, value for value. So this records what the reference's streaming engines do with
 * every shared case, including which ones they refuse, and the ports are held to that.
 *
 * A refusal is recorded as deliberately as a value. An engine that quietly answers a config it
 * cannot do correctly is worse than one that stops, and "did the port refuse the same configs"
 * is exactly the question a message-by-message comparison could not answer.
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
  return new TDC(options).toString();
}

function toLines(text) {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

const results = {};
let refused = 0;
let produced = 0;

for (const file of readdirSync(CASES_DIR).filter((f) => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8'));
  for (const testCase of doc.cases) {
    const key = `${file.replace(/\.json$/, '')}/${testCase.name}`;
    const entry = {};
    for (const engine of ENGINES) {
      try {
        entry[`engine${engine}`] = { lines: toLines(render(testCase, engine)) };
        produced += 1;
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
    'Engine 1 output lives in the cases themselves; the engines draw differently, so the two ' +
    'do not match and are not meant to. Regenerate with: npm run fixtures:engines -- --update',
  engines: ENGINES,
  cases: results,
};
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
  console.error(`${OUT} is missing or unreadable — run: npm run fixtures:engines -- --update`);
  process.exit(1);
}
// Compared as data, not as text: the repo's formatter owns the whitespace in this file, and a
// re-indent is not a behaviour change.
if (JSON.stringify(current) !== JSON.stringify(document)) {
  console.error(
    'engines.json no longer matches what the streaming engines do.\n' +
      'If the change was intended, run: npm run fixtures:engines -- --update',
  );
  process.exit(1);
}
console.log(`engines.json: ${produced} rendered, ${refused} refused — all match`);
