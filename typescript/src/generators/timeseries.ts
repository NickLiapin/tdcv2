/**
 * Time-series generator — `<gen type="timeseries" ...>`.
 *
 * A row's value is the classic layered model:
 *
 *     value(i) = base + trend·i + Σ amplitude·cos(2π·(i − peak)/period) + noise·e(i)
 *
 * — a linear trend, one or more sinusoidal seasonal waves, and noise, over the
 * row index as the time axis. Like counters it depends on the ABSOLUTE row
 * index, so it is special-cased in both engines with the real index; the noise
 * is built from per-row standard-normal draws, so the series stays deterministic
 * and seekable. Real time series (sales, sensors, traffic) look like this, not
 * like flat uniform noise.
 */

/** One seasonal wave: how long it is, how far it swings, and where it peaks. */
export interface Wave {
  readonly period: number;
  readonly amplitude: number;
  /**
   * Which row the wave peaks on, or undefined for the classic sine.
   *
   * A plain `sin(2π·i/period)` crosses zero at row 0 and peaks a QUARTER PERIOD
   * later, so a year of daily rows peaks in early April — the one season nobody
   * means by "warmer in summer". `peak_at` names the row instead of a shift,
   * because the row is what the author knows: 182 of 365 is the first of July.
   */
  readonly peakAt: number | undefined;
}

export interface TimeseriesSpec {
  readonly base: number;
  readonly trend: number;
  /**
   * The seasonal waves, in the order written. Empty means no seasonality.
   *
   * A list rather than one wave because real series carry more than one season
   * at a time: shop takings rise on Saturdays AND in December, and a model given
   * only the weekly wave has nothing to find in the yearly one. The waves simply
   * sum, which is what "several seasonalities at once" means.
   */
  readonly waves: readonly Wave[];
  /** Standard deviation of the noise; 0 disables noise. */
  readonly noiseSd: number;
  /**
   * How strongly one row's noise carries into the next, in (−1, 1). 0 is the
   * independent (white) noise this generator has always produced.
   *
   * Real measurement error is rarely independent: a sensor reading high today
   * tends to read high tomorrow, and a model tested only against white noise has
   * never met the case it will actually fail on.
   */
  readonly noiseCorrelation: number;
  readonly decimals: number;
}

/**
 * How many past rows the correlated noise remembers.
 *
 * The textbook AR(1) is written `e(t) = φ·e(t−1) + z(t)` — a recurrence, which a
 * seekable engine cannot evaluate: row 900,000 would have to replay 900,000
 * rows. Written out, that recurrence is a weighted sum of the past innovations,
 * `Σ φ^k·z(t−k)`, and the weights fall off geometrically — so this generator
 * defines the noise as that sum over a FIXED window and evaluates it directly.
 * Both engines then run the same arithmetic in the same order and cannot drift
 * apart, and any row is computable on its own.
 *
 * 64 terms, because that is where the cost stops mattering: with the window's
 * draws kept in a ring the whole sum costs about 20 ns a row over plain noise.
 */
export const NOISE_WINDOW = 63;

export function parseTimeseries(attrs: Record<string, string | undefined>): TimeseriesSpec {
  const num = (key: string, def: number): number => {
    const raw = attrs[key];
    if (raw === undefined || raw.trim() === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new Error(`timeseries: "${key}" must be a number (got "${raw}")`);
    return n;
  };
  /** A comma-separated list of numbers, or [] when the attribute is absent. */
  const list = (key: string): number[] => {
    const raw = attrs[key];
    if (raw === undefined || raw.trim() === '') return [];
    return raw.split(',').map((piece) => {
      const n = Number(piece.trim());
      if (piece.trim() === '' || !Number.isFinite(n))
        throw new Error(`timeseries: "${key}" must be a number (got "${raw}")`);
      return n;
    });
  };

  const periods = list('period');
  const amplitudes = list('amplitude');
  const peaks = list('peak_at');
  for (const period of periods) {
    if (period < 0) throw new Error('timeseries: "period" must be ≥ 0');
  }
  // The three lists describe the same waves position by position, so a length
  // that disagrees is not a wave anybody can draw. The validator says this first
  // and better; the generator keeps its own copy for callers who build a gen
  // through the library without validating.
  if (amplitudes.length > 1 && amplitudes.length !== periods.length) {
    throw new Error('timeseries: "amplitude" must have as many entries as "period"');
  }
  if (peaks.length > 0 && peaks.length !== periods.length) {
    throw new Error('timeseries: "peak_at" must have as many entries as "period"');
  }

  const waves: Wave[] = [];
  for (let k = 0; k < periods.length; k++) {
    waves.push({
      period: periods[k] ?? 0,
      // One amplitude for many periods is the shorthand for waves of equal
      // height; the far more common case is one of each, which reads the same.
      amplitude: (amplitudes.length === 1 ? amplitudes[0] : amplitudes[k]) ?? 0,
      peakAt: peaks[k],
    });
  }

  const noiseSd = num('noise', 0);
  if (noiseSd < 0) throw new Error('timeseries: "noise" must be ≥ 0');
  const noiseCorrelation = num('noise_correlation', 0);
  if (!(Math.abs(noiseCorrelation) < 1)) {
    throw new Error('timeseries: "noise_correlation" must be between -1 and 1');
  }

  const decimalsRaw = attrs['decimals'];
  const decimals = decimalsRaw === undefined || decimalsRaw.trim() === '' ? 0 : Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('timeseries: "decimals" must be a non-negative integer');
  }

  return {
    base: num('base', 0),
    trend: num('trend', 0),
    waves,
    noiseSd,
    noiseCorrelation,
    decimals,
  };
}

