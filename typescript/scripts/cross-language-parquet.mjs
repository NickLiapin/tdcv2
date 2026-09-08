#!/usr/bin/env node
/**
 * The Parquet fixture: a config, and the exact bytes it must produce.
 *
 * Two Parquet writers can both be correct and disagree byte for byte — the format leaves
 * compression and match-finding to the encoder, so "a reader opens it" is not the property this
 * project promises. It promises the files MATCH, which only a digest can check.
 *
 * So each case records the file's length and its SHA-256. A port that produces a valid file with
 * different bytes fails here, which is the point: the moment two implementations diverge, one of
 * them has silently made a choice the other did not.
 *
 * The cases live in the fixture itself, not here. They used to live in this file, and two cases
 * added straight to the JSON — the MAP columns and the typed <mix> column — were then invisible
 * to `--update`, which rewrites the file from its own list: the next update would have deleted
 * both without a word, and `npm run parquet` had been failing with "the case is gone from the
 * script" in the meantime. One source, the way the shared cases already work.
 *
 *   --update   rewrite the digests from current behaviour; the diff is the review.
 *   (default)  verify.
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderParquet } from '../src/output/render-parquet.ts';
import { parseStrict } from '../src/parser/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const SHARED = resolve(here, '..', '..', 'fixtures', 'cross-language');
const OUT = join(SHARED, 'parquet.json');
/** A case that reads a file names a folder here, the way the shared cases already do. */
const CASES_DIR = join(SHARED, 'cases');

const NOW = Date.parse('2026-04-23T12:00:00Z');
const update = process.argv.includes('--update');

/** The fixture is the source: every case is a whole config, wiring tested along with the encoder. */
let document;
try {
  document = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  console.error(`${OUT} is missing or unreadable`);
  process.exit(1);
}
const CASES = document.cases;

const results = CASES.map((testCase) => {
  const options = { now: NOW };
  if (testCase.dataPath !== undefined) options.dataPaths = [join(CASES_DIR, testCase.dataPath)];
  const bytes = renderParquet(parseStrict(testCase.config), options);
  return {
    name: testCase.name,
    description: testCase.description,
    config: testCase.config,
    ...(testCase.dataPath === undefined ? {} : { dataPath: testCase.dataPath }),
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
});

if (update) {
  writeFileSync(OUT, `${JSON.stringify({ ...document, cases: results }, null, 2)}\n`);
  console.log(`parquet.json: ${results.length} cases written`);
  process.exit(0);
}

const failures = [];
for (const [i, expected] of CASES.entries()) {
  const actual = results[i];
  if (actual.size !== expected.size || actual.sha256 !== expected.sha256) {
    failures.push(
      `${expected.name}\n  expected: ${expected.size} bytes, ${expected.sha256}\n` +
        `  actual:   ${actual.size} bytes, ${actual.sha256}`,
    );
  }
}
if (failures.length > 0) {
  console.error(`Parquet output changed:\n\n${failures.join('\n\n')}\n`);
  console.error('If the change is intended, run `npm run parquet:update` and review the diff.');
  process.exit(1);
}
console.log(`parquet.json: ${results.length} cases match the reference`);
