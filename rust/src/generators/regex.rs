//! `<gen type="regex" value="..."/>` — a value that matches a pattern.
//!
//! Deliberately not a regular-expression crate. Two reasons, and both are about
//! the product rather than about convenience:
//!
//! * This runs a pattern **forwards**, producing a string, where an engine runs
//!   one backwards to test a string. Nothing off the shelf does the forward
//!   direction.
//! * Every pattern here has a finite longest output, checked before a single
//!   value is made. `*` and `+` are rejected outright, and `.` means a printable
//!   ASCII character rather than "almost anything". A config that asked for an
//!   unbounded pattern would otherwise be a request for an arbitrarily large
//!   file.
//!
//! The subset is portable on purpose: no dialect quirks, no Unicode property
//! classes, no lookaround. What is accepted produces the same string from the
//! same seed in every implementation of TDC.

use std::collections::BTreeMap;
use std::sync::OnceLock;

use super::rand;
use crate::engine::{invalid, EngineResult};
use crate::prng::Sfc32;
use crate::unicode;

pub const DEFAULT_MAX_LENGTH: i32 = 32;

pub(super) fn digits() -> &'static [char] {
    static V: OnceLock<Vec<char>> = OnceLock::new();
    V.get_or_init(|| unicode::between('0', '9'))
}

pub(super) fn lower() -> &'static [char] {
    static V: OnceLock<Vec<char>> = OnceLock::new();
    V.get_or_init(|| unicode::between('a', 'z'))
}

pub(super) fn upper() -> &'static [char] {
    static V: OnceLock<Vec<char>> = OnceLock::new();
    V.get_or_init(|| unicode::between('A', 'Z'))
}

/// `.` — a printable ASCII character, not "almost anything".
pub(super) fn printable_ascii() -> &'static [char] {
    static V: OnceLock<Vec<char>> = OnceLock::new();
    V.get_or_init(|| unicode::between(' ', '~'))
}

pub(super) fn word() -> &'static [char] {
    static V: OnceLock<Vec<char>> = OnceLock::new();
    V.get_or_init(|| {
        let mut v = upper().to_vec();
        v.extend_from_slice(lower());
        v.extend_from_slice(digits());
        v.push('_');
        v
    })
}

pub(super) const SPACES: [char; 2] = [' ', '\t'];

// ── the tree ─────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum Node {
    Empty,
    Literal(char),
    Chars(Vec<char>),
    Sequence(Vec<Node>),
    Alternation(Vec<Node>),
    Repeat(Box<Node>, i32, i32),
    Capture(usize, Box<Node>, i64),
    Backref(usize),
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    document_max_length: i32,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    // A limit on the tag itself wins over the document's. That is how a pack can
    // ship a UUID pattern — 36 characters, well past the default 32 — without
    // every config having to raise its own ceiling to accommodate it.
    let limit = match attrs.get("regex_max_length") {
        Some(own) => parse_max_length(Some(own))?,
        None => document_max_length,
    };
    let root = compile(attrs.get("value").map(String::as_str).unwrap_or(""), limit)?;

    let mut result = Vec::with_capacity(count);
    for _ in 0..count {
        let mut captures = BTreeMap::new();
        result.push(render(&root, &mut captures, prng));
    }
    Ok(result)
}

pub fn compile(pattern: &str, regex_max_length: i32) -> EngineResult<Node> {
    let mut parser = Parser::new(pattern);
    let root = parser.parse()?;
    let max = max_length(&root, &parser.capture_max_lengths)?;
    if max > i64::from(regex_max_length) {
        return invalid(&format!(
            "regex can produce {max} characters, which exceeds \
             regex_max_length={regex_max_length}"
        ));
    }
    Ok(root)
}

pub fn parse_max_length(raw: Option<&str>) -> EngineResult<i32> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_MAX_LENGTH);
    };
    match raw.trim().parse::<i32>() {
        Ok(v) if v > 0 => Ok(v),
        _ => invalid(&format!(
            "regex_max_length must be a positive integer, got \"{raw}\""
        )),
    }
}

// ── generating ───────────────────────────────────────────────────────────────

fn render(node: &Node, captures: &mut BTreeMap<usize, String>, prng: &mut Sfc32) -> String {
    match node {
        Node::Empty => String::new(),
        Node::Literal(c) => c.to_string(),
        Node::Chars(values) => rand::pick(prng, values).to_string(),
        Node::Sequence(parts) => {
            // In order, always. Each part may take draws, so a different order is
            // different data.
            let mut text = String::new();
            for part in parts {
                text.push_str(&render(part, captures, prng));
            }
            text
        }
        Node::Alternation(choices) => {
            let at = (prng.next() * choices.len() as f64).floor() as usize;
            render(&choices[at.min(choices.len() - 1)], captures, prng)
        }
        Node::Repeat(inner, min, max) => {
            let times = rand::next_int(prng, *min, *max + 1);
            let mut text = String::new();
            for _ in 0..times.max(0) {
                text.push_str(&render(inner, captures, prng));
            }
            text
        }
        Node::Capture(index, inner, _) => {
            let value = render(inner, captures, prng);
            captures.insert(*index, value.clone());
            value
        }
        Node::Backref(index) => captures.get(index).cloned().unwrap_or_default(),
    }
}

