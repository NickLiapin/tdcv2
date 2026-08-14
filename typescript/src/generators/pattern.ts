/**
 * Pattern-graph — a drawn curve stretched over the cards.
 *
 * The curve's HORIZONTAL axis is the card index: card `i` of `count` reads the
 * curve at position `t = i/(count−1)`, so a small drawing (100 px, a handful of
 * points) is interpolated onto however many cards you generate (1, 1000,
 * 1_000_000). The curve's VERTICAL axis is the value; because a drawing has no
 * inherent scale, the caller declares the value range with `y_range="min..max"`
 * — REQUIRED, and the floor and ceiling the drawing's CANVAS becomes. The canvas
 * is the image for a raster and a percentage board (0..100, grown only to hold
 * anything drawn outside it) for a list of points, so what a drawing means never
 * depends on how much of the board it happens to use.
 *
 * Mode 1 (this file) is a single curve → a deterministic signal. Corridor mode
 * (two curves → a random value between them) and raster input (PNG → vector)
 * build on the same core. Design: `docs/superpowers/specs/
 * 2026-07-15-pattern-graph-density-design.md` (mode corrected to signal).
 */

import { luminance } from './png.js';
import { svgGraphPoints } from './svg-path.js';

/**
 * How the drawing is read BETWEEN two points.
 *
 * `linear` follows the straight segment — faithful to a polyline, but when one
 * segment is stretched over thousands of cards the values climb by an identical
 * step every time, which reads as obviously artificial. `smooth` runs a
 * monotone cubic through the points instead: it eases in and out of every point
 * and, unlike an ordinary spline, never overshoots beyond the drawn values —
 * important when the drawing is the specification. `step` holds each value
 * until the next point.
 */
export type Interp = 'linear' | 'smooth' | 'step';

export interface SignalCurve {
  /** Point x-coordinates, sorted (the horizontal shape). */
  readonly xs: readonly number[];
  /** Point y-values (the drawn height at each x). */
  readonly ys: readonly number[];
  readonly yMin: number;
  readonly yMax: number;
  /** Output value range the curve's height maps into; absent → raw y. */
  readonly yRange?: readonly [number, number];
  readonly decimals: number;
  readonly interp: Interp;
  /** Monotone-cubic tangents, precomputed for `smooth`. */
  readonly slopes?: readonly number[];
}

/** `interp="linear|smooth|step"` (default `linear`). */
export function parseInterp(raw: string | undefined): Interp {
  if (raw === undefined || raw.trim() === '') return 'linear';
  const v = raw.trim().toLowerCase();
  if (v !== 'linear' && v !== 'smooth' && v !== 'step') {
    throw new Error('pattern: "interp" must be "linear", "smooth" or "step"');
  }
  return v;
}

/**
 * Monotone cubic (Fritsch–Carlson) tangents: the slope at a point is a weighted
 * harmonic mean of its neighbouring secants, and is forced to zero wherever the
 * data turns. That is what keeps the smoothed curve inside the drawn values.
 */
function pchipSlopes(xs: readonly number[], ys: readonly number[]): number[] {
  const n = xs.length;
  const h: number[] = [];
  const d: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const hi = (xs[i + 1] ?? 0) - (xs[i] ?? 0);
    h.push(hi);
    d.push(hi === 0 ? 0 : ((ys[i + 1] ?? 0) - (ys[i] ?? 0)) / hi);
  }
  const m = new Array<number>(n).fill(0);
  m[0] = d[0] ?? 0;
  m[n - 1] = d[n - 2] ?? 0;
  for (let i = 1; i < n - 1; i++) {
    const d0 = d[i - 1] ?? 0;
    const d1 = d[i] ?? 0;
    if (d0 * d1 <= 0) {
      m[i] = 0;
      continue;
    }
    const w1 = 2 * (h[i] ?? 0) + (h[i - 1] ?? 0);
    const w2 = (h[i] ?? 0) + 2 * (h[i - 1] ?? 0);
    m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
  }
  return m;
}

/**
 * Parse a points list into `[x,y]` pairs. Robust to both `"x,y x,y"` and SVG's
 * space-separated `"x y x y"`: extracts every number and pairs them.
 */
