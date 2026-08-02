/**
 * Render a document straight into a Parquet file.
 *
 * Reuses the very same preparation as the text renderer — one `prepareRender`,
 * one registry — so a config exported to Parquet holds exactly the data it
 * would have printed as text for that seed. Only the SERIALISATION differs:
 * instead of formatting a card, each named `<data>` becomes a typed column.
 *
 * Rows are emitted in ROW GROUPS: a batch is built, written and released before
 * the next one starts, so memory stays bounded no matter how large `count` is.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §1, §5, §8.
 */

import type { DocumentContext } from '../generated/TDCParser.js';
import { interpolate } from '../processor/interpolate.js';
import { prepareRender, type RenderOptions } from '../processor/render.js';
import { findChildElement } from '../processor/walk.js';
import { extractSequenceSpecs } from '../sequence/index.js';

import {
  isListType,
  parseColumnType,
  type ColumnType,
  type OutputColumnType,
} from './column-type.js';
import { extractDeclaredColumns, type DeclaredColumn } from './columns.js';
import { deriveOutputColumnType, repeatSeparatorOf, soleReference } from './derive-type.js';
import { convertValue } from './parquet/convert.js';
import {
  rowGroupBlocks,
  writeParquetChunks,
  type ParquetBatch,
  type ParquetCell,
  type ParquetSchemaColumn,
  type RowGroupBlock,
} from './parquet/writer.js';

/** Untyped columns fall back to text — never guess, a string never corrupts data. */
const DEFAULT_TYPE: ColumnType = parseColumnType('string');

/**
 * Rows per row group. Bounds peak memory, lets readers skip whole groups — and
 * is the unit parallel generation is split on, because a group's bytes do not
 * depend on where it sits in the file.
 */
export const ROW_GROUP_ROWS = 50_000;

interface Plan {
  readonly declared: readonly DeclaredColumn[];
  readonly schema: readonly ParquetSchemaColumn[];
  readonly types: readonly OutputColumnType[];
  /** For a list column, what to split the rendered cell on. */
  readonly separators: readonly (string | undefined)[];
  readonly count: number;
  readonly inject: string;
  readonly registry: ReturnType<typeof prepareRender>['registry'];
}

function plan(document: DocumentContext, options: RenderOptions): Plan {
  const declared = extractDeclaredColumns(document);
  if (declared.length === 0) {
    throw new Error(
      'Parquet output needs at least one named column — add name="…" to a <data> in the <block>',
    );
  }
  const { tdc, env, registry } = prepareRender(document, options);
  const specs = extractSequenceSpecs(findChildElement(tdc.content(), 'env'));
  // Resolution order: an explicit type= wins; otherwise ask the generator that
  // feeds the column; otherwise fall back to text. We never guess from values.
  const sources = declared.map((column) => soleReference(column.template, env.inject));
  const types = declared.map((column, i) => {
    if (column.type) return column.type;
    const source = sources[i];
    return (
      (source === undefined ? undefined : deriveOutputColumnType(source, specs)) ?? DEFAULT_TYPE
    );
  });
  // A declared []T needs a separator too; fall back to the default comma when
  // the column was typed by hand rather than derived from a repeating gen.
  const separators = types.map((type, i) => {
    if (!isListType(type)) return undefined;
    const source = sources[i];
    return (source === undefined ? undefined : repeatSeparatorOf(source, specs)) ?? ',';
  });
  const schema = declared.map((column, i) => ({
    name: column.name,
    type: types[i] ?? DEFAULT_TYPE,
  }));
  return { declared, schema, types, separators, count: env.count, inject: env.inject, registry };
}

/** Rows `[from, to)`, or the whole file when no range is given. */
export interface RowRange {
  readonly from: number;
  readonly to: number;
}

function* batches(p: Plan, range?: RowRange): Generator<ParquetBatch> {
  const first = range ? range.from : 0;
  const last = range ? Math.min(range.to, p.count) : p.count;
  for (let start = first; start < last; start += ROW_GROUP_ROWS) {
    const end = Math.min(start + ROW_GROUP_ROWS, last);
    const batch: ParquetCell[][] = p.declared.map(() => []);
    for (let row = start; row < end; row++) {
      p.declared.forEach((column, index) => {
        const text = interpolate(column.template, p.inject, row, p.registry);
        const type = p.types[index] ?? DEFAULT_TYPE;
        try {
          if (isListType(type)) {
            // An empty cell is an EMPTY LIST, not a list holding one blank —
            // "" split on "," would otherwise yield a phantom element.
            const sep = p.separators[index] ?? ',';
            batch[index]?.push(text === '' ? [] : text.split(sep));
          } else {
            batch[index]?.push(convertValue(text, type));
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`column "${column.name}", row ${String(row + 1)}: ${message}`);
        }
      });
    }
    yield batch;
  }
}

/** Stream the file as chunks — peak memory is one row group. */
export function* renderParquetChunks(
  document: DocumentContext,
  options: RenderOptions = {},
): Generator<Uint8Array> {
  const p = plan(document, options);
  yield* writeParquetChunks(p.schema, batches(p));
}

/** The whole file in memory. Convenient for small outputs and tests. */
export function renderParquet(document: DocumentContext, options: RenderOptions = {}): Uint8Array {
  const parts = [...renderParquetChunks(document, options)];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The resolved schema, for showing the user what types were chosen. */
export function parquetSchemaOf(
  document: DocumentContext,
  options: RenderOptions = {},
): readonly ParquetSchemaColumn[] {
  return plan(document, options).schema;
}

/**
 * The row groups for a slice of the file, each ready to be placed anywhere.
 *
 * `range` MUST start and end on a row-group boundary, or the groups would be
 * cut differently than a single-threaded run cuts them and the outputs would
 * stop matching. `parquetRowGroupCount` gives the boundaries.
 */
export function* renderParquetBlocks(
  document: DocumentContext,
  options: RenderOptions = {},
  range?: RowRange,
): Generator<RowGroupBlock> {
  const p = plan(document, options);
  yield* rowGroupBlocks(p.schema, batches(p, range));
}

/** How many row groups the file will hold — the unit of parallel work. */
export function parquetRowGroupCount(
  document: DocumentContext,
  options: RenderOptions = {},
): number {
  return Math.ceil(plan(document, options).count / ROW_GROUP_ROWS);
}
