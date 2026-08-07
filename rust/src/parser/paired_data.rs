//! Paired raw text, rewritten before the lexer ever sees it.
//!
//! `<data pair="X">…</data pair="X">` lets a body carry a literal `</data>` — a
//! snippet of TDC syntax inside generated documentation, say. The grammar keeps
//! one static `</data>` close token because a lexer that had to know which
//! closer belongs to which opener would need the pair value inside a token rule,
//! so the pairing is resolved here instead: the paired closer becomes a plain
//! `</data>` and every literal `</data>` in the body becomes a sentinel the
//! lexer reads as ordinary text. [`restore`] puts the sentinel back when a body
//! is read.
//!
//! The rewrite is length-preserving on purpose. Everything the lexer, the parser
//! and the validator report afterwards carries a line and a column, and those
//! have to point into the file the user wrote rather than into the one this pass
//! produced — which is why the closing tag's leftover characters become spaces
//! instead of disappearing.
//!
//! Ported from `typescript/src/parser/paired-data.ts`. The five implementations
//! have to agree character for character, malformed input included, so this
//! follows the reference's decisions even where a fresh design would choose
//! otherwise.
//!
//! Everything below indexes CODE POINTS rather than bytes. The reference steps
//! over the closing tag by a fixed offset, which lands mid-character in UTF-8
//! the moment a pair value or the space before it is not ASCII.

use std::collections::HashMap;

use super::SyntaxProblem;

/// What a literal `</data>` inside a paired body becomes for the duration of
/// lexing. Exactly as long as the text it stands in for, which is what keeps
/// every later position honest, and built from NUL because a hand-written
/// config cannot contain one.
const SENTINEL: &str = "\u{0}/data\u{0}";

const CLOSE: &str = "</data>";

/// The source to lex, and everything wrong with the paired tags in it.
pub struct Rewrite {
    pub source: String,
    pub problems: Vec<SyntaxProblem>,
}

/// A close tag, and the `pair` it carried if it carried one.
struct Close {
    start: usize,
    end: usize,
    pair: Option<String>,
}

/// A line (1-based) and column (0-based), as every diagnostic here counts them.
#[derive(Clone, Copy)]
struct Position {
    line: i32,
    column: i32,
}

pub fn preprocess(source: &str) -> Rewrite {
    let chars: Vec<char> = source.chars().collect();
    let open: Vec<char> = "<data".chars().collect();
    let close_prefix: Vec<char> = "</data".chars().collect();

    let mut out = String::new();
    let mut cursor = 0usize;
    let mut problems: Vec<SyntaxProblem> = Vec::new();
    let mut seen: HashMap<String, Position> = HashMap::new();

    while cursor < chars.len() {
        let Some(open_start) = find(&chars, &open, cursor) else {
            push(&mut out, &chars[cursor..]);
            break;
        };

        if !is_data_open_at(&chars, open_start, open.len()) {
            // `<database>` and friends: emit the false start and keep looking past it.
            push(&mut out, &chars[cursor..open_start + open.len()]);
            cursor = open_start + open.len();
            continue;
        }

        let Some(open_end) = find_tag_end(&chars, open_start) else {
            push(&mut out, &chars[cursor..]);
            break;
        };

        let open_text = &chars[open_start..open_end + 1];
        let Some(pair) = pair_value(open_text) else {
            push(&mut out, &chars[cursor..open_end + 1]);
            cursor = open_end + 1;
            continue;
        };
        if is_self_closing(open_text) {
            push(&mut out, &chars[cursor..open_end + 1]);
            cursor = open_end + 1;
            continue;
        }

        let pair_chars: Vec<char> = pair.chars().collect();
        let offset = find(open_text, &pair_chars, 0).unwrap_or(0);
        let pair_position = position(&chars, open_start + offset);
        match seen.get(&pair) {
            Some(previous) => problems.push(SyntaxProblem {
                line: pair_position.line,
                column: pair_position.column,
                message: format!(
                    "duplicate <data pair=\"{pair}\"> value. \
                     First use was at line {}, column {}.",
                    previous.line, previous.column
                ),
            }),
            None => {
                seen.insert(pair.clone(), pair_position);
            }
        }

        let body_start = open_end + 1;
        let (matched, mismatch) = find_close(&chars, &close_prefix, body_start, &pair);
        let Some(matched) = matched else {
            let at = position(&chars, mismatch.as_ref().map_or(open_start, |m| m.start));
            let message = match &mismatch {
                Some(m) => format!(
                    "expected </data pair=\"{pair}\">, got </data pair=\"{}\">",
                    m.pair.clone().unwrap_or_default()
                ),
                None => format!("unclosed <data pair=\"{pair}\">"),
            };
            problems.push(SyntaxProblem {
                line: at.line,
                column: at.column,
                message,
            });
            // Nothing after an unmatched opener can be rewritten with any
            // confidence about where the body was meant to end, so the rest of
            // the file is handed over untouched.
            push(&mut out, &chars[cursor..]);
            break;
        };

        push(&mut out, &chars[cursor..body_start]);
        out.push_str(&text(&chars[body_start..matched.start]).replace(CLOSE, SENTINEL));
        out.push_str(CLOSE);
        out.push_str(&structural_whitespace(
            &chars[matched.start + CLOSE.chars().count()..matched.end + 1],
        ));
        cursor = matched.end + 1;
    }

    Rewrite {
        source: out,
        problems,
    }
}

