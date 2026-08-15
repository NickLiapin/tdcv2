/**
 * Derive the Polish feminine surname list from the masculine one.
 *
 * Polish adjectival surnames inflect: Kowalski / Kowalska, Nowicki / Nowicka,
 * Zawadzki / Zawadzka, Konieczny / Konieczna. The nominal ones — Nowak, Wójcik,
 * Mazur — do not change at all.
 *
 * The two files must stay ALIGNED LINE FOR LINE, because a config that draws a
 * surname by gender reads the same row index from both. Line 40 of
 * `person/lastName.txt` and line 40 of `person/female/lastName.txt` have to be
 * the same family, or a generated household ends up with a husband and wife whose
 * surnames are unrelated. Maintaining that by hand across several hundred rows is
 * exactly the kind of promise that quietly stops being true, so the feminine list
 * is not maintained at all: it is derived, and this script is the derivation.
 *
 * An ending the rules do not cover is REFUSED rather than guessed. Polish has
 * masculine surnames ending in -y that are not adjectival, and inventing a
 * feminine form for one would put a word that is not a name into the pack.
 *
 *   node data/scripts/build-pl-surnames.mjs           rewrite the feminine list
 *   node data/scripts/build-pl-surnames.mjs --check   fail if it is out of date
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'packs', 'pl', 'person');
const MASCULINE = join(PACK, 'lastName.txt');
const FEMININE = join(PACK, 'female', 'lastName.txt');

const HEADER =
  '---\n' +
  'description: Polish female surname — the feminine form parallel to the masculine list, line for line. ' +
  'Adjectival surnames take -ska / -cka / -dzka; nominal ones (Nowak, Wojcik, Lis) do not change.\n' +
  'locale: pl\n' +
  '---\n';

/** Adjectival endings, longest first so -dzki is seen before -ki. */
const RULES = [
  ['dzki', 'dzka'],
  ['cki', 'cka'],
  ['ski', 'ska'],
  ['szy', 'sza'],
  ['ny', 'na'],
  ['ły', 'ła'],
  ['wy', 'wa'],
];

/**
 * Masculine surnames that end in -y or -i and are NOT adjectival, so they stay
 * as they are. Kept as a list rather than a rule because there is no spelling
 * test that separates them — it is a fact about each word.
 */
const INVARIANT = new Set(['Antoni', 'Kacy', 'Krasy']);

function feminine(masculine) {
  for (const [from, to] of RULES) {
    if (masculine.endsWith(from)) return masculine.slice(0, -from.length) + to;
  }
  if (INVARIANT.has(masculine)) return masculine;
  if (/[yi]$/.test(masculine)) return null; // an ending no rule covers
  return masculine;
}

function values(file) {
  const text = readFileSync(file, 'utf8');
  const body = text.startsWith('---') ? (text.split(/^---$/m)[2] ?? '') : text;
  return body
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

const masculine = values(MASCULINE);
const refused = masculine.filter((m) => feminine(m) === null);
if (refused.length > 0) {
  console.error(
    `${String(refused.length)} masculine surname(s) end in -y or -i and no rule covers them:\n` +
      refused.map((m) => `  ${m}`).join('\n') +
      '\n\nEither add the ending to RULES, or list the word in INVARIANT if it does not inflect.',
  );
  process.exit(1);
}

const derived = HEADER + masculine.map((m) => feminine(m)).join('\n') + '\n';

if (process.argv.includes('--check')) {
  if (readFileSync(FEMININE, 'utf8') !== derived) {
    console.error(
      'pl female surnames are out of date — run: node data/scripts/build-pl-surnames.mjs',
    );
    process.exit(1);
  }
  const inflected = masculine.filter((m) => feminine(m) !== m).length;
  console.log(
    `pl surnames aligned: ${String(masculine.length)} pairs, ${String(inflected)} of them inflected`,
  );
} else {
  writeFileSync(FEMININE, derived, 'utf8');
  console.log(`wrote ${String(masculine.length)} feminine surnames`);
}
