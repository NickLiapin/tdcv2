//! The `<compute>` tree, checked before it runs.
//!
//! Compute is a small language of its own, and its mistakes are the quiet kind:
//! a `<var>` nobody bound reads as empty, a `<choose>` with no fallback produces
//! nothing when every branch misses, a second `<result>` silently wins over the
//! first. None of that stops a run — it produces a check digit that is wrong, in
//! a file of a million records that all look plausible.
//!
//! So the whole tree is walked here: unknown tags, bindings, arity, encodings,
//! and the wrapper children each construct needs. Diagnostics TDC180 through
//! TDC189.

use std::collections::BTreeSet;

use crate::errors::Diagnostic;
use crate::parser::ast::{Element, Kind};

const ENCODINGS: [&str; 6] = ["base36", "ascii", "unicode", "hex", "binary", "octal"];

/// The four tags that answer TRUE or FALSE rather than producing a value.
///
/// They are compute tags, so the unknown-tag check waves them through wherever
/// they appear; this set is what keeps a predicate out of a value position,
/// where the evaluator's own complaint arrived only at render time and named no
/// file, line or code.
const PREDICATE_TAGS: [&str; 4] = ["equals", "greater_than", "less_than", "is_digit"];

/// The two `<field>` names that arrive as NUMBERS rather than text. Their type is
/// known before the run, which is what makes the TDC286 refusal a proof.
const NUMERIC_BUILTIN_FIELDS: [&str; 2] = ["_count", "_total"];

const KNOWN_TAGS: [&str; 48] = [
    // literals and references
    "int",
    "str",
    "list",
    "field",
    "var",
    "current",
    "current_index",
    "acc",
    // binding
    "let",
    // collections
    "each",
    "reduce",
    "join",
    "split",
    "at",
    "length",
    // arithmetic
    "add",
    "subtract",
    "multiply",
    "divide",
    "mod",
    // encoding and conversion
    "encode",
    "to_number",
    "pad",
    "concat",
    "upper",
    "lower",
    "capitalize",
    "title",
    "mask",
    "slice",
    "replace",
    "trim",
    "group",
    // conditionals and the role wrappers
    "choose",
    "when",
    "otherwise",
    "test",
    "then",
    "result",
    "over",
    "do",
    "init",
    "in",
    "index",
    // predicates
    "equals",
    "greater_than",
    "less_than",
    "is_digit",
];

/// Tags the compute spec describes but this version does not ship, so the
/// diagnostic explains the gap instead of reading like a typo.
fn hint_for(tag: &str) -> &'static str {
    match tag {
        "param" => {
            "<param> belongs to the compute-def/use feature, which is not implemented yet. An \
             inline <compute> takes no parameters — read the value with <field name=\"…\"/> \
             instead."
        }
        _ => "",
    }
}

/// What is visible where: the bound variables, and which bodies we are inside.
#[derive(Clone)]
struct Scope<'a> {
    vars: BTreeSet<String>,
    in_iteration: bool,
    in_reduce: bool,
    /// The names `<field>` may read, or `None` when the caller does not know them
    /// — a pack generator's body is checked without the run's sequences in view.
    known_fields: Option<&'a BTreeSet<String>>,
}

impl Scope<'_> {
    fn iterating(&self, reduce: bool) -> Self {
        Self {
            in_iteration: true,
            in_reduce: reduce || self.in_reduce,
            ..self.clone()
        }
    }

    fn with_vars(&self, vars: BTreeSet<String>) -> Self {
        Self {
            vars,
            ..self.clone()
        }
    }
}

pub struct ComputeCheck<'a> {
    out: &'a mut Vec<Diagnostic>,
}

impl<'a> ComputeCheck<'a> {
    pub fn new(out: &'a mut Vec<Diagnostic>) -> Self {
        Self { out }
    }

    pub fn check(&mut self, compute_el: &Element, known_fields: Option<&BTreeSet<String>>) {
        let scope = Scope {
            vars: BTreeSet::new(),
            in_iteration: false,
            in_reduce: false,
            known_fields,
        };

        // Documented as "at most once". A second one silently wins and the first
        // is discarded, so a config can compute something entirely different from
        // what its author read top to bottom.
        let mut seen_result = false;
        for child in nodes(compute_el) {
            if child.name != "result" {
                continue;
            }
            if seen_result {
                self.report(
                    child,
                    "TDC189",
                    "<compute> has more than one <result>".to_string(),
                    "Only the last one would be used and the earlier ones silently dropped. Keep \
                     a single <result>.",
                );
            }
            seen_result = true;
        }

        self.walk_slot(&compute_el.children, &scope);
    }

