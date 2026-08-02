//! Our column types mapped onto Parquet's two layers: a PHYSICAL type that
//! carries the bytes, plus an optional LOGICAL annotation saying how to read
//! them.
//!
//! That split is why extra types are cheap — a date is an int32 wearing a label,
//! and a UUID is sixteen bytes wearing another. Both the modern logical type and
//! the legacy converted type are written, because readers in the wild still
//! consult either one.

use crate::output::column_type::{ColumnType, Kind};

/// parquet.thrift `Type`.
pub const BOOLEAN: i32 = 0;
pub const INT32: i32 = 1;
pub const INT64: i32 = 2;
pub const INT96: i32 = 3;
pub const FLOAT: i32 = 4;
pub const DOUBLE: i32 = 5;
pub const BYTE_ARRAY: i32 = 6;
pub const FIXED_LEN_BYTE_ARRAY: i32 = 7;

/// parquet.thrift `FieldRepetitionType`.
pub const REQUIRED: i32 = 0;
pub const OPTIONAL: i32 = 1;
pub const REPEATED: i32 = 2;

/// parquet.thrift `Encoding`.
pub const PLAIN_ENCODING: i32 = 0;
pub const RLE_ENCODING: i32 = 3;
/// Dictionary INDICES on a data page; the dictionary page itself is PLAIN.
pub const RLE_DICTIONARY: i32 = 8;

/// parquet.thrift `CompressionCodec`.
pub const UNCOMPRESSED: i32 = 0;
pub const SNAPPY_CODEC: i32 = 1;

/// parquet.thrift `PageType`.
pub const DATA_PAGE: i32 = 0;
pub const DICTIONARY_PAGE: i32 = 2;

/// parquet.thrift `ConvertedType` — the legacy annotation.
pub const CT_UTF8: i32 = 0;
pub const CT_LIST: i32 = 3;
pub const CT_ENUM: i32 = 4;
pub const CT_DECIMAL: i32 = 5;
pub const CT_DATE: i32 = 6;
pub const CT_TIMESTAMP_MILLIS: i32 = 9;
pub const CT_UINT8: i32 = 11;
pub const CT_UINT16: i32 = 12;
pub const CT_UINT32: i32 = 13;
pub const CT_UINT64: i32 = 14;
pub const CT_JSON: i32 = 19;

/// Field id of the variant inside parquet.thrift's `LogicalType` union.
pub const LT_STRING: i32 = 1;
/// Three in the LogicalType union. ConvertedType.LIST is also three, but the two
/// enums are unrelated — four here would mean ENUM.
pub const LT_LIST: i32 = 3;
pub const LT_ENUM: i32 = 4;
pub const LT_DECIMAL: i32 = 5;
pub const LT_DATE: i32 = 6;
pub const LT_TIMESTAMP: i32 = 8;
pub const LT_INTEGER: i32 = 10;
pub const LT_JSON: i32 = 12;
pub const LT_UUID: i32 = 14;
pub const LT_FLOAT16: i32 = 15;

/// Nothing here has a sensible zero, so absence is spelled out.
pub const NONE: i32 = -1;

/// How one declared type becomes bytes on disk, and what tells a reader to trust
/// them.
#[derive(Clone, Copy, Debug)]
pub struct Mapping {
    pub physical: i32,
    pub type_length: i32,
    pub converted_type: i32,
    pub logical_field: i32,
    pub precision: i32,
    pub scale: i32,
    pub bit_width: i32,
    pub signed: bool,
}

/// Physical type plus annotation for a declared column type.
pub fn map(ty: &ColumnType) -> Option<Mapping> {
    Some(match ty.kind {
        Kind::Bool => simple(BOOLEAN),
        Kind::Int32 => simple(INT32),
        Kind::Int64 => simple(INT64),
        // Unsigned integers ride in the same signed physical slot; the
        // annotation is the only thing stopping a reader from calling a large
        // value negative.
        Kind::UInt8 => unsigned(8, INT32, CT_UINT8),
        Kind::UInt16 => unsigned(16, INT32, CT_UINT16),
        Kind::UInt32 => unsigned(32, INT32, CT_UINT32),
        Kind::UInt64 => unsigned(64, INT64, CT_UINT64),
        Kind::Float => simple(FLOAT),
        Kind::Float16 => Mapping {
            physical: FIXED_LEN_BYTE_ARRAY,
            type_length: 2,
            converted_type: NONE,
            logical_field: LT_FLOAT16,
            ..simple(FIXED_LEN_BYTE_ARRAY)
        },
        Kind::Double => simple(DOUBLE),
        Kind::Enum => annotated(BYTE_ARRAY, CT_ENUM, LT_ENUM),
        Kind::String => annotated(BYTE_ARRAY, CT_UTF8, LT_STRING),
        Kind::Json => annotated(BYTE_ARRAY, CT_JSON, LT_JSON),
        Kind::Date => annotated(INT32, CT_DATE, LT_DATE),
        Kind::Timestamp => annotated(INT64, CT_TIMESTAMP_MILLIS, LT_TIMESTAMP),
        Kind::Decimal => Mapping {
            precision: ty.precision,
            scale: ty.scale,
            ..annotated(INT64, CT_DECIMAL, LT_DECIMAL)
        },
        Kind::Uuid => Mapping {
            type_length: 16,
            logical_field: LT_UUID,
            ..simple(FIXED_LEN_BYTE_ARRAY)
        },
        Kind::List => return None,
    })
}

fn simple(physical: i32) -> Mapping {
    Mapping {
        physical,
        type_length: 0,
        converted_type: NONE,
        logical_field: NONE,
        precision: 0,
        scale: 0,
        bit_width: 0,
        signed: true,
    }
}

fn annotated(physical: i32, converted_type: i32, logical_field: i32) -> Mapping {
    Mapping {
        converted_type,
        logical_field,
        ..simple(physical)
    }
}

fn unsigned(bit_width: i32, physical: i32, converted_type: i32) -> Mapping {
    Mapping {
        converted_type,
        logical_field: LT_INTEGER,
        bit_width,
        signed: false,
        ..simple(physical)
    }
}