export function parsePoints(raw: string): [number, number][] {
  // A `;` looks like it separates two lines, and it does not: every number in the
  // string is collected in order, so `0,20 100,20; 0,80 100,80` silently becomes ONE
  // curve of four points. Somebody writing that meant a band, and got a shape they
  // did not draw. Refused rather than guessed, because the right spelling exists.
  if (raw.includes(';')) {
    throw new Error(
      'pattern: ";" does not separate two lines in points= — every number is read as one ' +
        'curve. For a band, draw the two edges separately: upper="0,80 100,80" lower="0,20 100,20".',
    );
  }
  const nums = (raw.match(/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) ?? []).map(Number);
  if (nums.length === 0 || nums.length % 2 !== 0) {
    throw new Error(
      `pattern: points must be an even list of "x,y" coordinates (got ${String(nums.length)} numbers)`,
    );
  }
  const points: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) points.push([nums[i] ?? 0, nums[i + 1] ?? 0]);
  return points;
}

/**
 * `y_range="min..max"` → `[min, max]` — the value axis, and REQUIRED.
 *
 * A drawing carries no units of its own: a curve exported from one tool runs
 * 0..100, from another 0..480, from a third 0..10002345345. `y_range` is what
 * those coordinates mean, so without it there is nothing to bring the picture
 * into and every answer would be a guess about somebody's export settings.
 */
export function parseYRange(raw: string | undefined): [number, number] {
  if (raw === undefined || raw.trim() === '') {
    throw new Error(
      'pattern: y_range is required — it is the value axis a drawing is brought into, ' +
        'and a drawing has no scale of its own. Write y_range="0..100".',
    );
  }
  const parts = raw.split('..');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`pattern: y_range "${raw}" must be "min..max" with two numbers`);
  }
  return [a, b];
}

/**
 * `fit="A..B"` — where a drawing read from a FILE lands on the value axis.
 *
 * A file carries a shape and nothing else: not units, not an origin, not even
 * which way is up. So its own lowest and highest point are the only two things
 * that can be measured, and `fit=` says what they become. Absent, they become
 * the ends of `y_range` — the drawing fills the axis.
 *
 * Returns the TARGET band, so the caller passes it where `y_range` used to go and
 * the mapping in `signalValueAt` needs no knowledge of any of this.
 */
export function parseFit(
  raw: string | undefined,
  yRange: readonly [number, number],
): [number, number] {
  if (raw === undefined || raw.trim() === '') return [yRange[0], yRange[1]];
  const parts = raw.split('..');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b)) {
    throw new Error(`pattern: fit "${raw}" must be "low..high" with two numbers`);
  }
  // A backwards band would have to mean "flip the drawing", which is a second
  // thing wearing one attribute's name. Refusing is reversible; the reading is
  // not, once configs depend on it.
  if (a > b) {
    throw new Error(`pattern: fit "${raw}" counts down — write the lower number first`);
  }
  return [a, b];
}

/**
 * The default height of a drawn canvas — a percentage board, the same one the
 * Studio draws on.
 *
 * It is a CONSTANT rather than a measurement, and that is the whole point: a
 * horizontal line at 50 sits halfway up a canvas of 100 no matter how many
 * points the drawing has, so `y_range="0..100"` gives back 50 and `-5..5` gives
 * back 0. Measuring the drawing instead would make that same line the highest
 * thing present, hence the top of the range — which is how a flat line used to
 * come out as the floor and a ripple of ten units became indistinguishable from
 * a mountain across the whole board.
 */
const VECTOR_CANVAS_TOP = 100;

/**
 * The canvas a drawn list of points is read against.
 *
 * It never shrinks below 0..100; it only GROWS, to hold whatever was drawn
 * outside it. So a picture that fits the default board is measured against the
 * board, and a picture exported from a tool running 0..10002345345 is measured
 * against itself — in both cases the whole drawing lands inside `y_range` and
 * its proportions survive.
 */
function vectorCanvas(yMin: number, yMax: number): [number, number] {
  return [Math.min(0, yMin), Math.max(VECTOR_CANVAS_TOP, yMax)];
}

/**
 * Build a signal curve from raw points: sort by x, record the canvas the
 * drawing is read against. `normExtent` overrides that canvas — a raster passes
 * the image frame, and a corridor passes the SHARED canvas of both curves so
 * the band between them stays a band.
 */
