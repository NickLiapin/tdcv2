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
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * The four patronymics whose feminine form no rule produces.
 *
 * Fathers named Илья, Фома, Лука and Кузьма give sons a patronymic in -ич, and
 * every rule that turns -ич into -ична gets these four wrong: the feminine forms
 * are Ильинична, Фоминична, Лукинична and Кузьминична, with an -ин- that appears
 * from nowhere. Russian reference grammars list them as exceptions, and they are
 * the whole list — Никитич really does give Никитична, and Саввич gives Саввична.
 *
 * They were wrong here until 2026-08-04, which is what a table of four entries is
 * for: a rule that quietly mishandles its exceptions is worse than a rule with the
 * exceptions written out beside it.
 */
const IRREGULAR_PATRONYMICS = {
  Ильич: 'Ильинична',
  Фомич: 'Фоминична',
  Лукич: 'Лукинична',
  Кузьмич: 'Кузьминична',
};

/** `Иванович` → `Ивановна`. Every Russian patronymic ends one of three ways. */
export function femininePatronymic(masculine) {
  if (masculine in IRREGULAR_PATRONYMICS) return IRREGULAR_PATRONYMICS[masculine];
  for (const [ending, replacement] of [
    [/ович$/, 'овна'],
    [/евич$/, 'евна'],
    [/ич$/, 'ична'],
  ]) {
    if (ending.test(masculine)) return masculine.replace(ending, replacement);
  }
  throw new Error(`"${masculine}" is not a patronymic this script knows how to decline`);
}

/**
 * Given name → masculine patronymic. `Иван` → `Иванович`, `Сергей` → `Сергеевич`.
 *
 * A patronymic is not a name in its own right, it is a FUNCTION of the father's
 * given name, so it is computed here rather than typed. Typed separately, the two
 * lists drift: the authored patronymic list held 183 entries against 222 given
 * names, which meant 39 fathers whose sons the pack could not name.
 */
const PATRONYMIC_EXCEPTIONS = {
  // A vowel appears, drops or changes — none of it predictable from the spelling.
  Пётр: 'Петрович',
  Лев: 'Львович',
  Павел: 'Павлович',
  Михаил: 'Михайлович',
  Яков: 'Яковлевич',
  Нестор: 'Нестерович',
  Гавриил: 'Гаврилович',
  Даниил: 'Данилович',
  Данила: 'Данилович',
  // -ий takes -ьевич by default (Василий → Васильевич); these four take -иевич,
  // and no spelling rule separates them — Дмитрий and Юрий both end -рий and go
  // different ways.
  Дмитрий: 'Дмитриевич',
  Георгий: 'Георгиевич',
  Ираклий: 'Ираклиевич',
  Онуфрий: 'Онуфриевич',
  Эмиль: 'Эмильевич',
};

export function masculinePatronymic(given) {
  if (given in PATRONYMIC_EXCEPTIONS) return PATRONYMIC_EXCEPTIONS[given];
  // Илья → Ильич: the -я goes, the soft sign stays.
  if (given.endsWith('ья')) return `${given.slice(0, -1)}ич`;
  // Никита → Никитич, Фома → Фомич, Кузьма → Кузьмич.
  if (given.endsWith('а') || given.endsWith('я')) return `${given.slice(0, -1)}ич`;
  // Василий → Васильевич, Юрий → Юрьевич, Евгений → Евгеньевич.
  if (given.endsWith('ий')) return `${given.slice(0, -2)}ьевич`;
  // Сергей → Сергеевич, Николай → Николаевич.
  if (given.endsWith('й')) return `${given.slice(0, -1)}евич`;
  // Игорь → Игоревич, Лазарь → Лазаревич.
  if (given.endsWith('ь')) return `${given.slice(0, -1)}евич`;
  // Иван → Иванович, and every other name ending in a consonant.
  return `${given}ович`;
}

/**
 * Rank → relative frequency.
 *
 * Plain Zipf — 1/rank — was the first attempt and it is wrong at both ends. It
 * made Александр 17% of all men, which is three times life, and it left the tail
 * far too fat: Чеслав at rank 222 came out only 222 times rarer than Александр,
 * where the real gap is in the hundreds. The head was too sharp and the tail was
 * not sharp enough, which is the same complaint from both directions.
 *
 * Zipf–Mandelbrot fixes both, because `q` flattens the head independently of how
 * fast `s` drops the tail. The two constants were fitted numerically against three
 * things known about Russian given names rather than picked by feel:
 *
 *              this curve   real Russia
 *   Александр       5.0%      about 5–6%
 *   top 10           38%      about 35–40%
 *   top 40           79%      about 75%
 *   rank 1 / 222     459×
 *
 * They also do the right thing on a SHORT list without being told to. With only
 * fifteen names q=54 leaves the curve nearly flat, which is honest: for a people
 * whose list holds fifteen names, the order between them is a guess, and pretending
 * the first is seventy times the last would be inventing precision.
 */
const ZIPF_Q = 54;
const ZIPF_S = 3.8;

export function frequency(rank) {
  return 1 / Math.pow(rank + ZIPF_Q, ZIPF_S);
}

/** The same curve as an integer column, scaled so the commonest name reads 1000000. */
function zipf(rank) {
  return Math.max(1, Math.round((frequency(rank) / frequency(1)) * 1_000_000));
}

