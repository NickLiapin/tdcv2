//! How many characters a composed pack's own `<sequence>` produces, when that is a FACT.
//!
//! A pack parameter replaces one of the pack's sequences for the run:
//! `<gen type="template" value="usa.finance.aba_routing" prefix="12"/>` swaps the
//! pack's own `prefix`. That is the documented way to pin part of an identifier.
//!
//! The packs that carry a CHECK DIGIT compute it over a fixed layout, so a pinned
//! value of the wrong width does not shift the layout — it breaks it. Measured on
//! `usa.finance.aba_routing`, whose `prefix` is 2 characters and `tail` is 6:
//!
//! ```text
//! prefix="12345"  ->  the run aborts: <at>: index 8 is out of range
//! tail="678"      ->  326784 — six digits, and not a routing number
//! ```
//!
//! `check` passed on both. The first names no file, line or code; the second says
//! nothing at all and writes data that looks right.
//!
//! So the width is worked out here, and ONLY where it can be proven from the
//! pack's own body. Three shapes carry a width; everything else is absent and the
//! caller stays silent, because a refusal has to be a proof:
//!
//! ```text
//! <gen type="text" value="01,02,03"/>      every alternative is 2 -> 2
//! <gen type="regex" value="[0-9]{6}"/>     one class, fixed count -> 6
//! <gen type="number" value="0000..9999"/>  zero-padded, equal ends -> 4
//! ```
//!
//! Read by scanning the body rather than by parsing it — the same choice
//! `parameter_names` makes, and for the same reason: the validator asks before
//! anything is built, and parsing here would report a pack author's syntax error
//! at the caller's line.

use std::collections::BTreeMap;

/// `{N}` at the very end, returning N.
fn exact_count(rest: &str) -> Option<usize> {
    let inner = rest.strip_prefix('{')?.strip_suffix('}')?;
    if inner.is_empty() || !inner.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    inner.parse().ok()
}

/// The exact character count this generator always produces, or None.
fn fixed_width(kind: &str, value: &str) -> Option<usize> {
    if value.is_empty() {
        return None;
    }
    match kind {
        "text" => {
            let items: Vec<&str> = value.split(',').collect();
            if items.len() < 2 {
                return None; // a single literal is not a list
            }
            let width = items[0].chars().count();
            items
                .iter()
                .all(|item| item.chars().count() == width)
                .then_some(width)
        }
        "regex" => {
            // One class or escape repeated an exact number of times: `[0-9]{6}`, `\d{4}`.
            if let Some(after) = value.strip_prefix('[') {
                let close = after.find(']')?;
                if close == 0 {
                    return None;
                }
                exact_count(&after[close + 1..])
            } else if let Some(after) = value.strip_prefix('\\') {
                let mut chars = after.chars();
                let class = chars.next()?;
                if !matches!(class, 'd' | 'w' | 's' | 'D' | 'W' | 'S') {
                    return None;
                }
                exact_count(chars.as_str())
            } else {
                let mut chars = value.chars();
                let first = chars.next()?;
                if !first.is_ascii_alphanumeric() {
                    return None;
                }
                exact_count(chars.as_str())
            }
        }
        "number" => {
            let (low, high) = value.split_once("..")?;
            let whole = |t: &str| {
                let body = t.strip_prefix('-').unwrap_or(t);
                !body.is_empty() && body.bytes().all(|b| b.is_ascii_digit())
            };
            if !whole(low) || !whole(high) {
                return None;
            }
            // Only a zero-padded range has a fixed width: `1..9999` is 1 to 4 characters.
            (low.len() == high.len() && low.starts_with('0')).then(|| low.chars().count())
        }
        _ => None,
    }
}

/// The value of `name="…"` inside a tag's attribute text.
fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let needle = format!("{name}=\"");
    let mut rest = tag;
    loop {
        let at = rest.find(&needle)?;
        // A whole attribute name, not the tail of a longer one (`missing_as` vs `missing`).
        let before = rest[..at].chars().next_back();
        if before.is_none_or(|c| c.is_whitespace()) {
            let after = &rest[at + needle.len()..];
            let close = after.find('"')?;
            return Some(&after[..close]);
        }
        rest = &rest[at + needle.len()..];
    }
}

/// Parameter name → the width the pack's own sequence always produces.
pub fn parameter_widths(body: &str) -> BTreeMap<String, usize> {
    let mut out = BTreeMap::new();
    let mut rest = body;
    while let Some(at) = rest.find("<sequence") {
        rest = &rest[at + "<sequence".len()..];
        let Some(tag_end) = rest.find('>') else { break };
        let tag = &rest[..tag_end];
        let name = attr(tag, "name").map(str::to_string);
        rest = &rest[tag_end + 1..];
        let Some(close) = rest.find("</sequence>") else { break };
        let inner = &rest[..close];
        rest = &rest[close..];

        let Some(name) = name else { continue };
        // Exactly one `<gen>` and nothing else that produces a value: a compound
        // sequence, a <compute>, a <mix> or a <switch> has no single width to read.
        if inner.matches("<gen").count() != 1
            || ["<compute", "<mix", "<switch", "<case"]
                .iter()
                .any(|t| inner.contains(t))
        {
            continue;
        }
        let gen_at = inner.find("<gen").expect("counted one above");
        let after = &inner[gen_at + "<gen".len()..];
        let Some(gen_end) = after.find('>') else { continue };
        let gen_tag = &after[..gen_end];
        // A named <gen> is one field of a compound; repetition or formatting means the
        // bare width read below is no longer what the sequence produces.
        if ["name", "repeat", "mask", "missing"]
            .iter()
            .any(|a| attr(gen_tag, a).is_some())
        {
            continue;
        }
        let kind = attr(gen_tag, "type").unwrap_or("");
        let value = attr(gen_tag, "value").unwrap_or("");
        if let Some(width) = fixed_width(kind, value) {
            out.insert(name, width);
        }
    }
    out
}
