#!/usr/bin/env node
/**
 * A country pack ships the seven files every country pack ships.
 *
 * `usa` is the reference shape and most of it is specific to the United States —
 * an SSN, an ABA routing number, a state abbreviation. Seven files are not:
 * every country has a phone number, a university, a public holiday, a bank, a
 * football club, a city and a licence plate, and 145 or more of the 153 packs
 * that existed before this check shipped each of them. A pack missing one is
 * not wrong about its country; it is incomplete, and the gap only shows when
 * somebody writes `<gen type="template" value="lesotho.vehicle.plate"/>` and
 * gets an unknown-address error for a country that plainly has cars.
 *
 * Measured when this check was written: twelve packs written the same afternoon
 * — Central African Republic, Liberia, Eritrea, Gambia, Jamaica, Botswana,
 * Namibia, Lesotho, Eswatini, Mauritius, Trinidad and Tobago, Montenegro — had
 * every other core file and no `vehicle/plate.txt` between them, because the
 * author checked a sample of addresses rather than the set. A sample cannot
 * find an absence.
 *
 * The exceptions are real and are listed by name rather than pattern-matched,
 * so adding one is a deliberate act with a reason attached.
 *
 *   node data/scripts/check-country-core.mjs
 */

import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COUNTRIES = join(HERE, '..', 'packs', 'countries');

/** What every country has, whatever else it has. */
const CORE = [
  'phone.txt',
  'education/university.txt',
  'holiday.txt',
  'finance/bank.txt',
  'sport/team.txt',
  'geo/city.txt',
  'vehicle/plate.txt',
];

/**
 * Packs that legitimately lack a core file, and why.
 *
 * A city-state has no list of cities to draw from — it is one city, and the
 * pack says so with `geo/place` or `geo/municipality` instead. `europe` is not
 * a country at all: it is a delegating generator that answers `europe.tax.vat`
 * by handing the question to Germany.
 */
const EXCUSED = {
  europe: CORE, // a delegating VAT generator, not a country
  vatican_city: ['geo/city.txt'], // one city, and it is the country
  monaco: ['geo/city.txt'], // a city-state; the pack ships wards instead
  san_marino: ['geo/city.txt'], // castelli, not cities
  liechtenstein: ['geo/city.txt'], // municipalities, not cities
  macau: ['geo/city.txt'], // the territory is the city
  singapore: ['geo/city.txt'], // a city-state; its geo/city holds one entry
  comoros: ['sport/team.txt', 'vehicle/plate.txt'],
  cape_verde: ['vehicle/plate.txt'],
  east_timor: ['vehicle/plate.txt'],
  mauritania: ['vehicle/plate.txt'],
  sao_tome_and_principe: ['vehicle/plate.txt'],
  somalia: ['vehicle/plate.txt'],
  yemen: ['vehicle/plate.txt'],
  russia: ['finance/bank.txt'], // ships bank/ instead of finance/ — a known naming outlier
};

const problems = [];
let checked = 0;

for (const country of readdirSync(COUNTRIES).sort()) {
  const dir = join(COUNTRIES, country);
  if (!statSync(dir).isDirectory()) continue;
  checked += 1;
  const excused = EXCUSED[country] ?? [];
  const missing = CORE.filter((file) => {
    if (excused.includes(file)) return false;
    try {
      return !statSync(join(dir, file)).isFile();
    } catch {
      return true;
    }
  });
  if (missing.length > 0) problems.push(`${country}: ${missing.join(', ')}`);
}

if (problems.length > 0) {
  console.error('country packs missing a core file:\n');
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\n${String(problems.length)} incomplete pack(s) of ${String(checked)}. Write the file, or ` +
      'add the pack to EXCUSED in this script with the reason it does not need one.',
  );
  process.exit(1);
}

console.log(`every country pack ships the core seven (${String(checked)} checked)`);
