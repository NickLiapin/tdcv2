//! Turning TDC source text into a parse tree.
//!
//! The grammar lives in `../grammar`, the same two files every other
//! implementation generates its parser from. Keeping one grammar is what stops
//! the languages slowly accepting different dialects of the same thing — so
//! this parser is written *from* those files, rule by rule, rather than
//! designed afresh.
//!
//! Syntax errors are collected, never printed. A config that half-parsed would
//! produce data that looks plausible and is not what was asked for, so the
//! caller decides what to do with them.

pub mod ast;
pub mod config_builder;
pub mod lexer;
pub mod paired_data;

use ast::{Attr, Document, Element, Kind};
use lexer::{Pos, Tok, Token};

/// One syntax error, with the position a person can act on.
#[derive(Clone, Debug)]
pub struct SyntaxProblem {
    pub line: i32,
    pub column: i32,
    pub message: String,
}

impl std::fmt::Display for SyntaxProblem {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}:{} {}", self.line, self.column, self.message)
    }
}

/// A parse tree plus whatever went wrong producing it.
#[derive(Debug)]
pub struct ParseResult {
    pub tree: Document,
    pub problems: Vec<SyntaxProblem>,
}

impl ParseResult {
    pub fn ok(&self) -> bool {
        self.problems.is_empty()
    }
}

/// Parse a config, collecting syntax errors rather than printing them.
pub fn parse(source: &str) -> ParseResult {
    let rewritten = paired_data::preprocess(source);
    let lexed = lexer::tokenize(&rewritten.source);

    // Ahead of the lexer's own, because they were found ahead of it: a config
    // whose paired tags do not line up is misread from that point on, and the
    // first thing said about it should say why.
    let mut problems: Vec<SyntaxProblem> = rewritten.problems;
    problems.extend(lexed.errors.into_iter().map(|e| SyntaxProblem {
        line: e.pos.line,
        column: e.pos.column,
        message: e.message,
    }));

    let mut p = Parser {
        tokens: lexed.tokens,
        at: 0,
        depth: 0,
        gave_up: false,
        problems: &mut problems,
    };
    let mut tree = p.document();
    tree.comments = lexed.comments;
    ParseResult { tree, problems }
}

/// A hard ceiling on element nesting. The parser recurses once per nested
/// element, so input depth IS stack depth: a runaway document must be refused,
/// not parsed until the stack gives out — which in Rust aborts the process.
/// Real configs nest a handful of levels.
const MAX_ELEMENT_DEPTH: usize = 64;

struct Parser<'a> {
    tokens: Vec<Token>,
    at: usize,
    depth: usize,
    /// Set when nothing past this point can be judged any more — the nesting
    /// ceiling, or input that simply ran out. One refusal is the whole story;
    /// everything after it would be noise.
    gave_up: bool,
    problems: &'a mut Vec<SyntaxProblem>,
}

