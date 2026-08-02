#!/usr/bin/env node
/**
 * The shared behaviour cases: fill their expected output, or verify it.
 *
 * The reference implementation is the only thing allowed to write `expected`.
 * Hand-written expectations are how a port ends up encoding what somebody
 * believed on the day they wrote the test, and this whole directory exists so
 * that Java and Python are checked against what TypeScript actually does.
 *
 * Two modes, and both matter:
 *
 *   --update   rewrite every `expected` from current behaviour. The diff is the
 *              review: a case that changed after an unrelated edit is a
 *              behaviour change nobody asked for.
 *   (default)  verify. Wired into `npm run check`, so the reference cannot
 *              drift away from the fixtures the other languages are held to.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TDC } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolve(here, '..', '..', 'fixtures', 'cross-language', 'cases');

const update = process.argv.includes('--update');

/** Render one case exactly as every implementation must. */
function render(testCase) {
  const options = { configString: testCase.config };
  if (testCase.seed !== undefined) options.seed = testCase.seed;
  if (testCase.count !== undefined) options.count = testCase.count;
  if (testCase.locale !== undefined) options.locale = testCase.locale;
  // A case that reads the clock has to pin it, or it passes today and fails tomorrow.
  if (testCase.now !== undefined) options.now = Date.parse(testCase.now);
  return new TDC(options).toString();
}

/**
 * Text to the `expected` array. The output always ends in a newline, so the
 * final empty piece of the split is dropped rather than stored as a blank line.
 */
function toLines(text) {
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function fromLines(lines) {
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

let checked = 0;
let changed = 0;
const failures = [];

for (const file of readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const path = join(CASES_DIR, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  let fileChanged = false;

  for (const testCase of doc.cases) {
    checked += 1;
    let actual;
    try {
      actual = render(testCase);
    } catch (error) {
      failures.push(`${file} / ${testCase.name}: ${error.message}`);
      continue;
    }
    const lines = toLines(actual);

    if (update) {
      if (fromLines(testCase.expected ?? []) !== actual) {
        testCase.expected = lines;
        fileChanged = true;
        changed += 1;
      }
      continue;
    }

    if (fromLines(testCase.expected ?? []) !== actual) {
      failures.push(
        `${file} / ${testCase.name}\n` +
          `  expected: ${JSON.stringify(testCase.expected ?? [])}\n` +
          `  actual:   ${JSON.stringify(lines)}`,
      );
    }
  }

  if (fileChanged) {
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`updated ${file}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checked} shared cases do not match the reference:\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    'If the change is intended, run `npm run cases:update` and review the diff.\n' +
      'Every other implementation is held to these files, so a change here changes all of them.',
  );
  process.exit(1);
}

console.log(
  update
    ? `${checked} shared cases, ${changed} updated`
    : `${checked} shared cases match the reference`,
);
