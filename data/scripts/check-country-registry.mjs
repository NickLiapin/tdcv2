#!/usr/bin/env node
/**
 * Every country pack on disk must be reachable.
 *
 * A country's first address segment is gated by `CANONICAL_COUNTRIES` in
 * `typescript/src/data-pack/locales.ts`. The list is hand-written, and it is
 * the only thing standing between a country directory and its addresses: with
 * no entry, `israel/docs/teudatZehut.txt` warns TDC171 on load and every
 * config asking for `israel.docs.teudatZehut` fails with "unknown template
 * path" — a whole pack in the repository, reachable by nobody.
 *
 * That is this project's recurring shape: a thing that says it is there, and
 * is not. Nothing caught it before, because the packs load fine, the tests
 * pass, and the only symptom is a warning nobody reads. Four country packs
 * were written into that state in a single afternoon.
 *
 * The four ports need no equivalent check. They resolve a country by asking
 * the pack source whether the directory exists, so a new directory is reachable
 * the moment it is written; the canonical list is reference-only, which is why
 * TDC171 is a declared reference-only diagnostic.
 *
 *   node data/scripts/check-country-registry.mjs            fail on any unregistered country
 *   node data/scripts/check-country-registry.mjs --update    add the missing entries
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const COUNTRIES_DIR = join(ROOT, 'data', 'packs', 'countries');
const LOCALES_TS = join(ROOT, 'typescript', 'src', 'data-pack', 'locales.ts');

/** The exact text span of the CANONICAL_COUNTRIES set literal. */
function countrySetSpan(source) {
  const declaration = 'export const CANONICAL_COUNTRIES: ReadonlySet<string> = new Set([';
  const start = source.indexOf(declaration);
  if (start === -1) {
    throw new Error(`cannot find CANONICAL_COUNTRIES in ${LOCALES_TS}`);
  }
  const open = start + declaration.length;
  const close = source.indexOf(']);', open);
  if (close === -1) {
    throw new Error(`CANONICAL_COUNTRIES in ${LOCALES_TS} is not closed with "]);"`);
  }
  return { open, close };
}

const source = readFileSync(LOCALES_TS, 'utf8');
const { open, close } = countrySetSpan(source);
const registered = new Set(
  [...source.slice(open, close).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
);

const onDisk = readdirSync(COUNTRIES_DIR)
  .filter((name) => statSync(join(COUNTRIES_DIR, name)).isDirectory())
  .sort();

const unregistered = onDisk.filter((name) => !registered.has(name));
const phantom = [...registered].filter((name) => !onDisk.includes(name)).sort();

if (process.argv.includes('--update')) {
  const merged = [...new Set([...registered, ...onDisk])].sort();
  const body = merged.map((name) => `\n  '${name}',`).join('');
  writeFileSync(LOCALES_TS, `${source.slice(0, open)}${body}\n${source.slice(close)}`);
  console.log(
    `CANONICAL_COUNTRIES: added ${String(unregistered.length)} — ` +
      `${unregistered.join(', ') || 'nothing'}`,
  );
  process.exit(0);
}

let failed = false;
if (unregistered.length > 0) {
  failed = true;
  console.error(
    `${String(unregistered.length)} country pack(s) exist but are UNREACHABLE — ` +
      'no entry in CANONICAL_COUNTRIES:\n' +
      `  ${unregistered.join(', ')}\n` +
      'Every address under them fails with "unknown template path".\n' +
      'Run `node data/scripts/check-country-registry.mjs --update` and commit the result.',
  );
}
if (phantom.length > 0) {
  failed = true;
  console.error(
    `${String(phantom.length)} country name(s) are registered with no pack on disk:\n` +
      `  ${phantom.join(', ')}\n` +
      'Either the directory was renamed, or the entry is a typo that will never match.',
  );
}
if (failed) process.exit(1);

console.log(
  `every country pack is reachable: ${String(onDisk.length)} directories, ` +
    'all present in CANONICAL_COUNTRIES',
);
