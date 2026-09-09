#!/usr/bin/env node
/**
 * The shared diagnostic cases: fill the codes a config produces, or verify them.
 *
 * A sibling of `cross-language-cases.mjs`, and it exists for the same reason. "The same config
 * behaves the same way in every implementation" is only half true if one of them accepts a
 * config the other refuses — a config that runs in Java and fails in TypeScript is a portability
 * bug even though no value was ever wrong.
 *
 * A case records the severity, the stable code and where the diagnostic points, never the
 * message text. Wording is edited
 * for clarity over time and holding three implementations to a sentence would make every
 * improvement a breaking change; the code is the contract, which is what it was introduced for.
 *
 *   --update   rewrite every `expected` from current behaviour
 *   (default)  verify
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// How a case is DIAGNOSED lives in one module now, shared with the suite, which runs these same
// fixtures under coverage. See `shared-fixtures.mjs`.
import { DIAGNOSTICS_DIR as DIR, diagnoseCase } from './shared-fixtures.ts';

const update = process.argv.includes('--update');

let checked = 0;
let changed = 0;
const failures = [];

for (const file of readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()) {
  const path = join(DIR, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  let fileChanged = false;

  for (const testCase of doc.cases) {
    checked += 1;
    let actual;
    try {
      actual = diagnoseCase(testCase.config, testCase.dataPath);
    } catch (error) {
      failures.push(`${file} / ${testCase.name}: ${error.message}`);
      continue;
    }

    // `demonstrates` is the guard against a mis-transcribed config: a case named after TDC062
    // that quietly produces TDC050 instead would otherwise be recorded as correct and then
    // held over every implementation forever.
    if (testCase.demonstrates && !actual.some((d) => d.split(' ')[1] === testCase.demonstrates)) {
      failures.push(
        `${file} / ${testCase.name}: claims to demonstrate ${testCase.demonstrates}, ` +
          `but the reference reports ${JSON.stringify(actual)}`,
      );
      continue;
    }

    const before = JSON.stringify(testCase.expected ?? null);
    if (update) {
      if (before !== JSON.stringify(actual)) {
        testCase.expected = actual;
        fileChanged = true;
        changed += 1;
      }
      continue;
    }
    if (before !== JSON.stringify(actual)) {
      failures.push(
        `${file} / ${testCase.name}\n` +
          `  expected: ${before}\n` +
          `  actual:   ${JSON.stringify(actual)}`,
      );
    }
  }

  if (fileChanged) {
    writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`updated ${file}`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} of ${checked} diagnostic cases do not match:\n`);
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    'If the change is intended, run `npm run diagnostics:update` and review the diff.\n' +
      'A code that changes here changes what every implementation must report.',
  );
  process.exit(1);
}

console.log(
  update
    ? `${checked} diagnostic cases, ${changed} updated`
    : `${checked} diagnostic cases match the reference`,
);