    /// A slot: `<let>` prefixes bind for the siblings after them, and the last
    /// child is the value.
    fn walk_slot(&mut self, children: &[Element], scope: &Scope) {
        let mut bound = scope.vars.clone();
        for child in children {
            if child.kind == Kind::Data {
                continue;
            }
            if child.name == "let" {
                let name = child.attr_value("name").unwrap_or("").to_string();
                if bound.contains(&name) {
                    self.report(
                        child,
                        "TDC185",
                        format!("<let name=\"{name}\"> shadows an outer binding of the same name"),
                        "",
                    );
                }
                self.walk_slot(&child.children, &scope.with_vars(bound.clone()));
                bound.insert(name);
            } else {
                self.walk_expr(child, &scope.with_vars(bound.clone()));
            }
        }
    }

    /// A construct that needs one named wrapper child, like `<each><over>…`.
    fn walk_wrapper(&mut self, node: &Element, wrapper: &str, scope: &Scope) {
        for child in nodes(node) {
            if child.name == wrapper {
                self.walk_slot(&child.children, scope);
                return;
            }
        }
        self.report(
            node,
            "TDC187",
            format!("<{}> requires a <{wrapper}> child", node.name),
            "",
        );
    }

    fn walk_expr(&mut self, node: &Element, scope: &Scope) {
        if node.kind == Kind::Data {
            return;
        }
        let name = node.name.as_str();
        // A predicate answers TRUE or FALSE, so it is not a value. It is a compute
        // tag, so the unknown-tag check below waves it through wherever it appears —
        // and `<result><greater_than>…</greater_than></result>` then passed check and
        // died mid-run with a message carrying no code, no line and no file.
        if PREDICATE_TAGS.contains(&name) {
            self.report(
                node,
                "TDC180",
                format!("<{name}> is a predicate, not a value — it is valid only inside <test>"),
                &format!(
                    "A predicate answers true or false, and this position wants something to \
                     print. Wrap it: <choose><when><test><{name}>…</{name}></test></when>\
                     <then>…</then></choose>."
                ),
            );
            return;
        }
        if !KNOWN_TAGS.contains(&name) {
            self.report(
                node,
                "TDC180",
                format!("unknown compute tag <{name}>"),
                hint_for(name),
            );
            return;
        }

        match name {
            "current" | "current_index" => {
                if !scope.in_iteration {
                    self.report(
                        node,
                        "TDC181",
                        format!("<{name}/> is only valid inside a <do> iteration body"),
                        "",
                    );
                }
            }

            "acc" => {
                if !scope.in_reduce {
                    self.report(
                        node,
                        "TDC181",
                        "<acc/> is only valid inside a <reduce> <do> body".to_string(),
                        "",
                    );
                }
            }

            "var" => {
                let bound = node.attr_value("name").unwrap_or("").to_string();
                if !scope.vars.contains(&bound) {
                    self.report(
                        node,
                        "TDC182",
                        format!("<var name=\"{bound}\"> is not bound by an enclosing <let>"),
                        "",
                    );
                }
            }

            "field" => {
                let field = node.attr_value("name").unwrap_or("").to_string();
                if scope.known_fields.is_some_and(|k| !k.contains(&field)) {
                    self.report(
                        node,
                        "TDC182",
                        format!("<field name=\"{field}\"> refers to a value that is not in scope"),
                        "",
                    );
                }
            }

            "int" => {
                let raw = node.attr_value("v").unwrap_or("").to_string();
                if !is_integer_text(raw.trim()) {
                    self.report(
                        node,
                        "TDC188",
                        format!("<int v=\"{raw}\"> is not an integer"),
                        "Write a whole number, e.g. <int v=\"42\"/>. For text use <str v=\"…\"/>.",
                    );
                }
            }

            // A literal string: nothing about it can be wrong here.
            "str" => {}

            "group" => {
                // A size the engine cannot use turns grouping OFF and says nothing, so the
                // column comes out looking like the tag was never written. `size="2.5"` is
                // worse: measured "12 34 567", grouped by neither 2 nor 3.
                if let Some(size) = node.attr_value("size") {
                    let t = size.trim();
                    let ok = !t.is_empty()
                        && !t.starts_with('0')
                        && t.chars().all(|c| c.is_ascii_digit());
                    if !ok {
                        self.report(
                            node,
                            "TDC188",
                            format!("<group size=\"{t}\"> is not a whole number of characters"),
                            "Write a positive whole number. A size the engine cannot use would turn grouping off and leave the value unchanged, with nothing to show why.",
                        );
                    }
                }
                self.walk_slot(&node.children, scope);
            }

            "list" | "add" | "multiply" | "concat" => {
                // `<list>` has two spellings and reads only the first: with `v=` set the
                // children are never evaluated, so writing both keeps whichever the author
                // was not looking at.
                if node.name == "list" && node.attr_value("v").is_some() && nodes(node).next().is_some() {
                    self.report(
                        node,
                        "TDC189",
                        "<list> has both v= and children".to_string(),
                        "Only v= is read; the children are silently dropped. Keep one spelling: v=\"1,2,3\" for a literal list, or child elements for a computed one.",
                    );
                }
                for child in nodes(node) {
                    self.walk_expr(child, scope);
                }
            }

            "mod" | "divide" => {
                let count = nodes(node).count();
                if count != 2 {
                    self.report(
                        node,
                        "TDC183",
                        format!("<{name}> requires exactly 2 children, found {count}"),
                        "",
                    );
                }
                for child in nodes(node) {
                    self.walk_expr(child, scope);
                }
            }

            "subtract" => {
                if nodes(node).count() < 1 {
                    self.report(
                        node,
                        "TDC183",
                        "<subtract> requires at least one child".to_string(),
                        "",
                    );
                }
                for child in nodes(node) {
                    self.walk_expr(child, scope);
                }
            }

            "each" => {
                self.check_slot_names(node, &["over", "do"]);
                self.walk_wrapper(node, "over", scope);
                self.walk_wrapper(node, "do", &scope.iterating(false));
            }

            "reduce" => {
                self.check_slot_names(node, &["over", "init", "do"]);
                self.walk_wrapper(node, "over", scope);
                self.walk_wrapper(node, "init", scope);
                self.walk_wrapper(node, "do", &scope.iterating(true));
            }

            "at" => {
                self.check_slot_names(node, &["in", "index"]);
                self.walk_wrapper(node, "in", scope);
                self.walk_wrapper(node, "index", scope);
            }

            "mask" => {
                // The filter form of the same fault is TDC256 in mod.rs. A mask
                // with no pattern has nothing to keep, and the engine answered
                // that literally: it returned the empty string.
                if node.attr_value("pattern").unwrap_or("").trim().is_empty() {
                    self.report(
                        node,
                        "TDC256",
                        "<mask> needs a pattern= — without one it returns the empty string"
                            .to_string(),
                        "",
                    );
                }
                self.walk_slot(&node.children, scope);
            }

            "encode" => {
                let as_what = node.attr_value("as").unwrap_or("").to_string();
                if !ENCODINGS.contains(&as_what.as_str()) {
                    self.report(
                        node,
                        "TDC186",
                        format!("<encode>: unknown encoding \"{as_what}\""),
                        "",
                    );
                }
                self.numeric_builtin_argument(&node.children, "encode");
                self.walk_slot(&node.children, scope);
            }

            "choose" => self.walk_choose(node, scope),

            "over" => self.report(
                node,
                "TDC181",
                "<over> is only valid inside <each> or <reduce>".to_string(),
                "It names the list being walked. Outside those tags there is nothing to walk.",
            ),

            _ => self.walk_slot(&node.children, scope),
        }
    }

