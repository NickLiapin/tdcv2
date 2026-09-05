//! `<gen type="advanced_regex" .../>` — the same finite subset, plus exact shares.
//!
//! `(?%{70:RU;20:US;10:DE})`
//!
//! Seventy per cent of the column reads `RU`, exactly — not "seventy per cent on
//! average". Branches are themselves full patterns, so a weighted choice can hold
//! a weighted choice.
//!
//! It lives beside the plain `regex` generator rather than inside it, because an
//! exact share is only meaningful over a whole column. That forces a different
//! way of generating: every row is built **together**, level by level, with rows
//! bucketed by the branch they were assigned. The plain generator builds one
//! value at a time and never has to know how many rows there are.
//!
//! A consequence worth stating: the two dialects consume the generator in
//! different orders, so the same pattern produces different data under `regex`
//! and `advanced_regex`. That is not a defect to be reconciled — it follows from
//! what an exact share requires.

use std::collections::BTreeMap;

use super::rand;
use super::regex::{self, distinct, inverse, printable_ascii, SPACES};
use crate::engine::{invalid, EngineResult};
use crate::numbers;
use crate::prng::Sfc32;
use crate::stats::hamilton;
use crate::unicode;

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
    Weighted(Vec<Branch>),
    /// `(?if{sex=male:MR;sex=female:MS})` — pick a branch from what an EARLIER
    /// named group produced on this row.
    ///
    /// The one construct here that reads rather than draws. Everything else
    /// decides a row from randomness alone, which is why a pattern could describe
    /// an address or an identifier but never a title that agrees with a sex
    /// chosen two characters earlier.
    Conditional(Vec<CondBranch>),
}

#[derive(Clone, Debug)]
pub struct Branch {
    pub percent: f64,
    pub inner: Node,
}

#[derive(Clone, Debug)]
pub struct CondBranch {
    /// Which capture to read and what it must equal; `None` is the `*` branch,
    /// which always matches.
    ///
    /// Branches are tried in the order written and the first match wins, so a `*`
    /// is an "otherwise" wherever it stands — and a row matching NO branch
    /// produces nothing at all, which is what `*` exists to prevent.
    pub test: Option<(usize, String)>,
    pub inner: Node,
}

/// One row under construction: what it has so far, and what its groups captured.
#[derive(Default)]
struct RowState {
    out: String,
    captures: BTreeMap<usize, String>,
}

pub fn generate(
    attrs: &BTreeMap<String, String>,
    count: usize,
    document_max_length: i32,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let limit = match attrs.get("regex_max_length") {
        Some(own) => regex::parse_max_length(Some(own))?,
        None => document_max_length,
    };
    let root = compile(attrs.get("value").map(String::as_str).unwrap_or(""), limit)?;

    let mut rows: Vec<RowState> = (0..count).map(|_| RowState::default()).collect();
    let all: Vec<usize> = (0..count).collect();
    generate_into(&root, &mut rows, &all, prng);
    Ok(rows.into_iter().map(|r| r.out).collect())
}

pub fn compile(pattern: &str, regex_max_length: i32) -> EngineResult<Node> {
    let mut parser = Parser::new(pattern);
    let root = parser.parse()?;
    let max = max_length(&root, &parser.capture_max_lengths)?;
    if max > i64::from(regex_max_length) {
        return invalid(&format!(
            "advanced_regex can produce {max} characters, which exceeds \
             regex_max_length={regex_max_length}"
        ));
    }
    Ok(root)
}

/// Whether a pattern uses a weighted choice — the thing that needs a whole
/// column at once.
///
/// A malformed pattern is not this question's business; the real parse error
/// surfaces when the generator runs.
pub fn has_weighted_choice(pattern: &str) -> bool {
    let mut parser = Parser::new(pattern);
    match parser.parse() {
        Ok(_) => parser.weighted_choice_count > 0,
        Err(_) => false,
    }
}

// ── generating, a level at a time across every row ────────────────────────────

