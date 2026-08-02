/**
 * SVG geometry reader for the pattern generator.
 *
 * A drawing exported by ANY vector editor (Illustrator, Figma, Inkscape) is
 * mostly Bezier curves inside transformed groups — not the straight `M/L`
 * segments a naive reader assumes. This module turns such a file into a plain
 * list of points:
 *
 *   1. walk the document keeping a transform stack (nested `<g transform>`);
 *   2. read every curve-ish element (`path`, `polyline`, `polygon`, `line`);
 *   3. flatten Beziers and arcs into points;
 *   4. map through the accumulated matrix.
 *
 * Flattening is deterministic (a fixed subdivision count derived from the
 * control polygon), so every language implementation produces identical points.
 *
 * SVG's y axis points DOWN — the caller flips it, because for a graph "higher on
 * the screen" must mean "a larger value".
 */

export type Pt = [number, number];

/** An affine matrix `[a b c d e f]` as used by SVG's `transform`. */
export type Matrix = readonly [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function apply(m: Matrix, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Parse an SVG `transform` attribute (a chain of primitives) into one matrix. */
export function parseTransform(raw: string): Matrix {
  let m: Matrix = IDENTITY;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(raw)) !== null) {
    const name = hit[1] ?? '';
    const args = (hit[2] ?? '')
      .split(/[\s,]+/)
      .filter((s) => s !== '')
      .map(Number);
    m = multiply(m, primitive(name, args));
  }
  return m;
}

function primitive(name: string, a: readonly number[]): Matrix {
  const rad = (deg: number): number => (deg * Math.PI) / 180;
  switch (name) {
    case 'matrix':
      return [a[0] ?? 1, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1, a[4] ?? 0, a[5] ?? 0];
    case 'translate':
      return [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
    case 'scale': {
      const sx = a[0] ?? 1;
      return [sx, 0, 0, a[1] ?? sx, 0, 0];
    }
    case 'rotate': {
      const c = Math.cos(rad(a[0] ?? 0));
      const s = Math.sin(rad(a[0] ?? 0));
      const rot: Matrix = [c, s, -s, c, 0, 0];
      if (a.length < 3) return rot;
      const cx = a[1] ?? 0;
      const cy = a[2] ?? 0;
      return multiply(multiply([1, 0, 0, 1, cx, cy], rot), [1, 0, 0, 1, -cx, -cy]);
    }
    case 'skewX':
      return [1, 0, Math.tan(rad(a[0] ?? 0)), 1, 0, 0];
    case 'skewY':
      return [1, Math.tan(rad(a[0] ?? 0)), 0, 1, 0, 0];
    default:
      return IDENTITY;
  }
}

/** How finely a curve segment is split — deterministic across implementations. */
function segmentsFor(...pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (!a || !b) continue;
    len += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return Math.min(64, Math.max(4, Math.ceil(len / 3)));
}

function cubicPoints(p0: Pt, p1: Pt, p2: Pt, p3: Pt): Pt[] {
  const n = segmentsFor(p0, p1, p2, p3);
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const s = 1 - t;
    out.push([
      s * s * s * p0[0] + 3 * s * s * t * p1[0] + 3 * s * t * t * p2[0] + t * t * t * p3[0],
      s * s * s * p0[1] + 3 * s * s * t * p1[1] + 3 * s * t * t * p2[1] + t * t * t * p3[1],
    ]);
  }
  return out;
}

function quadPoints(p0: Pt, p1: Pt, p2: Pt): Pt[] {
  // A quadratic is a cubic with lifted control points.
  const c1: Pt = [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])];
  const c2: Pt = [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])];
  return cubicPoints(p0, c1, c2, p2);
}

