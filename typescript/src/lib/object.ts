/**
 * Object-output helpers for the public TDC class.
 *
 * Text rendering honours <block>/<line>/<data> wrappers. Object output ignores
 * those wrappers and reports the sequence registry as plain JavaScript records,
 * which is the API shape test code normally wants.
 *
 * Both go through `prepareRender`, and that is the whole point of this file being
 * as short as it is. It used to extract the config itself and always build the
 * in-memory engine, which meant two things: a second reading of `<env>` that a new
 * attribute would silently not reach, and `getAt(9_999_999)` materialising ten
 * million rows to hand back one. Now the router picks the engine, exactly as it
 * does for text, and a streaming registry answers one row for the cost of one row.
 */

import { prepareRender } from '../processor/render.js';
import type { RenderOptions } from '../processor/render.js';
import type { DocumentContext } from '../generated/TDCParser.js';
import { sequenceValueAt } from '../sequence/types.js';
import type { Sequence, SequenceRegistry, SequenceSpec } from '../sequence/index.js';

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
  const prepared = prepareRender(document, options);
  return {
    count: prepared.env.count,
    specs: prepared.sequenceSpecs,
    registry: prepared.registry,
  };
}

function objectRowAt(runtime: ObjectRuntime, index: number): TdcObjectRow {
  const row: TdcObjectRow = {};
  for (const spec of runtime.specs) {
    if (spec.gens) {
      const nested: Record<string, TdcObjectScalar> = {};
      for (const field of spec.gens) {
        const column = runtime.registry[`${spec.name}.${field.name}`];
        nested[field.name] = column ? sequenceValueAt(column, index) : undefined;
      }
      row[spec.name] = nested;
      continue;
    }
    // A `<gen type="pool">` hands the row a whole MEMBER, so it registers one
    // column per pool field under `Name.field` and nothing under `Name` — the
    // text renderer reads `${{Name.field}}` and never asks for the bare name.
    // Read the same way, or the whole sequence comes back undefined.
    const fields = poolFieldsOf(spec, runtime.registry);
    if (fields) {
      const nested: Record<string, TdcObjectScalar> = {};
      for (const [field, seq] of fields) nested[field] = sequenceValueAt(seq, index);
      row[spec.name] = nested;
      continue;
    }
    const column = runtime.registry[spec.name];
    row[spec.name] = column ? sequenceValueAt(column, index) : undefined;
  }
  return row;
}

/** The `Name.field` columns a pool reference registered, or undefined. */
function poolFieldsOf(
  spec: SequenceSpec,
  registry: SequenceRegistry,
): [string, Sequence][] | undefined {
  if (spec.gen?.type !== 'pool') return undefined;
  const prefix = `${spec.name}.`;
  const fields = Object.entries(registry)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, seq]): [string, Sequence] => [key.slice(prefix.length), seq]);
  return fields.length > 0 ? fields : undefined;
}