export function buildSignalCurve(
  points: readonly (readonly [number, number])[],
  yRange: readonly [number, number] | undefined,
  decimals: number,
  normExtent?: readonly [number, number],
  interp: Interp = 'linear',
): SignalCurve {
  if (points.length < 2) {
    throw new Error('pattern: need at least two points to define a curve');
  }
  // Two points ON ONE x is the same emptiness as one point, one step later: there is no
  // width, so "the value where this card's line crosses the drawing" has no single
  // answer. The engine used to take the first point and say nothing.
  if (points.every((p) => p[0] === points[0]?.[0])) {
    throw new Error(
      `pattern: every point sits at x=${String(points[0]?.[0] ?? 0)}, so the drawing has no ` +
        'width and a card has nothing to read across. Give the points at least two different ' +
        'x coordinates.',
    );
  }
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const xs = sorted.map((p) => p[0]);
  const ys = sorted.map((p) => p[1]);
  let yMin = ys[0] ?? 0;
  let yMax = ys[0] ?? 0;
  for (const y of ys) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  const [nyMin, nyMax] = normExtent ?? vectorCanvas(yMin, yMax);
  return {
    xs,
    ys,
    yMin: nyMin,
    yMax: nyMax,
    ...(yRange ? { yRange } : {}),
    decimals,
    interp,
    ...(interp === 'smooth' ? { slopes: pchipSlopes(xs, ys) } : {}),
  };
}

/** A corridor: two curves in one value space; the value is random between them. */
export interface Corridor {
  readonly lower: SignalCurve;
  readonly upper: SignalCurve;
  readonly decimals: number;
}

/**
 * Build a corridor from an upper curve and an optional lower one (omitted → a
 * flat floor at the axis minimum). Both curves live in the declared value axis,
 * so the band between them is read off the same frame the single curve uses.
 */
export function buildCorridor(
  upperPts: readonly (readonly [number, number])[],
  lowerPts: readonly (readonly [number, number])[] | undefined,
  yRange: readonly [number, number],
  decimals: number,
  interp: Interp = 'linear',
): Corridor {
  // ONE canvas for both curves. Measuring them separately would let each fill
  // the range on its own, so a narrow band and a wide one would come out the
  // same width and the corridor would stop meaning anything.
  const all = [...upperPts, ...(lowerPts ?? [])].map((p) => p[1]);
  const ext = vectorCanvas(Math.min(...all), Math.max(...all));
  const upper = buildSignalCurve(upperPts, yRange, decimals, ext, interp);
  const x0 = upperPts[0]?.[0] ?? 0;
  const xN = upperPts[upperPts.length - 1]?.[0] ?? 0;
  const lower = lowerPts
    ? buildSignalCurve(lowerPts, yRange, decimals, ext, interp)
    : buildSignalCurve(
        [
          [x0, ext[0]],
          [xN, ext[0]],
        ],
        yRange,
        decimals,
        ext,
        interp,
      );
  return { lower, upper, decimals };
}

/** Random value between the two curves at position `t`, using uniform `u`. */
export function corridorValueAt(c: Corridor, t: number, u: number): number {
  const a = signalValueAt(c.lower, t);
  const b = signalValueAt(c.upper, t);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return lo + u * (hi - lo);
}

/** Index of the segment `[xs[k], xs[k+1]]` containing `x`. */
function segmentAt(xs: readonly number[], x: number): number {
  let lo = 0;
  let hi = xs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((xs[mid] ?? 0) <= x) lo = mid;
    else hi = mid - 1;
  }
  return Math.min(lo, xs.length - 2);
}

