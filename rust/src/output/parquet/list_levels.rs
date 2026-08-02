//! The Dremel core: rows of lists turned into the three flat streams Parquet
//! actually stores.
//!
//! Parquet keeps no brackets. A list column is the leaf values laid end to end,
//! plus two integer streams that let a reader rebuild the shape. A repetition
//! level of 0 starts a new record and 1 continues the current list; a definition
//! level says how deep the value actually exists, which is how an empty list and
//! a missing element are expressed without any value at all.
//!
//! The schema here has exactly one level of repetition, so the maximum
//! repetition level is 1 and the maximum definition level is 1 for a required
//! element or 2 for an optional one. The outer group is REQUIRED because "no list
//! at all" is not a state this can produce — an empty cell is an empty list — and
//! declaring it optional would spend a level on something never emitted.
//!
//! Kept apart from the writer so it can be checked against levels worked out by
//! hand. Getting these two streams wrong produces a file that readers accept and
//! then reassemble incorrectly, which is the worst failure available.

/// The elements that are present, and the two level streams describing their
/// shape.
pub struct Built {
    pub present: Vec<String>,
    pub rep_levels: Vec<i32>,
    pub def_levels: Vec<i32>,
    pub max_def: i32,
    pub max_rep: i32,
}

/// The maximum definition level for a list whose element is, or is not,
/// nullable.
pub fn max_def_of(element_nullable: bool) -> i32 {
    if element_nullable {
        2
    } else {
        1
    }
}

/// Bits needed to hold levels up to `max_level`; zero when there is nothing to
/// say.
pub fn bit_width(max_level: i32) -> u32 {
    let mut bits = 0u32;
    while (1i32 << bits) <= max_level {
        bits += 1;
    }
    bits
}

/// The value, repetition and definition streams for one list column.
///
/// An element is NULL when its text is empty AND the element type is nullable —
/// the same rule the scalar path uses, so `missing=` behaves identically whether
/// or not the column repeats. When the element is not nullable an empty string is
/// a legitimate empty value and is passed on to conversion, which refuses it if
/// the type cannot hold it.
pub fn build(rows: &[Vec<String>], element_nullable: bool) -> Built {
    let max_def = max_def_of(element_nullable);
    let mut present = Vec::new();
    let mut rep_levels = Vec::new();
    let mut def_levels = Vec::new();

    for row in rows {
        if row.is_empty() {
            // An empty list still occupies one level slot; definition 0 IS the
            // statement "this row has no elements". Without it the row would
            // vanish entirely.
            rep_levels.push(0);
            def_levels.push(0);
            continue;
        }

        for (k, text) in row.iter().enumerate() {
            rep_levels.push(i32::from(k != 0));
            if element_nullable && text.is_empty() {
                def_levels.push(max_def - 1); // the slot exists, the value does not
                continue;
            }
            def_levels.push(max_def);
            present.push(text.clone());
        }
    }

    Built {
        present,
        rep_levels,
        def_levels,
        max_def,
        max_rep: 1,
    }
}
