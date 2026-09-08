#!/usr/bin/env node
/**
 * The pack picker's map, pinned across implementations.
 *
 * The picker is ~5,600 lines spread over five languages and, until this file, not one of them
 * had a test. Most of it is a terminal loop and cannot be pinned here. Its GEOMETRY can, and
 * that is the part five copies of a table can quietly disagree about: each implementation
 * carries its own copy of the continent outlines, so a hand-edited coordinate in one of them
 * would move a coastline there and nowhere else, and nothing would say so.
 *
 * Three things are recorded, all pure functions of their arguments:
 *
 *   mapSizes  the largest map that fits a terminal of a given size
 *   rasters   the outlines rasterised — one character per pixel, sea, inland and coastline
 *   points    where a country's longitude and latitude land on a map of a given size
 *
 * A note for whoever touches the height formula: `round(w * 0.39 / 2)` is spelled with three
 * different rounding rules across the five (banker's in Python, half-up in TypeScript and Java,
 * away-from-zero in Rust and C#). Measured over every width the picker can reach, 0 through 199,
 * they never disagree — the value never lands on a half. Do not "unify" it into something that
 * does, and do not assume it is safe if the formula changes. `mapSizes` below sweeps every width
 * rather than sampling, so a change that breaks that is caught rather than argued about.
 *
 * The SAME question about the point projection had the opposite answer, which is why `mapCell`
 * spells `floor(x + 0.5)` out instead of saying `round`. At a 60-column map, Belarus, Ireland,
 * New Zealand, Suriname, Uruguay and Zambia all land on exactly x.5, and Python put every one
 * of them a column to the left of the other four — 58 (country, map size) pairs among the 198
 * points that ship.
 *
 *   --update   rewrite from current behaviour; the diff is the review.
 *   (default)  verify.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { mapCell, mapRows, mapSize } from '../src/cli/pack-picker.ts';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(resolve(here, '..', '..', 'fixtures', 'cross-language'), 'pack-picker.json');
const update = process.argv.includes('--update');

/**
 * Terminal shapes worth asking about: comfortable, cramped, and too small to draw at all — and
 * then every width from nothing to wider than the picker will ever use, both ways, so the
 * height formula is pinned over its whole reachable range rather than at a few points.
 */
const TERMINALS = [
  { columns: 200, rows: 60, reserved: 13, halfBlocks: true },
  { columns: 200, rows: 60, reserved: 13, halfBlocks: false },
  { columns: 120, rows: 40, reserved: 13, halfBlocks: true },
  { columns: 120, rows: 40, reserved: 13, halfBlocks: false },
  { columns: 80, rows: 24, reserved: 13, halfBlocks: true },
  { columns: 80, rows: 24, reserved: 13, halfBlocks: false },
  { columns: 60, rows: 24, reserved: 13, halfBlocks: true },
  { columns: 59, rows: 24, reserved: 13, halfBlocks: true },
  { columns: 200, rows: 14, reserved: 13, halfBlocks: true },
  { columns: 4, rows: 60, reserved: 13, halfBlocks: true },
  { columns: 0, rows: 0, reserved: 0, halfBlocks: true },
  ...Array.from({ length: 205 }, (_, columns) => ({
    columns,
    rows: 200,
    reserved: 0,
    halfBlocks: columns % 2 === 0,
  })),
];

/** Two sizes: the smallest the picker will draw, and one a wide terminal reaches. */
const RASTERS = [
  { w: 56, h: 22 },
  { w: 60, h: 24 },
  { w: 132, h: 52 },
];

/**
 * Points that answer a question a reader can check on a map: a capital in each continent, the
 * two edges of the projection, and coordinates that fall off it entirely.
 */
const POINTS = [
  // Six that land on exactly x.5 at a 60-column map — the halves Python used to round the
  // other way. Their coordinates are the ones the registry ships.
  { name: 'Belarus', lon: 28, lat: 53 },
  { name: 'Ireland', lon: -8, lat: 53 },
  { name: 'New Zealand', lon: 174, lat: -41 },
  { name: 'Suriname', lon: -56, lat: 4 },
  { name: 'Uruguay', lon: -56, lat: -33 },
  { name: 'Zambia', lon: 28, lat: -13 },
  { name: 'Lisbon', lon: -9, lat: 39 },
  { name: 'Moscow', lon: 37, lat: 56 },
  { name: 'Cape Town', lon: 18, lat: -34 },
  { name: 'Tokyo', lon: 140, lat: 36 },
  { name: 'Wellington', lon: 175, lat: -41 },
  { name: 'Buenos Aires', lon: -58, lat: -35 },
  { name: 'Anchorage', lon: -150, lat: 61 },
  { name: 'the western edge', lon: -170, lat: 84 },
  { name: 'the eastern edge', lon: 190, lat: -56 },
  { name: 'past the western edge', lon: -179, lat: 0 },
  { name: 'the north pole', lon: 0, lat: 90 },
  { name: 'the south pole', lon: 0, lat: -90 },
];

const document = {
  schemaVersion: 1,
  comment:
    "The pack picker's map geometry. `mapSizes` is the largest map that fits a terminal; " +
    '`rasters` is the continent outlines rasterised, one character per pixel — "." sea, ' +
    'lower-case inland, UPPER-CASE coastline (a africa, s asia, e europe, n north, u south, ' +
    'o oceania); `points` is where a country lands on a map of that size, null when it falls ' +
    'outside. Regenerate with: npm run picker -- --update',
  mapSizes: TERMINALS.map((t) => ({
    ...t,
    size: mapSize(t.columns, t.rows, t.reserved, t.halfBlocks),
  })),
  rasters: RASTERS.map(({ w, h }) => ({ w, h, rows: [...mapRows(w, h)] })),
  points: POINTS.flatMap((p) =>
    RASTERS.map(({ w, h }) => ({ ...p, w, h, cell: mapCell(p.lon, p.lat, w, h) })),
  ),
};

if (update) {
  writeFileSync(OUT, `${JSON.stringify(document, null, 2)}\n`);
  console.log(
    `pack-picker.json: ${String(document.mapSizes.length)} sizes, ` +
      `${String(document.rasters.length)} rasters, ${String(document.points.length)} points`,
  );
  process.exit(0);
}

let current;
try {
  current = JSON.parse(readFileSync(OUT, 'utf8'));
} catch {
  console.error(`${OUT} is missing or unreadable — run: npm run picker -- --update`);
  process.exit(1);
}
const mine = JSON.stringify(document, null, 2);
if (mine !== JSON.stringify(current, null, 2)) {
  console.error(
    'The pack picker map changed.\n\n' +
      'If the change is intended, run `npm run picker:update` and review the diff — ' +
      'every implementation is held to this file.',
  );
  process.exit(1);
}
console.log(
  `pack-picker.json: ${String(document.mapSizes.length)} sizes, ` +
    `${String(document.rasters.length)} rasters, ${String(document.points.length)} points match`,
);
