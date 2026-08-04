/**
 * Build `countries/russia/person/**` — the names of the peoples of Russia.
 *
 * ── Why this is the country pack and not the ru locale ───────────────────────
 * `ru` is a LANGUAGE axis and Belarus, Kazakhstan, Kyrgyzstan and Tajikistan take
 * it too. A Dagestani or Tuvan given name is not a Russian-language name; it is a
 * name you meet in Russia. Put in `ru` it would turn up in Belarusian data, which
 * is simply wrong. So it lives here, on the country axis, where it belongs.
 *
 * ── Why Russians are one of the peoples ──────────────────────────────────────
 * A country pack must stand on its own — `tdcv2 pack add russia` cannot require
 * the ru locale. So `russia.person.male.firstName` has to contain Russian names
 * as well, and Russians appear in peoples.json like everybody else, with their
 * census count as the weight. Their lists are READ from the ru locale source
 * rather than copied, so there is still one place to edit them.
 *
 * ── What the weights mean ────────────────────────────────────────────────────
 * Two things multiply. Within a people the rank gives a Zipf curve, the same as
 * the ru pack. Across peoples the census population scales the whole list. A row
 * drawn from the merged address therefore looks like the country: mostly Russian
 * names, Tatar ones a few percent of the time, Kalmyk ones rarely. An unweighted
 * merge would make Kalmyks and Russians equally likely, which is off by a factor
 * of six hundred.
 *
 *   node data/scripts/build-russia-peoples.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { feminineSurname, femininePatronymic, frequency, masculinePatronymic } from './build-ru-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'russia-source');
const PACK = join(HERE, '..', 'packs', 'countries', 'russia', 'person');

const { peoples } = JSON.parse(readFileSync(join(SOURCE, 'peoples.json'), 'utf8'));

/** One list as authored: comments and blank lines dropped, order preserved. */
function read(people, name) {
  const dir = people.source ? join(HERE, people.source) : join(SOURCE, people.id);
  const path = join(dir, name);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

/** Strip the `!` that marks a deliberately indeclinable surname — see below. */
const bare = (value) => value.replace(/\s*!$/, '');

/** The shared curve as an integer column, commonest name at 1000000. */
function zipf(rank) {
  return Math.max(1, Math.round((frequency(rank) / frequency(1)) * 1_000_000));
}

/** `--check` compares instead of writing — see build-ru-names.mjs for why. */
const CHECK = process.argv.includes('--check');
const drifted = [];

function write(path, description, values) {
  const file = join(PACK, path);
  const header = ['---', `description: ${description}`, 'weighted: true', '---'].join('\n');
  const content = `${header}\n${values.join('\n')}\n`;
  if (CHECK) {
    if (!existsSync(file) || readFileSync(file, 'utf8') !== content) {
      drifted.push(`countries/russia/person/${path}`);
    }
    return values.length;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  return values.length;
}

const faults = [];
const loaded = [];

for (const people of peoples) {
  const male = read(people, 'first-names-male.txt');
  const female = read(people, 'first-names-female.txt');
  const surnames = read(people, 'surnames-masculine.txt');
  const indeclinable = read(people, 'surnames-indeclinable.txt');

  /*
   * `surnamesOnly` is an honest answer, not a shortcut.
   *
   * Chuvash, Mordvins, Mari, Udmurts, Komi, Russian Koreans and Russian Jews
   * overwhelmingly give their children Russian given names today; what stays
   * distinct is the surname — Цой, Пак, Рабинович. Inventing a list of "Chuvash
   * given names" to fill the column would put made-up data in the pack, so such a
   * people contributes its surnames to the merge and takes Russian given names,
   * and the file says which peoples those are.
   */
  if (people.surnamesOnly) {
    if (male.length > 0 || female.length > 0) {
      faults.push(`${people.id}: declared surnamesOnly but has given names — drop one or the other`);
    }
  } else if (male.length === 0 || female.length === 0) {
    faults.push(`${people.id}: has no given names — every people needs both lists`);
  }
  if (surnames.length === 0 && indeclinable.length === 0) {
    faults.push(`${people.id}: has no surnames`);
  }
  // The same check the ru builder makes, for the same reason: a surname that does
  // not decline cannot sit in the gendered file, where it would silently lose its
  // feminine form. Tuvan surnames are all like this — Ондар names a man and a
  // woman alike — and this is what caught them.
  for (const value of surnames) {
    try {
      feminineSurname(value);
    } catch {
      faults.push(`${people.id}: "${value}" does not decline — move it to surnames-indeclinable.txt`);
    }
  }
  /*
   * `Цой !` — the marker for a surname that looks declinable and is not.
   *
   * The declension rules read the ENDING, and some non-Russian surnames end the
   * same way by coincidence: Цой matches the -ой of Луговой → Луговая, Шин matches
   * the -ин of Пушкин → Пушкина. Neither declines; Виктор Цой and his sister are
   * both Цой.
   *
   * The rules cannot tell these apart from the spelling — that is what the
   * language is like, not a bug to fix — so the fact is written down beside the
   * name. A bare name that would decline is still refused, because that is nearly
   * always a name in the wrong file; the marker is how you say "I checked".
   */
  for (const raw of indeclinable) {
    const checked = raw.endsWith('!');
    if (checked) continue;
    try {
      const feminine = feminineSurname(raw);
      faults.push(
        `${people.id}: "${raw}" declines to "${feminine}" — move it to surnames-masculine.txt, ` +
          `or write "${raw} !" if it genuinely does not decline`,
      );
    } catch {
      /* refusing to decline is exactly what an indeclinable surname should do */
    }
  }
  for (const [what, list] of [
    ['male given names', male],
    ['female given names', female],
    ['surnames', surnames],
    ['indeclinable surnames', indeclinable.map(bare)],
  ]) {
    const seen = new Set();
    for (const value of list) {
      if (seen.has(value)) faults.push(`${people.id} ${what}: "${value}" appears twice`);
      seen.add(value);
      if (/[A-Za-z]/.test(value)) faults.push(`${people.id} ${what}: "${value}" contains Latin letters`);
    }
  }
  loaded.push({ people, male, female, surnames, indeclinable: indeclinable.map(bare) });
}

if (faults.length > 0) {
  console.error(`${String(faults.length)} problem(s) in the authored lists:\n`);
  for (const f of faults) console.error(`  ${f}`);
  process.exit(1);
}

/**
 * Merge one column across peoples, weighting each entry by population × rank.
 *
 * A name shared by two peoples — Магомед is Chechen and Dagestani both, Тимур is
 * Tatar and Dagestani — gets the SUM of its weights rather than two lines. That is
 * the same rule the pack loader applies to duplicates, so doing it here keeps the
 * printed file honest about what will actually be drawn.
 */
function merge(column) {
  const weights = new Map();
  for (const entry of loaded) {
    const values = column(entry);
    if (values.length === 0) continue;
    // Normalise each people's curve to sum to 1, THEN scale by population. Without
    // this a people's share depends on how many of its names happen to be written
    // down: measured before the fix, every minority came out at 0.56-0.73x of its
    // census share and Russians at 1.06x, purely because the Russian list is 222
    // names long and a Tajik list is 13. How much I managed to author is a fact
    // about me, not about Russia.
    const total = values.reduce((sum, _, i) => sum + frequency(i + 1), 0);
    for (const [i, value] of values.entries()) {
      const share = frequency(i + 1) / total;
      const weight = Math.max(1, Math.round(share * (entry.people.population / 100)));
      weights.set(value, (weights.get(value) ?? 0) + weight);
    }
  }
  return [...weights.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
    .map(([value, weight]) => `${value},${String(weight)}`);
}

const weighted = (list) => list.map((v, i) => `${v},${String(zipf(i + 1))}`);
const derived = (list, fn) => list.map((v, i) => `${fn(v)},${String(zipf(i + 1))}`);

// ── Per-people addresses: russia.person.<people>.male.firstName and friends ──
// Russians are skipped here only because ru/person/** already IS that list; they
// still take part in the merge below.
let files = 0;
/*
 * The pack holds SEVEN files and no more.
 *
 * An earlier version also wrote russia.person.tatar.male.firstName and one such
 * address per people. Nobody asked for that. It is surface to document and to keep
 * working, and it invites the misreading the whole thing has to avoid — that
 * `kazakh` is about Kazakhstan rather than about Kazakhs living in Voronezh.
 *
 * What a user wants is a name met in Russia, drawn in the proportions Russia has.
 * That is one file per column. The split by people stays where it belongs — in the
 * sources, where it is how the weights get computed — and never reaches the pack.
 */

// ── The merged addresses: russia.person.male.firstName and friends ──
const census = 'weights are 2021 census populations × rank, so the mix matches the country';
const counts = {
  'male/firstName.txt': write(
    'male/firstName.txt',
    `Male given name as met in Russia, across its peoples — ${census}`,
    merge((e) => e.male),
  ),
  'female/firstName.txt': write(
    'female/firstName.txt',
    `Female given name as met in Russia, across its peoples — ${census}`,
    merge((e) => e.female),
  ),
  'male/patronymic.txt': write(
    'male/patronymic.txt',
    `Male patronymic as met in Russia — ${census}`,
    merge((e) => e.male.map(masculinePatronymic)),
  ),
  'female/patronymic.txt': write(
    'female/patronymic.txt',
    `Female patronymic as met in Russia — ${census}`,
    merge((e) => e.male.map(masculinePatronymic).map(femininePatronymic)),
  ),
  'male/lastName.txt': write(
    'male/lastName.txt',
    `Male surname as met in Russia, across its peoples — ${census}`,
    merge((e) => e.surnames),
  ),
  'female/lastName.txt': write(
    'female/lastName.txt',
    `Female surname, the feminine form — ${census}`,
    merge((e) => e.surnames.map(feminineSurname)),
  ),
  'lastName.txt': write(
    'lastName.txt',
    `Surname that does not decline, identical for a man and a woman — ${census}`,
    merge((e) => e.indeclinable),
  ),
};

if (CHECK) {
  if (drifted.length > 0) {
    console.error('These pack files do not match what the sources produce:\n');
    for (const f of drifted) console.error(`  ${f}`);
    console.error(
      '\nThey are GENERATED. Edit data/scripts/russia-source/ instead, then run\n' +
        '  node data/scripts/build-russia-peoples.mjs\n' +
        'and commit the result.',
    );
    process.exit(1);
  }
  console.log(`russia person names match their sources (${String(loaded.length)} peoples)`);
} else {
  console.log(`${String(loaded.length)} peoples merged into ${String(Object.keys(counts).length)} files\n`);
  for (const [name, n] of Object.entries(counts)) {
    console.log(`${String(n).padStart(6)}  russia.person.${name.replace('.txt', '').replace('/', '.')}`);
  }
}
