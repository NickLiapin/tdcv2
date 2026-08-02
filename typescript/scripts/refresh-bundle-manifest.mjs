/**
 * Regenerate `data/bundles.json` from what is actually on disk.
 *
 * The manifest is the catalogue a user picks from, and it had drifted badly: 13 entries against
 * 248 folders, because it was written when only English and Spanish existed and never grew with
 * the data. A hand-maintained list of a hundred-odd bundles will drift again, so it is derived.
 *
 *   node scripts/refresh-bundle-manifest.mjs [--check]
 *
 * One bundle per AXIS, never a mash: `en` is the English language with no country in it, `usa` is
 * the country with no language in it, `common` is neither. That is what lets someone take English
 * without the United States, or Canadian French as common + fr + canada. A single `en-us` bundle
 * would make both impossible.
 *
 * A folder is published only if it holds enough to be worth downloading:
 *
 *   locale    at least LOCALE_MIN files. A full locale carries 220+; the ones below the line are
 *             started, not finished, and a catalogue entry is a promise that the address resolves.
 *   country   at least COUNTRY_MIN. The thirteen at one file each hold only a VAT format.
 *
 * Everything skipped is printed with its reason. A folder that quietly failed to appear would be
 * indistinguishable from one nobody has written yet.
 *
 * Descriptions written by hand are KEPT — they say things about a country's check digits that no
 * script can derive. "Written by hand" means "differs from what this script would produce": a
 * description the script itself wrote last time is regenerated, so improving the wording here
 * improves every entry rather than only the new ones.
 *
 * Names are always regenerated. They are formulaic, and keeping them let a first run's ugly
 * `Pl (language)` survive the very commit that added the table of language names.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../..');
const DATA = join(REPO, 'data');
const PACKS = join(DATA, 'packs');
const MANIFEST = join(DATA, 'bundles.json');

/** A locale below this is a start, not a language. The full ones carry 220+. */
const LOCALE_MIN = 100;

/** A country below this is a placeholder — the thirteen at one file hold only a VAT format. */
const COUNTRY_MIN = 4;

const CHECK = process.argv.includes('--check');

function countFiles(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) total += countFiles(full);
    else if (entry.name.endsWith('.txt')) total += 1;
  }
  return total;
}

/** Top-level areas the folder actually covers, for a description nobody had to write. */
function categories(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() || (e.isFile() && e.name.endsWith('.txt')))
    .map((e) => e.name.replace(/\.txt$/, ''))
    .filter((n) => !n.startsWith('_'))
    .sort();
}

/**
 * What a language is called, in English.
 *
 * `_locale.json` carries a code and a writing direction, not a name, and a bundle called
 * "Pl (language)" tells a reader nothing. Small and closed: a locale only reaches the catalogue
 * once it is finished, and an unnamed one here is a reminder to add the line, not a failure.
 */
const LANGUAGE_NAMES = {
  ar: 'Arabic',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
};

function readLocaleName(dir, id) {
  const meta = join(dir, '_locale.json');
  if (existsSync(meta)) {
    try {
      const parsed = JSON.parse(readFileSync(meta, 'utf8'));
      if (typeof parsed.name === 'string') return parsed.name;
    } catch {
      // A malformed _locale.json is the pack's problem, not the catalogue's.
    }
  }
  return LANGUAGE_NAMES[id];
}

/**
 * Where each country is, so a catalogue can be browsed as a map rather than as 97 lines.
 *
 * This lives with the catalogue, not with whichever command draws it: the interactive picker
 * exists in three languages, and a table repeated three times is a table that will disagree with
 * itself. `regions` is a list because Russia really is in two of them — a person hunting for it
 * will look under whichever half they had in mind, and listing it twice costs nothing.
 *
 * `point` is [longitude, latitude], roughly the middle of the country. It is precise enough to
 * light the right spot on a map a hundred characters wide, and no more precise than that.
 */
