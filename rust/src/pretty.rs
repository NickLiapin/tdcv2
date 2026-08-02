//! Pretty-printer for `.tdc` documents. `TdcFormatter` in the other four.
//!
//! Re-emits the parsed tree with consistent indentation, tidy attribute spacing,
//! inline output rows, and an aligned `<map>` table. Built to be SAFE: the
//! formatted text must generate byte-identical output to the original.
//!
//! Preserved verbatim: `<data>` bodies (that is literal generator output),
//! comments put back from the lexer's side channel by position, and attribute
//! order and values. Normalized: indentation at four spaces a level, a single
//! space between attributes, and `<map>` rows on one line when short or as an
//! aligned table when not.
//!
//! A document with a syntax error is returned unchanged. Never reformat a file
//! that cannot be fully parsed — the output would be a guess about what the
//! author meant.
//!
//! The five implementations must produce the same bytes: a team using two of
//! them would otherwise get a formatting diff on every commit, which is exactly
//! the churn a formatter exists to end.

use crate::parser::ast::{Attr, Document, Element, Kind};
use crate::parser::lexer::{Comment, Pos};
use crate::parser::{self};

const INDENT: &str = "    ";

/// Longest an inlined element may be before it wraps.
const INLINE_MAX: usize = 100;

/// Longest a one-line `<map>` may be before it becomes a table.
const MAP_INLINE_MAX: usize = 72;

/// Tags whose children always go on their own indented lines.
const BLOCK_TAGS: &[&str] = &[
    "tdc",
    "env",
    "block",
    "sequence",
    "mix",
    "switch",
    "distinct",
    "uniq",
    "before",
    "after",
    "before_block",
    "after_block",
    "delimiter_block",
    "before_line",
    "after_line",
    "delimiter_line",
];

fn is_block(name: &str) -> bool {
    BLOCK_TAGS.contains(&name)
}

/// A formatted config, or the source unchanged when it does not parse.
pub fn format(source: &str) -> String {
    let parsed = parser::parse(source);
    if !parsed.ok() {
        return source.to_string();
    }
    print(&parsed.tree)
}

/// The same, over a tree already parsed — what a caller with diagnostics in hand
/// uses, so the file is not parsed twice.
pub fn print(tree: &Document) -> String {
    let mut out = Printer {
        lines: Vec::new(),
        comments: &tree.comments,
        next: 0,
    };
    for element in &tree.elements {
        out.flush_comments_before(element.pos, 0);
        out.element(element, 0);
    }
    out.flush_comments_before(END_OF_FILE, 0);
    out.lines.join("\n") + "\n"
}

/// Past anything a real position can be, for the final flush.
const END_OF_FILE: Pos = Pos {
    line: i32::MAX,
    column: i32::MAX,
};

/// Source order, the way a reader reads: down the lines, then along one.
fn before(a: Pos, b: Pos) -> bool {
    (a.line, a.column) < (b.line, b.column)
}

struct Printer<'a> {
    lines: Vec<String>,
    comments: &'a [Comment],
    /// How many comments have been emitted. They come out in source order and
    /// each one exactly once, so a cursor is all the bookkeeping needed.
    next: usize,
}

impl Printer<'_> {
    fn flush_comments_before(&mut self, position: Pos, depth: usize) {
        while let Some(comment) = self.comments.get(self.next) {
            if !before(comment.pos, position) {
                break;
            }
            self.lines.push(indent(depth) + &comment.text);
            self.next += 1;
        }
    }

    fn element(&mut self, element: &Element, depth: usize) {
        match element.kind {
            Kind::Map => self.map(element, depth),
            Kind::Data => self.lines.push(indent(depth) + &data_string(element)),
            Kind::SelfClosing => self.lines.push(format!(
                "{}<{}{}/>",
                indent(depth),
                element.name,
                attrs(element)
            )),
            Kind::OpenClose => self.open_close(element, depth),
        }
    }

    fn open_close(&mut self, element: &Element, depth: usize) {
        let open_tag = format!("<{}{}>", element.name, attrs(element));
        let pad = indent(depth);

        if element.children.is_empty() {
            self.lines
                .push(format!("{pad}{open_tag}</{}>", element.name));
            return;
        }

        // A comment inside stops the element being written on one line: there is
        // nowhere on that line to put it, and dropping it is not an option.
        let inline = if is_block(&element.name) || self.has_comment_within(element) {
            None
        } else {
            try_inline_open(element)
        };
        if let Some(inline) = inline {
            if pad.chars().count() + inline.chars().count() <= INLINE_MAX {
                self.lines.push(pad + &inline);
                return;
            }
        }

        self.lines.push(format!("{pad}{open_tag}"));
        for child in &element.children {
            self.flush_comments_before(child.pos, depth + 1);
            self.element(child, depth + 1);
        }
        self.lines.push(format!("{pad}</{}>", element.name));
    }

    fn has_comment_within(&self, element: &Element) -> bool {
        self.comments
            .iter()
            .any(|c| before(element.pos, c.pos) && before(c.pos, element.end))
    }

    fn map(&mut self, element: &Element, depth: usize) {
        let pad = indent(depth);
        let rows = map_rows(element);
        if rows.is_empty() {
            self.lines
                .push(format!("{pad}<map{}></map>", attrs(element)));
            return;
        }

        let inline = inline_map(element, &rows);
        if rows.len() <= 1 || pad.chars().count() + inline.chars().count() <= MAP_INLINE_MAX {
            self.lines.push(pad + &inline);
            return;
        }

        // An aligned table: keys padded to the widest, a " : " separator, and a
        // trailing comma on all but the last row — the map reader splits on
        // commas.
        let width = rows
            .iter()
            .map(|r| r.keys.chars().count())
            .max()
            .unwrap_or(0);
        self.lines.push(format!("{pad}<map{}>", attrs(element)));
        for (i, row) in rows.iter().enumerate() {
            let comma = if i + 1 < rows.len() { "," } else { "" };
            let padding = " ".repeat(width - row.keys.chars().count());
            self.lines.push(format!(
                "{pad}{INDENT}{}{padding} : {}{comma}",
                row.keys, row.value
            ));
        }
        self.lines.push(format!("{pad}</map>"));
    }
}

