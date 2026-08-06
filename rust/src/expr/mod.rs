//! The tiny expression language behind `if="..."`.
//!
//! Comparison (`== != < > <= >=`), logic (`&& || !`) and arithmetic (`+ - * /`)
//! over sequence values, numbers and quoted strings.
//!
//! The reference parses these with jsep, a JavaScript expression parser, so the
//! precedence table below is **jsep's** rather than one chosen here.
//! Reproducing it matters: an expression like `a == b && c` has to bind the same
//! way in every implementation or the engines disagree about which rows appear —
//! the kind of difference no test of a single value would catch.
//!
//! A bare word that names no sequence is its own value: `Gender == Male` works
//! without quoting "Male", which is how configs have always been written.

pub mod evaluate;

use crate::engine::{invalid, EngineResult};

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Num(f64),
    Str(String),
    Bool(bool),
    Null,
    Name(String),
    /// A dotted reference: a compound field, a value test, or a literal —
    /// resolved later.
    Member(String),
    Binary(String, Box<Expr>, Box<Expr>),
    Unary(String, Box<Expr>),
    /// `abs(x)` — a call on a bare name, with its arguments already parsed.
    Call(String, Vec<Expr>),
    /// `[US, CA, MX]` — only ever the right side of `in`.
    Array(Vec<Expr>),
    /// `a ? b : c` — picks a VALUE, which is then compared like any other.
    Conditional(Box<Expr>, Box<Expr>, Box<Expr>),
    /// `x[0]` — subscripting, which the evaluator does not implement.
    ///
    /// Parsed rather than rejected so the complaint can name what is
    /// unsupported. A parser stricter than the reference's turns "computed
    /// member access is not supported" into "syntax error", and the second says
    /// nothing about what to write instead.
    Computed(Box<Expr>),
}

/// jsep's binary precedence, verbatim. Higher binds tighter.
///
/// The bitwise and shift operators are here even though the engine implements
/// none of them, and that is the point: the reference parses whatever jsep
/// parses and then refuses the operator BY NAME. A parser that stopped at the
/// supported set answered `x & 1` with a syntax error pointing at the
/// ampersand, which tells the reader nothing about what to write instead.
fn precedence(op: &str) -> Option<u8> {
    Some(match op {
        "||" => 1,
        "&&" => 2,
        "|" => 3,
        "^" => 4,
        "&" => 5,
        "==" | "!=" | "===" | "!==" => 6,
        "<" | ">" | "<=" | ">=" => 7,
        "<<" | ">>" | ">>>" => 8,
        "+" | "-" => 9,
        "*" | "/" | "%" => 10,
        // A word operator rather than a symbol; `peek_operator` keeps it from
        // swallowing a sequence called "index".
        "in" => 7,
        _ => return None,
    })
}

/// Longest first, so `<=` is never read as `<` followed by a stray `=`, and
/// `&&` never as two `&`.
const OPERATORS: [&str; 21] = [
    ">>>", "===", "!==", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "<", ">", "+", "-", "*",
    "/", "%", "&", "|", "^",
];

/// A hard ceiling on parenthesis nesting. The parser recurses per `(`, so a
/// generated `((((…))))` is a stack overflow — which aborts the process — for
/// the price of a text file. Real expressions nest a handful. The scan is
/// linear and quote-aware; the same ceiling lives in every implementation.
const MAX_EXPR_NESTING: usize = 32;

