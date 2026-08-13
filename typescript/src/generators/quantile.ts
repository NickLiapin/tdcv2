/**
 * A file read as a QUANTILE FUNCTION rather than as a bag of values.
 *
 * `<gen type="file" src="amounts.txt" read="quantile"/>` — the file is one
 * measurement per line, the engine sorts it once, and a row lands anywhere on
 * that sorted ruler, interpolating between two neighbours when it falls between
 * them.
 *
 * ### Why this exists beside `weight=`
 *
 * `weight=` reproduces declared shares EXACTLY (measured: 2.30/24.40/50.00 against
 * 2.3/24.4/50 requested), and for a countable quantity — a city, a status, a
 * number of orders — it is the final answer. But it can only ever emit values
 * that were written in the file. Ask for a million rows from a thousand-line
 * sample and you get a thousand distinct values with nothing between them: a
 * comb. For a MEASURED quantity — money, weight, a response time — that comb is
 * a structure the real data never had, and a model trained on it learns the
 * structure.
 *
 * Reading the same sample as a quantile function fixes it, and costs nothing
 * else: the values between observations appear on their own, the resolution
 * follows the mass rather than the range (a six-order-of-magnitude tail costs no
 * more points than a narrow hump), and a value repeated in the sample becomes a
 * flat shelf of exactly its own share — so atoms survive alongside the
 * continuum.
 *
 * ### Why it fits the engine
 *
 * One uniform per row, and the answer depends on that row alone. So it streams,
 * it parallelises, and it needs no totals up front — unlike `weight=`, which is
 * in-memory precisely because an exact quota has to see the whole file first.
 *
 * ### The precision question, decided by the source
 *
 * Interpolating between 31 and 40 gives 35.4, which is right for money and wrong
 * for a count of orders. Rather than guess, the answer is printed with the same
 * number of decimal places as the SOURCE: a whole-number sample gives whole
 * numbers, a sample written to the cent gives cents. `decimals=` overrides it.
 */

import { permute } from '../prng/permute.js';

/** A source read as a quantile function: sorted values, and how they were written. */
export interface QuantileSource {
  /** The sample, ascending. Duplicates are kept — they are what makes an atom. */
  readonly sorted: readonly number[];
  /** The most decimal places any line used, so the answer is written like the source. */
  readonly decimals: number;
}

export class QuantileError extends Error {
  public override readonly name = 'QuantileError';
}

/**
 * Parse and sort the file's values.
 *
 * A line that is not a number is refused rather than skipped: dropping it would
 * change the very shape the file was chosen for, and silently. The message names
 * the line, because in a file of ten thousand numbers "one of them is not a
 * number" is not an answer anyone can act on.
 */
export function quantileSource(values: readonly string[], src: string): QuantileSource {
  if (values.length === 0) {
    throw new QuantileError(`file generator: read="quantile" needs values, and "${src}" has none`);
  }
  const numbers: number[] = [];
  let decimals = 0;
  for (const [i, raw] of values.entries()) {
    const text = raw.trim();
    const value = Number(text);
    if (text === '' || !Number.isFinite(value)) {
      throw new QuantileError(
        `file generator: read="quantile" reads the file as measurements, and line ` +
          `${String(i + 1)} of "${src}" is "${raw}", which is not a number. Every value has to ` +
          'be one, because the sorted sample IS the distribution.',
      );
    }
    numbers.push(value);
    decimals = Math.max(decimals, decimalsOf(text));
  }
  numbers.sort((a, b) => a - b);
  return { sorted: numbers, decimals };
}

/** How many digits this text wrote after the point — `12.50` is two, `12` is none. */
function decimalsOf(text: string): number {
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  // An exponent would make the count meaningless (`1e-7` has no written digits
  // after a point in the ordinary sense), so such a value asks for nothing.
  if (/[eE]/.test(text)) return 0;
  return text.length - dot - 1;
}

/**
 * The value at probability `u`, interpolating between neighbours.
 *
 * `u` is expected in (0,1). Position `u · (n − 1)` puts `u = 0` on the smallest
 * observation and `u = 1` on the largest, so the generated range is exactly the
 * observed one — no tail is invented beyond what was measured, which would be a
 * claim the sample cannot support.
 */
export function quantileAt(sorted: readonly number[], u: number): number {
  const n = sorted.length;
  if (n === 1) return sorted[0] ?? 0;
  const p = u * (n - 1);
  const lo = Math.floor(p);
  const hi = lo + 1;
  const low = sorted[lo] ?? 0;
  if (hi >= n) return sorted[n - 1] ?? low;
  const high = sorted[hi] ?? low;
  // A repeated value makes low === high, and the interpolation returns it
  // unchanged — that is how an atom keeps exactly its own share of the run
  // while everything around it stays continuous.
  return low + (p - lo) * (high - low);
}

/** The finished cell: the interpolated value, written like the source unless told otherwise. */
export function renderQuantile(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

/**
 * The EXACT sweep: every row takes its own point on the ruler, no dice at all.
 *
 * Row `i` is sent to slot `permute(i, count, key)` and reads probability
 * `(slot + 0.5) / count`. Over the whole run the slots are the numbers `0 …
 * count-1` exactly once each, so the generated column reproduces the sample's
 * distribution with no sampling noise whatever — not "0.5% off", but the same
 * empirical distribution stretched to whatever number of rows was asked for.
 *
 * The permutation is what keeps it usable: without it the column would come out
 * sorted. It is the same seekable, seeded permutation `uniq` and the exact
 * `percent=` quota already use, so a row still costs nothing to compute on its
 * own and `--jobs` keeps working.
 *
 * Slot and row are separate arguments because the two engines number rows
 * differently under a `parent=` filter: the in-memory one by position in the
 * subset, the streaming one by population index. Both hand in the same number.
 */
export function exactQuantileAt(
  source: QuantileSource,
  decimals: number,
  count: number,
  key: number,
  position: number,
): string {
  const slot = permute(position, count, key);
  return renderQuantile(quantileAt(source.sorted, (slot + 0.5) / count), decimals);
}