const GEOGRAPHY = {
  algeria: { regions: ['africa'], point: [3, 28] },
  angola: { regions: ['africa'], point: [17, -12] },
  argentina: { regions: ['south'], point: [-64, -34] },
  australia: { regions: ['oceania'], point: [134, -25] },
  austria: { regions: ['europe'], point: [14, 47.5] },
  bahrain: { regions: ['asia'], point: [50.5, 26] },
  belarus: { regions: ['europe'], point: [28, 53.5] },
  belgium: { regions: ['europe'], point: [4.5, 50.5] },
  benin: { regions: ['africa'], point: [2.3, 9.5] },
  bolivia: { regions: ['south'], point: [-64, -17] },
  brazil: { regions: ['south'], point: [-52, -10] },
  burkina_faso: { regions: ['africa'], point: [-1.7, 12.3] },
  cameroon: { regions: ['africa'], point: [12.5, 6] },
  canada: { regions: ['north'], point: [-106, 58] },
  cape_verde: { regions: ['africa'], point: [-24, 16] },
  chad: { regions: ['africa'], point: [19, 15] },
  chile: { regions: ['south'], point: [-71, -35] },
  colombia: { regions: ['south'], point: [-73, 4] },
  comoros: { regions: ['africa'], point: [43.3, -11.7] },
  congo: { regions: ['africa'], point: [15.5, -1] },
  costa_rica: { regions: ['north'], point: [-84, 10] },
  cuba: { regions: ['north'], point: [-79, 21.5] },
  denmark: { regions: ['europe'], point: [10, 56] },
  djibouti: { regions: ['africa'], point: [42.6, 11.6] },
  dominican_republic: { regions: ['north'], point: [-70.7, 19] },
  dr_congo: { regions: ['africa'], point: [23, -3] },
  east_timor: { regions: ['asia'], point: [125.7, -8.8] },
  ecuador: { regions: ['south'], point: [-78.5, -1.5] },
  egypt: { regions: ['africa'], point: [30, 27] },
  el_salvador: { regions: ['north'], point: [-88.9, 13.8] },
  equatorial_guinea: { regions: ['africa'], point: [10.5, 1.6] },
  finland: { regions: ['europe'], point: [26, 64] },
  france: { regions: ['europe'], point: [2.5, 46.5] },
  gabon: { regions: ['africa'], point: [11.8, -0.8] },
  germany: { regions: ['europe'], point: [10.4, 51] },
  greece: { regions: ['europe'], point: [22, 39] },
  guatemala: { regions: ['north'], point: [-90.4, 15.7] },
  guinea: { regions: ['africa'], point: [-11, 10.5] },
  guinea_bissau: { regions: ['africa'], point: [-15, 12] },
  haiti: { regions: ['north'], point: [-72.5, 19] },
  honduras: { regions: ['north'], point: [-86.5, 14.8] },
  iraq: { regions: ['asia'], point: [43.7, 33] },
  ireland: { regions: ['europe'], point: [-8, 53.3] },
  italy: { regions: ['europe'], point: [12.5, 42.8] },
  ivory_coast: { regions: ['africa'], point: [-5.5, 7.6] },
  jordan: { regions: ['asia'], point: [36.5, 31] },
  kazakhstan: { regions: ['asia'], point: [67, 48] },
  kuwait: { regions: ['asia'], point: [47.6, 29.3] },
  kyrgyzstan: { regions: ['asia'], point: [74.5, 41.3] },
  lebanon: { regions: ['asia'], point: [35.9, 33.9] },
  libya: { regions: ['africa'], point: [17, 27] },
  liechtenstein: { regions: ['europe'], point: [9.55, 47.15] },
  luxembourg: { regions: ['europe'], point: [6.1, 49.8] },
  macau: { regions: ['asia'], point: [113.55, 22.2] },
  madagascar: { regions: ['africa'], point: [46.8, -19] },
  mali: { regions: ['africa'], point: [-3, 17.5] },
  mauritania: { regions: ['africa'], point: [-10.5, 20.5] },
  mexico: { regions: ['north'], point: [-102, 23.5] },
  monaco: { regions: ['europe'], point: [7.42, 43.74] },
  morocco: { regions: ['africa'], point: [-6, 32] },
  mozambique: { regions: ['africa'], point: [35.5, -18] },
  netherlands: { regions: ['europe'], point: [5.5, 52.2] },
  new_zealand: { regions: ['oceania'], point: [172, -41] },
  nicaragua: { regions: ['north'], point: [-85.2, 12.9] },
  niger: { regions: ['africa'], point: [9, 17.5] },
  oman: { regions: ['asia'], point: [56, 21] },
  palestine: { regions: ['asia'], point: [35.2, 31.9] },
  panama: { regions: ['north'], point: [-80.1, 8.5] },
  paraguay: { regions: ['south'], point: [-58, -23.4] },
  peru: { regions: ['south'], point: [-75, -9.2] },
  poland: { regions: ['europe'], point: [19.4, 52] },
  portugal: { regions: ['europe'], point: [-8.2, 39.5] },
  puerto_rico: { regions: ['north'], point: [-66.5, 18.2] },
  qatar: { regions: ['asia'], point: [51.2, 25.3] },
  russia: { regions: ['europe', 'asia'], point: [60, 60] },
  rwanda: { regions: ['africa'], point: [29.9, -2] },
  san_marino: { regions: ['europe'], point: [12.46, 43.94] },
  sao_tome_and_principe: { regions: ['africa'], point: [6.6, 0.2] },
  saudi_arabia: { regions: ['asia'], point: [45, 24] },
  senegal: { regions: ['africa'], point: [-14.5, 14.5] },
  somalia: { regions: ['africa'], point: [46, 5.5] },
  south_africa: { regions: ['africa'], point: [25, -29] },
  spain: { regions: ['europe'], point: [-3.7, 40.2] },
  sudan: { regions: ['africa'], point: [30, 15.5] },
  sweden: { regions: ['europe'], point: [15, 62] },
  switzerland: { regions: ['europe'], point: [8.2, 46.8] },
  syria: { regions: ['asia'], point: [38, 35] },
  tajikistan: { regions: ['asia'], point: [71, 38.8] },
  togo: { regions: ['africa'], point: [1, 8.6] },
  tunisia: { regions: ['africa'], point: [9.5, 34] },
  uae: { regions: ['asia'], point: [54, 24] },
  united_kingdom: { regions: ['europe'], point: [-2, 54] },
  uruguay: { regions: ['south'], point: [-56, -32.8] },
  usa: { regions: ['north'], point: [-98, 39] },
  vatican_city: { regions: ['europe'], point: [12.45, 41.9] },
  venezuela: { regions: ['south'], point: [-66, 7] },
  yemen: { regions: ['asia'], point: [47, 15.5] },
};

