/**
 * Derive the two dependent Ukrainian surname files from the masculine one.
 *
 * Ukrainian surnames fall into two groups. The patronymic ones — Шевченко,
 * Ковальчук, Бондар, Мороз — are nouns and do not change: a man and a woman
 * carry exactly the same string. The adjectival ones do change: Ковальський /
 * Ковальська, Хмельницький / Хмельницька, Білий / Біла.
 *
 * That split is what the three files encode:
 *
 *   person/male/lastName.txt     the master list, every surname, masculine form
 *   person/female/lastName.txt   the same list, feminine form, LINE FOR LINE
 *   person/lastName.txt          only the surnames that do not decline
 *
 * The line-for-line promise is the whole point of the second file. A config that
 * draws a household reads the same row index from both, so line 40 of one and
 * line 40 of the other have to be the same family — otherwise a husband and wife
 * end up with unrelated surnames. Two hundred rows of that maintained by hand is
 * a promise that quietly stops being true, so the feminine list is not
 * maintained: it is derived, and this is the derivation.
 *
 * The third file is derived from the same source for the same reason. Its header
 * claims it holds the non-declining forms; computing it means the claim cannot
 * drift away from the list it describes.
 *
 * An ending no rule covers is REFUSED rather than guessed.
 *
 *   node data/scripts/build-uk-surnames.mjs           rewrite both derived files
 *   node data/scripts/build-uk-surnames.mjs --check   fail if they are stale
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'packs', 'uk', 'person');
const MASCULINE = join(PACK, 'male', 'lastName.txt');
const FEMININE = join(PACK, 'female', 'lastName.txt');
const NEUTRAL = join(PACK, 'lastName.txt');

/** Adjectival endings, longest first so -цький is seen before -ький. */
const RULES = [
  ['ський', 'ська'],
  ['цький', 'цька'],
  ['зький', 'зька'],
  ['ий', 'а'],
];

/**
 * The weight column: a decaying frequency curve, floor(1e6 * rank^-0.1). The
 * numbers already in the pack were produced this way, so recomputing them
 * reproduces the file rather than rewriting it.
 */
function weight(rank) {
  return Math.floor(1_000_000 * Math.pow(rank, -0.1));
}

/**
 * Surnames that end in -ій and are NOT adjectival, so they stay as they are.
 * Салій, Бабій, Багрій and Заводій are nouns: a woman carries the same string.
 * Kept as a list rather than a rule because no spelling test separates them from
 * a genuine adjectival ending — it is a fact about each word.
 */
const INVARIANT = new Set(['Салій', 'Бабій', 'Багрій', 'Заводій']);

function feminine(masculine) {
  for (const [from, to] of RULES) {
    if (masculine.endsWith(from)) return masculine.slice(0, -from.length) + to;
  }
  if (INVARIANT.has(masculine)) return masculine;
  if (/[иі]й$/.test(masculine)) return null; // an adjectival ending no rule covers
  return masculine;
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

function file(description, names) {
  return (
    '---\n' +
    `description: ${description}\n` +
    'weighted: true\n' +
    '---\n' +
    names.map((n, i) => `${n},${String(weight(i + 1))}`).join('\n') +
    '\n'
  );
}

const masculine = values(MASCULINE);
const refused = masculine.filter((m) => feminine(m) === null);
if (refused.length > 0) {
  console.error(
    `${String(refused.length)} masculine surname(s) end in -й and no rule covers them:\n` +
      refused.map((m) => `  ${m}`).join('\n') +
      '\n\nEither add the ending to RULES, or list the word in INVARIANT if it does not inflect.',
  );
  process.exit(1);
}

const derivedFeminine = file(
  'Ukrainian female surname, the feminine form of the same surname at the same line as person/male/lastName. ' +
    'Patronymic surnames (-енко, -ук/-чук, -ар) do not change; adjectival ones (-ський/-цький, -ий) do: ' +
    'Ковальський → Ковальська, Білий → Біла.',
  masculine.map((m) => feminine(m)),
);
const derivedNeutral = file(
  'Ukrainian surname, gender-neutral — the forms that do not decline, so a man and a woman carry the same string. ' +
    'For a surname that does have a feminine form use person.male.lastName / person.female.lastName.',
  masculine.filter((m) => feminine(m) === m),
);

if (process.argv.includes('--check')) {
  const stale = [
    readFileSync(FEMININE, 'utf8') === derivedFeminine ? null : 'person/female/lastName.txt',
    readFileSync(NEUTRAL, 'utf8') === derivedNeutral ? null : 'person/lastName.txt',
  ].filter(Boolean);
  if (stale.length > 0) {
    console.error(
      `${stale.join(' and ')} out of date — run: node data/scripts/build-uk-surnames.mjs`,
    );
    process.exit(1);
  }
  const inflected = masculine.filter((m) => feminine(m) !== m).length;
  console.log(
    `uk surnames aligned: ${String(masculine.length)} pairs, ${String(inflected)} of them inflected, ` +
      `${String(masculine.length - inflected)} gender-neutral`,
  );
} else {
  writeFileSync(FEMININE, derivedFeminine, 'utf8');
  writeFileSync(NEUTRAL, derivedNeutral, 'utf8');
  console.log(`wrote ${String(masculine.length)} feminine surnames and the gender-neutral subset`);
}
