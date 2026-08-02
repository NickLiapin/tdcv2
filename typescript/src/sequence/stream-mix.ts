/**
 * A `<mix>` for the streaming engines.
 *
 * Split out of `stream-build.ts` when that file reached its line ceiling, on a
 * seam that was already there: a mix is the one construct whose value is chosen
 * by a whole-run percentage layout and then ASSEMBLED from a case body, so it
 * needs its own resolver rather than the per-column draw the rest of the file
 * describes.
 */

import { computeCountsPerValue } from '../distribution/hamilton.js';
import { expandPercentMask } from '../distribution/percent-mask.js';
import { createPrng } from '../prng/prng.js';
import { permute, permuteKey } from '../prng/permute.js';
import type { SequenceBuildOptions } from './build.js';
import { buildCaseResolver, type Domain } from './stream-build.js';
import { lazy } from './stream-lazy.js';
import type { MixSpec, Sequence } from './types.js';

/**
 * `<mix>` in stream mode: pick a case for row `i` by exact percentage (a
 * Feistel quota plan, like `text`), then assemble that case's parts at row `i`
 * (data literal, gen via a per-row seekable draw, nested mix recursively).
 * A nested mix distributes over its OUTER case's subset — the same subset
 * bijection as parent-child — so exact sub-percentages nest to any depth.
 */
export function buildMixSeq(
  streamId: string,
  mixSpec: MixSpec,
  domain: Domain,
  seed: string,
  locale: string,
  now: number,
  options: SequenceBuildOptions,
): { sequence: Sequence; flag?: { name: string; sequence: Sequence } } {
  const { size, popIndexAt } = domain;
  const cases = mixSpec.cases;
  const flagName =
    mixSpec.attrs['flag'] !== undefined && mixSpec.attrs['flag'].trim() !== ''
      ? mixSpec.attrs['flag']
      : undefined;
  if (size === 0 || cases.length === 0) {
    const sequence = lazy(streamId, (i) => (popIndexAt(i) === undefined ? undefined : ''));
    if (flagName === undefined) return { sequence };
    return {
      sequence,
      flag: {
        name: flagName,
        sequence: lazy(flagName, (i) => (popIndexAt(i) === undefined ? undefined : 'false')),
      },
    };
  }

  const percentAttr = mixSpec.attrs['percent'];
  const percents =
    percentAttr !== undefined && percentAttr.length > 0
      ? expandPercentMask(percentAttr, cases.length)
      : cases.map(() => 100 / cases.length);
  const counts = computeCountsPerValue(size, percents, createPrng(`${seed}|${streamId}|pct`));
  const key = permuteKey(seed, streamId);
  const cumLo: number[] = [];
  let acc = 0;
  for (const c of counts) {
    cumLo.push(acc);
    acc += c;
  }

  const slotAt = (i: number): number | undefined => {
    const r = popIndexAt(i);
    return r === undefined ? undefined : permute(r, size, key);
  };
  const caseOf = (slot: number): number => {
    for (let c = 0; c < counts.length; c++) {
      if (slot < (cumLo[c] ?? 0) + (counts[c] ?? 0)) return c;
    }
    return counts.length - 1;
  };

  // One assembler per case, each over that case's subset (for nested mixes).
  const caseResolvers = cases.map((caseSpec, c) =>
    buildCaseResolver(
      caseSpec,
      `${streamId}#c${String(c)}`,
      {
        size: counts[c] ?? 0,
        popIndexAt: (i) => {
          const slot = slotAt(i);
          if (slot === undefined) return undefined;
          const lo = cumLo[c] ?? 0;
          const quota = counts[c] ?? 0;
          return slot >= lo && slot < lo + quota ? slot - lo : undefined;
        },
      },
      seed,
      locale,
      now,
      options,
    ),
  );

  const sequence = lazy(streamId, (i) => {
    const slot = slotAt(i);
    if (slot === undefined) return undefined;
    return caseResolvers[caseOf(slot)]?.(i) ?? '';
  });
  if (flagName === undefined) return { sequence };

  // The label reads the SAME slot→case mapping the value does, so the two
  // cannot disagree on any row — that is the point of a ground-truth column.
  return {
    sequence,
    flag: {
      name: flagName,
      sequence: lazy(flagName, (i) => {
        const slot = slotAt(i);
        if (slot === undefined) return undefined;
        return cases[caseOf(slot)]?.anomaly === true ? 'true' : 'false';
      }),
    },
  };
}