/** Endpoint-parametrized elliptical arc → points (SVG spec F.6.5). */
function arcPoints(
  p0: Pt,
  rx0: number,
  ry0: number,
  rotDeg: number,
  largeArc: boolean,
  sweep: boolean,
  p1: Pt,
): Pt[] {
  let rx = Math.abs(rx0);
  let ry = Math.abs(ry0);
  if (rx === 0 || ry === 0) return [p1]; // degenerate → straight line
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (p0[0] - p1[0]) / 2;
  const dy = (p0[1] - p1[1]) / 2;
  const x1 = cosP * dx + sinP * dy;
  const y1 = -sinP * dx + cosP * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    const k = Math.sqrt(lam);
    rx *= k;
    ry *= k;
  }
  const denom = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const num = Math.max(0, rx * rx * ry * ry - denom);
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(denom === 0 ? 0 : num / denom);
  const cx1 = (coef * rx * y1) / ry;
  const cy1 = (-coef * ry * x1) / rx;
  const cx = cosP * cx1 - sinP * cy1 + (p0[0] + p1[0]) / 2;
  const cy = sinP * cx1 + cosP * cy1 + (p0[1] + p1[1]) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    const a = Math.acos(Math.min(1, Math.max(-1, len === 0 ? 1 : dot / len)));
    return ux * vy - uy * vx < 0 ? -a : a;
  };
  const theta = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let delta = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const n = Math.min(64, Math.max(6, Math.ceil((Math.abs(delta) / Math.PI) * 24)));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = theta + (delta * i) / n;
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    out.push([cosP * ex - sinP * ey + cx, sinP * ex + cosP * ey + cy]);
  }
  return out;
}

/** Split a path `d` string into commands and numbers. */
function tokenize(d: string): string[] {
  return d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? [];
}

/**
 * Flatten a path `d` into points. Supports every command: M L H V C S Q T A Z,
 * absolute and relative. Sub-paths are concatenated (a graph is normally one).
 */
export function flattenPathD(d: string): Pt[] {
  const tk = tokenize(d);
  const pts: Pt[] = [];
  let i = 0;
  let cur: Pt = [0, 0];
  let start: Pt = [0, 0];
  let prevCubic: Pt | undefined;
  let prevQuad: Pt | undefined;
  let cmd = '';
  const num = (): number => Number(tk[i++] ?? 0);
  const isNum = (s: string | undefined): boolean => s !== undefined && !/[A-Za-z]/.test(s);
  const push = (p: Pt): void => {
    cur = p;
    pts.push(p);
  };

  while (i < tk.length) {
    const tok = tk[i];
    if (isNum(tok)) {
      // Implicit repeat of the previous command (M→L per the spec).
      if (cmd === 'M') cmd = 'L';
      else if (cmd === 'm') cmd = 'l';
    } else {
      cmd = tk[i++] ?? '';
    }
    const rel = cmd === cmd.toLowerCase();
    const bx = rel ? cur[0] : 0;
    const by = rel ? cur[1] : 0;
    switch (cmd.toUpperCase()) {
      case 'M': {
        const p: Pt = [bx + num(), by + num()];
        start = p;
        push(p);
        prevCubic = prevQuad = undefined;
        break;
      }
      case 'L': {
        push([bx + num(), by + num()]);
        prevCubic = prevQuad = undefined;
        break;
      }
      case 'H': {
        push([bx + num(), cur[1]]);
        prevCubic = prevQuad = undefined;
        break;
      }
      case 'V': {
        push([cur[0], by + num()]);
        prevCubic = prevQuad = undefined;
        break;
      }
      case 'C': {
        const c1: Pt = [bx + num(), by + num()];
        const c2: Pt = [bx + num(), by + num()];
        const p: Pt = [bx + num(), by + num()];
        for (const q of cubicPoints(cur, c1, c2, p)) pts.push(q);
        cur = p;
        prevCubic = c2;
        prevQuad = undefined;
        break;
      }
      case 'S': {
        const c1: Pt = prevCubic
          ? [2 * cur[0] - prevCubic[0], 2 * cur[1] - prevCubic[1]]
          : [cur[0], cur[1]];
        const c2: Pt = [bx + num(), by + num()];
        const p: Pt = [bx + num(), by + num()];
        for (const q of cubicPoints(cur, c1, c2, p)) pts.push(q);
        cur = p;
        prevCubic = c2;
        prevQuad = undefined;
        break;
      }
      case 'Q': {
        const c: Pt = [bx + num(), by + num()];
        const p: Pt = [bx + num(), by + num()];
        for (const q of quadPoints(cur, c, p)) pts.push(q);
        cur = p;
        prevQuad = c;
        prevCubic = undefined;
        break;
      }
      case 'T': {
        const c: Pt = prevQuad
          ? [2 * cur[0] - prevQuad[0], 2 * cur[1] - prevQuad[1]]
          : [cur[0], cur[1]];
        const p: Pt = [bx + num(), by + num()];
        for (const q of quadPoints(cur, c, p)) pts.push(q);
        cur = p;
        prevQuad = c;
        prevCubic = undefined;
        break;
      }
      case 'A': {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = num() !== 0;
        const sweep = num() !== 0;
        const p: Pt = [bx + num(), by + num()];
        for (const q of arcPoints(cur, rx, ry, rot, large, sweep, p)) pts.push(q);
        cur = p;
        prevCubic = prevQuad = undefined;
        break;
      }
      case 'Z': {
        push([start[0], start[1]]);
        prevCubic = prevQuad = undefined;
        break;
      }
      default:
        i++; // unknown token — skip so we never spin
        break;
    }
  }
  return pts;
}

