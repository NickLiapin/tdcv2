//! A positional mask: `mask="xxx-xxx"`, `mask="w[1] w[0]"`, `mask="x[0]. *"`.
//!
//! The alphabet is small on purpose. `x` takes one character, `w` takes one
//! word, `*` takes everything not yet used, a backslash escapes the next
//! character, and anything else is a literal. That is enough to reformat a phone
//! number, swap a name around, or build an initial, without a config ever
//! reaching for a regular expression.
//!
//! `x[i]` and `w[i]` address the *original* input — 0-based, negative from the
//! end, `a..b` inclusive. Indexing and consumption are two channels that do not
//! interfere: what an index emits never depends on what has been consumed, and
//! consumption only decides what is left for a bare `x`, `w` or `*`. So the same
//! notation reads as a move when nothing else claims that position and as a copy
//! when something does — which is why `"w[1] w[0]"` swaps two words and
//! `"w[0] *"` repeats the first one.
//!
//! Out-of-range indexes emit nothing rather than failing. The length of a value
//! is not known until it is generated, so there is nothing to check the mask
//! against beforehand, and stopping a million-row run over one short value would
//! be worse than a gap in it.

use crate::engine::{invalid, EngineResult};

#[derive(Clone, Debug, PartialEq, Eq)]
enum Slot {
    Char,
    Word,
    CharAt(i32, i32),
    WordAt(i32, i32),
    Rest,
    Literal(char),
}

pub fn apply(pattern: &str, input: &str) -> EngineResult<String> {
    // Code points, not bytes and not grapheme clusters: `x` takes one character
    // the way the reference counts them, so a surrogate pair is never split and a
    // combining mark still counts as its own slot.
    let chars: Vec<char> = input.chars().collect();
    let mut used = vec![false; chars.len()];
    let spans = word_spans(&chars);
    let mut result = String::new();

    for slot in parse(pattern)? {
        match slot {
            Slot::Literal(c) => result.push(c),

            Slot::Char => {
                let i = next_free(&used);
                if i < chars.len() {
                    result.push(chars[i]);
                    used[i] = true;
                }
            }

            Slot::Word => {
                let mut i = next_free(&used);
                while i < chars.len() && !used[i] && !chars[i].is_whitespace() {
                    result.push(chars[i]);
                    used[i] = true;
                    i += 1;
                }
                // Swallow one delimiter with the word, so what a later `*` prints
                // does not begin with the space this word left behind.
                if i < chars.len() && !used[i] && chars[i].is_whitespace() {
                    used[i] = true;
                }
            }

            Slot::CharAt(from, to) => {
                for i in walk(from, to, chars.len()) {
                    result.push(chars[i]);
                    used[i] = true;
                }
            }

            Slot::WordAt(from, to) => {
                let mut picked: Vec<String> = Vec::new();
                for wi in walk(from, to, spans.len()) {
                    let (start, end) = spans[wi];
                    for slot in used.iter_mut().take(end).skip(start) {
                        *slot = true;
                    }
                    // Take one adjacent delimiter along, so the leftovers a later
                    // `*` prints do not collapse into a double space.
                    if end < chars.len() && chars[end].is_whitespace() {
                        used[end] = true;
                    } else if start > 0 && chars[start - 1].is_whitespace() {
                        used[start - 1] = true;
                    }
                    picked.push(chars[start..end].iter().collect());
                }
                result.push_str(&picked.join(" "));
            }

            Slot::Rest => {
                for (i, c) in chars.iter().enumerate() {
                    if !used[i] {
                        result.push(*c);
                        used[i] = true;
                    }
                }
            }
        }
    }

    Ok(result)
}

/// Parse a mask without applying it — what the validator needs to refuse a
/// broken one early.
///
/// Reports the same complaint applying it would, only before a single row exists.
pub fn check(pattern: &str) -> EngineResult<()> {
    parse(pattern).map(|_| ())
}

fn parse(pattern: &str) -> EngineResult<Vec<Slot>> {
    let pat: Vec<char> = pattern.chars().collect();
    let mut slots = Vec::new();
    let mut i = 0usize;

    while i < pat.len() {
        let ch = pat[i];
        if ch == '\\' && i + 1 < pat.len() {
            slots.push(Slot::Literal(pat[i + 1]));
            i += 2;
            continue;
        }
        if ch == '*' {
            slots.push(Slot::Rest);
            i += 1;
            continue;
        }
        if ch != 'x' && ch != 'w' {
            slots.push(Slot::Literal(ch));
            i += 1;
            continue;
        }

        // A `[` is index syntax only directly after an x or a w. Anywhere else it
        // is ordinary text, so `mask="[tel.] xxx"` needs no escaping.
        if i + 1 < pat.len() && pat[i + 1] == '[' {
            if let Some(close) = pat[i + 2..]
                .iter()
                .position(|c| *c == ']')
                .map(|p| p + i + 2)
            {
                let body: String = pat[i + 2..close].iter().collect();
                let Some((from, to)) = parse_index_spec(&body) else {
                    return invalid(&format!(
                        "mask: invalid index \"[{body}]\" after \"{ch}\" — use {ch}[0], \
                         {ch}[0..4] or {ch}[-1]; ranges use \"..\" (a hyphen would clash \
                         with a negative index). For a literal bracket write {ch}\\["
                    ));
                };
                slots.push(if ch == 'x' {
                    Slot::CharAt(from, to)
                } else {
                    Slot::WordAt(from, to)
                });
                i = close + 1;
                continue;
            }
            // No closing bracket anywhere: plain text, left alone.
        }

        slots.push(if ch == 'x' { Slot::Char } else { Slot::Word });
        i += 1;
    }

    Ok(slots)
}

/// `-3`, `7`, `0..4`, `-2..-1` — and nothing else.
fn parse_index_spec(body: &str) -> Option<(i32, i32)> {
    if let Ok(n) = body.parse::<i32>() {
        return Some((n, n));
    }
    // From the LEFT, so `-2..-1` splits at its own separator rather than inside
    // the negative bound that follows it.
    let at = body.find("..")?;
    let from = body[..at].parse::<i32>().ok()?;
    let to = body[at + 2..].parse::<i32>().ok()?;
    Some((from, to))
}

/// Indices from..to inclusive, counting backwards when the range runs that way.
fn walk(from: i32, to: i32, length: usize) -> Vec<usize> {
    let len = length as i32;
    let a = if from < 0 { len + from } else { from };
    let b = if to < 0 { len + to } else { to };
    let step: i32 = if a <= b { 1 } else { -1 };

    let mut result = Vec::new();
    let mut i = a;
    loop {
        if step > 0 && i > b {
            break;
        }
        if step < 0 && i < b {
            break;
        }
        if i >= 0 && i < len {
            result.push(i as usize);
        }
        i += step;
    }
    result
}

fn word_spans(chars: &[char]) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut i = 0usize;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let start = i;
        while i < chars.len() && !chars[i].is_whitespace() {
            i += 1;
        }
        spans.push((start, i));
    }
    spans
}

fn next_free(used: &[bool]) -> usize {
    used.iter().position(|u| !*u).unwrap_or(used.len())
}
