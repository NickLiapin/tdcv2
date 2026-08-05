//! One complaint about a config.
//!
//! The `code` is the contract across implementations, not the message. Wording
//! gets edited for clarity over time, and holding five languages to a sentence
//! would make every improvement a breaking change — which is what a stable code
//! is for.

use crate::parser::lexer::Pos;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Severity {
    Error,
    /// Worth saying, not worth stopping for: the run still produces usable data.
    Warning,
}

impl Severity {
    pub fn text(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Diagnostic {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub hint: String,
    /// 1-based, as an editor counts.
    pub line: i32,
    /// 0-based, as an editor counts.
    pub column: i32,
}

impl Diagnostic {
    pub fn error(code: &str, message: String, hint: &str, at: Pos) -> Self {
        Self::new(Severity::Error, code, message, hint, at)
    }

    pub fn warning(code: &str, message: String, hint: &str, at: Pos) -> Self {
        Self::new(Severity::Warning, code, message, hint, at)
    }

    fn new(severity: Severity, code: &str, message: String, hint: &str, at: Pos) -> Self {
        Self {
            severity,
            code: code.to_string(),
            message,
            hint: hint.to_string(),
            line: at.line,
            column: at.column,
        }
    }

    /// The shape the shared diagnostic fixtures record: severity and code, never
    /// the wording.
    pub fn signature(&self) -> String {
        format!(
            "{} {} {}:{}",
            self.severity.text(),
            self.code,
            self.line,
            self.column
        )
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{} {} (line {}, col {}): {}",
            self.severity.text(),
            self.code,
            self.line,
            self.column,
            self.message
        )
    }
}

/// Whether anything here stops the run.
pub fn has_errors(diagnostics: &[Diagnostic]) -> bool {
    diagnostics.iter().any(|d| d.severity == Severity::Error)
}

/// Diagnostics, printed the way a compiler prints them.
///
/// A header carrying severity and code, a `-->` line naming the position, the
/// offending source line with a caret under it, and the hint as a `note`. The
/// point is that one block pasted into a chat or an issue is actionable on its
/// own — nobody has to also send the config.
///
/// Held to the reference by `fixtures/cross-language/cli.json`: a user who runs
/// the same broken config through two implementations should see the same
/// complaint, not two dialects of it.
pub mod render {
    use super::{Diagnostic, Severity};

    const RED: &str = "\u{1b}[31m";
    const YELLOW: &str = "\u{1b}[33m";
    const CYAN: &str = "\u{1b}[36m";
    const BOLD: &str = "\u{1b}[1m";
    const RESET: &str = "\u{1b}[0m";

    fn colorize(text: &str, code: &str, enabled: bool) -> String {
        if enabled {
            format!("{code}{text}{RESET}")
        } else {
            text.to_string()
        }
    }

    /// One diagnostic as a block. Without `source`, only the header and the
    /// position — which is still enough to open the right line.
    pub fn one(
        diagnostic: &Diagnostic,
        source: Option<&str>,
        filename: &str,
        colors: bool,
    ) -> String {
        let severity_color = if diagnostic.severity == Severity::Error {
            RED
        } else {
            YELLOW
        };
        let coded = if diagnostic.code.is_empty() {
            colorize(diagnostic.severity.text(), severity_color, colors)
        } else {
            format!(
                "{}[{}]",
                colorize(diagnostic.severity.text(), severity_color, colors),
                diagnostic.code
            )
        };

        let mut lines = vec![
            format!("{}: {}", colorize(&coded, BOLD, colors), diagnostic.message),
            // The column is held 0-based, as the shared fixtures record it, and
            // printed 1-based, as every editor counts.
            format!(
                " --> {filename}:{}:{}",
                diagnostic.line,
                diagnostic.column + 1
            ),
        ];

        if let Some(source) = source.filter(|s| !s.is_empty()) {
            lines.extend(snippet(diagnostic, source, colors));
        }
        if !diagnostic.hint.is_empty() {
            lines.push(format!(
                "{}: {}",
                colorize("note", CYAN, colors),
                diagnostic.hint
            ));
        }
        lines.join("\n")
    }

    /// One line per diagnostic: code, position, message, hint after `::`.
    ///
    /// The full report is right for a person and wrong for a program. Measured on
    /// a three-error config it is 1807 characters over 27 lines, of which three
    /// lines carry the finding and the rest draw a picture of the file — and a
    /// tool feeding a refusal back to a model spends two thirds of its window on
    /// the drawing. The hint is kept: it carries the list of what IS allowed,
    /// which is the half a reader acts on. No trailing count either, so a caller
    /// parsing rows need not skip a sentence at the end.
    pub fn brief(diagnostics: &[Diagnostic]) -> String {
        diagnostics
            .iter()
            .map(|d| {
                let code = if d.code.is_empty() {
                    match d.severity {
                        Severity::Warning => "WARN",
                        _ => "ERROR",
                    }
                } else {
                    d.code.as_str()
                };
                let hint = if d.hint.is_empty() {
                    String::new()
                } else {
                    format!(" :: {}", d.hint)
                };
                format!("{code} {}:{} {}{hint}", d.line, d.column, d.message)
            })
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Every diagnostic as a block, with a count at the end. Nothing in, nothing
    /// out — so a caller can print the result unconditionally.
    pub fn all(
        diagnostics: &[Diagnostic],
        source: Option<&str>,
        filename: &str,
        colors: bool,
    ) -> String {
        if diagnostics.is_empty() {
            return String::new();
        }

        let mut blocks: Vec<String> = diagnostics
            .iter()
            .map(|d| one(d, source, filename, colors))
            .collect();

        let errors = diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error)
            .count();
        let warnings = diagnostics.len() - errors;

        let mut parts: Vec<String> = Vec::new();
        if errors > 0 {
            parts.push(format!("{errors} error{}", plural(errors)));
        }
        if warnings > 0 {
            parts.push(format!("{warnings} warning{}", plural(warnings)));
        }

        // "aborted" only when something actually stopped. Warnings alone leave a
        // run that finished, and announcing it as aborted sends the reader
        // looking for a failure that never happened.
        let line = if errors > 0 {
            format!("aborted: {}", parts.join(", "))
        } else {
            parts.join(", ")
        };
        blocks.push(String::new());
        blocks.push(colorize(&line, BOLD, colors));
        blocks.join("\n\n")
    }

