//! The small pieces of scanning that the other four get from a regex engine.
//!
//! This crate has no regex dependency, so the handful of patterns the generators
//! use are written out. Each function names the pattern it replaces, so the two
//! can be compared without guessing which regex a loop is standing in for.

/// `^-?\d+$` — a signed integer and nothing else.
pub fn is_single_int(text: &str) -> bool {
    let digits = text.strip_prefix('-').unwrap_or(text);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

/// `^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$` — `MIN..MAX`, with space allowed around each part.
///
/// The `..` is found from the LEFT, so a negative lower bound still parses:
/// searching from the right would split `-5..-1` at the wrong dots.
pub fn split_range(text: &str) -> Option<(&str, &str)> {
    let trimmed = text.trim();
    let at = trimmed.find("..")?;
    let min = trimmed[..at].trim();
    let max = trimmed[at + 2..].trim();
    if is_single_int(min) && is_single_int(max) {
        Some((min, max))
    } else {
        None
    }
}

/// `^(\d+)\s*-\s*(\d+)$` — `MIN-MAX`, unsigned on both sides.
///
/// Unsigned is what tells this apart from a negative number: `3-5` is a range
/// and `-5` is a length of minus five, which is not a length at all.
pub fn split_length_range(text: &str) -> Option<(&str, &str)> {
    let at = text.find('-')?;
    if at == 0 {
        return None;
    }
    let min = text[..at].trim();
    let max = text[at + 1..].trim();
    let unsigned = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    if unsigned(min) && unsigned(max) {
        Some((min, max))
    } else {
        None
    }
}

/// `^\[\s*([^\]]+?)\s*]` — the leading `[…]` of a range list.
///
/// Returns the contents and how much of the input the whole bracket consumed,
/// so the caller can step past it exactly as the regex's match length would.
pub fn bracket_head(text: &str) -> Option<(&str, usize)> {
    if !text.starts_with('[') {
        return None;
    }
    let close = text.find(']')?;
    let inner = text[1..close].trim();
    if inner.is_empty() {
        return None;
    }
    Some((inner, close + 1))
}
