/**
 * Time-series generator — `<gen type="timeseries" ...>`.
 *
 * A row's value is the classic layered model:
 *
 *     value(i) = base + trend·i + amplitude·cos(2π·(i − peak)/period) + noise·z
 *
 * — a linear trend, one sinusoidal seasonal wave, and gaussian noise, over the
 * row index as the time axis. Like counters it depends on the ABSOLUTE row
 * index, so it is special-cased in both engines with the real index; the noise
 * `z` is a standard-normal draw per row, so the series stays deterministic and
 * seekable. Real time series (sales, sensors, traffic) look like this, not like
 * flat uniform noise.
 *
 * v1 supports one trend + one seasonal wave + noise via attributes. Multiple
 * stacked seasonalities (weekly AND yearly) are a future extension.
 */

export interface TimeseriesSpec {
  readonly base: number;
  readonly trend: number;
  /** Seasonal period in rows; 0 disables seasonality. */
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
  /** Standard deviation of the gaussian noise; 0 disables noise. */
  readonly noiseSd: number;
  readonly decimals: number;
}

export function parseTimeseries(attrs: Record<string, string | undefined>): TimeseriesSpec {
  const num = (key: string, def: number): number => {
    const raw = attrs[key];
    if (raw === undefined || raw.trim() === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n))
      throw new Error(`timeseries: "${key}" must be a number (got "${raw}")`);
    return n;
  };
  const period = num('period', 0);
  const noiseSd = num('noise', 0);
  if (period < 0) throw new Error('timeseries: "period" must be ≥ 0');
  if (noiseSd < 0) throw new Error('timeseries: "noise" must be ≥ 0');

  const decimalsRaw = attrs['decimals'];
  const decimals = decimalsRaw === undefined || decimalsRaw.trim() === '' ? 0 : Number(decimalsRaw);
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error('timeseries: "decimals" must be a non-negative integer');
  }

  const peakRaw = attrs['peak_at'];
  const peakAt = peakRaw === undefined || peakRaw.trim() === '' ? undefined : num('peak_at', 0);

  return {
    base: num('base', 0),
    trend: num('trend', 0),
    period,
    amplitude: num('amplitude', 0),
    peakAt,
    noiseSd,
    decimals,
  };
}

/** Standard normal deviate via Box–Muller from two uniforms in (0,1). */
export function standardNormal(u1: number, u2: number): number {
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

/** The layered value at row `i` with standard-normal noise sample `z`. */
export function timeseriesValueAt(spec: TimeseriesSpec, i: number, z: number): number {
  let v = spec.base + spec.trend * i;
  if (spec.period > 0 && spec.amplitude !== 0) {
    // One formula for both. `cos` peaks where its argument is zero, so the wave
    // peaks exactly on `peak`. The DEFAULT peak is a quarter period in, which is
    // where a plain `sin(2π·i/period)` already peaked — so a config without
    // `peak_at` produces the same bytes it always did, without a second branch
    // saying so.
    const peak = spec.peakAt ?? spec.period / 4;
    v += spec.amplitude * Math.cos((2 * Math.PI * (i - peak)) / spec.period);
  }
  if (spec.noiseSd !== 0) v += spec.noiseSd * z;
  return v;
}

export function formatTimeseries(v: number, decimals: number): string {
  return v.toFixed(decimals);
}

/** Whether this spec draws noise (and thus consumes uniforms) at all. */
export function timeseriesHasNoise(spec: TimeseriesSpec): boolean {
  return spec.noiseSd !== 0;
}
