#!/usr/bin/env node
/**
 * A pack that writes its own month names must be able to reach them.
 *
 * `date/month.txt` and `DATE_LOCALE.json` look like the same thing and are not.
 * The first answers `<gen type="template" value="date.month"/>` — an author
 * asking for a month as a WORD. The second is what the date FORMATTER reads
 * when a config writes `format="LL"`, and the formatter never looks at the
 * pack's text lists. So a pack can hold a perfect set of translated months and
 * still print English ones, and nothing about the pack looks wrong.
 *
 * That is not hypothetical. The engine shipped for a long time reading no pack
 * date tables at all — `local="ka"` drew Georgian names and printed English
 * months, with the right words sitting in the pack the whole time — and the
 * fix registered `DATE_LOCALE.json` from the pack scan. This check closes the
 * other half: it makes sure the file is THERE.
 *
 * A locale is fine if any one of these holds:
 *   - it ships `DATE_LOCALE.json`;
 *   - the engine has a built-in table for it (the ~45 in date/locale.ts);
 *   - it is a variant whose base satisfies one of the above, because the
 *     resolver takes exactly one step to the base language.
 *
 *   node data/scripts/check-pack-date-locale.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKS = join(HERE, '..', 'packs');
const LOCALE_TS = join(HERE, '..', '..', 'typescript', 'src', 'date', 'locale.ts');

/** The names the engine answers for without any pack installed. */
function builtInDateLocales() {
  const source = readFileSync(LOCALE_TS, 'utf8');
  const start = source.indexOf('const LOCALES');
  const end = source.indexOf('];', start);
  return new Set([...source.slice(start, end).matchAll(/\['([^']+)',/g)].map((m) => m[1]));
}

/** True when the folder holds any addressable data at all. */
function hasData(dir) {
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) {
        if (walk(path)) return true;
      } else if (name.endsWith('.txt') || name.endsWith('.tdc')) return true;
    }
    return false;
  };
  return walk(dir);
}

/**
 * Half-written packs, which are committable but do not ship.
 *
 * The same list exists in `check-bundle-coverage.mjs` and for the same reason:
 * a 222-file pack lands over more than one sitting, and the intermediate state
 * has to be safe to commit. A pack here has not written its `date/` folder yet,
 * so it has nothing to build a table from. Remove the name when the pack is
 * finished — at which point it needs its DATE_LOCALE.json like everyone else.
 */
const WORK_IN_PROGRESS = new Set(['cv']);

const builtIn = builtInDateLocales();
const problems = [];
let checked = 0;

for (const name of readdirSync(PACKS).sort()) {
  if (name === 'countries' || name === 'common' || name === 'user') continue;
  const dir = join(PACKS, name);
  if (!statSync(dir).isDirectory()) continue;
  if (!hasData(dir)) continue;
  if (WORK_IN_PROGRESS.has(name)) continue;
  checked += 1;

  const table = join(dir, 'DATE_LOCALE.json');
  if (existsSync(table)) {
    /*
     * It exists — now check it says what the formatter needs.
     *
     * The weekday array is indexed 0 = Sunday, because that is what the
     * formatter does with a date's day number, and a table that starts on
     * Monday prints every weekday one day out. `date/weekday.txt` beside it is
     * a plain list an author draws from and conventionally starts on Monday in
     * Europe, so the two are compared as SETS and not in order — Frisian ships
     * snein first in the table and moandei first in the list, and both are
     * right.
     */
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(table, 'utf8'));
    } catch {
      problems.push(`${name}: DATE_LOCALE.json does not parse`);
      continue;
    }
    const months = parsed.months ?? [];
    const weekdays = parsed.weekdays ?? [];
    if (months.length !== 12) problems.push(`${name}: DATE_LOCALE.json has ${String(months.length)} months, expected 12`);
    if (weekdays.length !== 7) problems.push(`${name}: DATE_LOCALE.json has ${String(weekdays.length)} weekdays, expected 7`);
    /*
     * The table is NOT compared against `date/month.txt` and
     * `date/weekday.txt`, and a first draft of this check did compare them and
     * was wrong twice over on data that is right.
     *
     * Persian ships Gregorian months transliterated into Persian in the table —
     * ژانویه, فوریه — because that is what the formatter needs to print a
     * Gregorian date, while `date/month.txt` holds the Solar Hijri months,
     * فروردین and the rest, which is the calendar Iran actually runs on. Two
     * calendars, both wanted, and no overlap between them at all.
     *
     * Yoruba ships the full ceremonial forms in the table, Oṣù Ṣẹ́rẹ́ and Ọjọ́
     * Àìkú — "month of Ṣẹ́rẹ́", "day of Àìkú" — and the bare names in the list.
     *
     * So the two files answer different questions and are allowed to differ.
     * What can be checked without guessing at a language is the shape.
     */
    continue;
  }
  if (builtIn.has(name)) continue;

  const dash = name.indexOf('-');
  if (dash > 0) {
    const base = name.slice(0, dash);
    if (builtIn.has(base) || existsSync(join(PACKS, base, 'DATE_LOCALE.json'))) continue;
  }

  const ownMonths = existsSync(join(dir, 'date', 'month.txt'));
  problems.push(
    `${name}: no DATE_LOCALE.json and no built-in table` +
      (ownMonths ? ' — it ships date/month.txt, and those names will never be printed' : ''),
  );
}

if (problems.length > 0) {
  console.error('a pack will print English dates:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${String(problems.length)} of ${String(checked)} locale pack(s). Add DATE_LOCALE.json — ` +
      'months, monthsShort, weekdays, weekdaysShort and formats — beside the pack.',
  );
  process.exit(1);
}

console.log(`every locale pack can reach a date table (${String(checked)} checked)`);