    /// A child in a SLOT position that names no slot this tag has.
    ///
    /// `<choose>`, `<when>`, `<each>`, `<reduce>` and `<at>` do not evaluate
    /// their children in order — each looks up the slots it knows by name and
    /// ignores everything else. So a misspelled slot name was never walked,
    /// never validated, and never run. Measured on the compute overview's own
    /// Luhn example with `<when>` spelled `<wen>`: the `<otherwise>` won every
    /// row and every card number came out invalid, while `check` said valid.
    ///
    /// The stray part is deliberately NOT walked: what the author meant is
    /// unknown, so every rule applied inside is a guess about the intended
    /// shape — and walking a misspelled `<wen>` as a value slot reported its
    /// perfectly correct `<test><equals>` as a predicate in a value position.
    fn check_slot_names(&mut self, node: &Element, slots: &[&str]) {
        for child in nodes(node) {
            if slots.contains(&child.name.as_str()) {
                continue;
            }
            let allowed = slots
                .iter()
                .map(|s| format!("<{s}>"))
                .collect::<Vec<_>>()
                .join(" and ");
            self.report(
                child,
                "TDC180",
                format!("<{}> has no <{}> part", node.name, child.name),
                &format!(
                    "Inside <{}> only {allowed} are read; anything else is silently ignored, so \
                     a misspelling here changes the result without any other sign.",
                    node.name
                ),
            );
        }
    }

