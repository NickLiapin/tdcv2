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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundledPacks, packParameterNames } from '../src/data-pack/load.ts';
import { parse } from '../src/parser/index.ts';
import { validate } from '../src/validator/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const DIR = resolve(here, '..', '..', 'fixtures', 'cross-language', 'diagnostics');

const update = process.argv.includes('--update');

// The bundled packs, exactly as the CLI and every port's harness supply them. Without
// them the reference cannot tell "this locale does not ship that path" (TDC217) from
// "no such path anywhere" (TDC071), and would record the wrong code for the other four
// to match.
const PACKS = bundledPacks();
const PACK_ADDRESSES = [...PACKS.keys()];
const PACK_PARAMS = packParameterNames(PACKS);

/**
 * Parse and validate, returning `severity code line:column` per diagnostic, in report order.
 *
 * A parse error stops the run: there is no tree to validate, and the parser's own complaint is
 * the only honest thing to report.
 */
function diagnose(source) {
  const parsed = parse(source);
  if (parsed.diagnostics.length > 0) {
    // A parser diagnostic carries no severity of its own — refusing to parse is never
    // advisory, so every consumer (the CLI renderer, the LSP) states `error` for it, and
    // so does this. Without that the reference would record `undefined` where the four
    // ports record `error`.
    return parsed.diagnostics.map((d) => `error ${d.code ?? 'PARSE'} ${d.line}:${d.column}`);
  }
  return validate(parsed.tree, {
    packAddresses: PACK_ADDRESSES,
    packParams: PACK_PARAMS,
  }).diagnostics.map(
    (d) => `${d.severity} ${d.code ?? '?'} ${d.line}:${d.column}`,
  );
}

let checked = 0;
let changed = 0;
const failures = [];

for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()) {
  const path = join(DIR, file);
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  let fileChanged = false;

  for (const testCase of doc.cases) {
    checked += 1;
    let actual;
    try {
      actual = diagnose(testCase.config);
    } catch (error) {
      failures.push(`${file} / ${testCase.name}: ${error.message}`);
      continue;
    }

    // `demonstrates` is the guard against a mis-transcribed config: a case named after TDC062
    // that quietly produces TDC050 instead would otherwise be recorded as correct and then
    // held over every implementation forever.
    if (
      testCase.demonstrates &&
      !actual.some((d) => d.split(' ')[1] === testCase.demonstrates)
    ) {
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
