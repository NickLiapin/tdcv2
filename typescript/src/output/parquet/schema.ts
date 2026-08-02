/**
 * Mapping our column types onto Parquet's two-layer type system: a PHYSICAL type
 * that carries the bytes, plus an optional LOGICAL annotation that says how to
 * read them. This is why extra types are cheap — `date` is just an INT32 wearing
 * a label.
 *
 * We write both the modern `logicalType` and the legacy `converted_type`, since
 * readers in the wild still consult either one.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §2.
 */

import type { ColumnType } from '../column-type.js';

/** parquet.thrift `Type` */
export const PhysicalType = {
  BOOLEAN: 0,
  INT32: 1,
  INT64: 2,
  INT96: 3,
  FLOAT: 4,
  DOUBLE: 5,
  BYTE_ARRAY: 6,
  FIXED_LEN_BYTE_ARRAY: 7,
} as const;
export type PhysicalType = (typeof PhysicalType)[keyof typeof PhysicalType];

/** parquet.thrift `FieldRepetitionType` */
export const Repetition = { REQUIRED: 0, OPTIONAL: 1, REPEATED: 2 } as const;

/** parquet.thrift `Encoding` */
export const Encoding = {
  PLAIN: 0,
  RLE: 3,
  /** Dictionary INDICES on a data page. The dictionary page itself is PLAIN. */
  RLE_DICTIONARY: 8,
} as const;

/** parquet.thrift `CompressionCodec` */
export const Codec = { UNCOMPRESSED: 0, SNAPPY: 1 } as const;

/** parquet.thrift `PageType` */
export const PageType = { DATA_PAGE: 0, DICTIONARY_PAGE: 2 } as const;

/** parquet.thrift `ConvertedType` (legacy annotation) */
export const ConvertedType = {
  UTF8: 0,
  LIST: 3,
  ENUM: 4,
  UINT_8: 11,
  UINT_16: 12,
  UINT_32: 13,
  UINT_64: 14,
  DECIMAL: 5,
  DATE: 6,
  TIMESTAMP_MILLIS: 9,
  JSON: 19,
} as const;

/** Field id of the logical-type variant inside parquet.thrift `LogicalType`. */
export const LogicalTypeField = {
  STRING: 1,
  /** NOTE: 3 in the LogicalType union; ConvertedType.LIST is also 3, but the
   *  two enums are unrelated — 4 here would be ENUM. */
  LIST: 3,
  DECIMAL: 5,
  DATE: 6,
  TIMESTAMP: 8,
  JSON: 12,
  UUID: 14,
  FLOAT16: 15,
  ENUM: 4,
  INTEGER: 10,
} as const;

/** `LogicalType.IntType` needs both the width and the signedness. */
function unsignedMapping(
  bitWidth: number,
  physical: PhysicalType,
  convertedType: number,
): ParquetTypeMapping {
  return {
    physical,
    convertedType,
    logicalField: LogicalTypeField.INTEGER,
    bitWidth,
    isSigned: false,
  };
}

export interface ParquetTypeMapping {
  readonly physical: PhysicalType;
  /** Only for FIXED_LEN_BYTE_ARRAY. */
  readonly typeLength?: number;
  readonly convertedType?: number;
  /** Which variant of the LogicalType union to emit, if any. */
  readonly logicalField?: number;
  readonly precision?: number;
  readonly scale?: number;
  /** INTEGER only: declared width. */
  readonly bitWidth?: number;
  /** INTEGER only: false for the unsigned kinds. */
  readonly isSigned?: boolean;
}

/** Physical + annotation for a declared column type. */
export function mapColumnType(type: ColumnType): ParquetTypeMapping {
  switch (type.kind) {
    case 'bool':
      return { physical: PhysicalType.BOOLEAN };
    case 'int32':
      return { physical: PhysicalType.INT32 };
    case 'int64':
      return { physical: PhysicalType.INT64 };
    // Unsigned integers ride in the same signed physical slot; the annotation
    // is what stops a reader from calling 2^63 negative.
    case 'uint8':
      return unsignedMapping(8, PhysicalType.INT32, ConvertedType.UINT_8);
    case 'uint16':
      return unsignedMapping(16, PhysicalType.INT32, ConvertedType.UINT_16);
    case 'uint32':
      return unsignedMapping(32, PhysicalType.INT32, ConvertedType.UINT_32);
    case 'uint64':
      return unsignedMapping(64, PhysicalType.INT64, ConvertedType.UINT_64);
    case 'float':
      return { physical: PhysicalType.FLOAT };
    case 'float16':
      return {
        physical: PhysicalType.FIXED_LEN_BYTE_ARRAY,
        typeLength: 2,
        logicalField: LogicalTypeField.FLOAT16,
      };
    case 'double':
      return { physical: PhysicalType.DOUBLE };
    case 'enum':
      return {
        physical: PhysicalType.BYTE_ARRAY,
        convertedType: ConvertedType.ENUM,
        logicalField: LogicalTypeField.ENUM,
      };
    case 'string':
      return {
        physical: PhysicalType.BYTE_ARRAY,
        convertedType: ConvertedType.UTF8,
        logicalField: LogicalTypeField.STRING,
      };
    case 'json':
      return {
        physical: PhysicalType.BYTE_ARRAY,
        convertedType: ConvertedType.JSON,
        logicalField: LogicalTypeField.JSON,
      };
    case 'date':
      return {
        physical: PhysicalType.INT32,
        convertedType: ConvertedType.DATE,
        logicalField: LogicalTypeField.DATE,
      };
    case 'timestamp':
      return {
        physical: PhysicalType.INT64,
        convertedType: ConvertedType.TIMESTAMP_MILLIS,
        logicalField: LogicalTypeField.TIMESTAMP,
      };
    case 'decimal':
      return {
        physical: PhysicalType.INT64,
        convertedType: ConvertedType.DECIMAL,
        logicalField: LogicalTypeField.DECIMAL,
        precision: type.precision ?? 18,
        scale: type.scale ?? 0,
      };
    case 'uuid':
      return {
        physical: PhysicalType.FIXED_LEN_BYTE_ARRAY,
        typeLength: 16,
        logicalField: LogicalTypeField.UUID,
      };
  }
}
