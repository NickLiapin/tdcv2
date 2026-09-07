//! `MAP` columns: `type="{}int64"` over a cell that reads `alpha:1,beta:2`.
//!
//! Parquet stores a map as a repeated group of key/value pairs, so the shape is
//! the LIST shape with two leaves instead of one:
//!
//! ```text
//! required group <name> (MAP) {
//!     repeated group key_value {
//!         required BYTE_ARRAY key (STRING);
//!         required|optional <physical> value;
//!     }
//! }
//! ```
//!
//! Max rep is 1 for both leaves. Max def is 1 for the key — it is REQUIRED, as
//! the format insists, because a pair with no key is not a pair — and 1 or 2 for
//! the value depending on whether it is nullable.
//!
//! The KEY is always text. A cell arrives here as text and Parquet forbids a
//! null key, so a second type parameter would double the syntax to buy a
//! conversion nobody has asked for.
//!
//! Kept apart from the writer so the level streams can be checked against
//! hand-computed ones. Getting them wrong produces a file readers accept and
//! then mis-assemble, which is the worst failure this writer has.

use crate::engine::{invalid, EngineResult};

/// The key leaf's max definition level. Always 1: the key is REQUIRED in a pair.
pub const KEY_MAX_DEF: i32 = 1;

/// One pair. `value` of `None` is a NULL value, which only a nullable map holds.
#[derive(Clone, Debug)]
pub struct Entry {
    pub key: String,
    pub value: Option<String>,
}

/// The two leaves' values, and the level streams describing their shape.
pub struct Built {
    pub keys: Vec<String>,
    pub present: Vec<String>,
    pub rep_levels: Vec<i32>,
    pub key_def_levels: Vec<i32>,
    pub value_def_levels: Vec<i32>,
    pub max_value_def: i32,
}

/// The max definition level for a map value that is, or is not, nullable.
pub fn value_max_def(value_nullable: bool) -> i32 {
    if value_nullable {
        2
    } else {
        1
    }
}

/// Split one cell into pairs — `alpha:1,beta:2` on the column's separator.
///
/// The key is everything before the FIRST `:`, the value everything after, so a
/// value may hold colons (a timestamp does) and a key may not. That asymmetry is
/// the one worth having: keys are short labels, values are whatever the column
/// generates.
///
/// Three things are refused rather than guessed at, and each would otherwise
/// produce a map quietly missing an entry: a piece with no `:` at all (is it a
/// key with no value, or the reverse?); an empty key, which Parquet has no way
/// to store; and a key that repeats inside one row, because readers disagree
/// about which of the two wins and some drop the row's map entirely.
pub fn parse_cell(text: &str, separator: &str, value_nullable: bool) -> EngineResult<Vec<Entry>> {
    // An empty cell is an EMPTY MAP, not a map holding one blank pair — the same
    // rule a list follows, for the same reason.
    if text.is_empty() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<Entry> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for piece in text.split(separator) {
        let Some(at) = piece.find(':') else {
            return invalid(&format!(
                "map entry \"{piece}\" has no \":\" — a map cell reads \
                 key:value{separator}key:value"
            ));
        };
        let key = piece[..at].to_string();
        if key.is_empty() {
            return invalid(&format!("map entry \"{piece}\" has an empty key"));
        }
        if seen.contains(&key) {
            return invalid(&format!("map key \"{key}\" appears twice in one cell"));
        }
        seen.push(key.clone());
        let value = piece[at + 1..].to_string();
        let value = if value_nullable && value.is_empty() {
            None
        } else {
            Some(value)
        };
        entries.push(Entry { key, value });
    }
    Ok(entries)
}

/// The key, value, rep and def streams for one map column.
///
/// An empty map still occupies one level slot in BOTH leaves: def 0 is the
/// statement "this row has no pairs". Without it the row would vanish from the
/// column, and every row after it would shift up by one.
pub fn build(rows: &[Vec<Entry>], value_nullable: bool) -> Built {
    let deepest = value_max_def(value_nullable);
    let mut keys = Vec::new();
    let mut present = Vec::new();
    let mut rep_levels = Vec::new();
    let mut key_def_levels = Vec::new();
    let mut value_def_levels = Vec::new();

    for row in rows {
        if row.is_empty() {
            rep_levels.push(0);
            key_def_levels.push(0);
            value_def_levels.push(0);
            continue;
        }
        for (k, entry) in row.iter().enumerate() {
            rep_levels.push(if k == 0 { 0 } else { 1 });
            key_def_levels.push(KEY_MAX_DEF);
            keys.push(entry.key.clone());
            match &entry.value {
                // The pair exists, the value does not.
                None => value_def_levels.push(deepest - 1),
                Some(text) => {
                    value_def_levels.push(deepest);
                    present.push(text.clone());
                }
            }
        }
    }

    Built {
        keys,
        present,
        rep_levels,
        key_def_levels,
        value_def_levels,
        max_value_def: deepest,
    }
}