/** Curve height at a horizontal coordinate, honouring the interpolation mode. */
function heightAtX(curve: SignalCurve, x: number): number {
  const { xs, ys } = curve;
  const k = segmentAt(xs, x);
  const xa = xs[k] ?? 0;
  const xb = xs[k + 1] ?? 0;
  const ya = ys[k] ?? 0;
  const yb = ys[k + 1] ?? 0;
  const dx = xb - xa;
  if (dx <= 0) return ya;
  const s = (x - xa) / dx;
  // A step holds each point's value in the band to its RIGHT, up to the next
  // point. The last point has no band — the drawing ends there — so it used to
  // be drawn and yet unreachable, and the right edge reported the plateau
  // before it. There is exactly one place the last point can be read, and it is
  // the one place every run visits: the final coordinate itself, where the last
  // card's line crosses the drawing. `linear` and `smooth` already answer with
  // the drawn point there, so this is also what stops the three modes
  // disagreeing at the edge for no reason a person could see.
  if (curve.interp === 'step') return x >= xb ? yb : ya;
  if (curve.interp === 'smooth' && curve.slopes) {
    // Cubic Hermite on the segment with the monotone tangents.
    const ma = curve.slopes[k] ?? 0;
    const mb = curve.slopes[k + 1] ?? 0;
    const s2 = s * s;
    const s3 = s2 * s;
    return (
      (2 * s3 - 3 * s2 + 1) * ya +
      (s3 - 2 * s2 + s) * dx * ma +
      (-2 * s3 + 3 * s2) * yb +
      (s3 - s2) * dx * mb
    );
  }
  return ya + s * (yb - ya);
}

/**
 * The value of the card at position `t ∈ [0,1]`: where the card's vertical line
 * CROSSES the drawing. Ten cards are ten crossings, measured with a ruler.
 *
 * There used to be a second rule beside this one. A card also owned a WINDOW —
 * the slice of the drawing between it and its neighbours — and whenever a drawn
 * vertex fell inside that window the card returned the window's average instead
 * of the crossing. The intent was decent: a thousand-point trace squeezed into
 * ten rows would summarise its detail rather than drop it.
 *
 * The cost was worse than what it bought. Which rule a card used depended on
 * where the vertices happened to land, so neighbouring cards of one drawing were
 * computed by different laws and nothing in the picture said which was which. A
 * card sitting on a stretch running from 49.58 to 49.68 — flat to the eye, 50 by
 * the ruler — came out as 52, because its window reached back into a slope it
 * was not standing on. And the averaging never matched its own intent anyway: a
 * single vertex in the window gave a two-step trapezoid, so a window whose exact
 * mean was 50.87 was reported as 51.90.
 *
 * Ten cards are a request for ten readings, and ten readings are what they get.
 * Missing a peak that falls between two of them is not a lost measurement — it
 * is the consequence of having asked for ten. Draw in more detail, or ask for
 * more cards: on a million cards the same drawing spells itself out completely,
 * peaks included. What matters more is that a person can now look at their own
 * drawing and say what will come out.
 */
export function signalValueAt(curve: SignalCurve, t: number): number {
  const { xs } = curve;
  const x0 = xs[0] ?? 0;
  const xN = xs[xs.length - 1] ?? 0;
  const span = xN - x0;
  const at = (tt: number): number => heightAtX(curve, x0 + Math.min(Math.max(tt, 0), 1) * span);

  const y = at(t);
  if (!curve.yRange) return y;
  const [a, b] = curve.yRange;
  // The CANVAS is the scale, never the ink. For a raster the canvas is the
  // image; for a drawn list of points it is 0..100, grown only far enough to
  // hold anything drawn outside it. Measuring the ink instead threw the
  // drawing's amplitude away: a ripple of ten units and a mountain across the
  // whole board came out identical, and a flat line — nothing to divide by —
  // collapsed to the floor.
  const vspan = curve.yMax - curve.yMin;
  const yn = vspan === 0 ? 0.5 : (y - curve.yMin) / vspan;
  const scaled = a + yn * (b - a);
  // A drawn point is inside its canvas by construction, so this catches only
  // what is added AFTER the mapping — `spread` scatter and a band's width.
  return Math.min(Math.max(scaled, Math.min(a, b)), Math.max(a, b));
}

export function formatSignal(v: number, curve: SignalCurve): string {
  return v.toFixed(curve.decimals);
}

/**
 * The SECOND way to read the same drawing (`mode="density"`).
 *
 * A signal reads the curve as a TRAJECTORY: the horizontal axis is the card
 * index and the height is that card's value, so the cards walk along the line
 * in order. A density asks the opposite question — the horizontal axis is the
 * VALUE and the height is HOW OFTEN that value comes up. Draw a hump over the
 * middle and the numbers pile up in the middle, in random order: "draw your own
 * probability" instead of picking `normal`/`poisson` from a list.
 *
 * `xs` is a fine grid across the drawing, `dens` the (non-negative) height above
 * the baseline there, and `cdf` the normalized running area — inverting it turns
 * a uniform draw into a value. The grid keeps every drawn vertex and subdivides
 * between them, so `interp="smooth"` shapes the distribution too.
 */
