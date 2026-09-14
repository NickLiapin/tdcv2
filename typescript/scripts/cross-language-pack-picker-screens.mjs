#!/usr/bin/env node
/**
 * The pack picker's screens, pinned across implementations.
 *
 * Its sibling `cross-language-pack-picker.mjs` pins the map's GEOMETRY — pure functions of a
 * width and a height, the part that could be tested without a terminal. This file pins what the
 * picker actually shows: every line it draws, after every key, on the way through a whole
 * session. That is the other 90% of the file, and until this existed nothing ran it.
 *
 * Four runs, chosen to reach the screens rather than to be pretty:
 *
 *   plain      a narrow ASCII terminal: browse, pick, drop one in review, apply
 *   map        a wide colour terminal: the continent map, a region, a pick, a leave
 *   search     `/`, three letters, a pick, escape back out, cancel
 *   installed  packs already on disk: mark one for removal and apply the removal
 *
 * Between them: both glyph sets, colour on and off, the map drawn and the map suppressed for
 * want of rows, a list that scrolls and one that does not, a cursor clamped at both ends, an
 * empty basket and a full one, and both exits — Apply, and `q`.
 *
 * The catalogue is six invented bundles carried in the fixture rather than the real registry,
 * which grows every time a pack is published and would rewrite every screen here when it did.
 *
 * `escape` used to be the one key no run could contain anywhere but at the end: the ports read
 * the byte after a bare ESC to find out whether an arrow was coming and threw it away, so Escape
 * did nothing until the next key and that key vanished. The byte is handed back now, and the
 * search run presses Escape in the middle on purpose. What still differs is only WHEN: Node's
 * readline gives up waiting after half a second and acts on Escape alone, while a port waits for
 * the next keypress. The screens either way are these.
 *
 *   --update   rewrite from current behaviour; the diff is the review.
 *   (default)  verify.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundlesFromFixture, playRun } from './picker-screens.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  resolve(here, '..', '..', 'fixtures', 'cross-language'),
  'pack-picker-screens.json',
);
const update = process.argv.includes('--update');

/**
 * Six bundles: one that belongs to no locale, two languages, three countries on two continents.
 *
 * Spelled with `null` rather than left out, because `JSON.stringify` drops an `undefined` and a
 * port then reads a bundle with no `locale` key at all. `bundlesFromFixture` turns them back into
 * the `undefined` the picker's own type asks for.
 */
const BUNDLES = [
  {
    id: 'common',
    name: 'Common (locale-agnostic)',
    description: 'Colours, animals, and everything that does not speak a language',
    bytes: 12000,
    locale: null,
    country: null,
    regions: null,
    point: null,
  },
  {
    id: 'fr',
    name: 'French (language)',
    description: 'Names, streets and words in French',
    bytes: 340000,
    locale: 'fr',
    country: null,
    regions: null,
    point: null,
  },
  {
    id: 'pl',
    name: 'Polish (language)',
    description: 'Names, streets and words in Polish',
    bytes: 210000,
    locale: 'pl',
    country: null,
    regions: null,
    point: null,
  },
  {
    id: 'france',
    name: 'France (country)',
    description: 'NIR, SIRET and a French IBAN',
    bytes: 41000,
    locale: null,
    country: 'FR',
    regions: ['europe'],
    point: [2.3, 48.9],
  },
  {
    id: 'poland',
    name: 'Poland (country)',
    description: 'PESEL, NIP and REGON',
    bytes: 38000,
    locale: null,
    country: 'PL',
    regions: ['europe'],
    point: [19.1, 52.2],
  },
  {
    id: 'brazil',
    name: 'Brazil (country)',
    description: 'CPF, CNPJ and PIS',
    bytes: 52000,
    locale: null,
    country: 'BR',
    regions: ['south'],
    point: [-47.9, -15.8],
  },
];