fn generate_into(node: &Node, rows: &mut [RowState], at: &[usize], prng: &mut Sfc32) {
    if at.is_empty() {
        return;
    }
    match node {
        Node::Empty => {}
        Node::Literal(c) => {
            for &i in at {
                rows[i].out.push(*c);
            }
        }
        Node::Chars(values) => {
            for &i in at {
                let c = rand::pick(prng, values);
                rows[i].out.push(c);
            }
        }
        Node::Sequence(parts) => {
            for part in parts {
                generate_into(part, rows, at, prng);
            }
        }
        Node::Alternation(choices) => {
            // Assign every row a branch first, then run each branch once over its
            // own rows.
            let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); choices.len()];
            for &i in at {
                let pick = rand::next_int(prng, 0, choices.len() as i32);
                buckets[(pick.max(0) as usize).min(choices.len() - 1)].push(i);
            }
            for (choice, bucket) in choices.iter().zip(&buckets) {
                generate_into(choice, rows, bucket, prng);
            }
        }
        Node::Repeat(inner, min, max) => {
            let counts: Vec<i32> = at
                .iter()
                .map(|_| rand::next_int(prng, *min, *max + 1))
                .collect();
            // One pass per repetition, over the rows still repeating — so every
            // row's first repetition is drawn before any row's second.
            for step in 0..*max {
                let active: Vec<usize> = at
                    .iter()
                    .zip(&counts)
                    .filter(|(_, &n)| n > step)
                    .map(|(&i, _)| i)
                    .collect();
                generate_into(inner, rows, &active, prng);
            }
        }
        Node::Capture(index, inner, _) => {
            let starts: Vec<usize> = at.iter().map(|&i| rows[i].out.len()).collect();
            generate_into(inner, rows, at, prng);
            for (&i, &start) in at.iter().zip(&starts) {
                let value = rows[i].out[start..].to_string();
                rows[i].captures.insert(*index, value);
            }
        }
        Node::Backref(index) => {
            for &i in at {
                let value = rows[i].captures.get(index).cloned().unwrap_or_default();
                rows[i].out.push_str(&value);
            }
        }
        Node::Weighted(choices) => {
            // The reason this generator exists: an exact apportionment over the
            // column, the same Hamilton machinery percent= uses, rather than an
            // independent draw per row.
            let indexes: Vec<usize> = (0..choices.len()).collect();
            let percents: Vec<f64> = choices.iter().map(|b| b.percent).collect();
            let selected = hamilton::distribute(at.len() as i32, &indexes, &percents, prng);

            let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); choices.len()];
            for (&i, &which) in at.iter().zip(&selected) {
                buckets[which].push(i);
            }
            for (branch, bucket) in choices.iter().zip(&buckets) {
                generate_into(&branch.inner, rows, bucket, prng);
            }
        }
        Node::Conditional(branches) => {
            // Each row to the FIRST branch it passes, then the branches in the
            // order written. Rows that pass no branch are left untouched —
            // nothing is appended — which is the only honest answer when the
            // pattern says nothing about the value the row actually holds.
            let mut buckets: Vec<Vec<usize>> = vec![Vec::new(); branches.len()];
            for &i in at {
                for (b, branch) in branches.iter().enumerate() {
                    let hit = match &branch.test {
                        None => true,
                        Some((capture, want)) => {
                            rows[i]
                                .captures
                                .get(capture)
                                .map(String::as_str)
                                .unwrap_or("")
                                == want
                        }
                    };
                    if hit {
                        buckets[b].push(i);
                        break;
                    }
                }
            }
            for (branch, bucket) in branches.iter().zip(&buckets) {
                generate_into(&branch.inner, rows, bucket, prng);
            }
        }
    }
}

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
        Node::Weighted(choices) => {
            let mut best = 0i64;
            for branch in choices {
                best = best.max(max_length(&branch.inner, capture_max_lengths)?);
            }
            best
        }
        // The longest branch: a row takes exactly one of them, so the widest the
        // conditional can be is the widest branch — never their sum.
        Node::Conditional(branches) => {
            let mut best = 0i64;
            for branch in branches {
                best = best.max(max_length(&branch.inner, capture_max_lengths)?);
            }
            best
        }
    })
}

fn guard(value: i64) -> EngineResult<i64> {
    if value < 0 || value > i64::from(i32::MAX) {
        return invalid("advanced_regex: maximum length is too large");
    }
    Ok(value)
}

// ── parsing ──────────────────────────────────────────────────────────────────

/// Inside a weighted branch these end it, on top of the usual `)` and `|`.
const BRANCH_STOP: &[char] = &[';', '}'];

const NO_STOP: &[char] = &[];

