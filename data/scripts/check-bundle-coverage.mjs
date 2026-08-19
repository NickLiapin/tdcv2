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
  af: 'Afrikaans', ar: 'Arabic', az: 'Azerbaijani', be: 'Belarusian', bg: 'Bulgarian',
  bn: 'Bengali', bo: 'Tibetan', bs: 'Bosnian', ca: 'Catalan', cs: 'Czech', cy: 'Welsh',
  da: 'Danish', de: 'German', dv: 'Dhivehi', el: 'Greek', en: 'English', es: 'Spanish',
  et: 'Estonian', eu: 'Basque', fa: 'Persian', fi: 'Finnish', fil: 'Filipino',
  fo: 'Faroese', fr: 'French', ga: 'Irish', gd: 'Scottish Gaelic', gl: 'Galician',
  gu: 'Gujarati', he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian',
  'hy-am': 'Armenian', id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese',
  jv: 'Javanese', ka: 'Georgian', kk: 'Kazakh', km: 'Khmer', kn: 'Kannada', ko: 'Korean',
  ku: 'Kurdish', ky: 'Kyrgyz', lb: 'Luxembourgish', lo: 'Lao', lt: 'Lithuanian',
  lv: 'Latvian', mi: 'Māori', mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian',
  mr: 'Marathi', ms: 'Malay', mt: 'Maltese', my: 'Burmese', nb: 'Norwegian Bokmål',
  ne: 'Nepali', nl: 'Dutch', nn: 'Norwegian Nynorsk', 'pa-in': 'Punjabi', pl: 'Polish',
  pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', si: 'Sinhala', sk: 'Slovak',
  sl: 'Slovenian', sq: 'Albanian', sr: 'Serbian', sv: 'Swedish', sw: 'Swahili',
  ta: 'Tamil', te: 'Telugu', tg: 'Tajik', th: 'Thai', tk: 'Turkmen', tr: 'Turkish',
  'ug-cn': 'Uyghur', uk: 'Ukrainian', ur: 'Urdu', 'uz-latn': 'Uzbek (Latin)',
  vi: 'Vietnamese', yo: 'Yoruba', 'zh-cn': 'Simplified Chinese',
};

/**
 * Where each country sits, for the picker's continent map.
 *
 * `point` is [longitude, latitude]. Both fields are REQUIRED: pack-picker.ts
 * filters the map by `regions`, so a country with none is absent from every
 * continent screen and reachable only by typing its name — present and
 * invisible, which is the failure this file exists to prevent. Hence the throw
 * below rather than a default.
 *
 * Two regions is for a country the picker should show on both maps; the
 * existing entries use it only for Russia, and these follow the same reading
 * for the Caucasus, Turkey and Cyprus.
 */
const COUNTRY_GEO = {
  albania: [['europe'], [20, 41]],
  armenia: [['europe', 'asia'], [45, 40.2]],
  azerbaijan: [['europe', 'asia'], [47.6, 40.3]],
  bangladesh: [['asia'], [90.4, 23.7]],
  bhutan: [['asia'], [90.4, 27.5]],
  bosnia_and_herzegovina: [['europe'], [17.8, 44]],
  bulgaria: [['europe'], [25.5, 42.7]],
  cambodia: [['asia'], [105, 12.6]],
  croatia: [['europe'], [15.8, 45.1]],
  cyprus: [['europe', 'asia'], [33.2, 35.1]],
  czechia: [['europe'], [15.5, 49.8]],
  estonia: [['europe'], [25.5, 58.6]],
  georgia: [['europe', 'asia'], [43.4, 42.3]],
  ghana: [['africa'], [-1, 7.9]],
  hungary: [['europe'], [19.5, 47.2]],
  iceland: [['europe'], [-18.6, 64.9]],
  india: [['asia'], [79, 22]],
  indonesia: [['asia'], [113.9, -2.5]],
  iran: [['asia'], [53.7, 32.4]],
  israel: [['asia'], [34.9, 31]],
  japan: [['asia'], [138, 36.2]],
  kenya: [['africa'], [37.9, 0]],
  laos: [['asia'], [102.5, 19.9]],
  latvia: [['europe'], [24.6, 56.9]],
  lithuania: [['europe'], [23.9, 55.2]],
  malaysia: [['asia'], [102, 4.2]],
  maldives: [['asia'], [73.2, 3.2]],
  malta: [['europe'], [14.4, 35.9]],
  moldova: [['europe'], [28.4, 47.4]],
  mongolia: [['asia'], [103.8, 46.9]],
  myanmar: [['asia'], [96, 21.9]],
  nepal: [['asia'], [84.1, 28.4]],
  nigeria: [['africa'], [8.7, 9.1]],
  north_macedonia: [['europe'], [21.7, 41.6]],
  norway: [['europe'], [8.5, 60.5]],
  pakistan: [['asia'], [69.3, 30.4]],
  philippines: [['asia'], [121.8, 12.9]],
  romania: [['europe'], [25, 45.9]],
  serbia: [['europe'], [21, 44]],
  singapore: [['asia'], [103.8, 1.35]],
  slovakia: [['europe'], [19.7, 48.7]],
  slovenia: [['europe'], [15, 46.15]],
  south_korea: [['asia'], [127.8, 35.9]],
  sri_lanka: [['asia'], [80.8, 7.9]],
  taiwan: [['asia'], [121, 23.7]],
  tanzania: [['africa'], [34.9, -6.4]],
  thailand: [['asia'], [101, 15.9]],
  turkey: [['europe', 'asia'], [35.2, 39]],
  turkmenistan: [['asia'], [59.6, 39]],
  uganda: [['africa'], [32.3, 1.4]],
  ukraine: [['europe'], [31.2, 48.4]],
  uzbekistan: [['asia'], [64.6, 41.4]],
  vietnam: [['asia'], [108.3, 14.1]],
  zimbabwe: [['africa'], [29.2, -19]],
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
  const geo = COUNTRY_GEO[id];
  if (!geo) {
    throw new Error(
      `countryEntry: no geography for "${id}". Add it to COUNTRY_GEO as ` +
        '[[continent...], [longitude, latitude]]. Without it the pack installs ' +
        'but never appears on the picker\'s continent map.',
    );
  }
  const [regions, point] = geo;
  return {
    id,
    name: `${titleCase(id)} (country)`,
    description: `Data specific to ${titleCase(id)}: ${categoriesOf(join(PACKS, 'countries', id)).join(', ')}.`,
    country: id,
    regions,
    point,
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