function titleCase(id) {
  return id
    .split(/[_-]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function describe(kind, id, dir) {
  const areas = categories(dir);
  const shown = areas.slice(0, 12).join(', ');
  const more = areas.length > 12 ? `, and ${areas.length - 12} more` : '';
  return kind === 'locale'
    ? `Content bound to the ${LANGUAGE_NAMES[id] ?? titleCase(id)} language rather than to any one country: ${shown}${more}.`
    : `Data specific to ${titleCase(id)}: ${shown}${more}.`;
}

const previous = JSON.parse(readFileSync(MANIFEST, 'utf8'));
const handWritten = new Map(previous.bundles.map((b) => [b.id, b]));

/**
 * A previous description, but only if a person wrote it.
 *
 * The generated form is recognisable because it is exactly what `describe` produces; anything
 * else came from an author and says something the folder listing cannot.
 */
function authored(id, generated) {
  const previousText = handWritten.get(id)?.description;
  if (previousText === undefined) return generated;
  const looksGenerated =
    previousText.startsWith('Data specific to ') || previousText.startsWith('Content bound to the ');
  const listsCategories = /: [a-z_]+(, [a-z_]+)+\.$|, and \d+ more\.$/.test(previousText);
  return looksGenerated && listsCategories ? generated : previousText;
}

const bundles = [];
const skipped = [];
/** Published countries with no entry in GEOGRAPHY — they would be invisible on the map. */
const unplaced = [];

// `common` first: it is neither a language nor a country, and it is what everything else composes
// with, so it reads first in the catalogue too.
for (const id of ['common']) {
  const dir = join(PACKS, id);
  const files = countFiles(dir);
  bundles.push({
    id,
    name: 'Common (locale-agnostic)',
    description:
      handWritten.get(id)?.description ??
      'Generators bound to neither a language nor a country: uuid, hashes, ISBN/ISSN, GTIN/UPC/EAN, card PANs, MRZ, IPv4/IPv6/MAC, semver, and more.',
    packs: [`packs/${id}`],
    files,
  });
}

for (const entry of readdirSync(PACKS, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory() || entry.name === 'countries' || entry.name === 'common') continue;
  const id = entry.name;
  const dir = join(PACKS, id);
  const files = countFiles(dir);
  if (files < LOCALE_MIN) {
    skipped.push({ id, kind: 'locale', files, why: files === 0 ? 'empty' : `only ${files} files` });
    continue;
  }
  bundles.push({
    id,
    name: `${readLocaleName(dir, id) ?? titleCase(id)} (language)`,
    description: authored(id, describe('locale', id, dir)),
    locale: id,
    packs: [`packs/${id}`],
    files,
  });
}

const countriesDir = join(PACKS, 'countries');
for (const entry of readdirSync(countriesDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const id = entry.name;
  const dir = join(countriesDir, id);
  const files = countFiles(dir);
  if (files < COUNTRY_MIN) {
    skipped.push({ id, kind: 'country', files, why: files === 0 ? 'empty' : `only ${files} files` });
    continue;
  }
  const place = GEOGRAPHY[id];
  if (place === undefined) unplaced.push(id);
  bundles.push({
    id,
    name: `${titleCase(id)} (country)`,
    description: authored(id, describe('country', id, dir)),
    country: id,
    ...(place ? { regions: place.regions, point: place.point } : {}),
    packs: [`packs/countries/${id}`],
    files,
  });
}

// `files` was only carried to report on; the manifest itself does not need it, and a count that
// could go stale in a checked-in file is a lie waiting to happen.
const document = {
  $comment: previous.$comment,
  bundles: bundles.map(({ files: _files, ...rest }) => rest),
};
const text = JSON.stringify(document, null, 2) + '\n';

for (const bundle of bundles) {
  process.stdout.write(`  ${bundle.id.padEnd(24)} ${String(bundle.files).padStart(4)} files\n`);
}
process.stdout.write(`\n${bundles.length} bundles\n`);

if (unplaced.length > 0) {
  process.stdout.write(
    `\nno place on the map (add them to GEOGRAPHY): ${unplaced.join(', ')}\n`,
  );
}

if (skipped.length > 0) {
  process.stdout.write(`\nnot published (${skipped.length}) — a catalogue entry has to resolve:\n`);
  const byReason = new Map();
  for (const s of skipped) {
    const key = `${s.kind}, ${s.why === 'empty' ? 'empty' : 'a stub'}`;
    byReason.set(key, [...(byReason.get(key) ?? []), s.id]);
  }
  for (const [reason, ids] of byReason) {
    process.stdout.write(`  ${reason}: ${ids.length} — ${ids.slice(0, 8).join(', ')}${ids.length > 8 ? ', …' : ''}\n`);
  }
}

if (CHECK) {
  const current = readFileSync(MANIFEST, 'utf8');
  if (current !== text) {
    process.stderr.write('\ndata/bundles.json is out of date — run scripts/refresh-bundle-manifest.mjs\n');
    process.exit(1);
  }
  process.stdout.write('\nmanifest is up to date\n');
} else {
  writeFileSync(MANIFEST, text);
  process.stdout.write(`\nwrote ${MANIFEST}\n`);
}
