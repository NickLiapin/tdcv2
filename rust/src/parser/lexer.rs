//! The lexer, hand-written from `grammar/TDCLexer.g4`.
//!
//! The other four implementations generate this from the shared grammar. Rust
//! cannot: the only ANTLR runtime for it targets 4.8 and the grammar is 4.13.
//! So it is written out — which makes fidelity a thing to prove rather than
//! assume, and every rule below names the grammar line it comes from.
//!
//! Two behaviours are reproduced deliberately rather than improved on, because
//! the point is to accept exactly the same dialect as the other four:
//!
//! * **Longest match wins, ties broken by rule order.** `<data` is a literal of
//!   five characters with no word boundary after it, so `<database>` lexes as
//!   `<data` followed by the name `base` — exactly as ANTLR does it. A
//!   hand-written lexer that "sensibly" required a boundary would accept a
//!   config the other four reject.
//! * **Modes are a stack.** `<data` *pushes* the attribute mode, `>` *replaces*
//!   it with the body mode, and `</data>` or `/>` *pops* back. Getting the
//!   push/replace distinction wrong leaves the stack one deep after every
//!   `<data>` and the file stops parsing halfway down.

/// A lexed token. Hidden-channel tokens (comments, the XML declaration,
/// whitespace) never reach here — they are dropped where ANTLR would route them
/// to the hidden channel.
#[derive(Clone, Debug, PartialEq)]
pub enum Tok {
    /// `<data` — grammar line 22.
    DataTagOpen,
    /// `<map` — grammar line 28.
    MapTagOpen,
    /// `</name>` consumed whole, so the parser sees one clean closing marker.
    EndTag(String),
    Lt,
    Gt,
    SlashGt,
    Eq,
    Name(String),
    /// A quoted attribute value, quotes included — the validator needs the raw
    /// text to decide where inside them to point.
    Str(String),
    /// One character of a `<data>` body. `DATA_TEXT : . ;` really is per
    /// character; the parser joins them back up.
    DataText(char),
    DataClose,
    MapText(char),
    MapClose,
    Eof,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pos {
    /// 1-based, as every diagnostic in the shared fixtures is.
    pub line: i32,
    /// 0-based, as every diagnostic in the shared fixtures is.
    pub column: i32,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub tok: Tok,
    pub pos: Pos,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    Default,
    DataAttrs,
    DataBody,
    MapAttrs,
    MapBody,
}

/// A character the lexer could not begin any rule with.
#[derive(Debug)]
pub struct LexError {
    pub pos: Pos,
    pub message: String,
}

/// One `<!--…-->`, kept off to the side.
///
/// The parser never sees it — a comment means nothing to a generator, which is
/// why the grammar hides it. The pretty-printer is the one caller that needs it
/// back, and it puts it back by POSITION: a comment belongs between two things,
/// not to either of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Comment {
    pub pos: Pos,
    /// The whole `<!--…-->`, trimmed.
    pub text: String,
}

/// Everything one pass over the source produced.
pub struct Lexed {
    pub tokens: Vec<Token>,
    pub comments: Vec<Comment>,
    pub errors: Vec<LexError>,
}

pub fn tokenize(source: &str) -> Lexed {
    Lexer::new(source).run()
}

struct Lexer {
    /// Code points, not bytes. ANTLR's char stream counts code points, so a
    /// column past a non-ASCII character agrees with the other four only if
    /// this does too.
    chars: Vec<char>,
    at: usize,
    line: i32,
    column: i32,
    mode: Mode,
    stack: Vec<Mode>,
    errors: Vec<LexError>,
    comments: Vec<Comment>,
}

impl Lexer {
    fn new(source: &str) -> Self {
        Self {
            chars: source.chars().collect(),
            at: 0,
            line: 1,
            column: 0,
            mode: Mode::Default,
            stack: Vec::new(),
            errors: Vec::new(),
            comments: Vec::new(),
        }
    }

    fn run(mut self) -> Lexed {
        let mut tokens = Vec::new();
        loop {
            match self.next_token() {
                Some((tok, pos)) => tokens.push(Token { tok, pos }),
                None => {
                    tokens.push(Token {
                        tok: Tok::Eof,
                        pos: self.pos(),
                    });
                    return Lexed {
                        tokens,
                        comments: self.comments,
                        errors: self.errors,
                    };
                }
            }
        }
    }