/// The longest string the pattern can produce — computed before generating,
/// never after.
fn max_length(node: &Node, capture_max_lengths: &BTreeMap<usize, i64>) -> EngineResult<i64> {
    Ok(match node {
        Node::Empty => 0,
        Node::Literal(_) | Node::Chars(_) => 1,
        Node::Sequence(parts) => {
            let mut total = 0i64;
            for part in parts {
                total = guard(total + max_length(part, capture_max_lengths)?)?;
            }
            total
        }
        Node::Alternation(choices) => {
            let mut best = 0i64;
            for choice in choices {
                best = best.max(max_length(choice, capture_max_lengths)?);
            }
            best
        }
        Node::Repeat(inner, _, max) => {
            guard(max_length(inner, capture_max_lengths)?.saturating_mul(i64::from(*max)))?
        }
        Node::Capture(_, _, len) => *len,
        Node::Backref(index) => capture_max_lengths.get(index).copied().unwrap_or(0),
    })
}

fn guard(value: i64) -> EngineResult<i64> {
    if value < 0 || value > i64::from(i32::MAX) {
        return invalid("regex: maximum length is too large");
    }
    Ok(value)
}

// ── parsing ──────────────────────────────────────────────────────────────────

struct Parser {
    pattern: Vec<char>,
    pos: usize,
    capture_count: usize,
    closed_capture_count: usize,
    capture_max_lengths: BTreeMap<usize, i64>,
}

/// One entry inside `[...]`: the characters it contributes, and — when it is a
/// single character — the endpoint a `-` range may use.
struct ClassAtom {
    values: Vec<char>,
    single: Option<char>,
}

impl Parser {
    fn new(pattern: &str) -> Self {
        Self {
            pattern: pattern.chars().collect(),
            pos: 0,
            capture_count: 0,
            closed_capture_count: 0,
            capture_max_lengths: BTreeMap::new(),
        }
    }

    fn parse(&mut self) -> EngineResult<Node> {
        let node = self.alternation()?;
        if !self.at_end() {
            return self.error(&format!("unexpected \"{}\"", self.peek().unwrap_or(' ')));
        }
        Ok(node)
    }

    fn alternation(&mut self) -> EngineResult<Node> {
        let mut choices = vec![self.sequence()?];
        while self.peek() == Some('|') {
            self.pos += 1;
            choices.push(self.sequence()?);
        }
        Ok(if choices.len() == 1 {
            choices.pop().expect("just checked")
        } else {
            Node::Alternation(choices)
        })
    }

    fn sequence(&mut self) -> EngineResult<Node> {
        let mut parts = Vec::new();
        while let Some(ch) = self.peek() {
            if ch == ')' || ch == '|' {
                break;
            }
            parts.push(self.repeated_atom()?);
        }
        Ok(match parts.len() {
            0 => Node::Empty,
            1 => parts.pop().expect("just checked"),
            _ => Node::Sequence(parts),
        })
    }

    fn repeated_atom(&mut self) -> EngineResult<Node> {
        let atom = self.atom()?;
        match self.peek() {
            None => Ok(atom),
            Some('?') => {
                self.pos += 1;
                self.finish_repeat(atom, 0, 1)
            }
            Some('*') => self.error("unbounded \"*\" quantifier is not allowed; use \"{0,n}\""),
            Some('+') => self.error("unbounded \"+\" quantifier is not allowed; use \"{1,n}\""),
            Some('{') => self.bounded_repeat(atom),
            Some(_) => Ok(atom),
        }
    }

    fn finish_repeat(&mut self, node: Node, min: i32, max: i32) -> EngineResult<Node> {
        if max < min {
            return self.error(&format!("invalid quantifier bounds {{{min},{max}}}"));
        }
        match self.peek() {
            Some('?') => return self.error("lazy quantifiers are not supported"),
            Some('*') | Some('+') | Some('{') => {
                return self.error("stacked quantifiers are not supported")
            }
            _ => {}
        }
        Ok(Node::Repeat(Box::new(node), min, max))
    }