    fn plural(n: usize) -> &'static str {
        if n == 1 {
            ""
        } else {
            "s"
        }
    }

    /// How many characters the carets cover: the whole of what is wrong, not its
    /// first letter.
    ///
    /// Read back off the source line rather than carried on the diagnostic. A
    /// position points at one of two things — an element, or a value inside its
    /// quotes — and both say where they end in the text itself, so a hundred
    /// call sites do not each have to remember to pass a length they would get
    /// wrong once and nobody would notice.
    ///
    /// Every diagnostic in the shared fixtures underlines exactly what the
    /// reference underlines; a position that is neither gets one caret, which is
    /// what it had before.
    fn underline(text: &str, column: usize) -> usize {
        let chars: Vec<char> = text.chars().collect();
        if column >= chars.len() {
            return 1;
        }

        // A tag: everything through its closing `>`, or through the matching
        // `</name>` when it has one. `<!--` is not a tag, so a comment is not
        // swallowed.
        if chars[column] == '<' && chars.get(column + 1).is_some_and(char::is_ascii_alphabetic) {
            let Some(open_end) = tag_end(&chars, column) else {
                return chars.len() - column;
            };
            if chars[open_end - 1] == '/' {
                return open_end + 1 - column;
            }
            let mut depth = 1;
            let mut k = open_end + 1;
            while k < chars.len() {
                if chars[k] != '<' {
                    k += 1;
                    continue;
                }
                if chars.get(k + 1) == Some(&'/') {
                    let Some(close_end) = chars[k..].iter().position(|c| *c == '>').map(|i| k + i)
                    else {
                        break;
                    };
                    depth -= 1;
                    if depth == 0 {
                        return close_end + 1 - column;
                    }
                    k = close_end + 1;
                } else {
                    let Some(end) = tag_end(&chars, k) else { break };
                    if chars[end - 1] != '/' {
                        depth += 1;
                    }
                    k = end + 1;
                }
            }
            return chars.len() - column;
        }

        // Otherwise a value: up to the quote that closes it. An empty one puts
        // the position on that quote already, and underlines the one character.
        match chars[column..].iter().position(|c| *c == '"') {
            Some(0) | None => 1,
            Some(offset) => offset,
        }
    }

    /// The `>` that closes the tag opening at `at`, with quotes respected — a
    /// `>` inside an attribute value does not end anything.
    fn tag_end(chars: &[char], at: usize) -> Option<usize> {
        let mut quote: Option<char> = None;
        for (i, c) in chars.iter().enumerate().skip(at + 1) {
            match quote {
                Some(q) if *c == q => quote = None,
                Some(_) => {}
                None if *c == '"' || *c == '\'' => quote = Some(*c),
                None if *c == '>' => return Some(i),
                None => {}
            }
        }
        None
    }

    /// The offending line, with carets under what is wrong. Nothing when the line
    /// is out of range — a position that does not exist is not worth guessing at.
    fn snippet(diagnostic: &Diagnostic, source: &str, colors: bool) -> Vec<String> {
        let source_lines: Vec<&str> = source.split('\n').collect();
        if diagnostic.line < 1 || diagnostic.line as usize > source_lines.len() {
            return Vec::new();
        }

        let text = source_lines[diagnostic.line as usize - 1];
        let number = diagnostic.line.to_string();
        let blank = " ".repeat(number.len());
        let pipe = colorize("|", CYAN, colors);
        let column = diagnostic.column.max(0) as usize;
        let caret_len = underline(text, column);

        // Window an over-long line around the carets. The same formula lives
        // in the other four implementations' renderers; change them together.
        const SNIPPET_WINDOW: usize = 160;
        let chars: Vec<char> = text.chars().collect();
        let (shown, caret_start, caret_len) = if chars.len() > SNIPPET_WINDOW {
            let from = column.saturating_sub(40).min(chars.len() - SNIPPET_WINDOW);
            let to = from + SNIPPET_WINDOW;
            let prefix = if from > 0 { "\u{2026}" } else { "" };
            let suffix = if to < chars.len() { "\u{2026}" } else { "" };
            let body: String = chars[from..to].iter().collect();
            let clipped_len = caret_len.min(to - column).max(1);
            (
                format!("{prefix}{body}{suffix}"),
                column - from + usize::from(!prefix.is_empty()),
                clipped_len,
            )
        } else {
            (text.to_string(), column, caret_len)
        };

        let caret = format!(
            "{}{}",
            " ".repeat(caret_start),
            colorize(&"^".repeat(caret_len), RED, colors)
        );

        vec![
            format!("{blank} {pipe}"),
            format!("{} {pipe} {shown}", colorize(&number, CYAN, colors)),
            format!("{blank} {pipe} {caret}"),
            format!("{blank} {pipe}"),
        ]
    }
}