struct Parser {
    pattern: Vec<char>,
    pos: usize,
    capture_count: usize,
    closed_capture_count: usize,
    weighted_choice_count: usize,
    capture_max_lengths: BTreeMap<usize, i64>,
    /// `(?<name>…)` → its capture index, filled as each named group CLOSES.
    ///
    /// Closing rather than opening, so `(?<a>(?if{a=x:y}))` cannot read the group
    /// it is inside: at that point the group has produced nothing, and the
    /// condition would compare against the empty string on every row.
    group_names: BTreeMap<String, usize>,
}

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
            group_names: BTreeMap::new(),
            weighted_choice_count: 0,
            capture_max_lengths: BTreeMap::new(),
        }
    }

    fn parse(&mut self) -> EngineResult<Node> {
        let node = self.alternation(NO_STOP)?;
        if !self.at_end() {
            return self.error(&format!("unexpected \"{}\"", self.peek().unwrap_or(' ')));
        }
        Ok(node)
    }

    fn alternation(&mut self, stop: &[char]) -> EngineResult<Node> {
        let mut choices = vec![self.sequence(stop)?];
        while self.peek() == Some('|') {
            self.pos += 1;
            choices.push(self.sequence(stop)?);
        }
        Ok(if choices.len() == 1 {
            choices.pop().expect("just checked")
        } else {
            Node::Alternation(choices)
        })
    }

    fn sequence(&mut self, stop: &[char]) -> EngineResult<Node> {
        let mut parts = Vec::new();
        while let Some(ch) = self.peek() {
            if ch == ')' || ch == '|' || stop.contains(&ch) {
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
            Some('*' | '+' | '{') => return self.error("stacked quantifiers are not supported"),
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
            Some('^' | '$') => {
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
        if self.peek() == Some('?') && self.starts_here("?%{") {
            self.pos += 3;
            let weighted = self.weighted_choice()?;
            self.expect(')')?;
            return Ok(weighted);
        }

        if self.peek() == Some('?') && self.starts_here("?if{") {
            self.pos += 4;
            let conditional = self.conditional()?;
            self.expect(')')?;
            return Ok(conditional);
        }

        let mut capturing = true;
        let mut name: Option<String> = None;
        if self.peek() == Some('?') {
            if self.peek_at(1) == Some(':') {
                self.pos += 2;
                capturing = false;
            } else if self.starts_here("?<")
                // `(?<=…)` and `(?<!…)` are LOOKBEHIND, not a group called "=" or "!".
                && !matches!(self.peek_at(2), Some('=') | Some('!'))
            {
                self.pos += 2;
                name = Some(self.group_name()?);
            } else {
                return self.error(
                    "this group is not supported — advanced_regex has (?:…), (?<name>…), \
                     (?%{…}) and (?if{…}). Lookaround and numbered conditionals decide what a \
                     pattern MATCHES, and nothing here is matching anything",
                );
            }
        }

        let index = if capturing {
            self.capture_count += 1;
            self.capture_count
        } else {
            0
        };

        let node = self.alternation(NO_STOP)?;
        self.expect(')')?;
        if !capturing {
            return Ok(node);
        }

        self.closed_capture_count = self.closed_capture_count.max(index);
        let group_max = max_length(&node, &self.capture_max_lengths)?;
        self.capture_max_lengths.insert(index, group_max);
        if let Some(name) = name {
            self.group_names.insert(name, index);
        }
        Ok(Node::Capture(index, Box::new(node), group_max))
    }

    /// The `name` of `(?<name>…)`, up to the closing `>`.
    fn group_name(&mut self) -> EngineResult<String> {
        let start = self.pos;
        while !self.at_end() && self.peek() != Some('>') {
            self.pos += 1;
        }
        let name: String = self.pattern[start..self.pos].iter().collect();
        self.expect('>')?;
        if name.is_empty() {
            return self.error("a named group needs a name: (?<sex>…)");
        }
        let mut chars = name.chars();
        let head_ok = chars
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_');
        if !head_ok || !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return self.error(&format!(
                "group name \"{name}\" must start with a letter or \"_\" and hold only \
                 letters, digits and \"_\""
            ));
        }
        // Two groups under one name would make `(?if{name=…})` a coin toss between
        // them, decided by whichever the parser happened to record last.
        if self.group_names.contains_key(&name) {
            return self.error(&format!("group name \"{name}\" is already used"));
        }
        Ok(name)
    }

    /// `?if{sex=male:MR;sex=female:MS}` — the `(?if{` is already consumed.
    ///
    /// Each branch is a full pattern, so weighted choices and further conditionals
    /// nest inside them exactly as they do inside a weighted branch.
    fn conditional(&mut self) -> EngineResult<Node> {
        let mut branches: Vec<CondBranch> = Vec::new();
        while !self.at_end() {
            self.skip_spaces();
            if self.peek() == Some('}') {
                return self.error("conditional must contain at least one branch");
            }
            let test = self.conditional_test()?;
            let inner = self.alternation(BRANCH_STOP)?;
            branches.push(CondBranch { test, inner });

            match self.peek() {
                Some(';') => {
                    self.pos += 1;
                }
                Some('}') => {
                    self.pos += 1;
                    return Ok(Node::Conditional(branches));
                }
                _ => return self.error("expected \";\" or \"}\" in conditional"),
            }
        }
        self.error("unterminated conditional")
    }

    /// `name=value` before a branch's `:`, or `*` for the branch that always matches.
    fn conditional_test(&mut self) -> EngineResult<Option<(usize, String)>> {
        let start = self.pos;
        while !self.at_end() && !matches!(self.peek(), Some(':') | Some('}')) {
            self.pos += 1;
        }
        let raw: String = self.pattern[start..self.pos].iter().collect();
        self.expect(':')?;
        if raw == "*" {
            return Ok(None);
        }
        let Some(split) = raw.find('=') else {
            return self.error(&format!(
                "conditional branch \"{raw}\" must read a group: name=value, or \"*\" for \
                 every other row"
            ));
        };
        let name = raw[..split].trim().to_string();
        let Some(&capture) = self.group_names.get(&name) else {
            // Declared LATER is the same as not declared at all here: the pattern
            // is generated left to right, so a group further along has produced
            // nothing to compare against and the branch could never be taken.
            return self.error(&format!(
                "conditional reads \"{name}\", which no (?<{name}>…) group before it declares"
            ));
        };
        Ok(Some((capture, raw[split + 1..].to_string())))
    }

    fn weighted_choice(&mut self) -> EngineResult<Node> {
        let mut choices: Vec<Branch> = Vec::new();
        while !self.at_end() {
            self.skip_spaces();
            if self.peek() == Some('}') {
                return self.error("weighted choice must contain at least one branch");
            }

            let percent = self.weight()?;
            self.skip_spaces();
            self.expect(':')?;
            let inner = self.alternation(BRANCH_STOP)?;
            choices.push(Branch { percent, inner });

            match self.peek() {
                Some(';') => {
                    self.pos += 1;
                    continue;
                }
                Some('}') => {
                    self.pos += 1;
                    let sum: f64 = choices.iter().map(|b| b.percent).sum();
                    if (sum - 100.0).abs() > 0.0001 {
                        return self.error(&format!(
                            "weighted choice percentages sum to {}, expected 100",
                            numbers::to_text(sum)
                        ));
                    }
                    self.weighted_choice_count += 1;
                    return Ok(Node::Weighted(choices));
                }
                _ => return self.error("expected \";\" or \"}\" in weighted choice"),
            }
        }
        self.error("unterminated weighted choice")
    }

    fn weight(&mut self) -> EngineResult<f64> {
        let start = self.pos;
        while let Some(ch) = self.peek() {
            if !ch.is_ascii_digit() && ch != '.' {
                break;
            }
            self.pos += 1;
        }
        let raw: String = self.pattern[start..self.pos].iter().collect();
        match raw.parse::<f64>() {
            Ok(v) if v.is_finite() && v >= 0.0 => Ok(v),
            _ => self.error(&format!("invalid weighted choice percent \"{raw}\"")),
        }
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
            let excluded = distinct(&collected);
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
            'd' => set(regex::digits().to_vec()),
            'D' => set(inverse(regex::digits())),
            'w' => set(regex::word().to_vec()),
            'W' => set(inverse(regex::word())),
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
            'd' => Ok(chars_node(regex::digits())),
            'D' => Ok(chars_node(&inverse(regex::digits()))),
            'w' => Ok(chars_node(regex::word())),
            'W' => Ok(chars_node(&inverse(regex::word()))),
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

    fn skip_spaces(&mut self) {
        while matches!(self.peek(), Some(' ') | Some('\t')) {
            self.pos += 1;
        }
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

    fn starts_here(&self, text: &str) -> bool {
        text.chars()
            .enumerate()
            .all(|(i, c)| self.pattern.get(self.pos + i) == Some(&c))
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
        invalid(&format!("advanced_regex: {message} at offset {}", self.pos))
    }
}

fn chars_node(values: &[char]) -> Node {
    Node::Chars(distinct(values))
}