/// A `<data>` body as the user wrote it, with the sentinel back to a literal close tag.
pub fn restore(body: &str) -> String {
    body.replace(SENTINEL, CLOSE)
}

fn is_data_open_at(chars: &[char], index: usize, open_len: usize) -> bool {
    match chars.get(index + open_len) {
        None => true,
        Some(&next) => next == '>' || next == '/' || is_space(next),
    }
}

fn is_self_closing(tag: &[char]) -> bool {
    // The tag always ends in '>'; read back from there.
    let mut at = tag.len() as isize - 2;
    while at >= 0 && is_space(tag[at as usize]) {
        at -= 1;
    }
    at >= 0 && tag[at as usize] == '/'
}

/// The close that pairs with `expected`, or — when there is none — the first
/// close that carried some other pair, which is the difference between "you
/// closed it wrong" and "you never closed it".
fn find_close(
    chars: &[char],
    close_prefix: &[char],
    start: usize,
    expected: &str,
) -> (Option<Close>, Option<Close>) {
    let mut search_at = start;
    let mut mismatch: Option<Close> = None;

    while search_at < chars.len() {
        let Some(close_start) = find(chars, close_prefix, search_at) else {
            break;
        };
        let Some(close_end) = find_tag_end(chars, close_start) else {
            break;
        };

        let close_pair = pair_value(&chars[close_start..close_end + 1]);
        if close_pair.as_deref() == Some(expected) {
            return (
                Some(Close {
                    start: close_start,
                    end: close_end,
                    pair: close_pair,
                }),
                mismatch,
            );
        }
        if close_pair.is_some() && mismatch.is_none() {
            mismatch = Some(Close {
                start: close_start,
                end: close_end,
                pair: close_pair,
            });
        }
        search_at = close_start + close_prefix.len();
    }

    (None, mismatch)
}

/// The '>' that ends a tag, ignoring any inside quotes so `if="a>b"` does not end it early.
fn find_tag_end(chars: &[char], start: usize) -> Option<usize> {
    let mut quote: Option<char> = None;
    for (at, &ch) in chars.iter().enumerate().skip(start) {
        if let Some(open) = quote {
            if ch == open {
                quote = None;
            }
            continue;
        }
        if ch == '"' || ch == '\'' {
            quote = Some(ch);
            continue;
        }
        if ch == '>' {
            return Some(at);
        }
    }
    None
}

/// The `pair="…"` value in a tag, as the reference's `\bpair\s*=\s*"([^"\r\n]*)"`.
fn pair_value(tag: &[char]) -> Option<String> {
    let needle: Vec<char> = "pair".chars().collect();
    let mut at = 0usize;

    loop {
        let found = find(tag, &needle, at)?;
        // The word boundary: `superpair=` is not a pair attribute, `data-pair=` is.
        if found > 0 && is_word(tag[found - 1]) {
            at = found + 1;
            continue;
        }

        let mut scan = skip_space(tag, found + needle.len());
        if tag.get(scan) != Some(&'=') {
            at = found + 1;
            continue;
        }
        scan = skip_space(tag, scan + 1);
        if tag.get(scan) != Some(&'"') {
            at = found + 1;
            continue;
        }

        scan += 1;
        let value_start = scan;
        while scan < tag.len() && tag[scan] != '"' && tag[scan] != '\r' && tag[scan] != '\n' {
            scan += 1;
        }
        if tag.get(scan) == Some(&'"') {
            return Some(text(&tag[value_start..scan]));
        }
        at = found + 1;
    }
}

fn skip_space(chars: &[char], mut at: usize) -> usize {
    while at < chars.len() && is_space(chars[at]) {
        at += 1;
    }
    at
}

/// Line breaks kept, everything else blanked — the closer's leftovers hold their place.
fn structural_whitespace(chars: &[char]) -> String {
    chars
        .iter()
        .map(|&ch| if ch == '\n' || ch == '\r' { ch } else { ' ' })
        .collect()
}

fn position(chars: &[char], index: usize) -> Position {
    let mut line = 1;
    let mut column = 0;
    for &ch in &chars[..index] {
        if ch == '\n' {
            line += 1;
            column = 0;
        } else {
            column += 1;
        }
    }
    Position { line, column }
}

fn find(haystack: &[char], needle: &[char], from: usize) -> Option<usize> {
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&at| &haystack[at..at + needle.len()] == needle)
}

fn text(chars: &[char]) -> String {
    chars.iter().collect()
}

fn push(out: &mut String, chars: &[char]) {
    out.extend(chars);
}

/// Whitespace as JavaScript's `\s` defines it, which is what the reference tests
/// against. Spelling the set out is what stops five languages disagreeing over an
/// exotic space: `char::is_whitespace` admits U+0085 and refuses U+FEFF, so it is
/// not this set under another name.
fn is_space(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

fn is_word(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || ch == '_'
}
