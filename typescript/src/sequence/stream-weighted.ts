/**
 * Weighted-quota helpers for the streaming builder.
 *
 * These share one shape: a value's share is an exact quota over the WHOLE
 * column, so the streaming engine — which resolves one row at a time — must
 * plan it up front and map each row into it by index, never decide it from a
 * single-cell draw. Kept out of stream-build.ts to hold that file under its
 * line ceiling; all pure, no engine state.
 */

import { type NumberLengthChoice, parseNumberLengthChoices } from '../generators/number.js';
import { weightedPackValues } from '../generators/weighted.js';
import { resolvePackAddress } from '../data-pack/locales.js';
import type { PackEntry } from '../data-pack/load.js';

import type { GenSpec, SequenceSpec } from './types.js';

/**
 * The length groups of a weighted `<gen type="number" length="A,B-C"
 * percent="…">`, or undefined when this gen is not one. Anything malformed is
 * left to the validator and the generator itself — this only decides whether
 * the quota path applies.
 */
export function numberLengthChoicesOf(gen: GenSpec): readonly NumberLengthChoice[] | undefined {
  if (gen.type !== 'number') return undefined;
  const length = gen.attrs['length'];
  const percent = gen.attrs['percent'];
  if (length === undefined || percent === undefined || percent.trim() === '') return undefined;
  try {
    return parseNumberLengthChoices(length);
  } catch {
    return undefined;
  }
}

/**
 * The same gen pinned to ONE length group, with `percent` dropped so the
 * per-row builder cannot re-run the split it has already lost the context for.
 */
export function pinLength(gen: GenSpec, group: NumberLengthChoice): GenSpec {
  const attrs: Record<string, string> = {};
  for (const [k, v] of Object.entries(gen.attrs)) {
    if (k !== 'percent' && k !== 'length') attrs[k] = v;
  }
  attrs['length'] =
    group.min === group.max ? String(group.min) : `${String(group.min)}-${String(group.max)}`;
  return { ...gen, attrs };
}

/**
 * A `<gen type="template">` pointing at a WEIGHTED pack, as {values, percents},
 * or undefined for a plain template / non-template gen. Resolves the pack
 * address the same way the in-memory builder does, so both engines draw the
 * same pack by the same quota.
 */
/**
 * A pack whose BODY apportions a share over the whole column, as the parts the
 * lazy builder needs to run it: the body's own sequences and the text they are
 * assembled into.
 *
 * A single `<gen percent="…">` body comes back as a one-sequence body under a
 * fixed name, so both shapes take one road from here. A body carrying its own
 * `<valid>` comes back as nothing: rejecting a row and redrawing it is a
 * whole-column decision with no lazy form yet, and the caller refuses it.
 */
export function wholeColumnPackBody(
  gen: GenSpec,
  packs: ReadonlyMap<string, PackEntry> | undefined,
  locale: string,
): { sequences: readonly SequenceSpec[]; output: string; inject: string } | undefined {
  if (gen.type !== 'template') return undefined;
  const address = resolvePackAddress(gen.attrs['value'] ?? '', gen.attrs['local'] ?? locale);
  const entry = packs?.get(address);
  if (entry?.needsWholeColumn !== true) return undefined;
  const body = entry.generator;
  if (body === undefined) return undefined;
  if (body.kind === 'composed') {
    if (body.validate !== undefined) return undefined;
    return { sequences: body.sequences, output: body.output, inject: body.inject };
  }
  const name = 'value';
  return {
    sequences: [{ name, items: [{ kind: 'anon', gen: body.gen }] } as unknown as SequenceSpec],
    output: `\${{${name}}}`,
    inject: '',
  };
}

export function weightedTemplatePack(
  gen: GenSpec,
  packs: ReadonlyMap<string, PackEntry> | undefined,
  locale: string,
): { values: string[]; percents: number[] } | undefined {
  if (gen.type !== 'template') return undefined;
  const address = resolvePackAddress(gen.attrs['value'] ?? '', gen.attrs['local'] ?? locale);
  return weightedPackValues(packs?.get(address));
}
