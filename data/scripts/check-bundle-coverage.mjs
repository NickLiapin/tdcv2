#!/usr/bin/env node
/**
 * Every pack that exists must be downloadable.
 *
 * `data/bundles.json` is the hand-written source manifest that
 * `scripts/build-data-packs.mjs` turns into the zips a user installs with
 * `tdcv2 pack add <id>`. A pack directory with no entry there is in the
 * repository and reachable from a source checkout, and reachable by nobody
 * else — it does not ship, and nothing said so.
 *
 * Measured when this check was written: 21 locale packs and 12 country packs
 * were in exactly that state. Not only new ones — ja, ko, nl, sv, uk and vi had
 * been finished and unshippable for months, because adding the bundle entry is
 * a separate manual step from writing the pack and nothing tied the two
 * together. That is the same shape as every other bug in this project: a thing
 * that says it is there, and is not.
 *
 * A pack counts as REAL once it holds more than its `_locale.json` — an empty
 * stub is a placeholder for a language nobody has written yet and is not
 * expected to ship.
 *
 *   node data/scripts/check-bundle-coverage.mjs            fail if any pack is unshippable
 *   node data/scripts/check-bundle-coverage.mjs --update   write the missing entries
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PACKS = join(ROOT, 'data', 'packs');
const MANIFEST = join(ROOT, 'data', 'bundles.json');

/** English names for the locale codes we ship, for the bundle's `name`. */
const LOCALE_NAMES = {
  ar: 'Arabic', bn: 'Bengali', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek',
  en: 'English', es: 'Spanish', fa: 'Persian', fi: 'Finnish', fr: 'French', he: 'Hebrew',
  hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', id: 'Indonesian', it: 'Italian',
  ja: 'Japanese', ko: 'Korean', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', ro: 'Romanian',
  ru: 'Russian', sk: 'Slovak', sr: 'Serbian', sv: 'Swedish', sw: 'Swahili', th: 'Thai',
  tr: 'Turkish', uk: 'Ukrainian', vi: 'Vietnamese', bg: 'Bulgarian', 'zh-cn': 'Simplified Chinese',
};

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const titleCase = (s) => s.split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

/** The top-level categories a pack actually holds, sorted. */
function categoriesOf(dir) {
  return readdirSync(dir)
    .filter((e) => !e.startsWith('_') && !e.startsWith('.'))
    .map((e) => (e.endsWith('.txt') ? e.replace(/\.txt$/, '') : e))
    .filter((e) => e !== 'DATE_LOCALE.json')
    .sort();
}

/** A pack is REAL once it holds more than its manifest. */
function realLocalePacks() {
  return readdirSync(PACKS)
    .filter((d) => isDir(join(PACKS, d)) && existsSync(join(PACKS, d, '_locale.json')))
    .filter((d) => readdirSync(join(PACKS, d)).length > 1)
    .sort();
}

function realCountryPacks() {
  const dir = join(PACKS, 'countries');
  if (!isDir(dir)) return [];
  return readdirSync(dir)
    .filter((d) => isDir(join(dir, d)))
    .filter((d) => readdirSync(join(dir, d)).length > 0)
    .sort();
}

function localeEntry(code) {
  const cats = categoriesOf(join(PACKS, code));
  const shown = cats.slice(0, 12).join(', ');
  const rest = cats.length > 12 ? `, and ${String(cats.length - 12)} more` : '';
  const name = LOCALE_NAMES[code] ?? code;
  return {
    id: code,
    name: `${name} (language)`,
    description: `Content bound to the ${name} language rather than to any one country: ${shown}${rest}.`,
    locale: code,
    packs: [`packs/${code}`],
  };
}

function countryEntry(id) {
  return {
    id,
    name: `${titleCase(id)} (country)`,
    description: `Data specific to ${titleCase(id)}: ${categoriesOf(join(PACKS, 'countries', id)).join(', ')}.`,
    country: id,
    packs: [`packs/countries/${id}`],
  };
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const declared = new Set(manifest.bundles.map((b) => b.id));

// `europe` is a region grouping rather than a country and is deliberately not a
// bundle of its own; it is named by other bundles' `regions`.
const missingLocales = realLocalePacks().filter((c) => !declared.has(c));
const missingCountries = realCountryPacks().filter((c) => c !== 'europe' && !declared.has(c));
const missing = [...missingLocales, ...missingCountries];

if (process.argv.includes('--update')) {
  for (const code of missingLocales) manifest.bundles.push(localeEntry(code));
  for (const id of missingCountries) manifest.bundles.push(countryEntry(id));
  manifest.bundles.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `bundles.json: added ${String(missingLocales.length)} locale and ` +
      `${String(missingCountries.length)} country entries`,
  );
  process.exit(0);
}

if (missing.length > 0) {
  console.error(
    `${String(missing.length)} pack(s) exist but ship to nobody — no entry in data/bundles.json:\n` +
      `  locales:   ${missingLocales.join(', ') || '—'}\n` +
      `  countries: ${missingCountries.join(', ') || '—'}\n` +
      'Run `node data/scripts/check-bundle-coverage.mjs --update` and commit the result.',
  );
  process.exit(1);
}
console.log(
  `every pack ships: ${String(realLocalePacks().length)} locales, ` +
    `${String(realCountryPacks().length - 1)} countries, all declared in bundles.json`,
);
