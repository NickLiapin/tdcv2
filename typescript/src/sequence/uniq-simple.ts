/**
 * `uniq="true"` on a SIMPLE sequence: every row gets a different value.
 *
 * A compound's `uniq` rearranges what was already drawn — it can keep the
 * per-value proportions because a tuple has room to vary. A single column has
 * no such room: proportions and uniqueness contradict each other the moment
 * any value's share exceeds one row. So here `uniq` changes the DRAW itself:
 * values are sampled WITHOUT REPLACEMENT. A weighted pool keeps its meaning —
 * frequent values are more likely to make the cut — but nothing appears twice.
 *
 * When the pool holds fewer distinct values than there are rows, that is said
 * up front, in the same voice the compound infeasibility check uses. The one
 * thing this module never does is the old behavior: accept the attribute and
 * quietly ignore it.
 *
 * Draw budget: exactly one PRNG draw per row, whatever the pool — part of the
 * cross-language contract, like every other generator's budget.
 */

import { resolveExistingDataSourcePath } from '../data-source/index.js';
import { loadCsvColumnFile, loadListFile } from '../generators/file.js';
import { loadWeightedValues, weightColumnOf } from '../generators/weighted.js';
import { resolvePackAddress } from '../data-pack/index.js';

import type { SequenceBuildContext } from './context.js';
import type { GenSpec } from './types.js';

/** A pool the sampler can draw from: distinct values with positive weights. */
interface Pool {
  readonly values: readonly string[];
  readonly weights: readonly number[];
}

/**
 * True when this spec shape takes the without-replacement path. `increment`
 * and `decrement` are unique by construction and keep their normal build.
 */
export function genSupportsUniq(gen: GenSpec): boolean {
  return gen.type === 'increment' || gen.type === 'decrement' || enumerationOf(gen) !== undefined;
}

/**
 * The reason a gen CANNOT take the path, for the refusal message. `undefined`
 * when it can.
 */
export function uniqUnsupportedReason(gen: GenSpec): string | undefined {
  if (genSupportsUniq(gen)) return undefined;
  if (gen.type === 'number') {
    return 'its values are not a plain integer range — uniq supports value="a..b" without decimals=, distribution=, include= or exclude=';
  }
  return (
    `its values cannot be enumerated (type="${gen.type}") — uniq on a simple sequence ` +
    'supports text lists, template packs, file columns and plain integer ranges'
  );
}

/**
 * Build `count` pairwise-different values for a simple `uniq="true"` sequence.
 * Throws with the infeasibility said plainly when the pool is too small.
 */
export function buildUniqueValues(
  name: string,
  gen: GenSpec,
  count: number,
  prng: () => number,
  locale: string,
  ctx: SequenceBuildContext,
): string[] {
  if (gen.type === 'number') return uniqueNumbers(name, gen, count, prng);

  const pool = poolOf(name, gen, locale, ctx);
  if (pool.values.length < count) {
    throw new Error(
      `uniq: sequence "${name}" cannot produce ${String(count)} unique values — its source ` +
        `holds only ${String(pool.values.length)} distinct values. Add more values, or lower ` +
        'the count.',
    );
  }
  return sampleWithoutReplacement(pool, count, prng);
}

/**
 * Weighted sampling without replacement, one PRNG draw per pick: draw a point
 * in the remaining total weight, walk the pool in its stored order to the
 * value it lands on, take that value out. Selection order IS row order — the
 * walk is already random, so no extra shuffle (and no extra draws).
 */
function sampleWithoutReplacement(pool: Pool, count: number, prng: () => number): string[] {
  const weights = [...pool.weights];
  let total = weights.reduce((a, b) => a + b, 0);
  const taken = new Array<boolean>(weights.length).fill(false);
  const out: string[] = [];
  for (let k = 0; k < count; k++) {
    const target = prng() * total;
    let acc = 0;
    let picked = -1;
    for (let i = 0; i < weights.length; i++) {
      if (taken[i] === true) continue;
      acc += weights[i] ?? 0;
      if (target < acc) {
        picked = i;
        break;
      }
    }
    // Floating summation can leave `target` a hair past the last value's edge;
    // the last remaining value is the only honest answer then.
    if (picked < 0) {
      for (let i = weights.length - 1; i >= 0; i--) {
        if (taken[i] !== true) {
          picked = i;
          break;
        }
      }
    }
    if (picked < 0) break;
    taken[picked] = true;
    total -= weights[picked] ?? 0;
    out.push(pool.values[picked] ?? '');
  }
  return out;
}