    fn pos(&self) -> Pos {
        Pos {
            line: self.line,
            column: self.column,
        }
    }

    fn peek(&self) -> Option<char> {
        self.chars.get(self.at).copied()
    }

    fn peek_at(&self, ahead: usize) -> Option<char> {
        self.chars.get(self.at + ahead).copied()
    }

    fn starts_with(&self, word: &str) -> bool {
        word.chars()
            .enumerate()
            .all(|(i, c)| self.peek_at(i) == Some(c))
    }

    /// Consume `n` characters, keeping line and column true.
    fn advance(&mut self, n: usize) -> String {
        let mut taken = String::new();
        for _ in 0..n {
            let Some(c) = self.peek() else { break };
            self.at += 1;
            taken.push(c);
            if c == '\n' {
                self.line += 1;
                self.column = 0;
            } else {
                self.column += 1;
            }
        }
        taken
    }

    fn push_mode(&mut self, mode: Mode) {
        self.stack.push(self.mode);
        self.mode = mode;
    }

    fn pop_mode(&mut self) {
        self.mode = self.stack.pop().unwrap_or(Mode::Default);
    }

    /// The next token and **where it starts** — which is not where the scan
    /// started. Whitespace and comments are skipped first, so a lexer that
    /// stamped the position before the skip would put every indented tag at the
    /// end of the line above it. Only these functions know where the token
    /// itself began, so the position comes back with it.
    fn next_token(&mut self) -> Option<(Tok, Pos)> {
        match self.mode {
            Mode::Default => self.default_mode(),
            Mode::DataAttrs | Mode::MapAttrs => self.attrs_mode(),
            Mode::DataBody => self.raw_body("</data>", Tok::DataClose, Tok::DataText),
            Mode::MapBody => self.raw_body("</map>", Tok::MapClose, Tok::MapText),
        }
    }

    fn default_mode(&mut self) -> Option<(Tok, Pos)> {
        loop {
            let c = self.peek()?;

            // Hidden channel: consumed and not handed to the parser.
            if c.is_whitespace() && matches!(c, ' ' | '\t' | '\r' | '\n') {
                self.advance(1);
                continue;
            }
            if self.starts_with("<!--") {
                // Hidden from the parser, kept for the pretty-printer, which is
                // the only thing that has any use for it.
                let pos = self.pos();
                let text = self.take_until("-->", "unterminated comment");
                self.comments.push(Comment {
                    pos,
                    text: text.trim().to_string(),
                });
                continue;
            }
            if self.starts_with("<?xml") {
                self.skip_until("?>", "unterminated XML declaration");
                continue;
            }

            // Longest match first. `<data` and `<map` beat a bare `<`, and
            // `</name>` beats it too — which is why they are tested before it.
            let pos = self.pos();
            if self.starts_with("<data") {
                self.advance(5);
                self.push_mode(Mode::DataAttrs);
                return Some((Tok::DataTagOpen, pos));
            }
            if self.starts_with("<map") {
                self.advance(4);
                self.push_mode(Mode::MapAttrs);
                return Some((Tok::MapTagOpen, pos));
            }
            if let Some(len) = self.end_tag_len() {
                let text = self.advance(len);
                return Some((Tok::EndTag(text), pos));
            }

            return Some((
                match c {
                    '<' => {
                        self.advance(1);
                        Tok::Lt
                    }
                    '>' => {
                        self.advance(1);
                        Tok::Gt
                    }
                    '=' => {
                        self.advance(1);
                        Tok::Eq
                    }
                    '/' if self.peek_at(1) == Some('>') => {
                        self.advance(2);
                        Tok::SlashGt
                    }
                    '"' => Tok::Str(self.string()),
                    c if is_ident_start(c) => Tok::Name(self.ident()),
                    _ => {
                        let bad = self.advance(1);
                        self.errors.push(LexError {
                            pos,
                            message: format!("token recognition error at: '{bad}'"),
                        });
                        continue;
                    }
                },
                pos,
            ));
        }
    }