    fn bounded_repeat(&mut self, node: Node) -> EngineResult<Node> {
        self.expect('{')?;
        let min_text = self.digit_run();
        if min_text.is_empty() {
            return self.error("quantifier must start with a number");
        }
        let min = self.safe_int(&min_text)?;
        if self.peek() == Some('}') {
            self.pos += 1;
            return self.finish_repeat(node, min, min);
        }
        self.expect(',')?;
        let max_text = self.digit_run();
        if max_text.is_empty() {
            return self.error("unbounded \"{n,}\" quantifier is not allowed; use \"{n,m}\"");
        }
        let max = self.safe_int(&max_text)?;
        self.expect('}')?;
        self.finish_repeat(node, min, max)
    }

    fn atom(&mut self) -> EngineResult<Node> {
        match self.peek() {
            None => Ok(Node::Empty),
            Some('(') => self.group(),
            Some('[') => self.char_class(),
            Some('\\') => self.escape(),
            Some('.') => {
                self.pos += 1;
                Ok(chars_node(printable_ascii()))
            }
            // Anchors match a position rather than a character, and a generated
            // value is the whole string, so both are already true. They
            // contribute nothing.
            Some('^') | Some('$') => {
                self.pos += 1;
                Ok(Node::Empty)
            }
            Some(ch @ ('*' | '+' | '?' | '{')) => {
                self.error(&format!("quantifier \"{ch}\" has no target"))
            }
            Some(ch) => {
                self.pos += 1;
                Ok(Node::Literal(ch))
            }
        }
    }

    fn group(&mut self) -> EngineResult<Node> {
        self.expect('(')?;
        let mut capturing = true;
        if self.peek() == Some('?') {
            if self.peek_at(1) == Some(':') {
                self.pos += 2;
                capturing = false;
            } else {
                return self.error("lookaround, named, and conditional groups are not supported");
            }
        }

        let index = if capturing {
            self.capture_count += 1;
            self.capture_count
        } else {
            0
        };

        let node = self.alternation()?;
        self.expect(')')?;

        if !capturing {
            return Ok(node);
        }

        // A backreference is only legal once its group has closed, which is what
        // this tracks.
        self.closed_capture_count = self.closed_capture_count.max(index);
        let group_max = max_length(&node, &self.capture_max_lengths)?;
        self.capture_max_lengths.insert(index, group_max);
        Ok(Node::Capture(index, Box::new(node), group_max))
    }

    fn char_class(&mut self) -> EngineResult<Node> {
        self.expect('[')?;
        let negated = self.peek() == Some('^');
        if negated {
            self.pos += 1;
        }

        let mut collected: Vec<char> = Vec::new();
        let mut saw_atom = false;
        while let Some(ch) = self.peek() {
            if ch == ']' {
                break;
            }
            saw_atom = true;
            let start = self.read_class_atom()?;
            if self.peek() == Some('-') && self.peek_at(1).is_some() && self.peek_at(1) != Some(']')
            {
                self.pos += 1;
                let end = self.read_class_atom()?;
                let (Some(lo), Some(hi)) = (start.single, end.single) else {
                    return self
                        .error("character class ranges must use single-character endpoints");
                };
                if lo > hi {
                    return self.error(&format!("invalid character range \"{lo}-{hi}\""));
                }
                collected.extend(unicode::between(lo, hi));
            } else {
                collected.extend(start.values);
            }
        }

        self.expect(']')?;
        if !saw_atom {
            return self.error("empty character classes are not supported");
        }

        let final_chars = if negated {
            let excluded: Vec<char> = distinct(&collected);
            printable_ascii()
                .iter()
                .copied()
                .filter(|c| !excluded.contains(c))
                .collect()
        } else {
            distinct(&collected)
        };

        if final_chars.is_empty() {
            return self.error("character class has no available characters");
        }
        Ok(chars_node(&final_chars))
    }

    fn read_class_atom(&mut self) -> EngineResult<ClassAtom> {
        let Some(ch) = self.peek() else {
            return self.error("unterminated character class");
        };
        if ch == '\\' {
            return self.class_escape();
        }
        self.pos += 1;
        Ok(ClassAtom {
            values: vec![ch],
            single: Some(ch),
        })
    }

    fn class_escape(&mut self) -> EngineResult<ClassAtom> {
        self.expect('\\')?;
        let ch = self.escaped_char()?;
        let set = |values: Vec<char>| {
            Ok(ClassAtom {
                values,
                single: None,
            })
        };
        match ch {
            'd' => set(digits().to_vec()),
            'D' => set(inverse(digits())),
            'w' => set(word().to_vec()),
            'W' => set(inverse(word())),
            's' => set(SPACES.to_vec()),
            'S' => set(inverse(&SPACES)),
            'a' => {
                if self.peek() != Some('{') {
                    Ok(ClassAtom {
                        values: vec![ch],
                        single: Some(ch),
                    })
                } else {
                    set(self.named_alphabet()?)
                }
            }
            'n' | 'r' => self.error("multiline escapes are not supported"),
            't' => Ok(ClassAtom {
                values: vec!['\t'],
                single: Some('\t'),
            }),
            'p' | 'P' => self.error("Unicode property classes are not supported"),
            _ => Ok(ClassAtom {
                values: vec![ch],
                single: Some(ch),
            }),
        }
    }

