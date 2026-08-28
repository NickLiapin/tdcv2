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
import { loadWeightedValues, weightedPackValues } from '../generators/weighted.js';
import { resolvePackAddress } from '../data-pack/locales.js';
import type { PackEntry } from '../data-pack/load.js';

import type { GenSpec, SequenceSpec } from './types.js';
import type { DataSourceOptions } from '../data-source/resolve.js';
import { sequentialList } from './build.js';
import { resolveExistingDataSourcePath } from '../data-source/resolve.js';

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

/**
 * The value list of a PLAIN pack — one that declares no weights — or undefined
 * when the gen is not that. Laid out in equal shares over the column exactly as
 * a plain text list is; a per-row pick left every value's count to chance, and
 * inside a `<uniq>` that chance decided whether the run collects.
 */
export function plainTemplatePack(
  gen: GenSpec,
  packs: ReadonlyMap<string, PackEntry> | undefined,
  locale: string,
): string[] | undefined {
  if (gen.type !== 'template') return undefined;
  const entry = packs?.get(
    resolvePackAddress(gen.attrs['value'] ?? '', gen.attrs['local'] ?? locale, packs),
  );
  return entry?.values !== undefined &&
    entry.generator === undefined &&
    entry.percents === undefined
    ? [...entry.values]
    : undefined;
}

/**
 * The value list of a PLAIN file — no weights, no quantile read — or undefined.
 * An unreadable file is deferred, not reported: the lazy contract says a
 * missing source fails when a row first touches it, never at plan time.
 */
export function plainFileList(
  gen: GenSpec,
  weightColumn: string | undefined,
  dataSources: DataSourceOptions,
): string[] | undefined {
  if (
    gen.type !== 'file' ||
    weightColumn !== undefined ||
    (gen.attrs['read'] ?? '').trim() === 'quantile'
  ) {
    return undefined;
  }
  try {
    return sequentialList(gen, dataSources);
  } catch {
    return undefined;
  }
}

/**
 * The weighted list a column lays out — the pack's own, or the file's when a
 * `weight=` column names one — or undefined for a plain list.
 */
export function weightedListOf(
  gen: GenSpec,
  weightColumn: string | undefined,
  weightedPack: { values: string[]; percents: number[] } | undefined,
  dataSources: DataSourceOptions,
): { values: string[]; percents: number[] } | undefined {
  if (weightColumn === undefined) return weightedPack;
  return loadWeightedValues(
    resolveExistingDataSourcePath(gen.attrs['src'] ?? '', dataSources).path,
    {
      column: gen.attrs['column'],
      header: gen.attrs['header'],
      delimiter: gen.attrs['delimiter'],
    },
    weightColumn,
  );
}

/** A plain pack's or plain file's value list — whichever the gen is — or undefined. */
export function plainListOf(
  gen: GenSpec,
  packs: ReadonlyMap<string, PackEntry> | undefined,
  locale: string,
  weightColumn: string | undefined,
  dataSources: DataSourceOptions,
): string[] | undefined {
  return plainTemplatePack(gen, packs, locale) ?? plainFileList(gen, weightColumn, dataSources);
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