export interface Density {
  readonly xs: readonly number[];
  readonly dens: readonly number[];
  readonly cdf: readonly number[];
  /** Total area under the drawing — the scale `cdf` was normalized by. */
  readonly area: number;
  /** Value range the drawing's WIDTH maps into; absent → the raw x coordinates. */
  readonly yRange?: readonly [number, number];
  readonly decimals: number;
}

/** How many grid points the density is integrated on (vertices are all kept). */
const DENSITY_GRID = 512;

/**
 * Turn a curve into a distribution. Zero probability is the curve's BASELINE
 * (`curve.yMin`) — the picture's floor for a raster, the lowest drawn point
 * otherwise — so the deepest part of the drawing is the value that never
 * appears. A drawing with no height at all (a flat line) has nothing to weight
 * by and degrades to a uniform distribution rather than an error.
 */
export function buildDensity(curve: SignalCurve): Density {
  const { xs: vertices } = curve;
  const xMax = vertices[vertices.length - 1] ?? 0;

  // Grid = the drawn vertices plus enough subdivision to resolve curvature.
  const grid: number[] = [];
  const per = Math.max(1, Math.ceil(DENSITY_GRID / Math.max(1, vertices.length - 1)));
  for (let i = 0; i < vertices.length - 1; i++) {
    const a = vertices[i] ?? 0;
    const b = vertices[i + 1] ?? 0;
    for (let k = 0; k < per; k++) grid.push(a + ((b - a) * k) / per);
  }
  grid.push(xMax);

  const dens = grid.map((x) => Math.max(0, heightAtX(curve, x) - curve.yMin));
  const cum: number[] = [0];
  let total = 0;
  for (let i = 0; i < grid.length - 1; i++) {
    const h = (grid[i + 1] ?? 0) - (grid[i] ?? 0);
    total += (h * ((dens[i] ?? 0) + (dens[i + 1] ?? 0))) / 2;
    cum.push(total);
  }
  if (total <= 0) {
    // Nothing to weight by: every value equally likely.
    const flat = grid.map(() => 1);
    const uniform = grid.map((_, i) => (grid.length > 1 ? i / (grid.length - 1) : 0));
    return {
      xs: grid,
      dens: flat,
      cdf: uniform,
      area: xMax - (grid[0] ?? 0),
      ...(curve.yRange ? { yRange: curve.yRange } : {}),
      decimals: curve.decimals,
    };
  }
  return {
    xs: grid,
    dens,
    cdf: cum.map((c) => c / total),
    area: total,
    ...(curve.yRange ? { yRange: curve.yRange } : {}),
    decimals: curve.decimals,
  };
}

/**
 * Invert the distribution: a uniform `u` becomes a value. Inside a grid cell the
 * density is a straight line, so the area up to `s` is a quadratic in `s` and the
 * exact crossing is solved rather than searched — no bias from bucketing.
 */
export function densityValueAt(d: Density, u: number): number {
  const { cdf, xs, dens } = d;
  const target = Math.min(Math.max(u, 0), 1);
  // The cell whose running area contains the draw.
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((cdf[mid] ?? 0) <= target) lo = mid;
    else hi = mid - 1;
  }
  const k = Math.min(lo, xs.length - 2);
  const xa = xs[k] ?? 0;
  const xb = xs[k + 1] ?? 0;
  const h = xb - xa;
  const d0 = dens[k] ?? 0;
  const d1 = dens[k + 1] ?? 0;
  // Area still to cover inside this cell, in the same units as `dens * x`.
  const cellArea = (target - (cdf[k] ?? 0)) * d.area;
  let s: number;
  const slope = d1 - d0;
  if (h <= 0) {
    s = 0;
  } else if (Math.abs(slope) < 1e-12) {
    s = d0 === 0 ? 0 : Math.min(1, cellArea / (h * d0));
  } else {
    // (slope/2)·s² + d0·s − cellArea/h = 0
    const c = -cellArea / h;
    const disc = Math.max(0, d0 * d0 - 2 * slope * c);
    s = (-d0 + Math.sqrt(disc)) / slope;
    if (!Number.isFinite(s) || s < 0) s = 0;
    if (s > 1) s = 1;
  }
  const x = xa + s * h;

  if (!d.yRange) return x;
  const x0 = xs[0] ?? 0;
  const xN = xs[xs.length - 1] ?? 0;
  const span = xN - x0;
  const xn = span === 0 ? 0 : (x - x0) / span;
  const [a, b] = d.yRange;
  return a + xn * (b - a);
}

