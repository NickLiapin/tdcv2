package io.github.nickliapin.tdc.output.parquet;

import io.github.nickliapin.tdc.output.ColumnType;

/**
 * Our column types mapped onto Parquet's two layers: a PHYSICAL type that carries the bytes, plus
 * an optional LOGICAL annotation saying how to read them.
 *
 * <p>That split is why extra types are cheap — a date is an int32 wearing a label, and a UUID is
 * sixteen bytes wearing another. Both the modern logical type and the legacy converted type are
 * written, because readers in the wild still consult either one.
 */
public final class Schema {

  /** parquet.thrift {@code Type}. */
  public static final int BOOLEAN = 0;

  public static final int INT32 = 1;
  public static final int INT64 = 2;
  public static final int INT96 = 3;
  public static final int FLOAT = 4;
  public static final int DOUBLE = 5;
  public static final int BYTE_ARRAY = 6;
  public static final int FIXED_LEN_BYTE_ARRAY = 7;

  /** parquet.thrift {@code FieldRepetitionType}. */
  public static final int REQUIRED = 0;

  public static final int OPTIONAL = 1;
  public static final int REPEATED = 2;

  /** parquet.thrift {@code Encoding}. */
  public static final int PLAIN = 0;

  public static final int RLE = 3;

  /** Dictionary INDICES on a data page; the dictionary page itself is PLAIN. */
  public static final int RLE_DICTIONARY = 8;

  /** parquet.thrift {@code CompressionCodec}. */
  public static final int UNCOMPRESSED = 0;

  public static final int SNAPPY = 1;

  /** parquet.thrift {@code PageType}. */
  public static final int DATA_PAGE = 0;

  public static final int DICTIONARY_PAGE = 2;

  /** parquet.thrift {@code ConvertedType} — the legacy annotation. */
  public static final int CT_UTF8 = 0;

  public static final int CT_LIST = 3;
  public static final int CT_ENUM = 4;
  public static final int CT_DECIMAL = 5;
  public static final int CT_DATE = 6;
  public static final int CT_TIMESTAMP_MILLIS = 9;
  public static final int CT_UINT_8 = 11;
  public static final int CT_UINT_16 = 12;
  public static final int CT_UINT_32 = 13;
  public static final int CT_UINT_64 = 14;
  public static final int CT_JSON = 19;

  /** Field id of the variant inside parquet.thrift's {@code LogicalType} union. */
  public static final int LT_STRING = 1;

  /**
   * Three in the LogicalType union. ConvertedType.LIST is also three, but the two enums are
   * unrelated — four here would mean ENUM.
   */
  public static final int LT_LIST = 3;

  public static final int LT_ENUM = 4;
  public static final int LT_DECIMAL = 5;
  public static final int LT_DATE = 6;
  public static final int LT_TIMESTAMP = 8;
  public static final int LT_INTEGER = 10;
  public static final int LT_JSON = 12;
  public static final int LT_UUID = 14;
  public static final int LT_FLOAT16 = 15;

  /** Nothing here has a sensible zero, so absence is spelled out. */
  public static final int NONE = -1;

  /** How one declared type becomes bytes on disk, and what tells a reader to trust them. */
  public record Mapping(
      int physical,
      int typeLength,
      int convertedType,
      int logicalField,
      int precision,
      int scale,
      int bitWidth,
      boolean signed) {}

  private Schema() {}

  /** Physical type plus annotation for a declared column type. */
  public static Mapping map(ColumnType type) {
    switch (type.kind()) {
      case BOOL:
        return simple(BOOLEAN);
      case INT32:
        return simple(INT32);
      case INT64:
        return simple(INT64);
      // Unsigned integers ride in the same signed physical slot; the annotation is the only
      // thing stopping a reader from calling a large value negative.
      case UINT8:
        return unsigned(8, INT32, CT_UINT_8);
      case UINT16:
        return unsigned(16, INT32, CT_UINT_16);
      case UINT32:
        return unsigned(32, INT32, CT_UINT_32);
      case UINT64:
        return unsigned(64, INT64, CT_UINT_64);
      case FLOAT:
        return simple(FLOAT);
      case FLOAT16:
        return new Mapping(FIXED_LEN_BYTE_ARRAY, 2, NONE, LT_FLOAT16, 0, 0, 0, true);
      case DOUBLE:
        return simple(DOUBLE);
      case ENUM:
        return new Mapping(BYTE_ARRAY, 0, CT_ENUM, LT_ENUM, 0, 0, 0, true);
      case STRING:
        return new Mapping(BYTE_ARRAY, 0, CT_UTF8, LT_STRING, 0, 0, 0, true);
      case JSON:
        return new Mapping(BYTE_ARRAY, 0, CT_JSON, LT_JSON, 0, 0, 0, true);
      case DATE:
        return new Mapping(INT32, 0, CT_DATE, LT_DATE, 0, 0, 0, true);
      case TIMESTAMP:
        return new Mapping(INT64, 0, CT_TIMESTAMP_MILLIS, LT_TIMESTAMP, 0, 0, 0, true);
      case DECIMAL:
        return new Mapping(
            INT64, 0, CT_DECIMAL, LT_DECIMAL, type.precision(), type.scale(), 0, true);
      case UUID:
        return new Mapping(FIXED_LEN_BYTE_ARRAY, 16, NONE, LT_UUID, 0, 0, 0, true);
      default:
        throw new IllegalArgumentException("no Parquet mapping for " + type);
    }
  }

  private static Mapping simple(int physical) {
    return new Mapping(physical, 0, NONE, NONE, 0, 0, 0, true);
  }

  private static Mapping unsigned(int bitWidth, int physical, int convertedType) {
    return new Mapping(physical, 0, convertedType, LT_INTEGER, 0, 0, bitWidth, false);
  }
}