/**
 * Unique integers from a plain `a..b` range: draw normally, redraw on a
 * repeat. Feasibility is arithmetic — a range smaller than the row count is
 * refused before any drawing. Redraws append to the PRNG stream, the same
 * budget rule reject-and-retry already follows elsewhere.
 */
function uniqueNumbers(name: string, gen: GenSpec, count: number, prng: () => number): string[] {
  const range = plainIntRange(gen);
  if (!range) {
    throw new Error(`uniq: sequence "${name}" — ${uniqUnsupportedReason(gen) ?? ''}`);
  }
  const [lo, hi] = range;
  const size = hi - lo + 1;
  if (size < count) {
    throw new Error(
      `uniq: sequence "${name}" cannot produce ${String(count)} unique values — the range ` +
        `${String(lo)}..${String(hi)} holds only ${String(size)} integers. Widen the range, ` +
        'or lower the count.',
    );
  }
  const seen = new Set<number>();
  const out: string[] = [];
  while (out.length < count) {
    const n = lo + Math.floor(prng() * size);
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(String(n));
  }
  return out;
}

/** The `a..b` integer range of a plain number gen, or `undefined`. */
function plainIntRange(gen: GenSpec): [number, number] | undefined {
  if (gen.type !== 'number') return undefined;
  for (const blocked of ['distribution', 'decimals', 'include', 'exclude', 'first_zero']) {
    if ((gen.attrs[blocked] ?? '').trim() !== '') return undefined;
  }
  const m = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(gen.attrs['value'] ?? '');
  if (!m) return undefined;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  return lo <= hi ? [lo, hi] : undefined;
}

/** Whether the gen's values can be listed up front (with weights). */
function enumerationOf(gen: GenSpec): 'text' | 'template' | 'file' | 'number' | undefined {
  switch (gen.type) {
    case 'text':
      return (gen.attrs['percent'] ?? '').trim() === '' ? 'text' : undefined;
    case 'template':
      return 'template';
    case 'file':
      return (gen.attrs['row'] ?? '').trim() === '' ? 'file' : undefined;
    case 'number':
      return plainIntRange(gen) ? 'number' : undefined;
    default:
      return undefined;
  }
}

/**
 * The distinct values a gen can produce, with their weights. Duplicate
 * strings in a source merge — two identical lines are one value with the
 * summed weight, or uniqueness would be broken by the pool itself.
 */
function poolOf(name: string, gen: GenSpec, locale: string, ctx: SequenceBuildContext): Pool {
  const kind = enumerationOf(gen);
  if (kind === 'text') {
    const values = (gen.attrs['value'] ?? '').split(',').map((s) => s.trim());
    return mergeDuplicates(values, undefined);
  }
  if (kind === 'template') {
    const path = gen.attrs['value'] ?? '';
    const packEntry = ctx.packs?.get(resolvePackAddress(path, gen.attrs['local'] ?? locale));
    if (packEntry?.values) {
      return mergeDuplicates([...packEntry.values], packEntry.percents && [...packEntry.percents]);
    }
    throw new Error(
      `uniq: sequence "${name}" — template "${path}" does not resolve to a value list, so its ` +
        'values cannot be enumerated for a unique draw',
    );
  }
  if (kind === 'file') {
    const resolved = resolveExistingDataSourcePath(gen.attrs['src'] ?? '', ctx.dataSources).path;
    const column = gen.attrs['column'];
    const options = { column, header: gen.attrs['header'], delimiter: gen.attrs['delimiter'] };
    const weightColumn = weightColumnOf(gen.attrs);
    if (weightColumn !== undefined) {
      const { values, percents } = loadWeightedValues(resolved, options, weightColumn);
      return mergeDuplicates([...values], [...percents]);
    }
    const values =
      column && column.trim().length > 0
        ? loadCsvColumnFile(resolved, options)
        : loadListFile(resolved);
    return mergeDuplicates(values, undefined);
  }
  throw new Error(`uniq: sequence "${name}" — ${uniqUnsupportedReason(gen) ?? ''}`);
}

/** Merge duplicate strings, summing weights (missing weights count as 1). */
function mergeDuplicates(values: readonly string[], weights?: readonly number[]): Pool {
  const index = new Map<string, number>();
  const outValues: string[] = [];
  const outWeights: number[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i] ?? '';
    const weight = weights?.[i] ?? 1;
    const at = index.get(value);
    if (at === undefined) {
      index.set(value, outValues.length);
      outValues.push(value);
      outWeights.push(weight);
    } else {
      outWeights[at] = (outWeights[at] ?? 0) + weight;
    }
  }
  return { values: outValues, weights: outWeights };
}