/** `mode="signal|density"` (default `signal`) — which question the drawing answers. */
export function parseMode(raw: string | undefined): 'signal' | 'density' {
  if (raw === undefined || raw.trim() === '') return 'signal';
  const v = raw.trim().toLowerCase();
  if (v !== 'signal' && v !== 'density') {
    throw new Error(
      'pattern: "mode" must be "signal" (a trajectory) or "density" (a distribution)',
    );
  }
  return v;
}

/**
 * A resolved pattern gen — one curve (a deterministic signal) or a corridor
 * (a random band) — plus `spread`.
 *
 * `spread` widens the reading by ±N in VALUE units, so a single drawn line can
 * be treated as the CENTRE of a tunnel without drawing the two edges by hand:
 * `spread="1"` scatters every card ±1 around the curve. It follows whatever
 * scale `y_range` sets, so on a 0..1 axis a spread of `0.001` is the natural
 * way to ask for a barely-there wobble. Left at 0 a single line stays exactly
 * predictable.
 */
export type PatternGen =
  | { readonly kind: 'signal'; readonly curve: SignalCurve; readonly spread: number }
  | { readonly kind: 'corridor'; readonly corridor: Corridor; readonly spread: number }
  | { readonly kind: 'density'; readonly density: Density };

/**
 * Value of the card at position `t`. `u` is the per-card uniform, used when the
 * gen has a band to pick from (a corridor, or any curve given a `spread`).
 */
export function patternGenValue(pg: PatternGen, t: number, u: number): string {
  if (pg.kind === 'density') {
    // Position in the run means nothing here — the drawing is a distribution, so
    // the card's own uniform draw picks the value and the order is random.
    return densityValueAt(pg.density, u).toFixed(pg.density.decimals);
  }
  if (pg.kind === 'signal') {
    const v = signalValueAt(pg.curve, t);
    const out = pg.spread > 0 ? v + (2 * u - 1) * pg.spread : v;
    return formatSignal(out, pg.curve);
  }
  const c = pg.corridor;
  const a = signalValueAt(c.lower, t);
  const b = signalValueAt(c.upper, t);
  const lo = Math.min(a, b) - pg.spread;
  const hi = Math.max(a, b) + pg.spread;
  return (lo + u * (hi - lo)).toFixed(c.decimals);
}

/** Whether the gen consumes a uniform draw per card (a band, a spread, a density). */
export function patternGenDraws(pg: PatternGen): boolean {
  return pg.kind !== 'signal' || pg.spread > 0;
}

/**
 * Re-read an already-built gen as a distribution (`mode="density"`).
 *
 * Every input path — inline points, `upper`/`lower`, an SVG, a PNG — has by then
 * produced a curve in one common shape, so the switch is a single conversion at
 * the end rather than a branch in each reader. A band contributes its TOP edge:
 * the outline is the distribution, whatever the drawing's lower edge does.
 */
export function asDensity(pg: PatternGen): PatternGen {
  if (pg.kind === 'density') return pg;
  if (pg.spread > 0) {
    throw new Error(
      'pattern: "spread" has no meaning with mode="density" — the drawing itself sets the scatter',
    );
  }
  const curve = pg.kind === 'corridor' ? pg.corridor.upper : pg.curve;
  return { kind: 'density', density: buildDensity(curve) };
}

export function decimalsFromAttrs(attrs: Record<string, string | undefined>): number {
  const raw = attrs['decimals'];
  const decimals = raw === undefined || raw.trim() === '' ? 0 : Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('pattern: "decimals" must be a non-negative integer');
  }
  return decimals;
}

