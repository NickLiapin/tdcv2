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

const KNOWN_TAGS: [&str; 47] = [
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

            "list" | "add" | "multiply" | "concat" => {
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
                self.walk_wrapper(node, "over", scope);
                self.walk_wrapper(node, "do", &scope.iterating(false));
            }

            "reduce" => {
                self.walk_wrapper(node, "over", scope);
                self.walk_wrapper(node, "init", scope);
                self.walk_wrapper(node, "do", &scope.iterating(true));
            }

            "at" => {
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

    fn walk_choose(&mut self, node: &Element, scope: &Scope) {
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
