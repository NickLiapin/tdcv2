#!/usr/bin/env node
/**
 * Regenerate `fixtures/cross-language/quick-vectors.json` from the reference.
 *
 * The quick API is five implementations of one contract — the same synthesised
 * config, the same 512-row batch, the same `#`-derived seed for the batch after
 * it — and nothing but a shared fixture keeps them honest about it. The values
 * here are captured from THIS implementation because TypeScript is the
 * reference; the other four read the file and must reproduce it.
 *
 * The 600-value case is the important one. Everything below 512 comes out of a
 * single underlying run, so two implementations can agree on all of it while
 * disagreeing completely about what happens when that run is exhausted — which
 * is the bug a user would hit first and report last.
 *
 *   npm run fixtures:quick            # rewrite the fixture
 *   npm run fixtures:quick -- --check # fail if it would change
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BATCH_ROWS, QuickDraw } from '../dist/quick/draw.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET = join(ROOT, 'fixtures', 'cross-language', 'quick-vectors.json');

const ADDRESSES = [
  { seed: 'demo', locale: 'en', address: 'person.lastName', count: 5 },
  { seed: 'demo', locale: 'en', address: 'person.male.firstName', count: 3 },
  { seed: 'demo', locale: 'en', address: 'company.industry', count: 2 },
  { seed: 'demo', locale: 'en', address: 'common.id.uuid', count: 2 },
  { seed: 'demo', locale: 'en', address: 'common.finance.iban', count: 2 },
  { seed: 'demo', locale: 'en', address: 'usa.docs.ssn', count: 3 },
  { seed: 'other', locale: 'en', address: 'person.lastName', count: 3 },
  { seed: 'l', locale: 'en', address: 'person.lastName', count: 1 },
  // Crosses the batch boundary: the one place implementations drift.
  { seed: 'batch', locale: 'en', address: 'person.lastName', count: 600 },
];

const GENERATORS = [
  { seed: 'demo', type: 'number', attrs: { value: '18..80' }, count: 1 },
  { seed: 'x', type: 'number', attrs: { value: '1..1000' }, count: 4 },
  { seed: 'r', type: 'regex', attrs: { value: '[A-Z]{3}-[0-9]{4}' }, count: 3 },
];

const document = {
  schemaVersion: 1,
  $comment:
    'The quick API — one value, one call, no config — as the TypeScript reference computes ' +
    'it. Every implementation opens a run of 512 rows under the given seed, reads values from ' +
    'it in order, and reopens under the seed plus "#<batch>" when that run is exhausted; the ' +
    '600-value case is there because that boundary is the one place two implementations drift ' +
    'without anything else noticing. Regenerate with `npm run fixtures:quick`.',
  batchRows: BATCH_ROWS,
  addresses: ADDRESSES.map((c) => ({
    ...c,
    expected: new QuickDraw(c.seed, c.locale).draw(
      { type: 'template', attrs: { value: c.address } },
      c.count,
    ),
  })),
  generators: GENERATORS.map((g) => ({
    ...g,
    expected: new QuickDraw(g.seed, undefined).draw({ type: g.type, attrs: g.attrs }, g.count),
  })),
};

const rendered = `${JSON.stringify(document, null, 2)}\n`;

if (process.argv.includes('--check')) {
  const current = readFileSync(TARGET, 'utf8');
  if (current !== rendered) {
    console.error(
      'quick-vectors.json is out of date with this implementation.\n' +
        'Run `npm run fixtures:quick` and commit the result — or, if the change was ' +
        'not intended, the reference just moved and the other four will now disagree.',
    );
    process.exit(1);
  }
  console.log(
    `quick vectors match (${String(document.addresses.length)} addresses, ` +
      `${String(document.generators.length)} generators)`,
  );
} else {
  writeFileSync(TARGET, rendered);
  console.log(`wrote ${TARGET}`);
}
