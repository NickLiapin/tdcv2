//! The min, the max and the NULL count of a column chunk.
//!
//! This is what lets a reader skip a whole row group: asked for `price > 500`, it
//! reads the chunk's maximum and moves on without decoding a byte. Cheap to
//! produce — every value is already in hand — and a large win for whoever queries
//! the file.
//!
//! The danger runs the other way from most features: wrong statistics are worse
//! than none. A maximum that is too low makes a reader skip a group that did
//! contain matching rows, and the query returns fewer results with no error and
//! no warning. So the comparisons here follow Parquet's declared sort orders
//! rather than the language's defaults — byte arrays compare as unsigned UTF-8
//! bytes, NaN never takes part in a bound, and the unsigned kinds are compared
//! unsigned even though they are stored in signed slots.
//!
//! Only `min_value`/`max_value` are written, never the deprecated `min`/`max`:
//! the old pair had ambiguous signedness that readers disagreed about, and
//! writing a field readers may misread is the same trap as writing a wrong bound.

use std::cmp::Ordering;

use super::convert::Value;
use super::plain;
use crate::output::column_type::{ColumnType, Kind};

/// PLAIN-encoded bounds; `None` when the chunk holds no non-NULL value at all.
pub struct Stats {
    pub min_value: Option<Vec<u8>>,
    pub max_value: Option<Vec<u8>>,
    pub null_count: i64,
}

/// Min, max and NULL count for one column chunk.
///
/// `null_count` is supplied by the caller because for a list column the NULLs
/// live in the definition levels rather than among the values.
pub fn compute(ty: &ColumnType, present: &[Option<Value>], null_count: i64) -> Stats {
    let mut min: Option<&Value> = None;
    let mut max: Option<&Value> = None;

    for value in present.iter().flatten() {
        if unusable(ty, value) {
            continue;
        }
        if min.is_none_or_greater(ty, value) {
            min = Some(value);
        }
        if max.is_none_or_less(ty, value) {
            max = Some(value);
        }
    }

    match (min, max) {
        (Some(min), Some(max)) => Stats {
            min_value: Some(encode_one(ty, min)),
            max_value: Some(encode_one(ty, max)),
            null_count,
        },
        _ => Stats {
            min_value: None,
            max_value: None,
            null_count,
        },
    }
}

/// Two small helpers so the loop above reads as the rule it implements.
trait Bound {
    fn is_none_or_greater(&self, ty: &ColumnType, candidate: &Value) -> bool;
    fn is_none_or_less(&self, ty: &ColumnType, candidate: &Value) -> bool;
}

impl Bound for Option<&Value> {
    fn is_none_or_greater(&self, ty: &ColumnType, candidate: &Value) -> bool {
        match self {
            None => true,
            Some(current) => compare(ty, candidate, current) == Ordering::Less,
        }
    }

    fn is_none_or_less(&self, ty: &ColumnType, candidate: &Value) -> bool {
        match self {
            None => true,
            Some(current) => compare(ty, candidate, current) == Ordering::Greater,
        }
    }
}

/// Unsigned byte-wise comparison — Parquet's sort order for a byte array.
pub fn compare_bytes(a: &[u8], b: &[u8]) -> Ordering {
    let shared = a.len().min(b.len());
    for i in 0..shared {
        if a[i] != b[i] {
            return a[i].cmp(&b[i]);
        }
    }
    a.len().cmp(&b.len())
}

/// PLAIN encoding of ONE value, as statistics store it — no length prefix.
fn encode_one(ty: &ColumnType, value: &Value) -> Vec<u8> {
    match (ty.kind, value) {
        (Kind::Bool, Value::Bool(v)) => vec![u8::from(*v)],
        (Kind::Int32 | Kind::Date | Kind::UInt8 | Kind::UInt16 | Kind::UInt32, Value::Int(v)) => {
            plain::int32(&[*v])
        }
        (Kind::Float, Value::Double(v)) => plain::floats(&[*v]),
        (Kind::Float16, Value::Double(v)) => plain::float16(&[*v]),
        (Kind::Int64 | Kind::Timestamp | Kind::Decimal | Kind::UInt64, Value::Long(v)) => {
            plain::int64(&[*v])
        }
        (Kind::Double, Value::Double(v)) => plain::doubles(&[*v]),
        (Kind::String | Kind::Enum | Kind::Json, Value::Text(v)) => v.as_bytes().to_vec(),
        (Kind::Uuid, Value::Bytes(v)) => v.clone(),
        _ => Vec::new(),
    }
}

/// Order two present values of this column type, following Parquet's rules for
/// it.
fn compare(ty: &ColumnType, a: &Value, b: &Value) -> Ordering {
    match (ty.kind, a, b) {
        (Kind::Bool, Value::Bool(x), Value::Bool(y)) => x.cmp(y),
        // The small unsigned kinds keep their true value in the signed slot.
        (Kind::Int32 | Kind::Date | Kind::UInt8 | Kind::UInt16, Value::Int(x), Value::Int(y)) => {
            x.cmp(y)
        }
        (Kind::Float | Kind::Float16 | Kind::Double, Value::Double(x), Value::Double(y)) => {
            if x.is_nan() || y.is_nan() {
                Ordering::Equal
            } else {
                x.partial_cmp(y).unwrap_or(Ordering::Equal)
            }
        }
        // Stored as wrapped signed bits, so compared unsigned — otherwise a value
        // above 2^31 would look smaller than one, and the bound would exclude
        // real rows.
        (Kind::UInt32, Value::Int(x), Value::Int(y)) => (*x as u32).cmp(&(*y as u32)),
        (Kind::UInt64, Value::Long(x), Value::Long(y)) => (*x as u64).cmp(&(*y as u64)),
        (Kind::Int64 | Kind::Timestamp | Kind::Decimal, Value::Long(x), Value::Long(y)) => x.cmp(y),
        (Kind::String | Kind::Enum | Kind::Json, Value::Text(x), Value::Text(y)) => {
            compare_bytes(x.as_bytes(), y.as_bytes())
        }
        (Kind::Uuid, Value::Bytes(x), Value::Bytes(y)) => compare_bytes(x, y),
        _ => Ordering::Equal,
    }
}

/// A value that cannot take part in a bound. NaN only, for now.
fn unusable(ty: &ColumnType, value: &Value) -> bool {
    matches!(ty.kind, Kind::Double | Kind::Float | Kind::Float16)
        && matches!(value, Value::Double(v) if v.is_nan())
}
