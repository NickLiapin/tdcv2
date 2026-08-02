/**
 * Object-output helpers for the public TDC class.
 *
 * Text rendering honours <block>/<line>/<data> wrappers. Object output
 * ignores those wrappers and exposes the materialised sequence registry as
 * plain JavaScript records, which is the API shape test code normally wants.
 */

import { bundledPacks } from '../data-pack/index.js';
import type { DocumentContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { parseRegexMaxLength } from '../generators/regex.js';
import { createPrng } from '../prng/prng.js';
import { buildSequences, extractSequenceSpecs } from '../sequence/index.js';
import { buildPoolTables } from '../sequence/pool-build.js';
import { extractPoolSpecs } from '../sequence/pool.js';
import { extractEnvDistinctGroups, extractEnvUniqGroups } from '../sequence/extract.js';
import type { SequenceRegistry, SequenceSpec } from '../sequence/index.js';
import type { RenderOptions } from '../processor/render.js';
import { elementKind, elementName, extractAttrs, findChildElement } from '../processor/walk.js';

export type TdcObjectScalar = string | undefined;
export type TdcObjectValue = TdcObjectScalar | Record<string, TdcObjectScalar>;
export type TdcObjectRow = Record<string, TdcObjectValue>;

interface ObjectRuntime {
  readonly count: number;
  readonly specs: readonly SequenceSpec[];
  readonly registry: SequenceRegistry;
}

export function materializeObjectRows(
  document: DocumentContext,
  options: RenderOptions = {},
): TdcObjectRow[] {
  const runtime = materializeObjectRuntime(document, options);
  return Array.from({ length: runtime.count }, (_, index) => objectRowAt(runtime, index));
}

export function* iterateObjectRows(
  document: DocumentContext,
  options: RenderOptions = {},
): Generator<TdcObjectRow, void, void> {
  const runtime = materializeObjectRuntime(document, options);
  for (let index = 0; index < runtime.count; index++) yield objectRowAt(runtime, index);
}

export function getObjectRowAt(
  document: DocumentContext,
  index: number,
  options: RenderOptions = {},
): TdcObjectRow {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new RangeError(`TDC.getAt: index must be a non-negative integer, got ${String(index)}`);
  }
  const runtime = materializeObjectRuntime(document, options);
  if (index >= runtime.count) {
    throw new RangeError(
      `TDC.getAt: index ${String(index)} is out of range for count ${String(runtime.count)}`,
    );
  }
  return objectRowAt(runtime, index);
}

function materializeObjectRuntime(
  document: DocumentContext,
  options: RenderOptions,
): ObjectRuntime {
  const tdc = findTdc(document);
  if (!tdc) throw new Error('Document has no <tdc> root element');

  const envEl = findChildElement(tdc.content(), 'env');
  const config = extractObjectConfig(tdc, envEl, options);
  const prng = createPrng(config.seed);
  const specs = extractSequenceSpecs(envEl);
  const packOptions = {
    regexMaxLength: config.regexMaxLength,
    packs: options.packs ?? bundledPacks(),
    dataSources: {
      baseDir: options.baseDir,
      dataPaths: options.dataPaths,
    },
  };
  // The SAME build the text renderer performs. It used to be a shorter call —
  // no `seed`, no pools, no uniq/distinct groups — and the result was that
  // `iterate()` and `toString()` returned different data from one object with
  // one seed: generators that derive a per-sequence stream from `seed` fell
  // back to consuming the shared PRNG in a different order. A row read through
  // the object API also silently ignored every <pool> and every uniqueness
  // group. Whatever the renderer needs to be correct, this needs too.
  const registry = buildSequences(specs, config.count, prng, config.locale, config.now, {
    ...packOptions,
    seed: config.seed,
    pools: buildPoolTables(
      extractPoolSpecs(envEl),
      config.seed,
      config.locale,
      config.now,
      packOptions,
    ),
    envUniqGroups: extractEnvUniqGroups(envEl),
    envDistinctGroups: extractEnvDistinctGroups(envEl),
  });

  return { count: config.count, specs, registry };
}

function objectRowAt(runtime: ObjectRuntime, index: number): TdcObjectRow {
  const row: TdcObjectRow = {};
  for (const spec of runtime.specs) {
    if (spec.gens) {
      const nested: Record<string, TdcObjectScalar> = {};
      for (const field of spec.gens) {
        nested[field.name] = runtime.registry[`${spec.name}.${field.name}`]?.values[index];
      }
      row[spec.name] = nested;
      continue;
    }
    row[spec.name] = runtime.registry[spec.name]?.values[index];
  }
  return row;
}

function extractObjectConfig(
  tdcEl: OpenCloseElementContext,
  envEl: OpenCloseElementContext | undefined,
  options: RenderOptions,
): {
  readonly count: number;
  readonly seed: string;
  readonly locale: string;
  readonly now: number;
  readonly regexMaxLength: number;
} {
  const tdcAttrs = extractAttrs(tdcEl.attr());
  const attrs = envEl ? extractAttrs(envEl.attr()) : {};
  return {
    count: options.count ?? (attrs['count'] ? Number(attrs['count']) : 10),
    seed: options.seed ?? attrs['seed'] ?? String(Math.random()),
    locale: options.locale ?? attrs['local'] ?? options.defaultLocale ?? 'en',
    now: options.now ?? Date.now(),
    regexMaxLength: parseRegexMaxLength(tdcAttrs['regex_max_length']),
  };
}

function findTdc(doc: DocumentContext): OpenCloseElementContext | undefined {
  for (const el of doc.element()) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === 'tdc') return k.node;
  }
  return undefined;
}