impl Parser<'_> {
    fn peek(&self) -> &Tok {
        &self.tokens[self.at.min(self.tokens.len() - 1)].tok
    }

    fn pos(&self) -> Pos {
        self.tokens[self.at.min(self.tokens.len() - 1)].pos
    }

    /// Where the token just consumed began.
    ///
    /// An element's `end`. The START of its closing token rather than the end is
    /// enough for the one question that field answers — whether a comment sits
    /// inside the element — because nothing can sit inside a closing token.
    fn last_pos(&self) -> Pos {
        self.tokens[self.at.saturating_sub(1).min(self.tokens.len() - 1)].pos
    }

    fn bump(&mut self) -> Tok {
        let tok = self.tokens[self.at.min(self.tokens.len() - 1)].tok.clone();
        if self.at < self.tokens.len() - 1 {
            self.at += 1;
        }
        tok
    }

    fn error(&mut self, message: impl Into<String>) {
        if self.gave_up {
            return;
        }
        let pos = self.pos();
        self.problems.push(SyntaxProblem {
            line: pos.line,
            column: pos.column,
            message: message.into(),
        });
    }

    /// `document : element* EOF ;`
    fn document(&mut self) -> Document {
        let mut elements = Vec::new();
        while !matches!(self.peek(), Tok::Eof) {
            match self.element() {
                Some(el) => elements.push(el),
                None => {
                    // Nothing here starts an element. Report once and step over
                    // it, so one stray character does not hide the rest of the
                    // file's problems behind a single message.
                    let stray = self.describe(self.peek());
                    self.error(format!("extraneous input {stray} expecting an element"));
                    self.bump();
                }
            }
        }
        Document {
            elements,
            comments: Vec::new(),
        }
    }

    /// `</gen>` to `gen`. The lexer only ever builds an `EndTag` from a well
    /// formed `</name>`, so the trimming cannot fail — but it stays total
    /// rather than indexing, because a panic here would be a parser crash on
    /// input a user typed.
    fn closing_name(text: &str) -> &str {
        text.strip_prefix("</")
            .and_then(|rest| rest.strip_suffix('>'))
            .unwrap_or(text)
    }

    fn describe(&self, tok: &Tok) -> String {
        match tok {
            Tok::Eof => "'<EOF>'".to_string(),
            Tok::EndTag(text) => format!("'{text}'"),
            Tok::Name(text) => format!("'{text}'"),
            Tok::Str(text) => format!("'{text}'"),
            Tok::Lt => "'<'".to_string(),
            Tok::Gt => "'>'".to_string(),
            Tok::Eq => "'='".to_string(),
            Tok::SlashGt => "'/>'".to_string(),
            Tok::DataTagOpen => "'<data'".to_string(),
            Tok::MapTagOpen => "'<map'".to_string(),
            Tok::DataClose => "'</data>'".to_string(),
            Tok::MapClose => "'</map>'".to_string(),
            Tok::DataText(c) | Tok::MapText(c) => format!("'{c}'"),
        }
    }

    /// `element : dataElement | mapElement | openCloseElement | selfClosingElement ;`
    fn element(&mut self) -> Option<Element> {
        if !matches!(self.peek(), Tok::DataTagOpen | Tok::MapTagOpen | Tok::Lt) {
            return None;
        }
        if self.depth >= MAX_ELEMENT_DEPTH {
            // Refuse the 65th level while the stack is still shallow, then jump
            // to EOF so the one refusal is the whole story — not the first of
            // fifty thousand complaints about the tokens behind it.
            self.error(format!(
                "elements nested deeper than {MAX_ELEMENT_DEPTH} levels — refusing a runaway document"
            ));
            self.gave_up = true;
            self.at = self.tokens.len().saturating_sub(1);
            return None;
        }
        self.depth += 1;
        let element = match self.peek() {
            Tok::DataTagOpen => Some(self.raw_element(Kind::Data, "data")),
            Tok::MapTagOpen => Some(self.raw_element(Kind::Map, "map")),
            Tok::Lt => Some(self.tag_element()),
            _ => unreachable!("guarded by the match above"),
        };
        self.depth -= 1;
        element
    }

    /// `attr : attrName=NAME EQ attrValue=STRING ;`, repeated.
    fn attrs(&mut self) -> Vec<Attr> {
        let mut attrs = Vec::new();
        while let Tok::Name(_) = self.peek() {
            let name_pos = self.pos();
            let Tok::Name(name) = self.bump() else {
                unreachable!("guarded by the match above")
            };
            if !matches!(self.peek(), Tok::Eq) {
                self.error(format!("attribute \"{name}\" is missing its '='"));
                continue;
            }
            self.bump();
            let value_pos = self.pos();
            let Tok::Str(raw) = self.peek().clone() else {
                self.error(format!("attribute \"{name}\" is missing its quoted value"));
                continue;
            };
            self.bump();
            attrs.push(Attr {
                name,
                raw,
                value_pos,
                name_pos,
            });
        }
        attrs
    }

    /// `openCloseElement : LT NAME attr* GT content END_TAG ;`
    /// `selfClosingElement : LT NAME attr* SLASH_GT ;`
    ///
    /// One function, because the two share everything up to the character that
    /// tells them apart.
    fn tag_element(&mut self) -> Element {
        let pos = self.pos();
        self.bump(); // '<'
        let name = match self.peek().clone() {
            Tok::Name(name) => {
                self.bump();
                name
            }
            other => {
                let what = self.describe(&other);
                self.error(format!("expected a tag name, found {what}"));
                String::new()
            }
        };
        let attrs = self.attrs();

        if matches!(self.peek(), Tok::SlashGt) {
            self.bump();
            return Element {
                kind: Kind::SelfClosing,
                name,
                attrs,
                children: Vec::new(),
                text: String::new(),
                self_closed: true,
                pos,
                end: self.last_pos(),
            };
        }

        if matches!(self.peek(), Tok::Gt) {
            self.bump();
        } else {
            let what = self.describe(self.peek());
            self.error(format!("expected '>' or '/>' in <{name}>, found {what}"));
        }

        // `content : element* ;` — up to the closing tag.
        let mut children = Vec::new();
        loop {
            match self.peek() {
                Tok::Eof => {
                    // Every element still open is unclosed once the input runs
                    // out, so naming them all says nothing the first one did
                    // not. The other four report one complaint here; a stack of
                    // them would be four implementations disagreeing about a
                    // file none of them can read.
                    self.error(format!("<{name}> is never closed"));
                    self.gave_up = true;
                    break;
                }
                Tok::EndTag(text) => {
                    // The grammar's END_TAG takes ANY name, so `<sequence>…</gen>`
                    // parsed and nothing downstream ever compared the two: the
                    // element is built under its OPENING name and the closing tag
                    // is thrown away. `gave_up` because one misplaced closing tag
                    // shifts every closing tag below it, and all of those describe
                    // the same typo.
                    let text = text.clone();
                    let closes = Self::closing_name(&text);
                    if closes != name {
                        let opened = pos.line;
                        self.error(format!(
                            "</{closes}> closes <{name}>, which was opened on line {opened}"
                        ));
                        self.gave_up = true;
                    }
                    self.bump();
                    break;
                }
                _ => match self.element() {
                    Some(child) => children.push(child),
                    None => {
                        let stray = self.describe(self.peek());
                        self.error(format!("extraneous input {stray} inside <{name}>"));
                        self.bump();
                    }
                },
            }
        }

        Element {
            kind: Kind::OpenClose,
            name,
            attrs,
            children,
            text: String::new(),
            self_closed: false,
            pos,
            end: self.last_pos(),
        }
    }

    /// `dataElement` and `mapElement` — identical but for which raw-text tokens
    /// their bodies are made of.
    fn raw_element(&mut self, kind: Kind, name: &str) -> Element {
        let pos = self.pos();
        self.bump(); // '<data' or '<map'
        let attrs = self.attrs();

        if matches!(self.peek(), Tok::SlashGt) {
            self.bump();
            return Element {
                kind,
                name: name.to_string(),
                attrs,
                children: Vec::new(),
                text: String::new(),
                self_closed: true,
                pos,
                end: self.last_pos(),
            };
        }

        if matches!(self.peek(), Tok::Gt) {
            self.bump();
        } else {
            let what = self.describe(self.peek());
            self.error(format!("expected '>' or '/>' in <{name}>, found {what}"));
        }

        // The body is one token per character; put it back together.
        let mut text = String::new();
        loop {
            match self.peek() {
                Tok::DataText(c) | Tok::MapText(c) => {
                    let c = *c;
                    self.bump();
                    text.push(c);
                }
                Tok::DataClose | Tok::MapClose => {
                    self.bump();
                    break;
                }
                Tok::Eof => {
                    self.error(format!("<{name}> is never closed"));
                    self.gave_up = true;
                    break;
                }
                _ => {
                    // Unreachable while the lexer is in a raw-text mode, which
                    // it is until the closer. Reported rather than panicked on:
                    // a malformed file is a diagnostic, never a crash.
                    let what = self.describe(self.peek());
                    self.error(format!("unexpected {what} inside <{name}>"));
                    self.bump();
                }
            }
        }

        Element {
            kind,
            name: name.to_string(),
            attrs,
            children: Vec::new(),
            // Only a `<data>` body can hold the sentinel, and a `<map>` body that
            // happens to spell it out is text the user typed, not a rewrite.
            text: if kind == Kind::Data {
                paired_data::restore(&text)
            } else {
                text
            },
            self_closed: false,
            pos,
            end: self.last_pos(),
        }
    }
}
