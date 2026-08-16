/**
 * Derive the Bulgarian feminine surname list from the masculine one.
 *
 * Bulgarian surnames inflect for gender, and unlike Polish — where Kowalski
 * changes but Nowak does not — practically ALL of them do. Bulgarian family
 * names come in three shapes and each has a feminine form:
 *
 *   -ов  → -ова     Иванов → Иванова, Петров → Петрова
 *   -ев  → -ева     Георгиев → Георгиева, Стойчев → Стойчева
 *   -ски → -ска     Раковски → Раковска, Орешарски → Орешарска
 *
 * That is nearly the whole system, which puts Bulgarian at the opposite end of
 * the Slavic range from Serbian, where a woman carries her brother's surname
 * unchanged and the pack therefore ships no feminine list at all.
 *
 * The same suffixes inflect the MIDDLE name, which is the part outsiders miss.
 * A Bulgarian carries three names, and the middle one is a patronymic: the
 * father's given name with the same -ов / -ев ending. So the son of Петър in
 * the Георгиев family is Иван Петров Георгиев and his sister is Мария Петрова
 * Георгиева — two words changed, not one. That is why person/female/fullName.tdc
 * draws BOTH its middle name and its surname from the file this script writes.
 *
 * The two lists must stay ALIGNED LINE FOR LINE, because a config that draws a
 * surname by gender reads the same row index from both. Line 40 of
 * person/lastName.txt and line 40 of person/female/lastName.txt have to be the
 * same family, or a generated household ends up with a husband and wife whose
 * surnames are unrelated. Maintaining that by hand across several hundred rows
 * is exactly the kind of promise that quietly stops being true, so the feminine
 * list is not maintained at all: it is derived, and this script is the
 * derivation.
 *
 * An ending the rules do not cover is REFUSED rather than guessed. Bulgarian
 * has a thin tail of surnames outside the three shapes — Turkish-derived ones
 * that end in a consonant and take no suffix, and a handful in -а that are
 * already the same for both — and inventing a feminine form for one of those
 * would put a word that is not a name into the pack. There is no spelling test
 * that separates them, so they have to be listed in INVARIANT by hand.
 *
 *   node data/scripts/build-bg-surnames.mjs           rewrite the feminine list
 *   node data/scripts/build-bg-surnames.mjs --check   fail if it is out of date
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'packs', 'bg', 'person');
const MASCULINE = join(PACK, 'lastName.txt');
const FEMININE = join(PACK, 'female', 'lastName.txt');

const DESCRIPTION =
  'Bulgarian female surname — the feminine form parallel to the masculine list, line for line. ' +
  'Nearly every Bulgarian surname inflects: the patronymic types take -ова and -ева ' +
  '(Иванов → Иванова, Георгиев → Георгиева) and the adjectival type takes -ска ' +
  '(Раковски → Раковска). This file exists because Bulgarian is not Serbian: a Serbian woman ' +
  'carries her brother\'s surname unchanged, so the sr pack has no feminine list, while a ' +
  'Bulgarian woman changes hers, and changes her PATRONYMIC MIDDLE NAME as well — Иван Петров ' +
  'Георгиев has a sister Мария Петрова Георгиева. Draw this list twice for a full female name. ' +
  'Derived by data/scripts/build-bg-surnames.mjs — do not edit by hand.';

/**
 * The weight column, recomputed rather than copied from the source file so the
 * two lists are identical row for row by construction. The exponent is the
 * masculine list's own: a fitted rank decay that puts the commonest Bulgarian
 * surname near its real share of about 1.5%, where the pack's default rank^-0.1
 * curve would flatten it to roughly 0.5%.
 */
function weight(rank) {
  return Math.floor(1_000_000 * Math.pow(rank, -0.35));
}

/** Longest ending first, so -ски is seen before anything shorter. */
const RULES = [
  ['ски', 'ска'],
  ['ов', 'ова'],
  ['ев', 'ева'],
  ['ин', 'ина'],
];

/**
 * Surnames that do NOT inflect, kept as a list rather than as a rule because no
 * spelling test finds them — it is a fact about each word. Empty today: every
 * surname in the masculine list is one of the three regular shapes. It stays
 * here because the tail is real, and the next name added to the pack may be in
 * it.
 */
const INVARIANT = new Set([]);

function feminine(masculine) {
  for (const [from, to] of RULES) {
    if (masculine.endsWith(from)) return masculine.slice(0, -from.length) + to;
  }
  if (INVARIANT.has(masculine)) return masculine;
  return null; // an ending no rule covers — refuse rather than guess
}

/** Values of a pack list file, with the weight column stripped. */
function values(file) {
  const text = readFileSync(file, 'utf8');
  const body = text.startsWith('---') ? (text.split(/^---$/m)[2] ?? '') : text;
  return body
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.split(',')[0] ?? s);
}

const masculine = values(MASCULINE);
const refused = masculine.filter((m) => feminine(m) === null);
if (refused.length > 0) {
  console.error(
    `${String(refused.length)} masculine surname(s) end in something no rule covers:\n` +
      refused.map((m) => `  ${m}`).join('\n') +
      '\n\nEither add the ending to RULES, or list the word in INVARIANT if it does not inflect.',
  );
  process.exit(1);
}

const derived =
  '---\n' +
  `description: ${DESCRIPTION}\n` +
  'weighted: true\n' +
  'locale: bg\n' +
  '---\n' +
  masculine.map((m, i) => `${String(feminine(m))},${String(weight(i + 1))}`).join('\n') +
  '\n';

if (process.argv.includes('--check')) {
  if (readFileSync(FEMININE, 'utf8') !== derived) {
    console.error('bg female surnames are out of date — run: node data/scripts/build-bg-surnames.mjs');
    process.exit(1);
  }
  const inflected = masculine.filter((m) => feminine(m) !== m).length;
  console.log(
    `bg surnames aligned: ${String(masculine.length)} pairs, ${String(inflected)} of them inflected`,
  );
} else {
  writeFileSync(FEMININE, derived, 'utf8');
  console.log(`wrote ${String(masculine.length)} feminine surnames`);
}
