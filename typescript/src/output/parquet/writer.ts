/**
 * Assemble a Parquet file from typed columns.
 *
 * Layout: `PAR1`, one data page per column, the Thrift-encoded `FileMetaData`
 * footer, the footer length, `PAR1` again. v1 is deliberately plain — PLAIN
 * encoding, no compression, one row group — which is valid everywhere and keeps
 * the bytes deterministic, so every language port can produce the same file.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §6-7.
 */

import {
  isListType,
  isMapType,
  type ColumnType,
  type MapColumnType,
  type OutputColumnType,
} from '../column-type.js';
import { buildMapLevels, MAP_KEY_MAX_DEF, type MapEntry } from './map.js';
import { convertValue } from './convert.js';
import { buildListLevels, levelBitWidth } from './list.js';
import { computeStatistics, type ColumnStatistics } from './statistics.js';
import { buildDictionary } from './dictionary.js';
import { dictionaryBitWidth, encodeDictionaryIndices } from './rle.js';
import { snappyCompress } from './snappy.js';

import { encodeLevels } from './levels.js';
import {
  plainBoolean,
  plainByteArray,
  plainDouble,
  plainFixed,
  plainFloat,
  plainFloat16,
  plainInt32,
  plainInt64,
} from './plain.js';
import {
  Codec,
  ConvertedType,
  Encoding,
  LogicalTypeField,
  mapColumnType,
  PageType,
  Repetition,
  type ParquetTypeMapping,
} from './schema.js';
import { CompactType, CompactWriter } from './thrift.js';
import type { TypedValue } from './convert.js';

/** Fixed so the bytes never depend on a version, a clock or the language port. */
const CREATED_BY = 'TDC';
const MAGIC = Uint8Array.from([0x50, 0x41, 0x52, 0x31]); // "PAR1"

/** A column's identity — everything the schema needs, without the data. */
export interface ParquetSchemaColumn {
  readonly name: string;
  readonly type: OutputColumnType;
}

/**
 * One cell. A scalar column holds a converted value; a LIST column holds the
 * row's raw element texts, and a MAP its raw pairs, because the definition
 * levels have to be decided (which entries are NULL) before anything is
 * converted.
 */
export type ParquetCell = TypedValue | readonly string[] | readonly MapEntry[];

export interface ParquetColumn extends ParquetSchemaColumn {
  /** One entry per ROW. */
  readonly values: readonly ParquetCell[];
}

export interface ChunkMeta {
  /** Where the chunk begins — the dictionary page when there is one. */
  readonly offset: number;
  /** Where the DATA page begins, which is past the dictionary. */
  readonly dataOffset: number;
  /** Set only when this chunk carries a dictionary page. */
  readonly dictionaryOffset?: number;
  /** Bytes actually written — compressed. */
  readonly totalSize: number;
  /** What those bytes would have been uncompressed, for the footer. */
  readonly rawSize: number;
  /** Whichever codec actually saved bytes for this chunk. */
  readonly codec: number;
  /** Level slots, NOT rows — for a list they differ. */
  readonly numValues: number;
  readonly statistics: ColumnStatistics;
  /**
   * Which LEAF this chunk is, spelled as the reader addresses it.
   *
   * A scalar column is one leaf and one chunk; a list is one leaf under a
   * wrapper; a MAP is TWO — the key and the value — under one declared name.
   * The footer used to read the physical type and the path off the column,
   * which quietly assumed the first of those three.
   */
  readonly path: readonly string[];
  readonly physicalType: ColumnType;
  /** Whether the leaf carries level streams, which decides if RLE is declared. */
  readonly hasLevels: boolean;
}

/**
 * The leaf type that actually carries bytes: the element type for a list, the
 * VALUE type for a map — the key's leaf is described where it is built, because
 * it is always text and never the declared type.
 */
function leafType(type: OutputColumnType): ColumnType {
  if (isListType(type)) return type.element;
  if (isMapType(type)) return type.value;
  return type;
}