    fn walk_choose(&mut self, node: &Element, scope: &Scope) {
        self.check_slot_names(node, &["when", "otherwise"]);
        let mut has_otherwise = false;
        for child in nodes(node) {
            if child.name == "when" {
                self.walk_when(child, scope);
            } else if child.name == "otherwise" {
                has_otherwise = true;
                self.walk_slot(&child.children, scope);
            }
        }
        if !has_otherwise {
            // Without it, a row matching no branch computes nothing at all — and
            // an empty check digit is indistinguishable from a value that happens
            // to be blank.
            self.report(
                node,
                "TDC184",
                "<choose> requires an <otherwise> branch".to_string(),
                "",
            );
        }
    }

    fn walk_when(&mut self, node: &Element, scope: &Scope) {
        self.check_slot_names(node, &["test", "then"]);
        match nodes(node).find(|c| c.name == "test") {
            None => self.report(
                node,
                "TDC187",
                "<when> requires a <test> child".to_string(),
                "",
            ),
            Some(test) => {
                if let Some(predicate) = nodes(test).next() {
                    self.walk_predicate(predicate, scope);
                }
            }
        }
        self.walk_wrapper(node, "then", scope);
    }

    fn walk_predicate(&mut self, node: &Element, scope: &Scope) {
        match node.name.as_str() {
            name @ ("equals" | "greater_than" | "less_than") => {
                if nodes(node).count() != 2 {
                    self.report(
                        node,
                        "TDC183",
                        format!("<{name}> requires exactly 2 children"),
                        "",
                    );
                }
                for child in nodes(node) {
                    self.walk_expr(child, scope);
                }
            }
            "is_digit" => {
                self.numeric_builtin_argument(&node.children, "is_digit");
                for child in nodes(node) {
                    self.walk_expr(child, scope);
                }
            }
            name => self.report(
                node,
                "TDC180",
                format!("unknown predicate <{name}> (valid only inside <test>)"),
                "",
            ),
        }
    }

    /// `<is_digit>` and `<encode>` both want ONE CHARACTER OF TEXT, and both took a
    /// number without a word said.
    ///
    /// The two failures look nothing alike, which is why only one of them was ever
    /// noticed. `<is_digit>` answered "no" on every row — including rows 1 to 9, where
    /// the count plainly is a digit — and `check` called the config valid. `<encode>`
    /// did stop the run, but with `<encode>: expected a single-character string` and no
    /// file, no line and no code, on a config `check` had also called valid. Same cause,
    /// so one refusal covers both.
    fn numeric_builtin_argument(&mut self, children: &[Element], tag: &str) {
        for child in children.iter().filter(|c| c.kind != Kind::Data) {
            if child.name != "field" {
                continue;
            }
            let named = child.attr_value("name").unwrap_or("").to_string();
            if !NUMERIC_BUILTIN_FIELDS.contains(&named.as_str()) {
                continue;
            }
            let hint = if tag == "is_digit" {
                "It would answer \"no\" on every row, including the rows where the count is a single digit. Compare the number itself with <equals> or <less_than>, or put the digit you mean into a <str>."
            } else {
                "The run would stop with \"expected a single-character string\", naming no file and no line. Wrap it in <concat> to turn the number into its digits — <encode> still needs exactly one of them — or put the character you mean into a <str>."
            };
            self.report(
                child,
                "TDC286",
                format!(
                    "<{tag}> asks about one character of text, and \
                     <field name=\"{named}\"> is a number"
                ),
                hint,
            );
        }
    }

    fn report(&mut self, node: &Element, code: &str, message: String, hint: &str) {
        self.out
            .push(Diagnostic::error(code, message, hint, node.pos));
    }
}

/// A node's element children — a `<data>` body carries no compute node, so it is
/// not an argument.
fn nodes(element: &Element) -> impl Iterator<Item = &Element> {
    element.children.iter().filter(|c| c.kind != Kind::Data)
}

/// `^-?\d+$`
fn is_integer_text(raw: &str) -> bool {
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}