/** Standard normal deviate via Box–Muller from two uniforms in (0,1). */
export function standardNormal(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * The correlated noise at row `i`, from the innovations of rows `i−k`.
 *
 * `past(k)` hands back the innovation of row `i − k`; the caller decides where
 * it comes from, which is what lets a sequential walk keep a ring of 64 and a
 * random access pay for 64 lookups. The ARITHMETIC is the same either way — the
 * same terms, added in the same order — so the two engines cannot disagree.
 *
 * The sum is divided by the length of its own weight vector, so **every row has
 * the same spread**. Without that the first rows of a column would be visibly
 * quieter than the rest — the window has fewer terms to add there — and a series
 * that settles down after sixty rows is an artefact of the method, not of
 * anything the config asked for.
 */
export function correlatedNoise(
  spec: TimeseriesSpec,
  i: number,
  past: (k: number) => number,
): number {
  if (spec.noiseCorrelation === 0) return past(0);
  const reach = Math.min(i, NOISE_WINDOW);
  let sum = 0;
  let squares = 0;
  let weight = 1;
  for (let k = 0; k <= reach; k++) {
    sum += weight * past(k);
    squares += weight * weight;
    weight *= spec.noiseCorrelation;
  }
  return sum / Math.sqrt(squares);
}

/** The layered value at row `i` with noise sample `e` (already correlated). */
export function timeseriesValueAt(spec: TimeseriesSpec, i: number, e: number): number {
  let v = spec.base + spec.trend * i;
  for (const wave of spec.waves) {
    if (wave.period <= 0 || wave.amplitude === 0) continue;
    // One formula for both. `cos` peaks where its argument is zero, so the wave
    // peaks exactly on `peak`. The DEFAULT peak is a quarter period in, which is
    // where a plain `sin(2π·i/period)` already peaked — so a config without
    // `peak_at` produces the same bytes it always did, without a second branch
    // saying so.
    const peak = wave.peakAt ?? wave.period / 4;
    v += wave.amplitude * Math.cos((2 * Math.PI * (i - peak)) / wave.period);
  }
  if (spec.noiseSd !== 0) v += spec.noiseSd * e;
  return v;
}

export function formatTimeseries(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

/**
 * A reader for the window's innovations that keeps them in a ring.
 *
 * The sum in `correlatedNoise` wants the innovations of the last 64 rows, and
 * drawing each one costs a hash — 64 hashes a row would make correlated noise
 * forty times the price of plain noise (measured: 13.9 µs a row against 0.32).
 * Walking forward, though, 63 of those 64 were drawn for the row before, so the
 * ring turns it back into ONE draw a row: 0.35 µs, which is free.
 *
 * It is a cache and nothing else. The arithmetic never changes — the same terms
 * are added in the same order whether they came from the ring or from a fresh
 * draw — so an engine that seeks and an engine that walks produce one series.
 *
 * `draw` is asked only for rows the walk has reached, in order, which is what
 * lets the in-memory engine hand it a SEQUENTIAL generator: on that path there
 * is no row to seek to, and the ring is the only reason the window can be read
 * at all.
 */
export function innovationRing(draw: (row: number) => number): (row: number, k: number) => number {
  const size = NOISE_WINDOW + 1;
  const ring = new Float64Array(size);
  // The highest row in the ring; rows `have - NOISE_WINDOW .. have` are live.
  let have = -1;
  return (row, k) => {
    if (row > have) {
      // Forward by one on a sequential walk; a first touch deep into the column
      // fills the whole window at once, which is what a seeking engine wants.
      for (let r = Math.max(0, Math.max(row - NOISE_WINDOW, have + 1)); r <= row; r++) {
        ring[r % size] = draw(r);
      }
      have = row;
    }
    const want = row - k;
    if (want < 0) return 0; // before row zero there is nothing to remember
    // A jump backwards past the window re-draws, which costs one hash and cannot
    // give a different number.
    return want > have - size ? (ring[want % size] ?? 0) : draw(want);
  };
}

/** Whether this spec draws noise (and thus consumes uniforms) at all. */
export function timeseriesHasNoise(spec: TimeseriesSpec): boolean {
  return spec.noiseSd !== 0;
}
