/**
 * Pattern-graph signal mode. A drawn curve is stretched over the cards: card i
 * of `count` reads the curve at t=i/(count−1); the curve's height maps to the
 * declared `y_range`. Deterministic. Golden vectors come from the curve geometry.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildCorridor,
  buildSignalCurve,
  corridorValueAt,
  parseInterp,
  parseMode,
  parsePoints,
  parseSvgCurve,
  patternGenValue,
  signalValueAt,
  spreadFromAttrs,
} from '../../src/generators/pattern.js';
import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const curve = (s: string, yRange?: [number, number], decimals = 0) =>
  buildSignalCurve(parsePoints(s), yRange, decimals);

describe('signalValueAt — the curve stretched over t ∈ [0,1]', () => {
  it('reads the raw curve height (no y_range)', () => {
    const tri = curve('0,0 50,100 100,0');
    expect(signalValueAt(tri, 0)).toBeCloseTo(0, 9);
    expect(signalValueAt(tri, 0.25)).toBeCloseTo(50, 9); // rising half
    expect(signalValueAt(tri, 0.5)).toBeCloseTo(100, 9); // the peak
    expect(signalValueAt(tri, 0.75)).toBeCloseTo(50, 9); // falling half
    expect(signalValueAt(tri, 1)).toBeCloseTo(0, 9);
  });

  it('y_range normalizes the height extent into the value range', () => {
    const tri = curve('0,0 50,100 100,0', [0, 10]);
    expect(signalValueAt(tri, 0.5)).toBeCloseTo(10, 9); // top of the curve → 10
    expect(signalValueAt(tri, 0.25)).toBeCloseTo(5, 9);
    expect(signalValueAt(tri, 0)).toBeCloseTo(0, 9);
  });

  it('non-uniform x: a late spike only affects the last cards', () => {
    const c = curve('0,10 90,10 100,100'); // flat then a spike in the last 10%
    expect(signalValueAt(c, 0.5)).toBeCloseTo(10, 6); // still flat
    expect(signalValueAt(c, 0.95)).toBeGreaterThan(40); // inside the spike
  });
});

describe('parsePoints / parseSvgCurve', () => {
  it('parses points and SVG polyline/path', () => {
    expect(parsePoints('0,0  50,100')).toEqual([
      [0, 0],
      [50, 100],
    ]);
    // SVG's y grows DOWNWARD, so y=100 is drawn BELOW y=0 — a valley, not a
    // peak. The reader flips it so "higher on screen" means "a larger value".
    expect(parseSvgCurve('<svg><polyline points="0,0 50,100 100,0"/></svg>')).toEqual([
      [0, 0],
      [50, -100],
      [100, 0],
    ]);
    expect(parseSvgCurve('<svg><path d="M0 0 L50 100 L100 0"/></svg>')).toEqual([
      [0, 0],
      [50, -100],
      [100, 0],
    ]);
  });

  it('validates', () => {
    expect(() => buildSignalCurve(parsePoints('0,0'), undefined, 0)).toThrow(/point/i);
    expect(() => parsePoints('0,0 50')).toThrow(/point/i);
  });
});

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const dsl = (attrs: string, count = 101): string =>
  `<tdc><env count="${String(count)}" seed="pat"><sequence name="V"><gen type="pattern" ${attrs}/></sequence></env>` +
  `<block><line><data>\${{V}}</data></line></block></tdc>`;
const nums = (attrs: string, opts: RenderOptions, count = 101): number[] =>
  render(parseStrict(dsl(attrs, count)), opts)
    .split('\n')
    .filter(Boolean)
    .map(Number);

describe('type="pattern" — the curve stretched over the cards, both engines', () => {
  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`a peak curve traces over the cards (${label})`, () => {
      const xs = nums('points="0,0 50,100 100,0" y_range="0..100"', opts);
      expect(xs).toHaveLength(101);
      expect(xs[0]).toBeLessThan(5); // first card at the curve's left (0)
      expect(xs[50]).toBeGreaterThan(95); // middle card at the peak
      expect(xs[100]).toBeLessThan(5); // last card at the right (0)
      // monotone rise to the middle, then fall.
      for (let i = 1; i <= 50; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1] ?? 0);
      for (let i = 51; i < 101; i++) expect(xs[i]).toBeLessThanOrEqual(xs[i - 1] ?? 0);
    });

    it(`stretches a tiny 3-point curve onto many cards (${label})`, () => {
      const xs = nums('points="0,0 1,100 2,0" y_range="0..100"', opts, 1001);
      expect(xs[500]).toBeGreaterThan(95); // middle still hits the peak
    });
  }

  it('is deterministic and index-based (no randomness): identical each run', () => {
    expect(nums('points="0,0 50,100 100,0" y_range="0..100"', { now: NOW, engine: 1 })).toEqual(
      nums('points="0,0 50,100 100,0" y_range="0..100"', { now: NOW, engine: 1 }),
    );
  });

  it('reads the curve from an SVG src file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-pattern-'));
    const svg = join(dir, 'curve.svg');
    writeFileSync(svg, '<svg><polyline points="0,0 50,100 100,0"/></svg>');
    const xs = nums(`src="${svg}" y_range="0..100"`, { now: NOW, engine: 1 });
    // y=100 sits BELOW y=0 on an SVG canvas, so the middle is the deepest point.
    expect(xs[50]).toBeLessThan(5);
  });
});

describe('corridor — random value between two curves', () => {
  it('corridorValueAt: peak upper + 0 floor → random 0..height', () => {
    const c = buildCorridor(
      [
        [0, 0],
        [50, 100],
        [100, 0],
      ],
      undefined,
      [0, 100],
      0,
    );
    expect(corridorValueAt(c, 0.5, 0)).toBeCloseTo(0, 6); // bottom of the band
    expect(corridorValueAt(c, 0.5, 1)).toBeCloseTo(100, 6); // top (the peak)
    expect(corridorValueAt(c, 0.5, 0.5)).toBeCloseTo(50, 6); // middle of the band
    // at the edges the band collapses to ~0.
    expect(corridorValueAt(c, 0, 1)).toBeCloseTo(0, 6);
  });

  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`values stay inside the band; wide in the middle, tight at the edges (${label})`, () => {
      const xs = nums('upper="0,0 50,100 100,0" y_range="0..100"', opts, 400);
      expect(xs.every((x) => x >= 0 && x <= 100)).toBe(true); // inside [0, upper]
      // middle cards span a wide band (some low, some high); edges hug 0.
      const middle = xs.slice(180, 220);
      expect(Math.max(...middle)).toBeGreaterThan(80);
      expect(xs.slice(0, 10).every((x) => x < 15)).toBe(true); // band ~0 at the left
    });
  }

  it('is deterministic (seekable random in the band)', () => {
    expect(nums('upper="0,0 50,100 100,0" y_range="0..100"', { now: NOW, engine: 1 }, 200)).toEqual(
      nums('upper="0,0 50,100 100,0" y_range="0..100"', { now: NOW, engine: 1 }, 200),
    );
  });
});

describe('a card reads the crossing, never a window average', () => {
  // A 200-point zigzag between 0 and 100. Five cards cannot show the teeth, and
  // that is the point: five cards are five readings of the line, not five
  // summaries of what lies between them.
  const teeth = Array.from({ length: 200 }, (_, i) => `${String(i)},${i % 2 === 0 ? '0' : '100'}`);
  const saw = buildSignalCurve(parsePoints(teeth.join(' ')), [0, 100], 1);

  it('reads teeth and valleys, not the ~50 a window mean would have given', () => {
    // Read the drawing where it is actually drawn: x = 0, 1, 2 of 199.
    expect(signalValueAt(saw, 0)).toBeCloseTo(0, 6); // a valley
    expect(signalValueAt(saw, 1 / 199)).toBeCloseTo(100, 6); // the tooth beside it
    expect(signalValueAt(saw, 2 / 199)).toBeCloseTo(0, 6); // and back down
  });

  it('a flat stretch reads flat, whatever its neighbours do', () => {
    // The case that exposed the old rule: a card standing on a level run came
    // out 2 higher, because its window reached back into the slope before it.
    const c = buildSignalCurve(parsePoints('0,0 76.18,100 86.41,49.58 100,49.68'), [0, 100], 2);
    expect(signalValueAt(c, 0.8889)).toBeCloseTo(49.6, 1);
  });
});

describe('interp — how the line behaves between the drawn points', () => {
  const pts = parsePoints('0,0 50,60 100,100'); // a kink at x=50
  const lin = buildSignalCurve(pts, [0, 100], 3, undefined, 'linear');
  const smo = buildSignalCurve(pts, [0, 100], 3, undefined, 'smooth');
  const stp = buildSignalCurve(pts, [0, 100], 3, undefined, 'step');

  it('parseInterp accepts the three modes and rejects anything else', () => {
    expect(parseInterp(undefined)).toBe('linear');
    expect(parseInterp(' SMOOTH ')).toBe('smooth');
    expect(parseInterp('step')).toBe('step');
    expect(() => parseInterp('bezier')).toThrow(/interp/);
  });

  it('every mode agrees on the drawn points themselves', () => {
    for (const t of [0, 0.5, 1]) {
      expect(signalValueAt(smo, t)).toBeCloseTo(signalValueAt(lin, t), 6);
    }
  });

  it('smooth eases in and out — a long segment is not a constant climb', () => {
    // Steps along the first segment: linear repeats one value, smooth does not.
    const step = (c: typeof lin) =>
      Array.from(
        { length: 5 },
        (_, i) => signalValueAt(c, (i + 1) * 0.1) - signalValueAt(c, i * 0.1),
      );
    const dl = step(lin);
    const ds = step(smo);
    expect(Math.max(...dl) - Math.min(...dl)).toBeLessThan(1e-6); // linear: flat rate
    expect(Math.max(...ds) - Math.min(...ds)).toBeGreaterThan(0.5); // smooth: varying rate
  });

  it('smooth never overshoots the drawn extent', () => {
    for (let i = 0; i <= 100; i++) {
      const v = signalValueAt(smo, i / 100);
      expect(v).toBeGreaterThanOrEqual(-1e-6);
      expect(v).toBeLessThanOrEqual(100 + 1e-6);
    }
  });

  it('every mode reads the LAST drawn point at the right edge', () => {
    // A step holds a point's value in the band to its right, and the last point
    // has no band — so under step it used to be drawn and unreachable, and the
    // edge reported the plateau before it while linear and smooth reported the
    // point. Three modes, one drawing, no visible reason for the disagreement.
    const p = parsePoints('0,0 50,100 100,25');
    for (const mode of ['linear', 'smooth', 'step'] as const) {
      const c = buildSignalCurve(p, [0, 100], 0, undefined, mode);
      expect(signalValueAt(c, 1)).toBeCloseTo(25, 6);
    }
  });

  it('step holds each point until the next one', () => {
    expect(signalValueAt(stp, 0.25)).toBeCloseTo(signalValueAt(stp, 0.1), 6);
    expect(signalValueAt(stp, 0.75)).toBeCloseTo(signalValueAt(stp, 0.6), 6);
  });
});

describe('spread — a drawn line declared as the centre of a tunnel', () => {
  // A straight ramp: its midpoint is exactly 50, so the effect of spread is
  // readable directly. (A flat line has no extent to normalize and reads as 0.)
  const line = buildSignalCurve(parsePoints('0,0 100,100'), [0, 100], 3);

  it('spread="0" (the default) keeps the line exact', () => {
    expect(spreadFromAttrs({})).toBe(0);
    const pg = { kind: 'signal', curve: line, spread: 0 } as const;
    expect(patternGenValue(pg, 0.5, 0)).toBe(patternGenValue(pg, 0.5, 1)); // randomness ignored
  });

  it('a spread of s widens the line to ±s around it', () => {
    const pg = { kind: 'signal', curve: line, spread: 5 } as const;
    expect(Number(patternGenValue(pg, 0.5, 0))).toBeCloseTo(45, 6); // u=0 → bottom edge
    expect(Number(patternGenValue(pg, 0.5, 0.5))).toBeCloseTo(50, 6); // u=0.5 → the line
    expect(Number(patternGenValue(pg, 0.5, 1))).toBeCloseTo(55, 6); // u=1 → top edge
  });

  it('spread is read from the attributes and must not be negative', () => {
    expect(spreadFromAttrs({ spread: '0.001' })).toBeCloseTo(0.001, 9);
    expect(() => spreadFromAttrs({ spread: '-1' })).toThrow(/spread/);
    expect(() => spreadFromAttrs({ spread: 'wide' })).toThrow(/spread/);
  });
});

describe('mode="density" — the drawing as a distribution, not a trajectory', () => {
  const hist = (xs: number[], buckets = 10, lo = 0, hi = 100): number[] => {
    const out = new Array<number>(buckets).fill(0);
    for (const v of xs) {
      const k = Math.min(buckets - 1, Math.max(0, Math.floor(((v - lo) / (hi - lo)) * buckets)));
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  it('parseMode accepts the two readings and rejects anything else', () => {
    expect(parseMode(undefined)).toBe('signal');
    expect(parseMode(' DENSITY ')).toBe('density');
    expect(() => parseMode('corridor')).toThrow(/mode/);
  });

  it('a central hump piles the numbers up in the middle', () => {
    // A triangle standing on a flat floor between x=25 and x=75.
    const xs = nums(
      'points="0,0 25,0 50,100 75,0 100,0" y_range="0..100" mode="density"',
      { now: NOW, engine: 1 },
      4000,
    );
    const h = hist(xs);
    // Nothing outside the drawn triangle: the floor is zero probability.
    expect(h[0]! + h[1]!).toBe(0);
    expect(h[8]! + h[9]!).toBe(0);
    // The middle buckets carry far more than the slopes.
    expect(h[4]! + h[5]!).toBeGreaterThan(h[2]! + h[7]!);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(25);
    expect(Math.max(...xs)).toBeLessThanOrEqual(75);
  });

  it('the values come out in random order, not along the curve', () => {
    const xs = nums('points="0,0 50,100 100,0" y_range="0..100" mode="density"', {
      now: NOW,
      engine: 1,
    });
    // A trajectory would rise then fall; a distribution has no such order.
    const rising = xs.slice(1).filter((v, i) => v > (xs[i] ?? 0)).length;
    expect(rising).toBeGreaterThan(2);
    expect(rising).toBeLessThan(xs.length - 3);
  });

  it('a taller hump gets proportionally more of the values', () => {
    // Left hump half the height of the right one, same width.
    const xs = nums(
      'points="0,0 25,50 50,0 75,100 100,0" y_range="0..100" mode="density"',
      { now: NOW, engine: 1 },
      4000,
    );
    const left = xs.filter((v) => v < 50).length;
    const right = xs.length - left;
    expect(right / left).toBeGreaterThan(1.6); // ~2:1 by area
    expect(right / left).toBeLessThan(2.4);
  });

  it('a drawing with no height at all degrades to a uniform spread', () => {
    const xs = nums(
      'points="0,10 100,10" y_range="0..100" mode="density"',
      {
        now: NOW,
        engine: 1,
      },
      2000,
    );
    const h = hist(xs);
    expect(Math.min(...h)).toBeGreaterThan(120); // every bucket populated
    expect(Math.max(...h)).toBeLessThan(280);
  });

  // Each engine draws its uniforms from its own source (sequential vs seekable),
  // so the two are not expected to agree value-for-value — as with a corridor.
  // What both must give is a repeatable run that follows the drawn shape.
  for (const [label, opts] of [
    ['memory', { now: NOW, engine: 1 }],
    ['stream', { now: NOW, engine: 2 }],
  ] as const) {
    it(`is repeatable and follows the drawn shape (${label})`, () => {
      const cfg = 'points="0,0 50,100 100,0" y_range="0..100" mode="density"';
      const a = nums(cfg, opts, 2000);
      expect(nums(cfg, opts, 2000)).toEqual(a); // same seed → same pile
      const h = hist(a);
      expect(h[4]! + h[5]!).toBeGreaterThan(h[0]! + h[9]!); // the peak dominates
      expect(a.every((v) => v >= 0 && v <= 100)).toBe(true);
    });
  }

  it('rejects spread, which the drawing already provides', () => {
    expect(() =>
      nums('points="0,0 50,100 100,0" y_range="0..100" mode="density" spread="2"', {
        now: NOW,
        engine: 1,
      }),
    ).toThrow(/spread/);
  });
});