/**
 * `--check` compares instead of writing.
 *
 * These pack files look exactly like the hand-written ones beside them, so the
 * obvious thing to do with a name that needs fixing is to open the pack file and
 * fix it — after which the next run of this script silently throws the edit away.
 * Wired into `npm run check`, this turns that into a failed build with the command
 * to run, which is the only way an editable-looking generated file stays honest.
 */
const CHECK = process.argv.includes('--check');
const drifted = [];

function write(path, description, values) {
  const header = ['---', `description: ${description}`, 'weighted: true', '---'].join('\n');
  const content = `${header}\n${values.join('\n')}\n`;
  const file = join(PACK, path);
  if (CHECK) {
    const actual = readFileSync(file, 'utf8');
    if (actual !== content) drifted.push(`ru/person/${path}`);
    return;
  }
  writeFileSync(file, content, 'utf8');
  console.log(`${String(values.length).padStart(5)}  ${path}`);
}

/** The masculine list as authored: one surname per line, most common first. */
function authored(name) {
  return readFileSync(join(HERE, 'ru-source', name), 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

// Everything below builds the pack; everything above is the declension rules,
// which build-russia-peoples.mjs imports — Tatar and Kalmyk surnames are Russified
// and decline by exactly these rules, and a second copy of them would be a second
// thing to get wrong. Importing must not rebuild the ru pack as a side effect, so
// the body runs only when this file is the command being run.
const RUN_AS_SCRIPT = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!RUN_AS_SCRIPT) {
  // Loaded for its rules alone.
} else {
const surnames = authored('surnames-masculine.txt');
const indeclinable = authored('surnames-indeclinable.txt');
const maleNames = authored('first-names-male.txt');
const femaleNames = authored('first-names-female.txt');
const fathers = authored('fathers-by-frequency.txt');

/**
 * Every male given name, ranked as a father: the explicit order first, then the
 * rest in the order they appear as given names.
 *
 * Deriving rather than typing is what makes the two counts agree — 222 given names
 * now yield 222 patronymics, where the hand-kept list had 183 and nobody could see
 * which 39 were missing. Two names collapse to one patronymic (Даниил and Данила
 * both give Данилович), so the result is deduplicated and comes out one or two
 * short of the given-name count; that is the language, not a gap.
 */
const patronymics = (() => {
  const ranked = [...fathers, ...maleNames.filter((n) => !fathers.includes(n))];
  const seen = new Set();
  return ranked
    .map(masculinePatronymic)
    .filter((p) => !seen.has(p) && seen.add(p));
})();

/** Does any declension rule claim this surname? */
function declines(surname) {
  return DECLENSIONS.some(([ending]) => ending.test(surname));
}

// A duplicate would give one surname two ranks and therefore two weights, and the
// pack merges duplicates by summing them — so the list would silently stop being
// the ranking it claims to be.
// Every fault at once, not the first one: fixing a list of 600 names one thrown
// error per run is the slowest possible way to do it, and the same argument the
// release gate makes for reporting all five stages.
const faults = [];
for (const [what, list] of [
  ['surnames', surnames],
  ['indeclinable surnames', indeclinable],
  ['male given names', maleNames],
  ['female given names', femaleNames],
  ['father rankings', fathers],
]) {
  const seen = new Set();
  for (const value of list) {
    if (seen.has(value)) faults.push(`${what}: "${value}" appears twice`);
    seen.add(value);
  }
}
// The ranking file only reorders names the pack already has. A name here that is
// not a given name is a typo that would otherwise become a patronymic for a father
// who does not exist — Никалаевич, sitting at rank 4, looking entirely plausible.
{
  const known = new Set(maleNames);
  for (const value of fathers) {
    if (!known.has(value)) {
      faults.push(`father rankings: "${value}" is not in first-names-male.txt`);
    }
  }
}
// The two surname files are two answers to one question — does this name have a
// feminine form? A name in both would be drawn by `person.lastName` unchanged and
// by `person.female.lastName` declined, so the same woman is Ткаченко on one page
// and Ткаченкова on the next.
{
  const gendered = new Set(surnames);
  for (const value of indeclinable) {
    if (gendered.has(value)) faults.push(`"${value}" is in BOTH surname files — it declines or it does not`);
  }
}
// The check that the masculine list already gets, run backwards: a name here that
// the rules WOULD decline is simply in the wrong file, and putting it here quietly
// costs it its feminine form.
for (const value of indeclinable) {
  if (declines(value)) {
    faults.push(
      `indeclinable surnames: "${value}" declines to "${feminineSurname(value)}" — ` +
        'it belongs in surnames-masculine.txt',
    );
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
  ['indeclinable surnames', indeclinable],
  ['male given names', maleNames],
  ['female given names', femaleNames],
  ['father rankings', fathers],
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
  'lastName.txt',
  'Russian surname, gender-neutral — the forms that do not decline, so a man and a ' +
    'woman carry the same string. For a surname that does have a feminine form use ' +
    'person.male.lastName / person.female.lastName.',
  weighted(indeclinable),
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

if (CHECK) {
  if (drifted.length > 0) {
    console.error('These pack files do not match what the sources produce:\n');
    for (const f of drifted) console.error(`  ${f}`);
    console.error(
      '\nThey are GENERATED. Edit data/scripts/ru-source/ instead, then run\n' +
        '  node data/scripts/build-ru-names.mjs\n' +
        'and commit the result. A fix made in the pack file is thrown away by the next run.',
    );
    process.exit(1);
  }
  console.log(`ru person names match their sources (${String(surnames.length)} surnames, ${String(maleNames.length)} male and ${String(femaleNames.length)} female given names, ${String(patronymics.length)} patronymics)`);
}
}