const RUNS = [
  {
    name: 'browse, pick two, drop one, apply',
    terminal: { columns: 80, rows: 24, unicode: false, colour: false },
    installed: [],
    // The second `down` on the review screen is deliberate: the cursor is already on the last
    // row, and a clamp that let it past would be invisible without a key that tries.
    keys: [
      'down',
      'enter',
      'space',
      'down',
      'enter',
      'space',
      'backspace',
      'down',
      'down',
      'enter',
      'space',
      'down',
      'down',
      'enter',
    ],
  },
  {
    name: 'the continent map, in colour',
    terminal: { columns: 100, rows: 40, unicode: true, colour: true },
    installed: [],
    keys: ['down', 'enter', 'down', 'down', 'enter', 'enter', 'space', 'backspace', 'm', 'q'],
  },
  {
    name: 'search, pick, and cancel',
    terminal: { columns: 80, rows: 24, unicode: false, colour: false },
    installed: [],
    // `escape` in the MIDDLE, deliberately. It used to be the one key no run could contain:
    // the ports read the byte after a bare ESC to find out whether an arrow was coming and
    // threw it away, so Escape did nothing until the next key and that key vanished. The byte
    // is handed back now, and this run is what says so in every implementation at once.
    keys: ['/', 'p', 'o', 'l', 'down', 'enter', 'escape', 'down', 'enter', 'q'],
  },
  {
    name: 'mark an installed pack for removal and apply',
    terminal: { columns: 80, rows: 24, unicode: false, colour: false },
    installed: ['common', 'fr'],
    // `backspace` keeps the cursor where it was, so `up` is what reaches "Choose what I need".
    keys: [
      'down',
      'down',
      'enter',
      'space',
      'backspace',
      'up',
      'enter',
      'down',
      'down',
      'down',
      'enter',
      'down',
      'enter',
    ],
  },
];

const runs = [];
for (const run of RUNS) {
  const played = await playRun(bundlesFromFixture(BUNDLES), run);
  runs.push({
    name: run.name,
    terminal: run.terminal,
    installed: run.installed,
    keys: run.keys,
    screens: played.screens,
    result: played.result,
  });
}

const document = {
  schemaVersion: 1,
  comment:
    'What the pack picker shows. Each run starts the picker with `bundles` and `installed`, ' +
    'sends `keys` one at a time, and records the screen drawn after each: `screens[0]` is the ' +
    'opening draw and `screens[n]` follows `keys[n-1]`. A key name is what the hand-written ' +
    'decoders produce (see pack-picker-keys.json); anything else is the character itself. ' +
    'Screens keep colour codes — they are drawn — but not the clear, home and cursor commands, ' +
    'which every implementation spells in its own order; a picker that has left draws nothing, ' +
    'which is the one empty line each run ends on. `result` is what the picker returned. ' +
    'Regenerate with: npm run picker:screens -- --update',
  bundles: BUNDLES,
  runs,
};

const text = `${JSON.stringify(document, null, 2)}\n`;
const count = runs.reduce((n, r) => n + r.screens.length, 0);

if (update) {
  writeFileSync(OUT, text);
  console.log(`pack-picker-screens.json: ${String(runs.length)} runs, ${String(count)} screens`);
  process.exit(0);
}

// Compared as DATA, not as bytes: the commit hook runs prettier over every fixture, so the
// file on disk is formatted its way rather than JSON.stringify's, and a byte comparison would
// fail on every push while the screens themselves matched perfectly.
let current;
try {
  current = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  console.error(`${OUT} is missing or unreadable — run: npm run picker:screens -- --update`);
  process.exit(1);
}
if (JSON.stringify(document, null, 2) !== JSON.stringify(current, null, 2)) {
  console.error(
    'The pack picker draws something different.\n\n' +
      'If the change is intended, run `npm run picker:screens:update` and review the diff — ' +
      'every implementation is held to this file.',
  );
  process.exit(1);
}
console.log(
  `pack-picker-screens.json: ${String(runs.length)} runs, ${String(count)} screens match`,
);
