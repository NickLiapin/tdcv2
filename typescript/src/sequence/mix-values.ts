/**
 * A `<mix>` built in memory, arranged exactly as the streaming engine arranges it.
 *
 * The mirror of `stream-mix.ts`, and deliberately so: a mix picks its case by an
 * exact percentage layout over the whole run, then assembles that case's body.
 * Both halves are keyed by `(seed, streamId)`, so the two engines put the same
 * case on the same row and draw the same body for it.
 *
 * The one thing to keep straight is which index is which. A row has three
 * numbers here:
 *   - its POSITION in the mix's domain (0…size−1, after any parent mask),
 *   - its SLOT, `permute(position)`, which is what the case quotas are cut from,
 *   - its ROW, the absolute index in the run, which is what a per-row draw keys on.
 * A case's body sees a domain of its own, where position runs 0…quota−1 in slot
 * order — not in row order — and that is exactly what the streaming engine's
 * `popIndexAt` hands it.
 */

import { computeCountsPerValue, distributeByPercent } from '../distribution/hamilton.js';
import { expandPercentMask } from '../distribution/percent-mask.js';
import { permute, permuteKey } from '../prng/permute.js';
import { createPrng } from '../prng/prng.js';

import { buildGenValues } from './build.js';
import type { SequenceBuildContext } from './context.js';
import { absoluteRow, keyedDraws, withRows } from './per-row.js';
import type { CaseSpec, MixSpec } from './types.js';

/** The rows a mix (or one of its cases) covers, in the order it builds them. */
export interface MixDomain {
  readonly size: number;
  /** The absolute row of the domain's `local`-th position. */
  readonly rowAt: (local: number) => number;
}

/** Build a mix over `domain`, returning one value per position in it. */
export function buildKeyedMixValues(
  mixSpec: MixSpec,
  domain: MixDomain,
  seed: string,
  streamId: string,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  flagsOut?: boolean[],
): string[] {
  const { size } = domain;
  const cases = mixSpec.cases;
  const out = new Array<string>(size).fill('');
  if (size === 0) return out;
  if (cases.length === 0) {
    if (flagsOut) for (let i = 0; i < size; i++) flagsOut[i] = false;
    return out;
  }

  const percentAttr = mixSpec.attrs['percent'];
  const percents =
    percentAttr !== undefined && percentAttr.length > 0
      ? expandPercentMask(percentAttr, cases.length)
      : cases.map(() => 100 / cases.length);
  const counts = computeCountsPerValue(size, percents, createPrng(`${seed}|${streamId}|pct`));
  const key = permuteKey(seed, streamId);

  // Case c owns slots [cumLo[c], cumLo[c] + counts[c]).
  const cumLo: number[] = [];
  let acc = 0;
  for (const c of counts) {
    cumLo.push(acc);
    acc += c;
  }

  // The permutation both ways. The streaming engine asks "which slot is this
  // row?"; building a case's body needs the reverse, "which row holds slot s?".
  const slotOf = new Array<number>(size);
  const positionOfSlot = new Array<number>(size);
  for (let i = 0; i < size; i++) {
    const slot = permute(i, size, key);
    slotOf[i] = slot;
    positionOfSlot[slot] = i;
  }
  const caseOfSlot = (slot: number): number => {
    for (let c = 0; c < counts.length; c++) {
      if (slot < (cumLo[c] ?? 0) + (counts[c] ?? 0)) return c;
    }
    return counts.length - 1;
  };

  for (let c = 0; c < cases.length; c++) {
    const quota = counts[c] ?? 0;
    const caseSpec = cases[c];
    if (quota === 0 || !caseSpec) continue;
    const lo = cumLo[c] ?? 0;
    const positionIn = (local: number): number => positionOfSlot[lo + local] ?? 0;
    const values = buildKeyedCaseValues(
      caseSpec,
      { size: quota, rowAt: (local) => domain.rowAt(positionIn(local)) },
      seed,
      `${streamId}#c${String(c)}`,
      prng,
      locale,
      now,
      ctx,
    );
    for (let local = 0; local < quota; local++) out[positionIn(local)] = values[local] ?? '';
  }

  if (flagsOut) {
    // The label reads the same slot→case mapping the value did, so the two
    // cannot disagree on a row — that is the point of a ground-truth column.
    for (let i = 0; i < size; i++) {
      flagsOut[i] = cases[caseOfSlot(slotOf[i] ?? 0)]?.anomaly === true;
    }
  }
  return out;
}

