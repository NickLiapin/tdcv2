/**
 * Build the Russian name lists, with the feminine forms derived rather than typed.
 *
 * Russian surnames and patronymics come in two grammatical genders — Иванов and
 * Иванова, Иванович and Ивановна — and the pack keeps them in separate files whose
 * lines must stay ALIGNED: line 7 of `male/lastName.txt` and line 7 of
 * `female/lastName.txt` have to be the same surname, or a config that draws a
 * surname by gender hands a family two different names.
 *
 * Typing both lists by hand guarantees that alignment breaks eventually. So only
 * the masculine list is written down here, and the feminine one is derived by the
 * rules below — the alignment is then a property of the code rather than of
 * somebody's care.
 *
 * ── Weights ──────────────────────────────────────────────────────────────────
 * The English pack is weighted from real counts and says so: "US surnames by
 * frequency (US Census 2010, top 1000)", with `Smith,2442977`. Russian frequency
 * is just as skewed — Иванов, Смирнов and Кузнецов dwarf the tail — so an
 * unweighted list makes Живаго as common as Иванов, which no reader believes.
 *
 * But there is no count here to cite. The lists are ordered by frequency and the
 * weights are derived from that RANK, on a Zipf curve. The description says so
 * rather than implying a census: a plausible number with an invented source is
 * worse than an honest approximation.
 *
 *   node data/scripts/build-ru-names.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACK = join(HERE, '..', 'packs', 'ru', 'person');

/**
 * Masculine surname → feminine surname.
 *
 * The endings that decline, in the order they must be tested: the -ский/-цкий
 * family before the bare -ий it contains, and -ой before -ий for the same reason.
 * Anything that matches none of them does not decline (Шевченко, Черных, Живаго)
 * and belongs in the gender-neutral file instead, so reaching the end is a fault
 * in the input rather than a case to handle quietly.
 */
const DECLENSIONS = [
  [/ский$/, 'ская'],
  [/цкий$/, 'цкая'],
  [/ской$/, 'ская'],
  [/цкой$/, 'цкая'],
  [/ый$/, 'ая'],
  [/ой$/, 'ая'],
  [/ий$/, 'яя'],
  [/ёв$/, 'ёва'],
  [/ев$/, 'ева'],
  [/ов$/, 'ова'],
  [/ин$/, 'ина'],
  [/ын$/, 'ына'],
];

export function feminineSurname(masculine) {
  for (const [ending, replacement] of DECLENSIONS) {
    if (ending.test(masculine)) return masculine.replace(ending, replacement);
  }
  throw new Error(
    `"${masculine}" does not decline by any known rule — an indeclinable surname ` +
      'belongs in person/lastName.txt, which is the gender-neutral list',
  );
}

/** `Иванович` → `Ивановна`. Every Russian patronymic ends one of three ways. */
export function femininePatronymic(masculine) {
  for (const [ending, replacement] of [
    [/ович$/, 'овна'],
    [/евич$/, 'евна'],
    [/ьич$/, 'инична'],
    [/ич$/, 'ична'],
  ]) {
    if (ending.test(masculine)) return masculine.replace(ending, replacement);
  }
  throw new Error(`"${masculine}" is not a patronymic this script knows how to decline`);
}

/**
 * Rank → weight, on a Zipf curve.
 *
 * Zipf is the shape surname frequency actually takes, and it is what makes the
 * top of the list dominate the way it does in life: rank 1 is worth about seven
 * times rank 7 and seventy times rank 70. The constant only scales the whole
 * column, so it is chosen to keep the numbers readable rather than to mean
 * anything.
 */
function zipf(rank) {
  return Math.max(1, Math.round(1_000_000 / rank));
}

function write(path, description, values) {
  const header = ['---', `description: ${description}`, 'weighted: true', '---'].join('\n');
  writeFileSync(join(PACK, path), `${header}\n${values.join('\n')}\n`, 'utf8');
  console.log(`${String(values.length).padStart(5)}  ${path}`);
}

/** The masculine list as authored: one surname per line, most common first. */
function authored(name) {
  return readFileSync(join(HERE, 'ru-source', name), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

const surnames = authored('surnames-masculine.txt');
const maleNames = authored('first-names-male.txt');
const femaleNames = authored('first-names-female.txt');
const patronymics = authored('patronymics-masculine.txt');

// A duplicate would give one surname two ranks and therefore two weights, and the
// pack merges duplicates by summing them — so the list would silently stop being
// the ranking it claims to be.
// Every fault at once, not the first one: fixing a list of 600 names one thrown
// error per run is the slowest possible way to do it, and the same argument the
// release gate makes for reporting all five stages.
const faults = [];
for (const [what, list] of [
  ['surnames', surnames],
  ['male given names', maleNames],
  ['female given names', femaleNames],
  ['patronymics', patronymics],
]) {
  const seen = new Set();
  for (const value of list) {
    if (seen.has(value)) faults.push(`${what}: "${value}" appears twice`);
    seen.add(value);
  }
}
for (const [what, list, derive] of [
  ['surname', surnames, feminineSurname],
  ['patronymic', patronymics, femininePatronymic],
]) {
  for (const value of list) {
    try {
      derive(value);
    } catch {
      faults.push(`${what}: "${value}" does not decline — remove it or move it to the neutral list`);
    }
  }
}
// A Latin letter inside a Cyrillic name is invisible on the page and breaks every
// lookup. Two slipped in while this list was being typed.
for (const [what, list] of [
  ['surnames', surnames],
  ['male given names', maleNames],
  ['female given names', femaleNames],
  ['patronymics', patronymics],
]) {
  for (const value of list) {
    if (/[A-Za-z]/.test(value)) faults.push(`${what}: "${value}" contains Latin letters`);
  }
}
if (faults.length > 0) {
  console.error(`${String(faults.length)} problem(s) in the authored lists:\n`);
  for (const f of faults) console.error(`  ${f}`);
  process.exit(1);
}

const weighted = (list) => list.map((v, i) => `${v},${String(zipf(i + 1))}`);
const weightedPairs = (list, derive) =>
  list.map((v, i) => `${derive(v)},${String(zipf(i + 1))}`);

write(
  'male/lastName.txt',
  'Russian male surname (declined masculine form), ordered by frequency; weights are ' +
    'rank-derived on a Zipf curve, not counts from a census',
  weighted(surnames),
);
write(
  'female/lastName.txt',
  'Russian female surname, the feminine form of the same surname at the same line as ' +
    'person/male/lastName — so a family keeps one name. Weights match the masculine list.',
  weightedPairs(surnames, feminineSurname),
);
write(
  'male/firstName.txt',
  'Russian male given name, ordered by frequency; weights are rank-derived on a Zipf ' +
    'curve, not counts from a registry',
  weighted(maleNames),
);
write(
  'female/firstName.txt',
  'Russian female given name, ordered by frequency; weights are rank-derived on a Zipf ' +
    'curve, not counts from a registry',
  weighted(femaleNames),
);
write(
  'male/patronymic.txt',
  'Russian male patronymic, formed from the father’s given name (-ович/-евич/-ич), ' +
    'ordered by the frequency of that name',
  weighted(patronymics),
);
write(
  'female/patronymic.txt',
  'Russian female patronymic, the feminine form of the same patronymic at the same line ' +
    'as person/male/patronymic — so siblings share a father.',
  weightedPairs(patronymics, femininePatronymic),
);