    fn escape(&mut self) -> EngineResult<Node> {
        self.expect('\\')?;
        let ch = self.escaped_char()?;
        if ch.is_ascii_digit() {
            let index_text = format!("{ch}{}", self.digit_run());
            let index = self.safe_int(&index_text)?;
            if index <= 0 || index as usize > self.closed_capture_count {
                return self.error(&format!(
                    "backreference \"\\{index_text}\" points to a group that is not generated yet"
                ));
            }
            return Ok(Node::Backref(index as usize));
        }

        match ch {
            'd' => Ok(chars_node(digits())),
            'D' => Ok(chars_node(&inverse(digits()))),
            'w' => Ok(chars_node(word())),
            'W' => Ok(chars_node(&inverse(word()))),
            's' => Ok(chars_node(&SPACES)),
            'S' => Ok(chars_node(&inverse(&SPACES))),
            'a' => {
                if self.peek() != Some('{') {
                    Ok(Node::Literal(ch))
                } else {
                    let alphabet = self.named_alphabet()?;
                    Ok(chars_node(&alphabet))
                }
            }
            'n' | 'r' => self.error("multiline escapes are not supported"),
            't' => Ok(Node::Literal('\t')),
            'p' | 'P' => self.error("Unicode property classes are not supported"),
            _ => Ok(Node::Literal(ch)),
        }
    }

    /// `\a{name}` — a named alphabet, the escape that has no equivalent anywhere else.
    fn named_alphabet(&mut self) -> EngineResult<Vec<char>> {
        self.expect('{')?;
        let mut name = String::new();
        while let Some(ch) = self.peek() {
            if ch == '}' {
                break;
            }
            name.push(ch);
            self.pos += 1;
        }
        self.expect('}')?;

        if name.is_empty() {
            return self.error("alphabet escape \"\\a{...}\" requires a non-empty name");
        }
        // `^[A-Za-z0-9._-]+$`
        if !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'_' || b == b'-')
        {
            return self.error(&format!("invalid alphabet name \"{name}\""));
        }
        match unicode::chars(&name) {
            Some(resolved) => Ok(resolved.to_vec()),
            None => self.error(&format!("unknown alphabet \"{name}\"")),
        }
    }

    fn escaped_char(&mut self) -> EngineResult<char> {
        let Some(ch) = self.peek() else {
            return self.error("dangling escape at end of pattern");
        };
        self.pos += 1;
        Ok(ch)
    }

    fn digit_run(&mut self) -> String {
        let mut text = String::new();
        while let Some(ch) = self.peek() {
            if !ch.is_ascii_digit() {
                break;
            }
            text.push(ch);
            self.pos += 1;
        }
        text
    }

    fn expect(&mut self, expected: char) -> EngineResult<()> {
        match self.peek() {
            Some(actual) if actual == expected => {
                self.pos += 1;
                Ok(())
            }
            Some(actual) => self.error(&format!("expected \"{expected}\" but found \"{actual}\"")),
            None => self.error(&format!(
                "expected \"{expected}\" but found \"end of pattern\""
            )),
        }
    }

    fn at_end(&self) -> bool {
        self.pos >= self.pattern.len()
    }

    fn peek(&self) -> Option<char> {
        self.pattern.get(self.pos).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<char> {
        self.pattern.get(self.pos + ahead).copied()
    }

    fn safe_int(&self, text: &str) -> EngineResult<i32> {
        match text.parse::<i32>() {
            Ok(v) if v >= 0 => Ok(v),
            _ => self.error(&format!("invalid quantifier number \"{text}\"")),
        }
    }

    fn error<T>(&self, message: &str) -> EngineResult<T> {
        invalid(&format!("regex: {message} at offset {}", self.pos))
    }
}

fn chars_node(values: &[char]) -> Node {
    Node::Chars(distinct(values))
}

/// Duplicates removed, first occurrence kept — the order is what a draw index
/// means.
pub(super) fn distinct(values: &[char]) -> Vec<char> {
    let mut seen = std::collections::BTreeSet::new();
    values.iter().copied().filter(|c| seen.insert(*c)).collect()
}

pub(super) fn inverse(excluded: &[char]) -> Vec<char> {
    printable_ascii()
        .iter()
        .copied()
        .filter(|c| !excluded.contains(c))
        .collect()
}
