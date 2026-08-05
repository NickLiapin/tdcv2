//! The parse tree.
//!
//! ANTLR hands the other four implementations a context class per grammar rule
//! and they walk it with helpers. This is the same tree with the ceremony
//! removed: one `Element` with a `kind`, because nearly every question the
//! validator and the config builder ask is "the child named X, whatever kind it
//! is".
//!
//! Positions are carried on elements and on attributes, and both are load
//! bearing. A diagnostic about a whole tag points at its `<`; a diagnostic about
//! one attribute points at the first character **inside** its quotes, which is
//! where the value the message quotes actually begins. Every position in
//! `fixtures/cross-language/diagnostics/` is one of those two.

use super::lexer::{Comment, Pos};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// `<name …> … </name>`
    OpenClose,
    /// `<name … />`
    SelfClosing,
    /// `<data …> raw text </data>`, or `<data … />`
    Data,
    /// `<map …> raw text </map>`, or `<map … />`
    Map,
}

#[derive(Clone, Debug)]
pub struct Attr {
    pub name: String,
    /// The value with its quotes still on — what the position arithmetic needs.
    pub raw: String,
    /// Where the quoted value starts.
    pub value_pos: Pos,
    pub name_pos: Pos,
}

impl Attr {
    /// The value with the quotes taken off.
    pub fn value(&self) -> &str {
        let bytes = self.raw.as_bytes();
        if bytes.len() >= 2 && bytes[0] == b'"' && bytes[bytes.len() - 1] == b'"' {
            &self.raw[1..self.raw.len() - 1]
        } else {
            &self.raw
        }
    }

    /// Where a complaint about this value should point: the first character
    /// inside the quotes. An editor underlines what a diagnostic points at, and
    /// a whole tag is not what is wrong when one attribute is.
    pub fn at(&self) -> Pos {
        let quoted = self.raw.len() >= 2 && self.raw.starts_with('"') && self.raw.ends_with('"');
        Pos {
            line: self.value_pos.line,
            column: self.value_pos.column + i32::from(quoted),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Element {
    pub kind: Kind,
    /// `data` and `map` carry their own names, so a lookup by name works for
    /// every kind without the caller checking which it has.
    pub name: String,
    pub attrs: Vec<Attr>,
    /// Children of an `OpenClose`. Empty for every other kind — a raw-text
    /// body holds text, not elements, which is the whole point of `<data>`.
    pub children: Vec<Element>,
    /// The body of a `Data` or `Map`, verbatim.
    pub text: String,
    /// Whether a `Data` or `Map` was written `<data …/>` rather than
    /// `<data …></data>`.
    ///
    /// The two mean the same thing to every generator, and only the
    /// pretty-printer cares — but it has to write back the one the author wrote,
    /// or running the formatter would produce a diff in a file nobody edited.
    /// `OpenClose` and `SelfClosing` already say this for a tag element; a raw
    /// body has one kind covering both, so it says it here.
    pub self_closed: bool,
    /// Where the `<` is.
    pub pos: Pos,
    /// Where the element's LAST token begins — the `</name>`, the `/>`, the
    /// `</data>`.
    ///
    /// Only the pretty-printer needs it, to ask whether a comment sits inside
    /// this element and therefore stops it being written on one line. The start
    /// of the closing token rather than its end is enough for that: nothing can
    /// be inside a closing token.
    pub end: Pos,
}

impl Element {
    /// The first child element with this name, at any kind.
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.children.iter().find(|c| c.name == name)
    }

    /// Every child element with this name, in source order.
    pub fn children_named<'a>(&'a self, name: &'a str) -> impl Iterator<Item = &'a Element> + 'a {
        self.children.iter().filter(move |c| c.name == name)
    }

    pub fn attr(&self, name: &str) -> Option<&Attr> {
        self.attrs.iter().find(|a| a.name == name)
    }

    /// One attribute's value, unquoted.
    pub fn attr_value(&self, name: &str) -> Option<&str> {
        self.attr(name).map(Attr::value)
    }

    /// Where a complaint about `name` should point, falling back to the element
    /// itself. A complaint about a *missing* attribute has nowhere better to go.
    pub fn at(&self, name: &str) -> Pos {
        self.attr(name).map_or(self.pos, Attr::at)
    }

    /// The attributes as a map. Later duplicates win, as they do in every other
    /// implementation — the DSL has no rule against writing one twice.
    pub fn attr_map(&self) -> std::collections::BTreeMap<String, String> {
        self.attrs
            .iter()
            .map(|a| (a.name.clone(), a.value().to_string()))
            .collect()
    }
}

/// A whole file: elements at the top level.
///
/// Deliberately permissive, as the grammar is, so that a comment-only or empty
/// input parses and the *validator* is what says there is no `<tdc>`. Making
/// that a syntax error here would report it in the wrong voice and at the wrong
/// position — the shared fixture wants TDC001 at 1:0.
#[derive(Clone, Debug, Default)]
pub struct Document {
    pub elements: Vec<Element>,
    /// Every comment in the file, in source order.
    ///
    /// The parser drops them, as the grammar does — a comment means nothing to
    /// a generator. The pretty-printer is the one caller that needs them, and it
    /// puts them back by position rather than by tree position, because a
    /// comment does not belong to any element.
    pub comments: Vec<Comment>,
}

impl Document {
    pub fn child(&self, name: &str) -> Option<&Element> {
        self.elements.iter().find(|c| c.name == name)
    }
}

/// A `<gen>`, whichever way it was punctuated.
///
/// Four of the five implementations only ever looked for the SELF-CLOSING form,
/// so `<gen type="text" value="a,b"></gen>` — the ordinary alternative spelling —
/// was not seen as a generator at all, and the sequence was blamed for having
/// none: "has no <gen> child", about a <gen> standing in plain sight.
pub fn is_gen(el: &Element) -> bool {
    el.name == "gen" && el.kind != Kind::Data
}
