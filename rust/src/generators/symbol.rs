//! `<gen type="symbol" .../>` — characters, drawn one at a time.
//!
//! The pool comes from either a named `alphabet` or an inline `value` set, never
//! both. To pick a whole word from a list, `<gen type="text">` is the tag; this
//! one works below the level of words.

use std::collections::BTreeMap;
use std::collections::BTreeSet;

use super::rand;
use crate::engine::{invalid, EngineResult};
use crate::prng::Sfc32;
use crate::unicode::{self, char_set};

const DEFAULT_LENGTH: i32 = 1;
const MAX_LENGTH: i32 = 1024;

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let chars = resolve_chars(attrs)?;
    let length = parse_length(attrs.get("length").map(String::as_str))?;

    Ok((0..count)
        .map(|_| {
            (0..length)
                .map(|_| rand::pick(prng, &chars))
                .collect::<String>()
        })
        .collect())
}

pub fn parse_length(raw: Option<&str>) -> EngineResult<i32> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_LENGTH);
    };
    match raw.trim().parse::<i32>() {
        Ok(v) if v > 0 && v <= MAX_LENGTH => Ok(v),
        _ => invalid(&format!(
            "symbol length must be an integer from 1 to {MAX_LENGTH}, got \"{raw}\""
        )),
    }
}

pub fn resolve_chars(attrs: &BTreeMap<String, String>) -> EngineResult<Vec<char>> {
    fn blank_to_none(s: Option<&String>) -> Option<&str> {
        s.map(String::as_str).filter(|v| !v.is_empty())
    }
    let value = blank_to_none(attrs.get("value"));
    let alphabet = blank_to_none(attrs.get("alphabet"));

    if value.is_some() && alphabet.is_some() {
        return invalid(
            "symbol generator: use either \"value\" (inline set) or \"alphabet\" (named), not both",
        );
    }

    let base = if let Some(value) = value {
        let parsed = char_set::parse(value)?;
        if parsed.is_empty() {
            return invalid(&format!(
                "symbol generator: value \"{value}\" produced an empty character set"
            ));
        }
        parsed
    } else if let Some(alphabet) = alphabet {
        match unicode::chars(alphabet) {
            Some(chars) => chars.to_vec(),
            None => {
                return invalid(&format!(
                    "unknown alphabet \"{alphabet}\"; known alphabets: {}",
                    unicode::names().join(", ")
                ))
            }
        }
    } else {
        return invalid(&format!(
            "symbol generator requires \"value\" (inline set like \"abc\" or \"[a-z]\") or \
             \"alphabet\" (named); known alphabets: {}",
            unicode::names().join(", ")
        ));
    };

    apply_include_exclude(
        base,
        attrs.get("include").map(String::as_str),
        attrs.get("exclude").map(String::as_str),
    )
}

/// `(base ∪ include) − exclude`. Exclude is applied last, so it always has the
/// last word.
fn apply_include_exclude(
    base: Vec<char>,
    include: Option<&str>,
    exclude: Option<&str>,
) -> EngineResult<Vec<char>> {
    let include = include.filter(|s| !s.is_empty());
    let exclude = exclude.filter(|s| !s.is_empty());
    if include.is_none() && exclude.is_none() {
        return Ok(base);
    }

    // First-seen order kept, because the set is indexed by a random draw.
    let mut order = base.clone();
    let mut seen: BTreeSet<char> = base.into_iter().collect();
    if let Some(include) = include {
        for c in char_set::parse(include)? {
            if seen.insert(c) {
                order.push(c);
            }
        }
    }
    if let Some(exclude) = exclude {
        let drop: BTreeSet<char> = char_set::parse(exclude)?.into_iter().collect();
        order.retain(|c| !drop.contains(c));
    }

    if order.is_empty() {
        return invalid(
            "symbol generator: the character set is empty after applying include/exclude",
        );
    }
    Ok(order)
}