/** Assemble one `<case>`'s parts over the rows that case was given. */
function buildKeyedCaseValues(
  caseSpec: CaseSpec,
  domain: MixDomain,
  seed: string,
  streamId: string,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): string[] {
  const out = new Array<string>(domain.size).fill('');
  const rows = Array.from({ length: domain.size }, (_, local) => domain.rowAt(local));
  // Parts are numbered among ALL of them, literals included — the streaming
  // engine numbers them off the same array, and a different count here would
  // key the same part under a different name.
  caseSpec.parts.forEach((part, p) => {
    const id = `${streamId}#p${String(p)}`;
    let values: readonly string[];
    if (part.kind === 'data') {
      values = new Array<string>(domain.size).fill(part.text);
    } else if (part.kind === 'gen') {
      values = buildGenValues(part.gen, domain.size, prng, locale, now, withRows(ctx, id, rows));
    } else {
      values = buildKeyedMixValues(part.mixSpec, domain, seed, id, prng, locale, now, ctx);
    }
    for (let i = 0; i < domain.size; i++) out[i] = `${out[i] ?? ''}${values[i] ?? ''}`;
  });
  return out;
}

/**
 * `flagsOut`, when given, records for each row whether the case selected for it
 * carries `anomaly="true"` — the ground-truth label behind `<mix flag="NAME">`.
 * It reflects the SELECTION, so the label and the value can never disagree.
 */
export function buildMixValues(
  mixSpec: MixSpec,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
  flagsOut?: boolean[],
): string[] {
  if (count === 0) return [];
  // Named and seeded, this mix is laid out exactly as the streaming engine lays
  // it out. Without a name — an inline mix inside a pack generator body — there
  // is nothing to key by, and the older arrangement below stands.
  const keyed = keyedDraws(ctx);
  if (keyed) {
    return buildKeyedMixValues(
      mixSpec,
      { size: count, rowAt: (local) => absoluteRow(ctx, local) },
      keyed.seed,
      keyed.streamId,
      prng,
      locale,
      now,
      ctx,
      flagsOut,
    );
  }
  const cases = mixSpec.cases;
  if (cases.length === 0) {
    if (flagsOut) for (let i = 0; i < count; i++) flagsOut[i] = false;
    return new Array<string>(count).fill('');
  }

  const percentAttr = mixSpec.attrs['percent'];
  const percents =
    percentAttr === undefined
      ? new Array<number>(cases.length).fill(100 / cases.length)
      : expandPercentMask(percentAttr, cases.length);

  const selectedCases = distributeByPercent({ count, values: cases, percents, prng });
  const out: string[] = new Array<string>(count).fill('');
  if (flagsOut) {
    for (let i = 0; i < count; i++) flagsOut[i] = selectedCases[i]?.anomaly === true;
  }

  for (const currentCase of cases) {
    const indexes: number[] = [];
    for (let i = 0; i < selectedCases.length; i++) {
      if (selectedCases[i] === currentCase) indexes.push(i);
    }
    if (indexes.length === 0) continue;

    const caseValues = buildCaseValues(currentCase, indexes.length, prng, locale, now, ctx);
    for (let i = 0; i < indexes.length; i++) {
      const targetIndex = indexes[i];
      if (targetIndex !== undefined) out[targetIndex] = caseValues[i] ?? '';
    }
  }

  return out;
}

export function buildCaseValues(
  caseSpec: CaseSpec,
  count: number,
  prng: () => number,
  locale: string,
  now: number,
  ctx: SequenceBuildContext,
): string[] {
  const out: string[] = new Array<string>(count).fill('');
  for (const part of caseSpec.parts) {
    let values: readonly string[];
    if (part.kind === 'data') {
      values = new Array<string>(count).fill(part.text);
    } else if (part.kind === 'gen') {
      values = buildGenValues(part.gen, count, prng, locale, now, ctx);
    } else {
      values = buildMixValues(part.mixSpec, count, prng, locale, now, ctx);
    }

    for (let i = 0; i < count; i++) {
      out[i] = `${out[i] ?? ''}${values[i] ?? ''}`;
    }
  }
  return out;
}