fn paren_depth(source: &str) -> usize {
    let mut depth = 0usize;
    let mut deepest = 0usize;
    let mut in_string: Option<char> = None;
    let mut escaped = false;
    for ch in source.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if let Some(quote) = in_string {
            if ch == '\\' {
                escaped = true;
            } else if ch == quote {
                in_string = None;
            }
            continue;
        }
        match ch {
            '\'' | '"' => in_string = Some(ch),
            '(' | '[' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            ')' | ']' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

pub fn parse(source: &str) -> EngineResult<Expr> {
    if paren_depth(source) > MAX_EXPR_NESTING {
        return invalid(&format!("nests deeper than {MAX_EXPR_NESTING} levels"));
    }
    let mut parser = Parser {
        src: source.chars().collect(),
        raw: source,
        pos: 0,
    };
    let result = parser.ternary(0)?;
    parser.skip_space();
    if !parser.done() {
        return invalid(&format!(
            "if expression: unexpected \"{}\" in \"{source}\"",
            parser.rest()
        ));
    }
    Ok(result)
}

/// Precedence climbing over a hand-written tokenizer.
struct Parser<'a> {
    src: Vec<char>,
    raw: &'a str,
    pos: usize,
}

impl Parser<'_> {
    fn done(&self) -> bool {
        self.pos >= self.src.len()
    }

    fn rest(&self) -> String {
        self.src[self.pos.min(self.src.len())..].iter().collect()
    }

    fn peek(&self) -> Option<char> {
        self.src.get(self.pos).copied()
    }

    fn skip_space(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.pos += 1;
        }
    }

    fn starts_with(&self, word: &str) -> bool {
        word.chars()
            .enumerate()
            .all(|(i, c)| self.src.get(self.pos + i) == Some(&c))
    }

    /// `a ? b : c`, which binds looser than every binary operator.
    ///
    /// Wrapping the binary loop rather than living inside it is what makes
    /// `x > 1 ? a : b` read as `(x > 1) ? a : b` and not `x > (1 ? a : b)`.
    fn ternary(&mut self, min_precedence: u8) -> EngineResult<Expr> {
        let test = self.expression(min_precedence)?;
        self.skip_space();
        if self.peek() != Some('?') {
            return Ok(test);
        }
        self.pos += 1;
        let consequent = self.ternary(0)?;
        self.skip_space();
        if self.peek() != Some(':') {
            return invalid(&format!(
                "if expression: a ? without its : in \"{}\"",
                self.raw
            ));
        }
        self.pos += 1;
        let alternate = self.ternary(0)?;
        Ok(Expr::Conditional(
            Box::new(test),
            Box::new(consequent),
            Box::new(alternate),
        ))
    }

    fn expression(&mut self, min_precedence: u8) -> EngineResult<Expr> {
        let mut left = self.unary_expr()?;
        loop {
            self.skip_space();
            let Some(op) = self.peek_operator() else {
                return Ok(left);
            };
            let p = precedence(op).expect("every operator has one");
            if p < min_precedence {
                return Ok(left);
            }
            self.pos += op.len();
            // Left-associative: the right operand stops at anything this loop
            // can handle.
            let right = self.expression(p + 1)?;
            left = Expr::Binary(op.to_string(), Box::new(left), Box::new(right));
        }
    }

    fn unary_expr(&mut self) -> EngineResult<Expr> {
        self.skip_space();
        if let Some(c) = self.peek() {
            if c == '!' && !self.starts_with("!=") {
                self.pos += 1;
                return Ok(Expr::Unary("!".to_string(), Box::new(self.unary_expr()?)));
            }
            if (c == '-' || c == '+') && !self.is_number_start() {
                self.pos += 1;
                return Ok(Expr::Unary(c.to_string(), Box::new(self.unary_expr()?)));
            }
            // `~` parses and then fails validation, rather than failing to
            // parse. The reference's expression library accepts it too, and both
            // have to refuse the same configs for the same stated reason —
            // "unsupported operator" says more than "syntax error" does.
            if c == '~' {
                self.pos += 1;
                return Ok(Expr::Unary("~".to_string(), Box::new(self.unary_expr()?)));
            }
        }
        self.primary()
    }

    /// A leading `-` belongs to the number when a digit follows it directly.
    fn is_number_start(&self) -> bool {
        self.src.get(self.pos + 1).is_some_and(char::is_ascii_digit)
    }

    fn primary(&mut self) -> EngineResult<Expr> {
        self.skip_space();
        let Some(c) = self.peek() else {
            return invalid("if expression: ends where a value was expected");
        };

        if c == '(' {
            self.pos += 1;
            let inner = self.ternary(0)?;
            self.skip_space();
            if self.peek() != Some(')') {
                return invalid(&format!(
                    "if expression: unbalanced parentheses in \"{}\"",
                    self.raw
                ));
            }
            self.pos += 1;
            return Ok(inner);
        }

        if c == '[' {
            self.pos += 1;
            let mut items: Vec<Expr> = Vec::new();
            self.skip_space();
            if self.peek() == Some(']') {
                self.pos += 1;
                return Ok(Expr::Array(items));
            }
            loop {
                items.push(self.ternary(0)?);
                self.skip_space();
                match self.peek() {
                    Some(',') => {
                        self.pos += 1;
                    }
                    Some(']') => {
                        self.pos += 1;
                        break;
                    }
                    _ => {
                        return invalid(&format!(
                            "if expression: unbalanced brackets in \"{}\"",
                            self.raw
                        ));
                    }
                }
            }
            return Ok(Expr::Array(items));
        }

        if c == '\'' || c == '"' {
            return self.string_literal(c);
        }

        if c.is_ascii_digit() || (c == '-' && self.is_number_start()) {
            return self.number_literal();
        }

        if c.is_alphabetic() || c == '_' || c == '$' {
            let mut value = self.word()?;
            self.skip_space();
            // A call, but only on a bare name: `abs(x)` and never `obj.method(x)`.
            // The reference restricts it the same way, and the validator says so
            // with a position.
            if let Expr::Name(name) = &value {
                if self.peek() == Some('(') {
                    let name = name.clone();
                    self.pos += 1;
                    let mut args: Vec<Expr> = Vec::new();
                    self.skip_space();
                    if self.peek() == Some(')') {
                        self.pos += 1;
                    } else {
                        loop {
                            args.push(self.ternary(0)?);
                            self.skip_space();
                            match self.peek() {
                                Some(',') => {
                                    self.pos += 1;
                                }
                                Some(')') => {
                                    self.pos += 1;
                                    break;
                                }
                                _ => {
                                    return invalid(&format!(
                                        "if expression: unbalanced parentheses in \"{}\"",
                                        self.raw
                                    ));
                                }
                            }
                        }
                    }
                    self.skip_space();
                    return Ok(Expr::Call(name, args));
                }
            }
            // A subscript parses and then fails validation, so the complaint can
            // say which construct is unsupported rather than only where the
            // parser stopped.
            while self.peek() == Some('[') {
                self.pos += 1;
                self.expression(0)?;
                self.skip_space();
                if self.peek() != Some(']') {
                    return invalid(&format!(
                        "if expression: unbalanced brackets in \"{}\"",
                        self.raw
                    ));
                }
                self.pos += 1;
                self.skip_space();
                value = Expr::Computed(Box::new(value));
            }
            return Ok(value);
        }

        invalid(&format!(
            "if expression: cannot read \"{}\" in \"{}\"",
            self.rest(),
            self.raw
        ))
    }

    fn string_literal(&mut self, quote: char) -> EngineResult<Expr> {
        self.pos += 1;
        let mut result = String::new();
        while let Some(c) = self.peek() {
            if c == quote {
                self.pos += 1;
                return Ok(Expr::Str(result));
            }
            let mut ch = c;
            if ch == '\\' && self.pos + 1 < self.src.len() {
                self.pos += 1;
                ch = self.src[self.pos];
            }
            result.push(ch);
            self.pos += 1;
        }
        invalid(&format!(
            "if expression: unterminated string in \"{}\"",
            self.raw
        ))
    }

    fn number_literal(&mut self) -> EngineResult<Expr> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while self.peek().is_some_and(|c| c.is_ascii_digit() || c == '.') {
            self.pos += 1;
        }
        let text: String = self.src[start..self.pos].iter().collect();
        match text.parse::<f64>() {
            Ok(n) => Ok(Expr::Num(n)),
            Err(_) => invalid(&format!("if expression: \"{text}\" is not a number")),
        }
    }

    fn word(&mut self) -> EngineResult<Expr> {
        let mut parts = vec![self.identifier()?];
        while self.peek() == Some('.') {
            self.pos += 1;
            parts.push(self.identifier()?);
        }

        if parts.len() == 1 {
            return Ok(match parts[0].as_str() {
                "true" => Expr::Bool(true),
                "false" => Expr::Bool(false),
                "null" => Expr::Null,
                _ => Expr::Name(parts.remove(0)),
            });
        }
        Ok(Expr::Member(parts.join(".")))
    }

    fn identifier(&mut self) -> EngineResult<String> {
        let start = self.pos;
        while let Some(c) = self.peek() {
            if c.is_alphanumeric() || c == '_' || c == '$' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if start == self.pos {
            return invalid(&format!(
                "if expression: expected a name in \"{}\"",
                self.raw
            ));
        }
        Ok(self.src[start..self.pos].iter().collect())
    }

    fn peek_operator(&self) -> Option<&'static str> {
        // `in` is a WORD, so it counts only when what surrounds it cannot
        // continue an identifier — otherwise a sequence called "index" would be
        // read as the operator followed by "dex".
        if self.starts_with("in") {
            let is_word = |c: Option<&char>| {
                c.is_some_and(|ch| ch.is_alphanumeric() || *ch == '_' || *ch == '$')
            };
            let after_ok = !is_word(self.src.get(self.pos + 2));
            let before_ok = self.pos == 0 || !is_word(self.src.get(self.pos - 1));
            if after_ok && before_ok {
                return Some("in");
            }
        }
        OPERATORS.into_iter().find(|op| self.starts_with(op))
    }
}
