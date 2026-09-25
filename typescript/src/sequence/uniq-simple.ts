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
import { planAdvancedRegexColumn } from '../generators/advanced-regex-plan.js';
import { regexGenerator, regexSpaceSize } from '../generators/regex.js';

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
  return (
    gen.type === 'increment' ||
    gen.type === 'decrement' ||
    gen.type === 'regex' ||
    gen.type === 'advanced_regex' ||
    enumerationOf(gen) !== undefined
  );
}

/**
 * The reason a gen CANNOT take the path, for the refusal message. `undefined`
 * when it can.
 */
export function uniqUnsupportedReason(gen: GenSpec): string | undefined {
  if (genSupportsUniq(gen)) return undefined;
  if (gen.type === 'number') {
    // Every attribute named here is one `plainIntRange` actually blocks. `first_zero=` was
    // missing from the list and is the one people reach for when they want a fixed width for a
    // composed value — so the reader was told their attributes were fine and refused anyway.
    // `length=` is deliberately absent: it does NOT block, and a range like 100000..999999 is
    // already six digits wide without it.
    return 'its values are not a plain integer range — uniq supports value="a..b" without decimals=, distribution=, include=, exclude= or first_zero=';
  }
  return (
    `its values cannot be enumerated (type="${gen.type}") — uniq on a simple sequence ` +
    'supports text lists, template packs, file columns, plain integer ranges, regex and ' +
    'advanced_regex patterns'
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
  if (gen.type === 'regex') return uniqueRegexValues(name, gen, count, prng, ctx);
  if (gen.type === 'advanced_regex') return uniqueAdvancedRegexValues(name, gen, count, prng, ctx);

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

/**
 * Unique strings from a `type="regex"` pattern: the same redraw-on-repeat as the integer range
 * above, which is the whole of the reason a pattern was ever refused here. Nothing needs listing.
 * What uniqueness needs from a source is to know how big it is, so that a request it cannot
 * meet is refused before drawing rather than discovered after — and a finite pattern knows:
 * `regexSpaceSize` counts it over the parse tree, and this generator accepts no pattern whose
 * output is unbounded.
 *
 * Each value is one walk of the pattern, taken from the stream every unique draw here shares, and
 * a repeat costs one more walk. That stream is not the plain column's — the plain column keys
 * each row's draw to the row, the integer range above does not, and neither does this — so a
 * unique column is not the plain one with its repeats removed, and was never meant to be. Taken
 * together it is weighted sampling without replacement, with the
 * pattern's own odds as the weights — the same meaning `uniq` already has over a weighted list:
 * likelier strings are likelier to make the cut, and none appears twice. It also means a short
 * form runs out first. `{2,10}` picks each of its nine lengths one time in nine, and the
 * hundred two-digit strings of `[0-9]{2,10}` are gone long before the longer ones; after that a
 * draw that lands on length two is simply drawn again, and the column leans longer.
 *
 * Two things can make the drawing stall, and both end in a refusal naming them rather than in a
 * loop. The count can take nearly all of the space, so the last few strings are hard to hit; or
 * the size can be an overstatement (see `regexSpaceSize`), so the space is smaller than it was
 * counted. `stallLimit` is how many repeats in a row are allowed before that is said.
 */
function uniqueRegexValues(
  name: string,
  gen: GenSpec,
  count: number,
  prng: () => number,
  ctx: SequenceBuildContext,
): string[] {
  const attrs = {
    pattern: gen.attrs['value'] ?? '',
    regexMaxLength: gen.attrs['regex_max_length'] ?? ctx.regexMaxLength,
  };
  const space = regexSpaceSize(attrs);
  if (space < count) {
    throw new Error(
      `uniq: sequence "${name}" cannot produce ${String(count)} unique values — the pattern ` +
        `"${attrs.pattern}" makes at most ${String(space)} different strings. Widen the ` +
        'pattern, or lower the count.',
    );
  }
  const draw = regexGenerator(attrs);
  const seen = new Set<string>();
  const out: string[] = [];
  let repeats = 0;
  while (out.length < count) {
    const value = draw(1, prng)[0] ?? '';
    if (seen.has(value)) {
      repeats += 1;
      if (repeats > stallLimit(space, out.length)) {
        throw new Error(
          `uniq: sequence "${name}" — after ${String(out.length)} unique values the pattern ` +
            `"${attrs.pattern}" produced only ones already drawn, ${String(repeats)} in a row. ` +
            `Its space of at most ${String(space)} strings is nearly used up, or fewer of them ` +
            'differ than its shape suggests. Widen the pattern, or lower the count.',
        );
      }
      continue;
    }
    repeats = 0;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Unique strings from an `advanced_regex` pattern — the plain pattern's redraw, with the one
 * thing this generator adds kept exactly: its weighted shares.
 *
 * `(?%{70:RU;30:US})` deals RU to exactly seven rows in ten, and that is a promise about the
 * column that uniqueness must not break. So the column is dealt first, exactly as it would be
 * without `uniq`, and every value that repeats is redrawn ALONG THE BRANCHES ITS ROW WAS DEALT
 * (`PlannedAdvancedColumn.redraw`). Rows whose values were already different are left alone.
 *
 * That turns "is there room?" into a question per share, and the per-pattern count stops being
 * enough: `(?%{70:RU;30:US})-[0-9]{3}` at 2 000 rows can make exactly 2 000 strings, and its RU
 * share alone needs 1 400 of the 1 000 that start `RU-`. So three refusals, in the order a reader
 * meets them. The whole pattern too small, as for a plain pattern. Then one share too small, named
 * by its percentage, before anything is redrawn — wherever the pattern's shares can be counted
 * apart. And a run of repeats too long, when a share runs dry that could not be counted apart, or
 * when its count was high.
 */
function uniqueAdvancedRegexValues(
  name: string,
  gen: GenSpec,
  count: number,
  prng: () => number,
  ctx: SequenceBuildContext,
): string[] {
  const pattern = gen.attrs['value'] ?? '';
  const column = planAdvancedRegexColumn(
    { pattern, regexMaxLength: gen.attrs['regex_max_length'] ?? ctx.regexMaxLength },
    count,
    prng,
  );
  if (column.totalSpace < count) {
    throw new Error(
      `uniq: sequence "${name}" cannot produce ${String(count)} unique values — the pattern ` +
        `"${pattern}" makes at most ${String(column.totalSpace)} different strings. Widen the ` +
        'pattern, or lower the count.',
    );
  }

  // Rows per share, in the order the shares first appear in the column.
  const rowsIn = new Map<string, number>();
  for (const key of column.pathKeys) rowsIn.set(key, (rowsIn.get(key) ?? 0) + 1);
  for (const [key, rows] of rowsIn) {
    const space = column.pathSpace(key);
    const path = column.describePath(key);
    if (space !== undefined && path !== '' && space < rows) {
      throw new Error(
        `uniq: sequence "${name}" — the ${path} share of the pattern "${pattern}" is ` +
          `${String(rows)} rows, and it can make at most ${String(space)} different strings. ` +
          'Give that branch a smaller share, widen it, or lower the count.',
      );
    }
  }

  const values = column.values;
  const seen = new Set<string>();
  const takenIn = new Map<string, number>();
  const redo: number[] = [];
  values.forEach((value, row) => {
    if (seen.has(value)) {
      redo.push(row);
      return;
    }
    seen.add(value);
    const key = column.pathKeys[row] ?? '';
    takenIn.set(key, (takenIn.get(key) ?? 0) + 1);
  });

  for (const row of redo) {
    const key = column.pathKeys[row] ?? '';
    const space = column.pathSpace(key) ?? column.totalSpace;
    const path = column.describePath(key);
    let repeats = 0;
    for (;;) {
      const candidate = column.redraw(row, prng);
      if (candidate !== undefined && !seen.has(candidate)) {
        values[row] = candidate;
        seen.add(candidate);
        takenIn.set(key, (takenIn.get(key) ?? 0) + 1);
        break;
      }
      repeats += 1;
      if (repeats > stallLimit(space, takenIn.get(key) ?? 0)) {
        const whose = path === '' ? 'the pattern' : `the ${path} share of the pattern`;
        throw new Error(
          `uniq: sequence "${name}" — after ${String(seen.size)} unique values ${whose} ` +
            `"${pattern}" produced only ones already drawn, ${String(repeats)} in a row. Its ` +
            `space of at most ${String(space)} strings is nearly used up, or fewer of them ` +
            'differ than its shape suggests. Widen the pattern, or lower the count.',
        );
      }
    }
  }
  return values;
}

/**
 * How many repeats in a row a unique pattern draw tolerates before calling the space exhausted.
 *
 * A floor of a hundred thousand, and above it twenty times the wait one fresh value costs when
 * every remaining string is equally likely: with `space` strings of which `produced` are taken,
 * that wait is space / (space − produced). Twenty of those in a row is a chance of about one in
 * five hundred million for a pattern whose size is exact and whose odds are even — so asking for
 * every one of the million six-digit strings of `[0-9]{6}` finishes, while a pattern that was
 * overcounted stops as soon as its real space is spent.
 *
 * The division is done in integers. Five languages have to stop on the same draw, and a
 * floating-point quotient of two numbers near 2^53 can round onto a whole number and lose the
 * ceiling that integer division keeps.
 */
function stallLimit(space: number, produced: number): number {
  const total = BigInt(space);
  const remaining = BigInt(Math.max(1, space - produced));
  const wait = Number((total + remaining - 1n) / remaining);
  return Math.max(100_000, 20 * wait);
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
    const packEntry = ctx.packs?.get(
      resolvePackAddress(path, gen.attrs['local'] ?? locale, ctx.packs),
    );
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
