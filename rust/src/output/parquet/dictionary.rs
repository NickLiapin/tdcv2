//! Dictionary encoding — store each distinct value once, then point at it.
//!
//! A column of city names repeats "Moscow" ten thousand times. PLAIN writes
//! those bytes ten thousand times; a dictionary writes them once and spends two
//! BITS per row pointing at them. That is the largest size win available short
//! of compression, and it costs no dependency.
//!
//! Whether to use it has to be decided from the data, and the decision has to be
//! reproducible. A heuristic that consulted anything else — a clock, a memory
//! figure, a sampling rate — would put different bytes in the file on different
//! runs and break the guarantee the whole writer exists to keep. So the rule
//! below reads only the values.

use std::collections::BTreeMap;

use super::convert::Value;
use crate::output::column_type::{ColumnType, Kind};

/// A dictionary pays for itself when values repeat. Requiring at least a halving
/// keeps it away from near-unique columns — ids, timestamps, uuids — where the
/// indices would be pure overhead on top of values that are already all
/// different.
const MAX_DISTINCT_RATIO: f64 = 0.5;

/// Beyond this, the dictionary page itself grows large enough that a reader pays
/// to load it even when it wants only a few rows.
const MAX_DISTINCT: usize = 1 << 16;

/// The distinct values in first-seen order, and one index per present value.
pub struct Built {
    pub values: Vec<Option<Value>>,
    pub indices: Vec<i32>,
}

/// Build a dictionary for these values, or `None` when it would not pay.
///
/// `None` is the signal to keep PLAIN encoding, not an error.
pub fn build(ty: &ColumnType, present: &[Option<Value>]) -> Option<Built> {
    // A boolean already costs one bit; a dictionary would only add a page to
    // carry two values.
    if ty.kind == Kind::Bool || present.is_empty() {
        return None;
    }

    let mut seen: BTreeMap<String, i32> = BTreeMap::new();
    let mut values: Vec<Option<Value>> = Vec::new();
    let mut indices: Vec<i32> = Vec::with_capacity(present.len());

    for value in present {
        let key = key_of(value);
        let index = match seen.get(&key) {
            Some(index) => *index,
            None => {
                let index = values.len() as i32;
                seen.insert(key, index);
                values.push(value.clone());
                // Give up as soon as it is clearly not worth it, rather than
                // building a dictionary the size of the column and then throwing
                // it away.
                if values.len() > MAX_DISTINCT {
                    return None;
                }
                index
            }
        };
        indices.push(index);
    }

    if values.len() as f64 > present.len() as f64 * MAX_DISTINCT_RATIO {
        return None;
    }
    Some(Built { values, indices })
}

/// A stable identity key. It must never merge two values a reader would tell
/// apart.
fn key_of(value: &Option<Value>) -> String {
    match value {
        None => "n:".to_string(),
        Some(Value::Bytes(bytes)) => {
            let mut key = String::from("b:");
            for b in bytes {
                key.push_str(&b.to_string());
                key.push(',');
            }
            key
        }
        Some(Value::Text(text)) => format!("s:{text}"),
        Some(Value::Long(n)) => format!("i:{n}"),
        // Distinguished from a long by its prefix, so the same digits in two
        // slots cannot merge.
        Some(Value::Int(n)) => format!("j:{n}"),
        Some(Value::Double(n)) => format!("d:{}", double_key(*n)),
        Some(Value::Bool(flag)) => format!("z:{}", if *flag { "true" } else { "false" }),
    }
}

/// A double's identity.
///
/// Only the key's uniqueness matters, not its shape — but two doubles that print
/// alike must be the same double. `Debug` rather than `Display` because Display
/// prints `0` for negative zero as well as for zero, which would merge two
/// values every reader tells apart.
fn double_key(v: f64) -> String {
    format!("{v:?}")
}