/** `spread="N"` — half-width of the random band around the drawing, in values. */
export function spreadFromAttrs(attrs: Record<string, string | undefined>): number {
  const raw = attrs['spread'];
  if (raw === undefined || raw.trim() === '') return 0;
  const s = Number(raw);
  if (!Number.isFinite(s) || s < 0) {
    throw new Error('pattern: "spread" must be a non-negative number');
  }
  return s;
}

/** Build a signal curve straight from gen attributes (`y_range`, `decimals`) + points. */
export function signalCurveFromAttrs(
  attrs: Record<string, string | undefined>,
  points: readonly (readonly [number, number])[],
): SignalCurve {
  const yRange = parseYRange(attrs['y_range']);
  // No extent is passed: a drawn curve is read against the default canvas, and
  // `y_range` says what that canvas's floor and ceiling become. Passing the
  // range here instead would make the points raw values and turn `y_range` into
  // a clamp, so anything but 0..100 would flatten the drawing against one edge.
  return buildSignalCurve(
    points,
    yRange,
    decimalsFromAttrs(attrs),
    undefined,
    parseInterp(attrs['interp']),
  );
}

/** Build a corridor straight from gen attributes + the two point lists. */
export function corridorFromAttrs(
  attrs: Record<string, string | undefined>,
  upperPts: readonly (readonly [number, number])[],
  lowerPts: readonly (readonly [number, number])[] | undefined,
): Corridor {
  return buildCorridor(
    upperPts,
    lowerPts,
    parseYRange(attrs['y_range']),
    decimalsFromAttrs(attrs),
    parseInterp(attrs['interp']),
  );
}

/**
 * Turn a decoded raster image into a pattern gen. Each image column becomes a
 * point on the horizontal axis; the ink (dark, opaque) pixels in that column
 * define the height. The image's full height maps to `y_range` (the frame is
 * the scale — floor of the image = min, top = max), so only the drawing's shape
 * matters, not the pixel count.
 *
 * A pixel is INK by ALPHA when the image has no opaque background (a drawing
 * exported on transparency): anything not fully transparent counts. Otherwise
 * ink falls back to luminance, with `ink_threshold` (0..1, default 0.5) as the
 * dark/light cutoff.
 *
 * There is no separate signal-vs-corridor detection step. Every column is
 * measured twice — from the top down to the first ink and from the bottom up to
 * the first ink. If both readings meet on the same pixel the column is an EXACT
 * point on the graph; if they differ the column is a band and the value is
 * random between them. One drawing can therefore run as a single line and split
 * into a corridor further along, which is exactly what a hand drawing does.
 */
export function rasterPatternGen(
  img: { readonly width: number; readonly height: number; readonly rgba: Uint8Array },
  attrs: Record<string, string | undefined>,
): PatternGen {
  const { width, height, rgba } = img;
  const lumCut = rasterInkThreshold(attrs) * 255;
  const opaqueOnly = !hasOpaqueBackground(rgba);
  const isInk = (x: number, y: number): boolean => {
    const p = (y * width + x) * 4;
    if ((rgba[p + 3] ?? 0) < 128) return false; // transparent → background
    // A drawing exported on alpha has no background at all, so every opaque
    // pixel is the line. Only when the picture is flattened onto an opaque
    // canvas do we fall back to "dark = ink".
    if (opaqueOnly) return true;
    return luminance(rgba[p] ?? 0, rgba[p + 1] ?? 0, rgba[p + 2] ?? 0) <= lumCut;
  };

  // Per column, measure from the bottom up and from the top down to the first
  // ink. Those two readings ARE the band for that column: where they meet on one
  // pixel the drawing is a single line (an exact value, no random); where they
  // stand apart the value is random between them. So one picture can be an exact
  // curve in some columns and a widening corridor in others.
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let x = 0; x < width; x++) {
    let minRow = -1;
    let maxRow = -1;
    for (let y = 0; y < height; y++) {
      if (isInk(x, y)) {
        if (minRow < 0) minRow = y;
        maxRow = y;
      }
    }
    if (minRow < 0) continue; // empty column (a gap in the stroke) — interpolated across
    if (maxRow - minRow <= 1) {
      // Touching within one pixel: a single line, not a band.
      const mid = height - 1 - (minRow + maxRow) / 2;
      top.push([x, mid]);
      bottom.push([x, mid]);
    } else {
      top.push([x, height - 1 - minRow]);
      bottom.push([x, height - 1 - maxRow]);
    }
  }
  if (top.length < 2) {
    throw new Error('pattern: the image has too little ink to read a curve from');
  }

  // A raster DOES carry a frame: the image is exactly as tall as it says, and a
  // stroke in its upper third means the upper third. That frame is the canvas,
  // as it has always been. Only a vector file has no trustworthy frame — an
  // editor crops the viewBox to the artwork — so only there is the ink measured.
  return patternFromEnvelope(top, bottom, attrs, [0, height - 1]);
}

