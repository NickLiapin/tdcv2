import { describe, expect, it } from 'vitest';

import { collectSvgCurves, svgEnvelope, svgGraphPoints } from '../../src/generators/svg-path.js';

const wrap = (inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner}</svg>`;

describe('shape primitives are read, as the docs always promised', () => {
  it('a lone <rect> is a closed outline, not an error', () => {
    const { top, bottom } = svgEnvelope(wrap('<rect x="10" y="20" width="80" height="40"/>'));
    // The vertices sit at the corners; the corridor between them is the
    // interpolation, so both measured columns already span the full height
    // (y flips: SVG grows downward, a graph grows upward).
    expect(top).toEqual([
      [10, -20],
      [90, -20],
    ]);
    expect(bottom).toEqual([
      [10, -60],
      [90, -60],
    ]);
  });

  it('a <circle> reads as drawn: widest at the equator, closing at the poles', () => {
    const { top, bottom } = svgEnvelope(wrap('<circle cx="50" cy="50" r="30"/>'));
    const heightAt = (x: number): number => {
      let hi = -Infinity;
      let lo = Infinity;
      for (const [px, py] of top) if (Math.abs(px - x) < 2 && py > hi) hi = py;
      for (const [px, py] of bottom) if (Math.abs(px - x) < 2 && py < lo) lo = py;
      return hi - lo;
    };
    expect(heightAt(50)).toBeCloseTo(60, 0);
    expect(heightAt(22)).toBeLessThan(30);
  });

  it('an <ellipse> honours both radii', () => {
    const curves = collectSvgCurves(wrap('<ellipse cx="50" cy="50" rx="40" ry="10"/>'));
    expect(curves).toHaveLength(1);
    expect(curves[0]?.primitive).toBe(true);
    const xs = curves[0]?.points.map(([x]) => x) ?? [];
    const ys = curves[0]?.points.map(([, y]) => y) ?? [];
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80, 6);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(20, 6);
  });

  it('a rounded <rect> follows its corner arcs rather than squaring them', () => {
    const sharp = collectSvgCurves(wrap('<rect x="0" y="0" width="100" height="60"/>'));
    const round = collectSvgCurves(wrap('<rect x="0" y="0" width="100" height="60" rx="20"/>'));
    // The rounded outline never reaches the sharp corner point (0, 0): its
    // nearest approach stays on the arc.
    const cornerDist = (curves: typeof sharp): number =>
      Math.min(...(curves[0]?.points.map(([x, y]) => Math.hypot(x, y)) ?? [Infinity]));
    expect(cornerDist(sharp)).toBe(0);
    expect(cornerDist(round)).toBeGreaterThan(5);
  });

  it('the one-line reading keeps primitives as furniture while anything is drawn', () => {
    // The frame rect is WIDER than the data line; the line must still win.
    const svg = wrap('<rect x="0" y="0" width="100" height="100"/><path d="M 10 80 L 90 30"/>');
    const points = svgGraphPoints(svg);
    expect(points[0]).toEqual([10, -80]);
    expect(points[points.length - 1]).toEqual([90, -30]);
  });

  it('a file holding ONLY primitives reads the widest of them', () => {
    const svg = wrap(
      '<circle cx="30" cy="50" r="10"/><rect x="10" y="20" width="80" height="40"/>',
    );
    const points = svgGraphPoints(svg);
    const xs = points.map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(80, 6);
  });
});

describe('a vertical edge is a step, not a wedge', () => {
  // Flat ground, a cliff up to a roof, and back down — the car silhouette that
  // found the bug. Before the fix the top envelope ramped from the START of the
  // ground all the way up to the roof: flat ground spread 0..23 from row one.
  const car = wrap('<path d="M 0 80 L 50 80 L 50 40 L 90 40 L 90 80 L 100 80 Z"/>');

  it('the flat stretch before the cliff stays exact to the last row', () => {
    const { top, bottom } = svgEnvelope(car);
    for (const [x, y] of top) {
      if (x < 50) expect(y, `top at x=${String(x)}`).toBeCloseTo(-80, 9);
    }
    for (const [x, y] of bottom) {
      if (x < 50) expect(y, `bottom at x=${String(x)}`).toBeCloseTo(-80, 9);
    }
  });

  it('the cliff itself is two points at one x — the step', () => {
    const { top } = svgEnvelope(car);
    const atEdge = top.filter(([x]) => x === 50);
    expect(atEdge).toHaveLength(2);
    expect(atEdge[0]?.[1]).toBeCloseTo(-80, 9);
    expect(atEdge[1]?.[1]).toBeCloseTo(-40, 9);
  });

  it('the roof between the cliffs is the full band', () => {
    const { top, bottom } = svgEnvelope(car);
    // The envelope measures at the vertices; the roof spans between the two
    // cliffs, so its ceiling is carried by the step's right point at x=50 and
    // the far cliff's left point at x=90, while the floor stays the ground.
    expect(top).toEqual([
      [0, -80],
      [50, -80],
      [50, -40],
      [90, -40],
      [90, -80],
      [100, -80],
    ]);
    for (const [, y] of bottom) expect(y).toBeCloseTo(-80, 9);
  });
});