    /// The `<data …>` / `<map …>` attribute modes, which emit the same token
    /// types as the default mode so the parser needs only one `attr` rule.
    fn attrs_mode(&mut self) -> Option<(Tok, Pos)> {
        loop {
            let c = self.peek()?;
            if matches!(c, ' ' | '\t' | '\r' | '\n') {
                self.advance(1);
                continue;
            }
            let pos = self.pos();
            return Some((
                match c {
                    '/' if self.peek_at(1) == Some('>') => {
                        self.advance(2);
                        self.pop_mode();
                        Tok::SlashGt
                    }
                    '>' => {
                        self.advance(1);
                        // `mode(…)`, not `pushMode(…)`: the body replaces the
                        // attribute mode, and the eventual `</data>` pops back to
                        // whatever was current before the tag opened.
                        self.mode = if self.mode == Mode::DataAttrs {
                            Mode::DataBody
                        } else {
                            Mode::MapBody
                        };
                        Tok::Gt
                    }
                    '=' => {
                        self.advance(1);
                        Tok::Eq
                    }
                    '"' => Tok::Str(self.string()),
                    c if is_ident_start(c) => Tok::Name(self.ident()),
                    _ => {
                        let bad = self.advance(1);
                        self.errors.push(LexError {
                            pos,
                            message: format!("token recognition error at: '{bad}'"),
                        });
                        continue;
                    }
                },
                pos,
            ));
        }
    }

    /// A raw-text body: every character is opaque until the literal closer.
    fn raw_body(
        &mut self,
        closer: &str,
        close_tok: Tok,
        text_tok: fn(char) -> Tok,
    ) -> Option<(Tok, Pos)> {
        self.peek()?;
        let pos = self.pos();
        if self.starts_with(closer) {
            self.advance(closer.chars().count());
            self.pop_mode();
            return Some((close_tok, pos));
        }
        let c = self.peek()?;
        self.advance(1);
        Some((text_tok(c), pos))
    }

    /// How long a `</name>` is here, or `None` if this is not one.
    fn end_tag_len(&self) -> Option<usize> {
        if self.peek() != Some('<') || self.peek_at(1) != Some('/') {
            return None;
        }
        let mut i = 2;
        if !is_ident_start(self.peek_at(i)?) {
            return None;
        }
        i += 1;
        while self.peek_at(i).is_some_and(is_ident_part) {
            i += 1;
        }
        if self.peek_at(i) == Some('>') {
            Some(i + 1)
        } else {
            None
        }
    }

    fn ident(&mut self) -> String {
        let mut n = 1;
        while self.peek_at(n).is_some_and(is_ident_part) {
            n += 1;
        }
        self.advance(n)
    }

    /// `STRING : '"' ~["\r\n]* '"'` — quotes kept, because the validator points
    /// at the first character inside them and needs to know where they are.
    fn string(&mut self) -> String {
        let mut n = 1;
        while let Some(c) = self.peek_at(n) {
            if c == '"' {
                return self.advance(n + 1);
            }
            if c == '\r' || c == '\n' {
                break;
            }
            n += 1;
        }
        // Unterminated. ANTLR would fail to match STRING and fall through to a
        // recognition error; the same is reported, and the lone quote consumed
        // so the scan can carry on and find the other problems in the file.
        let pos = self.pos();
        self.advance(1);
        self.errors.push(LexError {
            pos,
            message: "token recognition error at: '\"'".to_string(),
        });
        String::from("\"\"")
    }

    fn skip_until(&mut self, closer: &str, unterminated: &str) {
        self.take_until(closer, unterminated);
    }

    /// The same, handing back what was skipped — closer included.
    fn take_until(&mut self, closer: &str, unterminated: &str) -> String {
        let pos = self.pos();
        let mut taken = String::new();
        while self.peek().is_some() {
            if self.starts_with(closer) {
                taken.push_str(&self.advance(closer.chars().count()));
                return taken;
            }
            taken.push_str(&self.advance(1));
        }
        self.errors.push(LexError {
            pos,
            message: unterminated.to_string(),
        });
        taken
    }
}

fn is_ident_start(c: char) -> bool {
    c.is_ascii_alphabetic() || c == '_'
}

fn is_ident_part(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
