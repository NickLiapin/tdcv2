"""Our column types mapped onto Parquet's two layers.

A PHYSICAL type carries the bytes, plus an optional LOGICAL annotation saying how to read them.
That split is why extra types are cheap — a date is an int32 wearing a label, and a UUID is sixteen
bytes wearing another. Both the modern logical type and the legacy converted type are written,
because readers in the wild still consult either one.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..column_type import ColumnType, Kind

# parquet.thrift Type.
BOOLEAN = 0
INT32 = 1
INT64 = 2
INT96 = 3
FLOAT = 4
DOUBLE = 5
BYTE_ARRAY = 6
FIXED_LEN_BYTE_ARRAY = 7

# parquet.thrift FieldRepetitionType.
REQUIRED = 0
OPTIONAL = 1
REPEATED = 2

# parquet.thrift Encoding.
PLAIN = 0
RLE = 3
RLE_DICTIONARY = 8
"""Dictionary INDICES on a data page; the dictionary page itself is PLAIN."""

# parquet.thrift CompressionCodec.
UNCOMPRESSED = 0
SNAPPY = 1

# parquet.thrift PageType.
DATA_PAGE = 0
DICTIONARY_PAGE = 2

# parquet.thrift ConvertedType — the legacy annotation.
CT_UTF8 = 0
CT_LIST = 3
CT_ENUM = 4
CT_DECIMAL = 5
CT_DATE = 6
CT_TIMESTAMP_MILLIS = 9
CT_UINT_8 = 11
CT_UINT_16 = 12
CT_UINT_32 = 13
CT_UINT_64 = 14
CT_JSON = 19

# Field id of the variant inside parquet.thrift's LogicalType union.
LT_STRING = 1
LT_LIST = 3
"""Three in the LogicalType union. ConvertedType.LIST is also three, but the two enums are
unrelated — four here would mean ENUM."""
LT_ENUM = 4
LT_DECIMAL = 5
LT_DATE = 6
LT_TIMESTAMP = 8
LT_INTEGER = 10
LT_JSON = 12
LT_UUID = 14
LT_FLOAT16 = 15

# Nothing here has a sensible zero, so absence is spelled out.
NONE = -1


@dataclass(frozen=True, slots=True)
class Mapping:
    """How one declared type becomes bytes on disk, and what tells a reader to trust them."""

    physical: int
    type_length: int = 0
    converted_type: int = NONE
    logical_field: int = NONE
    precision: int = 0
    scale: int = 0
    bit_width: int = 0
    signed: bool = True


_SIMPLE = {
    Kind.BOOL: BOOLEAN,
    Kind.INT32: INT32,
    Kind.INT64: INT64,
    Kind.FLOAT: FLOAT,
    Kind.DOUBLE: DOUBLE,
}

# Unsigned integers ride in the same signed physical slot; the annotation is the only thing
# stopping a reader from calling a large value negative.
_UNSIGNED = {
    Kind.UINT8: (8, INT32, CT_UINT_8),
    Kind.UINT16: (16, INT32, CT_UINT_16),
    Kind.UINT32: (32, INT32, CT_UINT_32),
    Kind.UINT64: (64, INT64, CT_UINT_64),
}


def map_type(type_: ColumnType) -> Mapping:
    """The physical type plus annotation for a declared column type."""
    kind = type_.kind
    if kind in _SIMPLE:
        return Mapping(_SIMPLE[kind])
    if kind in _UNSIGNED:
        bit_width, physical, converted = _UNSIGNED[kind]
        return Mapping(physical, 0, converted, LT_INTEGER, 0, 0, bit_width, False)
    if kind is Kind.FLOAT16:
        return Mapping(FIXED_LEN_BYTE_ARRAY, 2, NONE, LT_FLOAT16)
    if kind is Kind.ENUM:
        return Mapping(BYTE_ARRAY, 0, CT_ENUM, LT_ENUM)
    if kind is Kind.STRING:
        return Mapping(BYTE_ARRAY, 0, CT_UTF8, LT_STRING)
    if kind is Kind.JSON:
        return Mapping(BYTE_ARRAY, 0, CT_JSON, LT_JSON)
    if kind is Kind.DATE:
        return Mapping(INT32, 0, CT_DATE, LT_DATE)
    if kind is Kind.TIMESTAMP:
        return Mapping(INT64, 0, CT_TIMESTAMP_MILLIS, LT_TIMESTAMP)
    if kind is Kind.DECIMAL:
        return Mapping(INT64, 0, CT_DECIMAL, LT_DECIMAL, type_.precision, type_.scale)
    if kind is Kind.UUID:
        return Mapping(FIXED_LEN_BYTE_ARRAY, 16, NONE, LT_UUID)
    raise ValueError(f"no Parquet mapping for {type_}")