/**
 * Turn a per-position "highest point / lowest point" measurement into a gen —
 * the one rule both inputs share.
 *
 * Where the two readings coincide the drawing is a single line at that position,
 * so the value is exact. Where they stand apart it is a band and the value is
 * random between them. A picture that never parts is therefore a plain signal
 * and spends no random draw at all; as soon as it parts anywhere the gen draws
 * per card, and the positions that still touch keep returning their exact value
 * because a zero-width band ignores the draw.
 */
export function patternFromEnvelope(
  top: readonly (readonly [number, number])[],
  bottom: readonly (readonly [number, number])[],
  attrs: Record<string, string | undefined>,
  frame?: readonly [number, number],
): PatternGen {
  const yRange = parseYRange(attrs['y_range']);
  // `fit=` is the target the drawing's ends land on; without it the drawing
  // spans the whole `y_range`.
  const target = parseFit(attrs['fit'], yRange);
  const decimals = decimalsFromAttrs(attrs);
  const n = Math.min(top.length, bottom.length);
  let banded = false;
  for (let i = 0; i < n; i++) {
    const a = top[i];
    const b = bottom[i];
    if (a && b && Math.abs(a[1] - b[1]) > 1e-9) {
      banded = true;
      break;
    }
  }
  const interp = parseInterp(attrs['interp']);
  const spread = spreadFromAttrs(attrs);
  // A raster hands us its frame and that is the canvas. A vector file has none
  // worth trusting, so the canvas is the drawing's own extent — measured across
  // BOTH strokes, banded or not, because the two edges of a corridor are one
  // drawing and measuring them apart would let a narrow band and a wide one come
  // out the same width. That single rule replaces the two the vector path had:
  // the 0..100 board for one stroke, the ink for two, so adding a second stroke
  // moved the first from the floor of the range to the ceiling.
  let ext = frame;
  if (ext === undefined) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const [, y] of [...top, ...bottom]) {
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    ext = [lo, hi];
  }
  if (!banded) {
    return {
      kind: 'signal',
      curve: buildSignalCurve(top, target, decimals, ext, interp),
      spread,
    };
  }
  return {
    kind: 'corridor',
    corridor: {
      upper: buildSignalCurve(top, target, decimals, ext, interp),
      lower: buildSignalCurve(bottom, target, decimals, ext, interp),
      decimals,
    },
    spread,
  };
}

/** True when the picture is flattened onto an opaque canvas (no alpha cut-out). */
function hasOpaqueBackground(rgba: Uint8Array): boolean {
  for (let p = 3; p < rgba.length; p += 4) {
    if ((rgba[p] ?? 0) < 128) return false;
  }
  return true;
}

function rasterInkThreshold(attrs: Record<string, string | undefined>): number {
  const raw = attrs['ink_threshold'];
  if (raw === undefined || raw.trim() === '') return 0.5;
  const t = Number(raw);
  if (!Number.isFinite(t) || t <= 0 || t >= 1) {
    throw new Error('pattern: "ink_threshold" must be a number strictly between 0 and 1');
  }
  return t;
}

/**
 * Extract the graph curve from an SVG file.
 *
 * Handles what real editors actually export: the full path grammar (Bezier
 * curves, arcs, relative commands), `<polyline>`/`<polygon>`/`<line>`, and
 * nested `<g transform>`. Among several shapes the widest one is taken as the
 * data line (axes and frames are narrower). Y is flipped, because SVG grows
 * downward while a graph grows upward. See `svg-path.ts`.
 */
export function parseSvgCurve(svg: string): [number, number][] {
  return svgGraphPoints(svg);
}