/** One curve found in the document, already in user space. */
export interface SvgCurve {
  readonly points: Pt[];
  /** Horizontal extent — used to pick the graph line among decorations. */
  readonly width: number;
}

/** Read `points="x,y x,y"` (polyline/polygon) into pairs. */
function readPointsAttr(raw: string): Pt[] {
  const nums = (raw.match(/-?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
  const out: Pt[] = [];
  for (let k = 0; k + 1 < nums.length; k += 2) out.push([nums[k] ?? 0, nums[k + 1] ?? 0]);
  return out;
}

const ATTR = (tag: string, name: string): string | undefined =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(tag)?.[1] ??
  new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, 'i').exec(tag)?.[1];

/**
 * Walk the SVG source, tracking the transform stack, and collect every curve.
 * A hand-rolled tag scan (not a full XML parser) is enough: we only need element
 * names, their attributes and the nesting of `<g>`.
 */
export function collectSvgCurves(svg: string): SvgCurve[] {
  const found: SvgCurve[] = [];
  const stack: Matrix[] = [IDENTITY];
  const tagRe = /<\/?([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)\/?>/g;
  let hit: RegExpExecArray | null;
  while ((hit = tagRe.exec(svg)) !== null) {
    const whole = hit[0];
    const name = (hit[1] ?? '').toLowerCase();
    const closing = whole.startsWith('</');
    const selfClosing = whole.endsWith('/>');
    const top = stack[stack.length - 1] ?? IDENTITY;

    if (closing) {
      if (name === 'g' || name === 'svg') stack.pop();
      continue;
    }
    const tf = ATTR(whole, 'transform');
    const local = tf ? multiply(top, parseTransform(tf)) : top;

    if (name === 'g' || name === 'svg') {
      if (!selfClosing) stack.push(local);
      continue;
    }

    let raw: Pt[] | undefined;
    if (name === 'path') {
      const d = ATTR(whole, 'd');
      if (d) raw = flattenPathD(d);
    } else if (name === 'polyline' || name === 'polygon') {
      const p = ATTR(whole, 'points');
      if (p) raw = readPointsAttr(p);
    } else if (name === 'line') {
      const x1 = Number(ATTR(whole, 'x1') ?? NaN);
      const y1 = Number(ATTR(whole, 'y1') ?? NaN);
      const x2 = Number(ATTR(whole, 'x2') ?? NaN);
      const y2 = Number(ATTR(whole, 'y2') ?? NaN);
      if ([x1, y1, x2, y2].every(Number.isFinite)) {
        raw = [
          [x1, y1],
          [x2, y2],
        ];
      }
    }
    if (!raw || raw.length < 2) continue;
    const points = raw.map((p) => apply(local, p));
    let min = points[0]?.[0] ?? 0;
    let max = min;
    for (const [x] of points) {
      if (x < min) min = x;
      if (x > max) max = x;
    }
    found.push({ points, width: max - min });
  }
  return found;
}

/**
 * The curve to read a graph from: the one spanning the most horizontal space.
 * A chart export usually also carries axes, a frame and a legend; the data line
 * is the widest path, so this picks the signal without the user selecting it.
 *
 * Y is flipped (SVG grows downward, a graph grows upward).
 */
export function svgGraphPoints(svg: string): Pt[] {
  const curves = collectSvgCurves(svg);
  if (curves.length === 0) {
    throw new Error(
      'pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from',
    );
  }
  let best: SvgCurve | undefined;
  for (const c of curves) if (!best || c.width > best.width) best = c;
  if (!best || best.points.length < 2 || best.width <= 0) {
    throw new Error('pattern: the SVG curve has no horizontal extent to stretch over the cards');
  }
  return best.points.map(([x, y]) => [x, y === 0 ? 0 : -y] as Pt);
}

/**
 * Measure the drawing the same way the raster reader does: at each position
 * along the horizontal axis, take the HIGHEST and the LOWEST point of every
 * shape in the file.
 *
 * One stroke gives the same point twice — an exact value. Two strokes (or any
 * closed outline: draw a car and it still has a top and a bottom) give two
 * different points — a band. A single file may do both: run as one line and
 * split into a corridor further along.
 *
 * A shape is crossed segment by segment, so a stroke that doubles back over the
 * same x contributes every crossing, not just the first.
 */
export function svgEnvelope(svg: string, samples = 600): { top: Pt[]; bottom: Pt[] } {
  const curves = collectSvgCurves(svg);
  if (curves.length === 0) {
    throw new Error(
      'pattern: the SVG has no <path>/<polyline>/<polygon>/<line> to read a curve from',
    );
  }
  // Flip once: SVG grows downward, a graph grows upward.
  const shapes = curves.map((c) => c.points.map(([x, y]) => [x, y === 0 ? 0 : -y] as Pt));

  let xMin = Infinity;
  let xMax = -Infinity;
  for (const s of shapes) {
    for (const [x] of s) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
    }
  }
  if (!(xMax > xMin)) {
    throw new Error('pattern: the SVG curve has no horizontal extent to stretch over the cards');
  }

  // Measure AT THE DRAWN VERTICES, not on a uniform grid: a grid would replace
  // the drawing with a dense straight-line resampling, and there would be
  // nothing left for `interp="smooth"` to round off. Between two consecutive
  // vertices every shape is a straight segment anyway, so the vertices carry
  // the whole shape.
  const seen = new Set<number>();
  for (const s of shapes) for (const [x] of s) seen.add(x);
  let axis = [...seen].sort((a, b) => a - b);
  if (axis.length > samples) {
    // Absurdly dense input (a huge flattened path): keep an even subset.
    const step = axis.length / samples;
    const thinned: number[] = [];
    for (let i = 0; i < samples; i++) thinned.push(axis[Math.floor(i * step)] ?? xMin);
    thinned.push(xMax);
    axis = [...new Set(thinned)].sort((a, b) => a - b);
  }

  const top: Pt[] = [];
  const bottom: Pt[] = [];
  for (const x of axis) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of shapes) {
      for (let k = 1; k < s.length; k++) {
        const a = s[k - 1];
        const b = s[k];
        if (!a || !b) continue;
        const [ax, ay] = a;
        const [bx, by] = b;
        if (x < Math.min(ax, bx) || x > Math.max(ax, bx)) continue;
        const dx = bx - ax;
        // A vertical segment covers a whole span of values at this x.
        const ys = dx === 0 ? [ay, by] : [ay + ((x - ax) / dx) * (by - ay)];
        for (const y of ys) {
          if (y < lo) lo = y;
          if (y > hi) hi = y;
        }
      }
    }
    if (lo === Infinity) continue; // nothing drawn at this x
    top.push([x, hi]);
    bottom.push([x, lo]);
  }
  if (top.length < 2) {
    throw new Error('pattern: the SVG has too little geometry to read a curve from');
  }
  return { top, bottom };
}