function encodeValues(type: ColumnType, present: readonly TypedValue[]): Uint8Array {
  switch (type.kind) {
    case 'bool':
      return plainBoolean(present as boolean[]);
    case 'int32':
    case 'date':
    case 'uint8':
    case 'uint16':
    case 'uint32':
      return plainInt32(present as number[]);
    case 'int64':
    case 'timestamp':
    case 'decimal':
    case 'uint64':
      return plainInt64(present as bigint[]);
    case 'float':
      return plainFloat(present as number[]);
    case 'float16':
      return plainFloat16(present as number[]);
    case 'double':
      return plainDouble(present as number[]);
    case 'string':
    case 'enum':
    case 'json':
      return plainByteArray(present as string[]);
    case 'uuid':
      return plainFixed(present as Uint8Array[]);
  }
}

/** Length-prefixed level block, as the page body expects it. */
function levelBlock(levels: readonly number[], maxLevel: number): Uint8Array {
  const rle = encodeLevels(levels, levelBitWidth(maxLevel));
  const out = new Uint8Array(4 + rle.length);
  new DataView(out.buffer).setUint32(0, rle.length, true);
  out.set(rle, 4);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Page body plus the number of LEVEL SLOTS it describes.
 *
 * Scalar: `[values]`, or `[def][values]` when nullable — one slot per row.
 * List: `[rep][def][values]`, repetition first as parquet.thrift mandates, and
 * the slot count is the number of elements (an empty list still costs one).
 */
/**
 * Encode the VALUES of a chunk: either PLAIN, or — when the data repeats
 * enough to pay for it — a dictionary page plus RLE-packed indices.
 */
function encodeValueSection(
  type: ColumnType,
  present: readonly TypedValue[],
): {
  values: Uint8Array;
  dictionaryBody?: Uint8Array;
  dictionaryCount?: number;
  encoding: number;
} {
  const dictionary = buildDictionary(type, present);
  if (!dictionary) {
    return { values: encodeValues(type, present), encoding: Encoding.PLAIN };
  }
  const body = encodeValues(type, dictionary.values);
  return {
    values: encodeDictionaryIndices(
      dictionary.indices,
      dictionaryBitWidth(dictionary.values.length),
    ),
    dictionaryBody: body,
    dictionaryCount: dictionary.values.length,
    encoding: Encoding.RLE_DICTIONARY,
  };
}

/** One leaf's page: the bytes, and what the footer has to say about them. */
interface LeafPage {
  body: Uint8Array;
  numValues: number;
  statistics: ColumnStatistics;
  dictionaryBody?: Uint8Array;
  dictionaryCount?: number;
  encoding: number;
  path: readonly string[];
  physicalType: ColumnType;
  hasLevels: boolean;
}

/**
 * The leaves one declared column becomes: one for a scalar or a list, TWO for a
 * map — its key and its value, which are separate columns in the file and share
 * only their repetition levels.
 */
function encodeColumnLeaves(column: ParquetColumn): LeafPage[] {
  if (isMapType(column.type)) return encodeMapLeaves(column, column.type);
  const single = encodePageBody(column);
  return [
    {
      ...single,
      path: isListType(column.type) ? [column.name, 'list', 'element'] : [column.name],
      physicalType: leafType(column.type),
      hasLevels: isListType(column.type) || column.type.nullable,
    },
  ];
}

/**
 * A map's two leaves. The KEY stream is required text; the VALUE stream carries
 * the column's declared type and may be optional. Both hold one level slot per
 * pair, and one for a row whose map is empty.
 */
function encodeMapLeaves(column: ParquetColumn, type: MapColumnType): LeafPage[] {
  const rows = column.values as readonly (readonly MapEntry[])[];
  const levels = buildMapLevels(rows, type.value.nullable);
  const keyType: ColumnType = { kind: 'string', nullable: false };

  const keyValues = levels.keys.map((text) => convertValue(text, keyType));
  const keySection = encodeValueSection(keyType, keyValues);
  const keyPage: LeafPage = {
    body: concat([
      levelBlock(levels.repLevels, 1),
      levelBlock(levels.keyDefLevels, MAP_KEY_MAX_DEF),
      keySection.values,
    ]),
    numValues: levels.repLevels.length,
    // The same rule a list follows: a "null" is any level slot that did not
    // reach the leaf. For the key leaf that is exactly the rows whose map is
    // empty — a key itself is never absent.
    statistics: computeStatistics(keyType, keyValues, levels.repLevels.length - keyValues.length),
    ...(keySection.dictionaryBody
      ? {
          dictionaryBody: keySection.dictionaryBody,
          dictionaryCount: keySection.dictionaryCount,
        }
      : {}),
    encoding: keySection.encoding,
    path: [column.name, 'key_value', 'key'],
    physicalType: keyType,
    hasLevels: true,
  };

  const converted = levels.present.map((text) => convertValue(text, type.value));
  const present = converted.filter((v) => v !== null);
  const valueSection = encodeValueSection(type.value, present);
  const valuePage: LeafPage = {
    body: concat([
      levelBlock(levels.repLevels, 1),
      levelBlock(levels.valueDefLevels, levels.maxValueDef),
      valueSection.values,
    ]),
    numValues: levels.repLevels.length,
    statistics: computeStatistics(type.value, present, levels.repLevels.length - present.length),
    ...(valueSection.dictionaryBody
      ? {
          dictionaryBody: valueSection.dictionaryBody,
          dictionaryCount: valueSection.dictionaryCount,
        }
      : {}),
    encoding: valueSection.encoding,
    path: [column.name, 'key_value', 'value'],
    physicalType: type.value,
    hasLevels: true,
  };

  return [keyPage, valuePage];
}

function encodePageBody(column: ParquetColumn): {
  body: Uint8Array;
  numValues: number;
  statistics: ColumnStatistics;
  dictionaryBody?: Uint8Array;
  dictionaryCount?: number;
  encoding: number;
} {
  // A map never reaches here — `encodeColumnLeaves` sends it to its own builder,
  // because one declared map is two leaves and this returns one page.
  if (isMapType(column.type)) throw new Error('a map column has two leaves, not one');
  if (!isListType(column.type)) {
    const cells = column.values as readonly TypedValue[];
    const present = cells.filter((v) => v !== null);
    const { values, dictionaryBody, dictionaryCount, encoding } = encodeValueSection(
      column.type,
      present,
    );
    const statistics = computeStatistics(column.type, present, cells.length - present.length);
    const head = {
      numValues: cells.length,
      statistics,
      encoding,
      ...(dictionaryBody ? { dictionaryBody, dictionaryCount } : {}),
    };
    if (!column.type.nullable) return { body: values, ...head };
    const def = levelBlock(
      cells.map((v) => (v === null ? 0 : 1)),
      1,
    );
    return { body: concat([def, values]), ...head };
  }

  const element = column.type.element;
  const rows = column.values as readonly (readonly string[])[];
  const levels = buildListLevels(rows, element.nullable);
  const converted = levels.present.map((text) => convertValue(text, element));
  const present = converted.filter((v) => v !== null);
  const { values, dictionaryBody, dictionaryCount, encoding } = encodeValueSection(
    element,
    present,
  );
  return {
    body: concat([
      levelBlock(levels.repLevels, levels.maxRep),
      levelBlock(levels.defLevels, levels.maxDef),
      values,
    ]),
    numValues: levels.repLevels.length,
    // For a list a "null" is any level slot that did not reach the leaf —
    // an absent element, or an empty list.
    statistics: computeStatistics(element, present, levels.repLevels.length - present.length),
    encoding,
    ...(dictionaryBody ? { dictionaryBody, dictionaryCount } : {}),
  };
}

function pageHeader(
  rawSize: number,
  compressedSize: number,
  numValues: number,
  encoding: number,
): Uint8Array {
  const w = new CompactWriter();
  w.structBegin();
  w.i32(1, PageType.DATA_PAGE);
  w.i32(2, rawSize); // uncompressed_page_size
  w.i32(3, compressedSize); // compressed_page_size
  w.fieldBegin(5, CompactType.STRUCT); // data_page_header
  w.structBegin();
  w.i32(1, numValues);
  w.i32(2, encoding); // PLAIN, or RLE_DICTIONARY when indices follow
  w.i32(3, Encoding.RLE); // definition levels
  w.i32(4, Encoding.RLE); // repetition levels (unused for a flat column)
  w.structEnd();
  w.structEnd();
  return w.bytes();
}

/**
 * The dictionary page's header. Its own encoding is PLAIN — the modern pairing
 * with an RLE_DICTIONARY data page. (The legacy pairing put PLAIN_DICTIONARY on
 * both, which recent readers accept but no longer produce.)
 */
function dictionaryPageHeader(
  rawSize: number,
  compressedSize: number,
  numValues: number,
): Uint8Array {
  const w = new CompactWriter();
  w.structBegin();
  w.i32(1, PageType.DICTIONARY_PAGE);
  w.i32(2, rawSize);
  w.i32(3, compressedSize);
  w.fieldBegin(7, CompactType.STRUCT); // dictionary_page_header
  w.structBegin();
  w.i32(1, numValues);
  w.i32(2, Encoding.PLAIN);
  w.structEnd();
  w.structEnd();
  return w.bytes();
}

/** The LogicalType union — exactly one variant field is set. */
function writeLogicalType(w: CompactWriter, map: ParquetTypeMapping): void {
  if (map.logicalField === undefined) return;
  w.fieldBegin(10, CompactType.STRUCT);
  w.structBegin();
  w.fieldBegin(map.logicalField, CompactType.STRUCT);
  w.structBegin();
  if (map.logicalField === LogicalTypeField.DECIMAL) {
    w.i32(1, map.scale ?? 0);
    w.i32(2, map.precision ?? 18);
  } else if (map.logicalField === LogicalTypeField.INTEGER) {
    w.i8(1, map.bitWidth ?? 32);
    w.bool(2, map.isSigned ?? true);
  } else if (map.logicalField === LogicalTypeField.TIMESTAMP) {
    w.bool(1, true); // isAdjustedToUTC
    w.fieldBegin(2, CompactType.STRUCT); // TimeUnit union
    w.structBegin();
    w.fieldBegin(1, CompactType.STRUCT); // MILLIS
    w.structBegin();
    w.structEnd();
    w.structEnd();
  }
  w.structEnd();
  w.structEnd();
}

function writeSchema(w: CompactWriter, columns: readonly ParquetSchemaColumn[]): void {
  // Root + every SchemaElement: a list contributes three and a map four, not one.
  const elements = columns.reduce(
    (n, c) => n + (isListType(c.type) ? 3 : isMapType(c.type) ? 4 : 1),
    0,
  );
  w.listBegin(2, CompactType.STRUCT, elements + 1);

  // Root element: just a name and the child count.
  w.structBegin();
  w.string(4, 'schema');
  w.i32(5, columns.length);
  w.structEnd();

  for (const column of columns) {
    if (isListType(column.type)) {
      writeListSchema(w, column.name, column.type.element);
      continue;
    }
    if (isMapType(column.type)) {
      writeMapSchema(w, column.name, column.type.value);
      continue;
    }
    const map = mapColumnType(column.type);
    w.structBegin();
    w.i32(1, map.physical);
    if (map.typeLength !== undefined) w.i32(2, map.typeLength);
    w.i32(3, column.type.nullable ? Repetition.OPTIONAL : Repetition.REQUIRED);
    w.string(4, column.name);
    if (map.convertedType !== undefined) w.i32(6, map.convertedType);
    if (map.scale !== undefined) w.i32(7, map.scale);
    if (map.precision !== undefined) w.i32(8, map.precision);
    writeLogicalType(w, map);
    w.structEnd();
  }
}

/**
 * The three-element LIST wrapper. The names `list` and `element` are fixed by
 * the Parquet spec, not our choice; readers match on the annotated shape.
 *
 *     required group <name> (LIST) { repeated group list { … element } }
 */
function writeListSchema(w: CompactWriter, name: string, element: ColumnType): void {
  w.structBegin();
  w.i32(3, Repetition.REQUIRED);
  w.string(4, name);
  w.i32(5, 1); // num_children
  w.i32(6, ConvertedType.LIST);
  w.fieldBegin(10, CompactType.STRUCT); // logicalType
  w.structBegin();
  w.fieldBegin(LogicalTypeField.LIST, CompactType.STRUCT);
  w.structBegin();
  w.structEnd();
  w.structEnd();
  w.structEnd();

  w.structBegin();
  w.i32(3, Repetition.REPEATED);
  w.string(4, 'list');
  w.i32(5, 1); // num_children
  w.structEnd();

  const map = mapColumnType(element);
  w.structBegin();
  w.i32(1, map.physical);
  if (map.typeLength !== undefined) w.i32(2, map.typeLength);
  w.i32(3, element.nullable ? Repetition.OPTIONAL : Repetition.REQUIRED);
  w.string(4, 'element');
  if (map.convertedType !== undefined) w.i32(6, map.convertedType);
  if (map.scale !== undefined) w.i32(7, map.scale);
  if (map.precision !== undefined) w.i32(8, map.precision);
  writeLogicalType(w, map);
  w.structEnd();
}

/**
 * The four-element MAP wrapper. The names `key_value`, `key` and `value` are
 * fixed by the Parquet spec, not our choice; readers match on the annotated
 * shape and quietly mis-assemble anything else.
 *
 *     required group <name> (MAP) {
 *         repeated group key_value {
 *             required BYTE_ARRAY key (STRING);
 *             required|optional <physical> value;
 *         }
 *     }
 *
 * The key is REQUIRED because the format says so: a pair with no key is not a
 * pair, and a reader given an optional key has no way to index it.
 */
function writeMapSchema(w: CompactWriter, name: string, value: ColumnType): void {
  w.structBegin();
  w.i32(3, Repetition.REQUIRED);
  w.string(4, name);
  w.i32(5, 1); // num_children
  w.i32(6, ConvertedType.MAP);
  w.fieldBegin(10, CompactType.STRUCT); // logicalType
  w.structBegin();
  w.fieldBegin(LogicalTypeField.MAP, CompactType.STRUCT);
  w.structBegin();
  w.structEnd();
  w.structEnd();
  w.structEnd();

  w.structBegin();
  w.i32(3, Repetition.REPEATED);
  w.string(4, 'key_value');
  w.i32(5, 2); // num_children — the key and the value
  w.structEnd();

  const keyMapping = mapColumnType({ kind: 'string', nullable: false });
  w.structBegin();
  w.i32(1, keyMapping.physical);
  w.i32(3, Repetition.REQUIRED);
  w.string(4, 'key');
  if (keyMapping.convertedType !== undefined) w.i32(6, keyMapping.convertedType);
  writeLogicalType(w, keyMapping);
  w.structEnd();

  const valueMapping = mapColumnType(value);
  w.structBegin();
  w.i32(1, valueMapping.physical);
  if (valueMapping.typeLength !== undefined) w.i32(2, valueMapping.typeLength);
  w.i32(3, value.nullable ? Repetition.OPTIONAL : Repetition.REQUIRED);
  w.string(4, 'value');
  if (valueMapping.convertedType !== undefined) w.i32(6, valueMapping.convertedType);
  if (valueMapping.scale !== undefined) w.i32(7, valueMapping.scale);
  if (valueMapping.precision !== undefined) w.i32(8, valueMapping.precision);
  writeLogicalType(w, valueMapping);
  w.structEnd();
}

/**
 * parquet.thrift `Statistics`, field 12 of ColumnMetaData.
 *
 * Only `null_count` (3), `max_value` (5) and `min_value` (6) — NOT the
 * deprecated `max`/`min` (1/2), whose signedness readers historically
 * disagreed about. A bound a reader may misinterpret is as dangerous as a
 * bound that is simply wrong.
 */
function writeStatistics(w: CompactWriter, stats: ColumnStatistics): void {
  w.fieldBegin(12, CompactType.STRUCT);
  w.structBegin();
  w.i64(3, stats.nullCount);
  if (stats.maxValue) w.binary(5, stats.maxValue);
  if (stats.minValue) w.binary(6, stats.minValue);
  w.structEnd();
}

export interface GroupMeta {
  readonly chunks: readonly ChunkMeta[];
  readonly numRows: number;
}

function writeRowGroups(
  w: CompactWriter,
  columns: readonly ParquetSchemaColumn[],
  groups: readonly GroupMeta[],
): void {
  w.listBegin(4, CompactType.STRUCT, groups.length);
  for (const group of groups) {
    w.structBegin();
    w.listBegin(1, CompactType.STRUCT, group.chunks.length); // columns
    group.chunks.forEach((chunk) => {
      const map = mapColumnType(chunk.physicalType);
      const dictionaried = chunk.dictionaryOffset !== undefined;
      w.structBegin();
      w.i64(2, chunk.offset); // file_offset — the dictionary page when present
      w.fieldBegin(3, CompactType.STRUCT); // meta_data
      w.structBegin();
      w.i32(1, map.physical);
      // PLAIN always appears: it is how the dictionary page itself is written,
      // and how the values are written when there is no dictionary. A list
      // always carries levels, so RLE is always among its encodings too.
      const encodings: number[] = [Encoding.PLAIN];
      if (chunk.hasLevels) encodings.push(Encoding.RLE);
      if (dictionaried) encodings.push(Encoding.RLE_DICTIONARY);
      w.listBegin(2, CompactType.I32, encodings.length);
      for (const e of encodings) w.listI32(e);
      // The chunk addresses the LEAF, so a list's path walks the wrapper and a
      // map's names which of its two columns this is.
      w.listBegin(3, CompactType.BINARY, chunk.path.length); // path_in_schema
      for (const segment of chunk.path) w.listString(segment);
      w.i32(4, chunk.codec);
      w.i64(5, chunk.numValues);
      w.i64(6, chunk.rawSize); // total_uncompressed_size
      w.i64(7, chunk.totalSize); // total_compressed_size
      w.i64(9, chunk.dataOffset); // data_page_offset
      // Field 11 must be written between 9 and 12: compact protocol encodes
      // field ids as ascending deltas.
      if (chunk.dictionaryOffset !== undefined) w.i64(11, chunk.dictionaryOffset);
      writeStatistics(w, chunk.statistics);
      w.structEnd();
      w.structEnd();
    });
    w.i64(
      2,
      group.chunks.reduce((sum, c) => sum + c.totalSize, 0),
    ); // total_byte_size
    w.i64(3, group.numRows);
    w.structEnd();
  }
}

/** One row group's worth of values: `batch[columnIndex][row]`. */
export type ParquetBatch = readonly (readonly ParquetCell[])[];

/**
 * Emit a `.parquet` file as a sequence of chunks. Each batch becomes one ROW
 * GROUP, written and released before the next arrives, so peak memory is one
 * batch — not the whole dataset. Only the (small) per-group metadata is kept,
 * because the footer must be written last.
 */
/**
 * One row group, encoded and ready to place anywhere in a file.
 *
 * This is the unit that makes parallel writing possible: a group's BYTES do not
 * depend on where it sits, because page headers carry sizes and the only
 * offsets in the whole format live in the footer. So workers can each build
 * whole groups independently and a coordinator merely concatenates them and
 * fixes the offsets up at the end.
 *
 * `chunks` therefore carries offsets RELATIVE to the start of this block; the
 * caller shifts them once it knows where the block landed.
 */
export interface RowGroupBlock {
  readonly pages: Uint8Array[];
  readonly chunks: ChunkMeta[];
  readonly numRows: number;
  readonly byteLength: number;
}

/** Encode each batch into a position-independent row group. */
export function* rowGroupBlocks(
  columns: readonly ParquetSchemaColumn[],
  batches: Iterable<ParquetBatch>,
): Generator<RowGroupBlock> {
  for (const batch of batches) {
    const rowsInGroup = batch[0]?.length ?? 0;
    if (rowsInGroup === 0) continue;

    const pages: Uint8Array[] = [];
    const chunks: ChunkMeta[] = [];
    let at = 0;

    // Leaves, not columns: a map is two of them under one declared name, and
    // each gets its own chunk.
    const leaves = columns.flatMap((column, i) =>
      encodeColumnLeaves({ ...column, values: batch[i] ?? [] }),
    );

    for (const leaf of leaves) {
      const { body, numValues, statistics, dictionaryBody, dictionaryCount, encoding } = leaf;

      // The codec is declared per COLUMN CHUNK, so the choice is made once for
      // the whole chunk — and only taken when it actually saves bytes. Snappy
      // adds a few bytes of framing, which on an already-tiny dictionary page
      // makes the "compressed" form the larger one.
      const squeezedData = snappyCompress(body);
      const squeezedDict = dictionaryBody ? snappyCompress(dictionaryBody) : undefined;
      const rawTotal = body.length + (dictionaryBody?.length ?? 0);
      const squeezedTotal = squeezedData.length + (squeezedDict?.length ?? 0);
      const compress = squeezedTotal < rawTotal;

      const dataBody = compress ? squeezedData : body;
      const dictPayload = compress ? squeezedDict : dictionaryBody;
      const dictPage =
        dictionaryBody && dictPayload
          ? concat([
              dictionaryPageHeader(dictionaryBody.length, dictPayload.length, dictionaryCount ?? 0),
              dictPayload,
            ])
          : undefined;

      const header = pageHeader(body.length, dataBody.length, numValues, encoding);
      const dictSize = dictPage?.length ?? 0;
      const written = dictSize + header.length + dataBody.length;
      chunks.push({
        offset: at,
        dataOffset: at + dictSize,
        ...(dictPage ? { dictionaryOffset: at } : {}),
        totalSize: written,
        rawSize: dictSize + header.length + body.length,
        codec: compress ? Codec.SNAPPY : Codec.UNCOMPRESSED,
        numValues,
        statistics,
        path: leaf.path,
        physicalType: leaf.physicalType,
        hasLevels: leaf.hasLevels,
      });
      if (dictPage) pages.push(dictPage);
      pages.push(header);
      pages.push(dataBody);
      at += written;
    }

    yield { pages, chunks, numRows: rowsInGroup, byteLength: at };
  }
}

/** Move a block's relative offsets to where the block actually landed. */
export function shiftChunks(chunks: readonly ChunkMeta[], by: number): ChunkMeta[] {
  return chunks.map((c) => ({
    ...c,
    offset: c.offset + by,
    dataOffset: c.dataOffset + by,
    ...(c.dictionaryOffset === undefined ? {} : { dictionaryOffset: c.dictionaryOffset + by }),
  }));
}

/**
 * `column_orders` — the field that makes the statistics USABLE.
 *
 * The spec is explicit: a reader must ignore `min_value`/`max_value` unless
 * `FileMetaData.column_orders` says the sort order is TypeDefinedOrder. Without
 * it the bounds are there in the bytes and no conforming reader may act on
 * them, so every row group is decoded in full — which is exactly what the
 * statistics exist to avoid. The values we wrote were correct; nothing was
 * allowed to read them.
 *
 * One entry per LEAF column, in schema order — the same order the row groups
 * list their chunks in. A scalar or a list is one leaf; a MAP is TWO, its key
 * and its value, so this is not the count of declared columns. Getting that
 * wrong is not a subtle bug: readers refuse the file outright with "not enough
 * ColumnOrder values", which is at least loud.
 *
 * `ColumnOrder` is a union whose only member, `TYPE_ORDER`, holds an EMPTY
 * struct, so each entry is three bytes: the union's field header, the empty
 * struct's stop byte, and the union's own stop byte.
 */
/** How many leaf columns the declared ones expand to: a map is two, the rest one. */
export function leafCount(columns: readonly ParquetSchemaColumn[]): number {
  return columns.reduce((n, column) => n + (isMapType(column.type) ? 2 : 1), 0);
}

function writeColumnOrders(w: CompactWriter, leaves: number): void {
  w.listBegin(7, CompactType.STRUCT, leaves);
  for (let i = 0; i < leaves; i++) {
    w.structBegin(); // ColumnOrder
    w.fieldBegin(1, CompactType.STRUCT); // TYPE_ORDER
    w.structBegin(); // TypeDefinedOrder {}
    w.structEnd();
    w.structEnd();
  }
}

/** The footer: schema, row-group directory, and the trailing length + magic. */
export function parquetFooter(
  columns: readonly ParquetSchemaColumn[],
  groups: readonly GroupMeta[],
  numRows: number,
): Uint8Array {
  const footer = new CompactWriter();
  footer.structBegin();
  footer.i32(1, 1); // version
  writeSchema(footer, columns);
  footer.i64(3, numRows);
  writeRowGroups(footer, columns, groups);
  footer.string(6, CREATED_BY);
  writeColumnOrders(footer, leafCount(columns));
  footer.structEnd();
  const bytes = footer.bytes();

  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concat([bytes, length, MAGIC]);
}

/** The four leading magic bytes; a file starts here. */
export const PARQUET_MAGIC = MAGIC;

export function* writeParquetChunks(
  columns: readonly ParquetSchemaColumn[],
  batches: Iterable<ParquetBatch>,
): Generator<Uint8Array> {
  yield MAGIC;
  let offset = MAGIC.length;
  const groups: GroupMeta[] = [];
  let numRows = 0;

  for (const block of rowGroupBlocks(columns, batches)) {
    for (const page of block.pages) yield page;
    groups.push({ chunks: shiftChunks(block.chunks, offset), numRows: block.numRows });
    offset += block.byteLength;
    numRows += block.numRows;
  }

  yield parquetFooter(columns, groups, numRows);
}

/** Build a complete `.parquet` file in memory (one row group). */
export function writeParquet(columns: readonly ParquetColumn[], _numRows?: number): Uint8Array {
  const schema = columns.map(({ name, type }) => ({ name, type }));
  const batch = columns.map((c) => c.values);
  const parts = [...writeParquetChunks(schema, [batch])];
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
