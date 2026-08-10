//! `${{Name}}` and `${{Name|upper|mask:xxx}}` inside a `<data>`.
//!
//! The marker itself is configurable through `<env inject="...">`: the `%` in it
//! stands for the name, and everything around it is the delimiter. A config
//! generating shell scripts can set `inject="<<%>>"` and stop fighting with
//! dollar signs.
//!
//! A name that matches no sequence is left exactly as it was written, marker and
//! all. Replacing it with an empty string would hide a typo inside data that
//! still looks well-formed; leaving `${{Gendre}}` in the output makes it obvious
//! on the first row.
//!
//! The other four implementations do the scan with a regular expression. Rust
//! has none in its standard library and this crate takes no dependencies, so it
//! is written out — and the two properties of that regex that a hand-written
//! scan gets wrong by default are called out where they are reproduced: the name
//! is matched **non-greedily**, and `.` does **not** match a newline.

/// What a name resolves to on the row being rendered.
pub trait Lookup {
    fn has(&self, name: &str) -> bool;
    fn value(&self, name: &str) -> String;
}

use crate::engine::EngineResult;

/// One filter in a reference: a bare word, or `word:arg`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Filter {
    pub kind: String,
    pub arg: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Reference {
    pub name: String,
    pub filters: Vec<Filter>,
}

/// The two halves of an `inject` marker, or `None` when it names nothing.
///
/// The reference reads the shape with `(.+)%(.+)`, whose first group is greedy —
/// so for a marker holding several `%`, the **rightmost** usable one is the slot.
/// Both sides must be non-empty, which is what `+` means on each side.
pub fn split_inject(inject: Option<&str>) -> Option<(&str, &str)> {
    let marker = match inject {
        Some(m) if !m.is_empty() => m,
        _ => "${{%}}",
    };
    // The rightmost `%` that leaves BOTH sides non-empty, which is not the same as
    // the rightmost `%`. Taking the last one and giving up when the suffix came out
    // empty is where this diverged: the reference's regex BACKTRACKS, so on the
    // documented `inject="%{%}%"` it settles on the middle `%` and substitutes,
    // while this took the trailing one, found nothing after it, and left every
    // `%{Name}%` in the output verbatim. Measured before the fix — TypeScript,
    // Python, Java and C# printed the value, Rust printed `%{Id}%`: the same
    // config, different data.
    let (idx, mark) = marker
        .char_indices()
        .rev()
        .find(|&(i, c)| c == '%' && i > 0 && i + c.len_utf8() < marker.len())?;
    let (prefix, rest) = marker.split_at(idx);
    Some((prefix, &rest[mark.len_utf8()..]))
}

pub fn apply(text: &str, inject: Option<&str>, lookup: &dyn Lookup) -> EngineResult<String> {
    // An inject with no `%` names nothing, so there is nothing to substitute.
    let Some((prefix, suffix)) = split_inject(inject) else {
        return Ok(text.to_string());
    };

    let mut out = String::with_capacity(text.len());
    let mut copied = 0usize;
    let mut search = 0usize;

    while let Some(rel) = text[search..].find(prefix) {
        let start = search + rel;
        let content_start = start + prefix.len();

        match find_close(text, content_start, suffix) {
            Some(content_end) => {
                out.push_str(&text[copied..start]);
                let reference = parse_reference(&text[content_start..content_end]);
                if lookup.has(&reference.name) {
                    let mut value = lookup.value(&reference.name);
                    for filter in &reference.filters {
                        value = super::transforms::apply_filter(
                            &filter.kind,
                            filter.arg.as_deref(),
                            &value,
                        )?;
                    }
                    out.push_str(&value);
                } else {
                    // Left exactly as written, marker and all.
                    out.push_str(&text[start..content_end + suffix.len()]);
                }
                copied = content_end + suffix.len();
                search = copied;
            }
            None => {
                // No closer for this opener. The regex engine would shift the
                // match start along by one character and try again, so this
                // does the same rather than giving up on the rest of the line.
                search = start + next_char_len(text, start);
            }
        }
    }

    out.push_str(&text[copied..]);
    Ok(out)
}

/// Where the name ends: the FIRST `suffix` at least one character along, with no
/// newline in between.
///
/// Two details, both from the pattern the reference compiles:
///
/// * `(.+?)` is non-greedy, so `${{A}}${{B}}` is two references and not one name
///   reading `A}}${{B`. A `find` from the end, or a greedy scan, silently merges
///   every pair of references on a line.
/// * `.` does not match `\n`, because the pattern is compiled without
///   `Singleline`. An unclosed `${{` therefore stops at the end of its line
///   instead of swallowing the rest of the file.
fn find_close(text: &str, content_start: usize, suffix: &str) -> Option<usize> {
    let mut at = content_start;
    let mut seen_one = false;
    loop {
        if seen_one && text[at..].starts_with(suffix) {
            return Some(at);
        }
        let c = text[at..].chars().next()?;
        if c == '\n' {
            return None;
        }
        at += c.len_utf8();
        seen_one = true;
    }
}

fn next_char_len(text: &str, at: usize) -> usize {
    text[at..].chars().next().map_or(1, char::len_utf8)
}

/// `NAME ( "|" filter )*`, where a filter is a bare word or `word:arg`.
///
/// The argument runs to the next `|`, which is why a mask pattern may contain
/// anything but a pipe.
pub fn parse_reference(raw: &str) -> Reference {
    let mut parts = raw.split('|');
    let name = parts.next().unwrap_or("").trim().to_string();
    let mut filters = Vec::new();
    for piece in parts {
        match piece.find(':') {
            None => {
                let bare = piece.trim();
                if !bare.is_empty() {
                    filters.push(Filter {
                        kind: bare.to_string(),
                        arg: None,
                    });
                }
            }
            Some(colon) => {
                let kind = piece[..colon].trim();
                if !kind.is_empty() {
                    filters.push(Filter {
                        kind: kind.to_string(),
                        arg: Some(piece[colon + 1..].trim().to_string()),
                    });
                }
            }
        }
    }
    Reference { name, filters }
}
