/**
 * Raster pattern mode: a PNG is decoded (no external deps) and each column's
 * ink defines the height — a filled shape on the floor is a signal, a floating
 * band is a corridor. Test images are synthesized here with a tiny PNG encoder
 * so the full decode → extract → stretch loop runs on real bytes.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodePng } from '../../src/generators/png.js';
import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

// ---- a minimal PNG encoder, for tests only (CRCs are zeroed; the decoder skips them) ----
function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, data.length);
  const t = new Uint8Array(type.length);
  for (let i = 0; i < type.length; i++) t[i] = type.charCodeAt(i);
  return concat([len, t, data, new Uint8Array(4)]);
}
function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** colorType: 0 gray (1 chan) or 6 RGBA (4 chan). `px(x,y)` returns the sample bytes. */
function encodePng(
  width: number,
  height: number,
  colorType: 0 | 6,
  px: (x: number, y: number) => number[],
): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  const chan = colorType === 0 ? 1 : 4;
  const raw = new Uint8Array(height * (1 + width * chan));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: None
    for (let x = 0; x < width; x++) for (const s of px(x, y)) raw[p++] = s;
  }
  return concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

function writePng(bytes: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdc-png-'));
  const file = join(dir, 'img.png');
  writeFileSync(file, bytes);
  return file;
}

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const nums = (src: string, extra: string, opts: RenderOptions, count = 11): number[] =>
  render(
    parseStrict(
      `<tdc><env count="${String(count)}" seed="png"><sequence name="V">` +
        `<gen type="pattern" src="${src}" ${extra}/></sequence></env>` +
        `<block><line><data>\${{V}}</data></line></block></tdc>`,
    ),
    opts,
  )
    .split('\n')
    .filter(Boolean)
    .map(Number);

describe('decodePng — real bytes through the decoder', () => {
  it('decodes an 8-bit grayscale image', () => {
    const bytes = encodePng(3, 2, 0, (x, y) => [x === y ? 0 : 255]);
    const img = decodePng(bytes);
    expect([img.width, img.height]).toEqual([3, 2]);
    // pixel (0,0) black, (1,0) white; alpha filled to 255.
    expect([img.rgba[0], img.rgba[1], img.rgba[2], img.rgba[3]]).toEqual([0, 0, 0, 255]);
    expect(img.rgba[4]).toBe(255); // (1,0) is white
  });

  it('decodes RGBA and keeps the alpha channel', () => {
    const bytes = encodePng(2, 1, 6, (x) => (x === 0 ? [0, 0, 0, 255] : [0, 0, 0, 0]));
    const img = decodePng(bytes);
    expect(img.rgba[3]).toBe(255); // opaque black
    expect(img.rgba[7]).toBe(0); // transparent
  });
});

describe('type="pattern" src=PNG — signal from a filled histogram', () => {
  // A triangle of black ink sitting on the floor: tall in the middle, empty at the edges.
  const H = 11;
  const triangle = encodePng(11, H, 0, (x, y) => {
    const fill = Math.round((H - 1) * (1 - Math.abs(x - 5) / 5)); // pixels of bar height
    const topRow = H - 1 - fill;
    return [y >= topRow ? 0 : 255];
  });

  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`a fill on the floor reads as a corridor up to its top edge (${label})`, () => {
      const src = writePng(triangle);
      const xs = nums(src, 'y_range="0..100"', opts, 40);
      // Each column is measured from the floor up and from the top down. A fill
      // touching the floor therefore spans [0 … bar height]: the value is random
      // inside that band. Only a column whose ink is a single pixel (the flat
      // edges here) collapses to one exact value.
      expect(xs.every((v) => v >= 0 && v <= 100)).toBe(true);
      expect(Math.max(...xs)).toBeGreaterThan(60); // tall middle columns are reachable
    });
  }
});

describe('type="pattern" src=PNG — corridor from a floating band', () => {
  // A horizontal black stripe on rows 3..5 of an 11-tall image (does not touch the floor).
  const band = encodePng(11, 11, 0, (_x, y) => [y >= 3 && y <= 5 ? 0 : 255]);

  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`values land inside the stripe's band (${label})`, () => {
      const src = writePng(band);
      // rows 3..5 in an H=11 image → heights 5..7 of 10 → y_range 0..100 → band [50,70].
      const xs = nums(src, 'y_range="0..100"', opts, 40);
      expect(xs.every((v) => v >= 49 && v <= 71)).toBe(true);
      expect(Math.min(...xs)).toBeLessThan(58); // spans the low side of the band
      expect(Math.max(...xs)).toBeGreaterThan(62); // and the high side
    });
  }

  it('a one-pixel line collapses the band → exact values, no randomness', () => {
    // A single-pixel stroke: the reading from below and from above meet, so the
    // column is an exact point on the graph rather than a range.
    const line = encodePng(11, 11, 0, (_x, y) => [y === 4 ? 0 : 255]);
    const src = writePng(line);
    const a = nums(src, 'y_range="0..100"', { now: NOW, engine: 1 }, 40);
    // Every card lands on the very same value: a band would have scattered them.
    expect(a.every((v) => Math.abs(v - 60) < 1)).toBe(true); // row 4 → height 6 → 60
  });
});

describe('raster validation', () => {
  it('errors on an image with no ink', () => {
    const blank = writePng(encodePng(4, 4, 0, () => [255]));
    expect(() => nums(blank, 'y_range="0..100"', { now: NOW, engine: 1 })).toThrow(
      /too little ink/i,
    );
  });

  it('ink_threshold moves the dark/light cutoff', () => {
    // A mid-gray (128) bar: below the default cutoff it is background, above it is ink.
    const gray = writePng(encodePng(4, 4, 0, (_x, y) => [y >= 2 ? 128 : 255]));
    // low threshold (0.4 → 102): 128 is lighter than the cut → no ink → error.
    expect(() =>
      nums(gray, 'y_range="0..100" ink_threshold="0.4"', { now: NOW, engine: 1 }),
    ).toThrow(/too little ink/i);
    // high threshold (0.6 → 153): 128 counts as ink → a signal is produced.
    expect(nums(gray, 'y_range="0..100" ink_threshold="0.6"', { now: NOW, engine: 1 }).length).toBe(
      11,
    );
  });
});