fn indent(depth: usize) -> String {
    INDENT.repeat(depth)
}

/// One-line rendering, or `None` when the element must span several.
fn try_inline(element: &Element) -> Option<String> {
    match element.kind {
        Kind::Map => Some(inline_map(element, &map_rows(element))),
        Kind::Data => Some(data_string(element)),
        Kind::SelfClosing => Some(format!("<{}{}/>", element.name, attrs(element))),
        Kind::OpenClose => try_inline_open(element),
    }
}

fn try_inline_open(element: &Element) -> Option<String> {
    if is_block(&element.name) {
        return None;
    }
    let open_tag = format!("<{}{}>", element.name, attrs(element));
    if element.children.is_empty() {
        return Some(format!("{open_tag}</{}>", element.name));
    }

    let mut inner = String::new();
    for child in &element.children {
        inner.push_str(&try_inline(child)?);
    }
    Some(format!("{open_tag}{inner}</{}>", element.name))
}

// ── <data> ───────────────────────────────────────────────────────────────────

fn data_string(element: &Element) -> String {
    // A self-closing `<data …/>` has no body — and is written back the way it
    // was written, because `<data></data>` means the same and is not the same
    // bytes.
    if element.self_closed {
        return format!("<data{}/>", attrs(element));
    }
    let close = match element.attr_value("pair") {
        Some(pair) => format!("</data pair=\"{pair}\">"),
        None => "</data>".to_string(),
    };
    format!("<data{}>{}{close}", attrs(element), element.text)
}

// ── <map> ────────────────────────────────────────────────────────────────────

struct Row {
    keys: String,
    value: String,
}

fn map_rows(element: &Element) -> Vec<Row> {
    let mut rows = Vec::new();
    for raw in element.text.split(',') {
        let row = raw.trim();
        if row.is_empty() {
            continue;
        }
        let Some(colon) = row.find(':') else { continue };
        let keys: Vec<&str> = row[..colon]
            .split('|')
            .map(str::trim)
            .filter(|part| !part.is_empty())
            .collect();
        if keys.is_empty() {
            continue;
        }
        rows.push(Row {
            keys: keys.join("|"),
            value: row[colon + 1..].trim().to_string(),
        });
    }
    rows
}

fn inline_map(element: &Element, rows: &[Row]) -> String {
    let parts: Vec<String> = rows
        .iter()
        .map(|r| format!("{}:{}", r.keys, r.value))
        .collect();
    format!("<map{}>{}</map>", attrs(element), parts.join(", "))
}

// ── attributes ───────────────────────────────────────────────────────────────

/// The attributes, in the order they were written, one space apart.
///
/// A later duplicate wins, as it does everywhere else in the DSL, and the
/// earlier one is dropped rather than emitted twice.
fn attrs(element: &Element) -> String {
    let mut seen: Vec<&Attr> = Vec::new();
    for attr in &element.attrs {
        if attr.name.is_empty() {
            continue;
        }
        match seen.iter().position(|a| a.name == attr.name) {
            Some(at) => seen[at] = attr,
            None => seen.push(attr),
        }
    }
    seen.iter()
        .map(|a| format!(" {}=\"{}\"", a.name, a.value()))
        .collect()
}
