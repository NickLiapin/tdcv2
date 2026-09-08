/**
 * The pack picker's map, against the shared fixture.
 *
 * The picker is about 5,600 lines across the five implementations and had no test at all —
 * the largest untested surface in the project. Most of it is a terminal loop, and a loop that
 * reads keys is not something a fixture can hold. Its geometry is, and geometry is the part
 * five copies of a coordinate table can quietly disagree about: each implementation keeps its
 * own continent outlines, so one hand-edited number would move a coastline in one language and
 * nowhere else.
 *
 * The tables were identical when this was written — measured, all six continents, every
 * number. What was missing was anything that would notice if they stopped being.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { mapCell, mapRows, mapSize } from '../../src/cli/pack-picker.js';

const FIXTURE = join(
  resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'cross-language'),
  'pack-picker.json',
);

interface Fixture {
  readonly mapSizes: readonly {
    readonly columns: number;
    readonly rows: number;
    readonly reserved: number;
    readonly halfBlocks: boolean;
    readonly size: { readonly w: number; readonly h: number } | null;
  }[];
  readonly rasters: readonly {
    readonly w: number;
    readonly h: number;
    readonly rows: readonly string[];
  }[];
  readonly points: readonly {
    readonly name: string;
    readonly lon: number;
    readonly lat: number;
    readonly w: number;
    readonly h: number;
    readonly cell: { readonly col: number; readonly row: number } | null;
  }[];
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;

describe('the picker map matches the shared fixture', () => {
  it('fits the map to the terminal', () => {
    for (const c of fixture.mapSizes) {
      expect(mapSize(c.columns, c.rows, c.reserved, c.halfBlocks)).toEqual(c.size);
    }
  });

  it('rasterises the continents to the same pixels', () => {
    for (const r of fixture.rasters) {
      expect(mapRows(r.w, r.h)).toEqual(r.rows);
    }
  });

  it('puts a country where the country is', () => {
    for (const p of fixture.points) {
      expect(mapCell(p.lon, p.lat, p.w, p.h), p.name).toEqual(p.cell);
    }
  });
});

describe('what the map is, beyond matching itself', () => {
  it('half-blocks buy height, so the same terminal takes a bigger map', () => {
    const half = mapSize(120, 40, 13, true);
    const full = mapSize(120, 40, 13, false);
    expect(half).not.toBeNull();
    expect(full).not.toBeNull();
    expect(half?.w).toBeGreaterThan(full?.w ?? 0);
  });

  it('refuses to draw rather than squash', () => {
    // Narrower than the smallest map, and no amount of height helps.
    expect(mapSize(59, 200, 0, true)).toBeNull();
    // Tall enough to be wide, but not tall enough for the list beside it.
    expect(mapSize(200, 14, 13, true)).toBeNull();
  });

  it('keeps the aspect ratio at every width it will choose', () => {
    // 360 degrees of longitude against 140 of latitude. A map that drifts from that shows
    // countries in the wrong place relative to each other, which is the map's whole job.
    for (let columns = 60; columns <= 200; columns += 1) {
      const size = mapSize(columns, 200, 0, true);
      if (!size) continue;
      expect(size.h).toBe(Math.max(2, Math.round((size.w * 0.39) / 2) * 2));
      expect(size.h % 2).toBe(0); // half-blocks pair rows, so an odd height cannot be drawn
    }
  });

  it('draws land, sea and coastline, and every land pixel belongs to one continent', () => {
    const rows = mapRows(56, 22);
    const seen = new Set(rows.join('').split(''));
    expect(seen.has('.')).toBe(true);
    for (const ch of seen) {
      if (ch === '.') continue;
      expect('asenuo').toContain(ch.toLowerCase());
    }
    // A coastline is not optional: every continent drawn has one, or it is a solid blob.
    for (const letter of 'asenuo') {
      const body = rows.join('');
      if (!body.includes(letter)) continue;
      expect(body).toContain(letter.toUpperCase());
    }
  });

  it('is a projection, not a lookup: a point outside the frame lands nowhere', () => {
    expect(mapCell(0, 90, 56, 22)).toBeNull(); // north of the frame
    expect(mapCell(0, -90, 56, 22)).toBeNull(); // south of it
    // The frame is half-open, so its top-left corner is on the map and its bottom-right is
    // just past it — the same way a pixel grid works. All five agree on both, which is what
    // matters; the fixture holds them so they go on agreeing.
    expect(mapCell(-170, 84, 56, 22)).toEqual({ col: 0, row: 0 });
    expect(mapCell(190, -56, 56, 22)).toBeNull();
    // A hair inside the far corner does land, on the last cell.
    expect(mapCell(189, -55, 56, 22)).toEqual({ col: 55, row: 21 });
  });
});
