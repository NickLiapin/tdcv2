//! Checks a config before it runs, and reports what is wrong by stable code.
//!
//! This exists because "the same config produces the same data everywhere" is
//! only half a promise if one implementation accepts what another refuses. A
//! config that runs in Rust and fails in TypeScript is a portability bug even
//! when no value was ever wrong.
//!
//! The grammar is deliberately permissive — it lets any element nest anywhere —
//! so every rule about *where* a tag may live is owned here rather than by the
//! parser. That keeps the grammar shared and small while the rules stay
//! readable.
//!
//! Codes and their meanings come from the reference. Nothing is invented here: a
//! rule that exists in one implementation and not the other is exactly the
//! divergence this file is meant to prevent.

mod compute_check;
mod tables;

use crate::sequence::pool;

use std::collections::{BTreeMap, BTreeSet};

use crate::date;
use crate::distribution::percent_mask;
use crate::errors::Diagnostic;
use crate::expr;
use crate::format::{mask, transforms};
use crate::generators::{accumulate, advanced_regex, file, number, regex, repeat};
use crate::output::column_type::ColumnType;
use crate::packs::DataPacks;
use crate::stats::distribution;
use crate::unicode;

/// A tag's attributes, unquoted and by name.
type Attrs = std::collections::BTreeMap<String, String>;
use crate::parser::ast::{Document, Element, Kind};
use crate::parser::lexer::Pos;

/// The document versions this runtime understands.
const SUPPORTED_VERSION: &str = "0.1.0";

pub fn validate(document: &Document) -> Vec<Diagnostic> {
    validate_with(document, None)
}

/// The same, with the packs a template address resolves against.
pub fn validate_with(document: &Document, packs: Option<DataPacks>) -> Vec<Diagnostic> {
    validate_in(document, packs, None)
}

/// The same again, plus the folder a relative `src=` resolves from — the config
/// file's own, not whatever directory the program was started in.
pub fn validate_in(
    document: &Document,
    packs: Option<DataPacks>,
    base_dir: Option<&str>,
) -> Vec<Diagnostic> {
    let mut v = Validator {
        packs,
        base_dir: base_dir.map(str::to_string),
        document_max_length: regex::DEFAULT_MAX_LENGTH,
        ..Validator::default()
    };
    v.run(document);
    v.diagnostics
}

#[derive(Default)]
struct Validator {
    diagnostics: Vec<Diagnostic>,
    /// The sequences declared BEFORE the one being walked. `of=` on a running
    /// total takes the declaration-order rule, and the gen check is too deep to
    /// be handed the walk's own list.
    declared_order: Vec<String>,
    locale: String,
    /// The packs a template address is looked up in, when the caller has them.
    /// Absent means addresses are taken on trust — a check that cannot be made
    /// is better skipped than guessed.
    packs: Option<DataPacks>,
    /// Where a relative `src=` resolves from — the config file's own folder.
    base_dir: Option<String>,
    document_max_length: i32,
    /// Every sequence name the config declares — what an interpolation may refer
    /// to.
    declared_names: BTreeSet<String>,
    /// Of those, the ones declared at the TOP level — which is what a `filter=`
    /// compares against. A pool's members share no namespace with the run's.
    env_names: BTreeSet<String>,
    /// Field names per `<pool>`, and the sequences that draw a whole member.
    pool_fields: BTreeMap<String, Vec<String>>,
    pool_references: BTreeSet<String>,
    /// Of those, the compounds: every `<gen>` named, so the sequence is a group
    /// of fields and produces no value of its own. Which is what `parent=`
    /// filters on.
    valueless_names: BTreeSet<String>,
    /// Sequences whose produced values are plainly the list in their `value=`.
    ///
    /// Which is what lets `if="Gender.Mail"` be caught: the dot on a plain
    /// sequence asks about a VALUE, and here the values are known. Only recorded
    /// where nothing rewrites them — see [`finite_text_values`].
    finite_values: std::collections::BTreeMap<String, Vec<String>>,
    /// Every `if=` seen, where its complaint belongs in the report, and the
    /// builtins in scope there.
    ///
    /// The names cannot be checked as the walk passes: an expression may name a
    /// sequence declared BELOW it, and the run resolves that happily, so
    /// checking mid-walk would invent errors on configs that work.
    pending_expressions: Vec<(usize, String, Pos, bool)>,
    /// Those of them that produce a list, which is what `each=` may walk.
    repeating_names: BTreeSet<String>,
}

impl Validator {
    fn error(&mut self, code: &str, message: String, hint: &str, at: Pos) {
        self.diagnostics
            .push(Diagnostic::error(code, message, hint, at));
    }

    fn warn(&mut self, code: &str, message: String, hint: &str, at: Pos) {
        self.diagnostics
            .push(Diagnostic::warning(code, message, hint, at));
    }

    fn run(&mut self, document: &Document) {
        let Some(tdc) = document.child("tdc") else {
            self.error(
                "TDC001",
                "document has no <tdc> root element".to_string(),
                "Wrap your configuration in a single <tdc>…</tdc> root tag.",
                Pos { line: 1, column: 0 },
            );
            return;
        };

        self.check_version(tdc);
        self.check_regex_max_length(tdc);
        self.document_max_length = regex::parse_max_length(tdc.attr_value("regex_max_length"))
            .unwrap_or(regex::DEFAULT_MAX_LENGTH);

        let env = tdc.child("env").filter(|e| e.kind == Kind::OpenClose);
        let block = tdc.child("block").filter(|e| e.kind == Kind::OpenClose);
        if block.is_none() {
            self.error(
                "TDC002",
                "<tdc> has no <block> child — nothing to render".to_string(),
                "<block> describes the layout of each generated card. Add a <block>…</block> \
                 inside <tdc>.",
                tdc.pos,
            );
        }

        self.check_tdc_children(tdc);
        if let Some(env) = env {
            self.check_env(env);
        }
        if let Some(block) = block {
            self.check_block(block);
        }

        // Now that every name is known, the expressions can be checked — and
        // each complaint goes back where its attribute was, so the report stays
        // in source order.
        let pending = std::mem::take(&mut self.pending_expressions);
        let mut shift = 0usize;
        for (at_index, condition, pos, each) in pending {
            let before = self.diagnostics.len();
            self.check_expression_names(&condition, pos, each);
            let found: Vec<Diagnostic> = self.diagnostics.split_off(before);
            let count = found.len();
            for (offset, diagnostic) in found.into_iter().enumerate() {
                self.diagnostics
                    .insert(at_index + shift + offset, diagnostic);
            }
            shift += count;
        }
    }

    /// `<tdc>` holds `<env>` and `<block>`, and a self-closing spelling of either
    /// is refused rather than honoured in part.
    ///
    /// `<env count="3" seed="demo"/>` parses, and then every attribute on it is
    /// discarded: the run silently falls back to a default count on a random
    /// seed. Half-honouring it is worse than refusing it.
    fn check_tdc_children(&mut self, tdc: &Element) {
        for child in &tdc.children {
            let name = child.name.clone();
            if child.kind == Kind::SelfClosing {
                if name == "env" || name == "block" {
                    self.error(
                        "TDC014",
                        format!(
                            "<{name}/> cannot be self-closing — its attributes and children would \
                             be ignored"
                        ),
                        &format!("Write <{name}> … </{name}>."),
                        child.pos,
                    );
                    continue;
                }
                self.error(
                    "TDC010",
                    format!("unknown child of <tdc>: \"<{name}>\""),
                    "Allowed children: env, block.",
                    child.pos,
                );
                continue;
            }
            if !tables::TDC_CHILDREN.contains(&name.as_str()) {
                self.error(
                    "TDC010",
                    format!("unknown child of <tdc>: \"<{name}>\""),
                    "Allowed children: env, block.",
                    child.pos,
                );
            }
        }
    }

    // ── document ─────────────────────────────────────────────────────────────

    fn check_version(&mut self, tdc: &Element) {
        self.check_closed_tag_attrs("tdc", tdc);
        let version = tdc.attr_value("version").map(str::to_string);
        let short = tdc.attr_value("v").map(str::to_string);

        if version.is_some() && short.is_some() {
            self.error(
                "TDC003",
                "both \"version\" and \"v\" are present on <tdc>".to_string(),
                "Use one of them. They mean the same thing.",
                tdc.pos,
            );
            return;
        }

        let Some(raw) = version.clone().or(short) else {
            return;
        };
        let key = if version.is_some() { "version" } else { "v" };

        // Any dot-separated numeric version: "0.1", "0.1.0", "1.2.3". Insisting
        // on exactly two parts would reject the version this runtime itself
        // declares.
        if !is_version_text(raw.trim()) {
            self.error(
                "TDC004",
                format!("invalid TDC document version \"{raw}\""),
                "Use dot-separated numeric versions, e.g. \"0.1\", \"0.1.0\", or \"1.2.3\".",
                tdc.at(key),
            );
            return;
        }

        // A document from the future may use tags this runtime has never heard
        // of, and rendering it as best we can would produce data that is quietly
        // missing whatever it did not understand.
        if compare_versions(&raw, SUPPORTED_VERSION) > 0 {
            self.error(
                "TDC005",
                format!(
                    "document version \"{raw}\" is newer than this runtime supports \
                     ({SUPPORTED_VERSION})"
                ),
                "Update the library, or lower the version attribute.",
                tdc.at(key),
            );
        }
    }

    fn check_regex_max_length(&mut self, tdc: &Element) {
        let Some(raw) = tdc.attr_value("regex_max_length").map(str::to_string) else {
            return;
        };
        if raw.trim().parse::<i32>().is_ok_and(|v| v > 0) {
            return;
        }
        self.error(
            "TDC096",
            format!("regex_max_length must be a positive integer, got \"{raw}\""),
            "It caps how long a generated regex value may be.",
            tdc.at("regex_max_length"),
        );
    }

    // ── env ──────────────────────────────────────────────────────────────────

    fn check_env(&mut self, env: &Element) {
        self.locale = env.attr_value("local").unwrap_or("en").to_string();

        if let Some(count) = env.attr_value("count").map(str::to_string) {
            if !count.trim().parse::<i32>().is_ok_and(|n| n >= 0) {
                self.error(
                    "TDC020",
                    format!("invalid count \"{count}\" — expected a non-negative integer"),
                    "count is how many records to generate.",
                    env.at("count"),
                );
            }
        }

        if let Some(inject) = env.attr_value("inject").map(str::to_string) {
            if !inject.contains('%') {
                self.error(
                    "TDC021",
                    format!(
                        "inject pattern \"{inject}\" has no \"%\" placeholder — interpolation \
                         will never match"
                    ),
                    "Use a single \"%\" where the sequence name should go, e.g. \
                     inject=\"${{{{%}}}}\".",
                    env.at("inject"),
                );
            }
        }

        self.check_children(env, "env", &tables::ENV_CHILDREN);
        self.check_closed_tag_attrs("env", env);
        self.check_group_sizes(env);
        // Pools first, and only their shape: a reference may stand above the
        // pool it names, and complaining about an unknown field in that case
        // would report a problem the author does not have.
        self.collect_pool_fields(env);
        let mut pools_above: Vec<String> = Vec::new();
        for child in &env.children {
            if child.kind == Kind::OpenClose && child.name == "pool" {
                self.check_closed_tag_attrs("pool", child);
                self.check_pool(child);
                // Only the pools ALREADY seen: a member may draw from one of
                // those and from nothing else, which makes a cycle unwritable.
                self.check_pool_member_refs(child, &pools_above);
                if let Some(name) = child.attr_value("name") {
                    if pools_above.iter().any(|p| p == name) {
                        // The second pool quietly replaced the first, and the
                        // only sign was a TDC193 in the block about a field
                        // that "does not exist" — the wrong place to look.
                        self.error(
                            "TDC241",
                            format!("duplicate pool name \"{name}\""),
                            "A pool is reached by name, so two of them cannot share one. \
                             Rename or remove the second.",
                            child.pos,
                        );
                    } else {
                        pools_above.push(name.to_string());
                    }
                }
            }
        }

        let mut names: BTreeSet<String> = BTreeSet::new();
        let mut declared: Vec<String> = Vec::new();
        self.declared_order.clear();

        for declaration in declarations(env) {
            let tag = declaration.name.clone();
            if tag == "sequence" && declaration.wrapped_in_group.is_some() {
                self.check_env_group_member(
                    declaration.element,
                    declaration.wrapped_in_group.unwrap(),
                );
            }
            let in_pool = declaration.in_pool;
            let open = declaration.element;
            self.check_closed_tag_attrs(&tag, open);
            let name = open.attr_value("name").map(str::to_string);
            let named = name.as_deref().map(str::trim).filter(|n| !n.is_empty());

            match named {
                None => self.error(
                    "TDC030",
                    format!("<{tag}> is missing a required \"name\" attribute"),
                    "A sequence is referenced by name, so it needs one.",
                    open.pos,
                ),
                Some(n) if is_builtin(n) => self.error(
                    "TDC033",
                    format!("sequence name \"{n}\" collides with a builtin"),
                    &format!("Builtins: {}.", BUILTINS.join(", ")),
                    open.at("name"),
                ),
                // The leading underscore is the engine's namespace. Letting a
                // config into it means a future builtin would silently shadow
                // somebody's column.
                Some(n) if n.starts_with('_') => self.error(
                    "TDC031",
                    format!("sequence name \"{n}\" starts with \"_\" — reserved for builtins"),
                    "User sequences should avoid the leading underscore.",
                    open.at("name"),
                ),
                Some(n) if !in_pool && !names.insert(n.to_string()) => self.error(
                    "TDC032",
                    format!("duplicate sequence name \"{n}\""),
                    "Two sequences cannot share a name — the second would shadow the first.",
                    open.at("name"),
                ),
                Some(_) => {}
            }

            // Declaration order decides who can filter whom: a parent must
            // already exist, because the rows it selects are what the child is
            // built over.
            if let Some(parent) = open
                .attr_value("parent")
                .map(str::to_string)
                .filter(|p| !p.trim().is_empty())
            {
                let parent_name = match parent.find('.') {
                    Some(dot) => &parent[..dot],
                    None => parent.as_str(),
                };
                if parent_name.is_empty() {
                    self.error(
                        "TDC034",
                        format!("invalid parent reference \"{parent}\""),
                        "Syntax: parent=\"ParentName\" or parent=\"ParentName.Value\".",
                        open.at("parent"),
                    );
                } else if !declared.iter().any(|d| d == parent_name) {
                    self.error(
                        "TDC035",
                        format!(
                            "parent sequence \"{parent_name}\" is not declared before this \
                             sequence"
                        ),
                        "Move the parent above it. A child is built over the rows its parent \
                         selected.",
                        open.at("parent"),
                    );
                } else if self.valueless_names.contains(parent_name) {
                    // A parent selects rows by the VALUE it produced. A compound
                    // is a group of fields and produces none, so no row can ever
                    // match — the run used to discover that and report the parent
                    // as unknown, sending the reader after a name that is right
                    // there.
                    self.error(
                        "TDC214",
                        format!(
                            "compound sequence \"{parent_name}\" has no value of its own to \
                             filter on"
                        ),
                        &format!(
                            "A parent is chosen by the value it produced, e.g. \
                             parent=\"Gender.Male\". \"{parent_name}\" is a group of fields and \
                             produces none — name one of its fields, or a sequence that has a \
                             single value."
                        ),
                        open.at("parent"),
                    );
                }
            }

            match tag.as_str() {
                "switch" => self.check_switch(open, &declared),
                "mix" => self.check_mix(open, true),
                "sequence" => {
                    self.check_sequence_body(open, named);
                    self.check_sequence_data_attrs(open);
                    self.check_compute_body(open);
                }
                _ => {}
            }

            for inner in &open.children {
                self.check_gens_in(inner);
            }

            if let Some(n) = named {
                declared.push(n.to_string());
                self.declared_order.push(n.to_string());
                self.declared_names.insert(n.to_string());
                if !in_pool {
                    self.env_names.insert(n.to_string());
                    self.register_pool_reference(open, n);
                }
                // A compound's fields are referenced as Name.Field, and a flag
                // column is a name too. Fields inside a <distinct> wrapper are
                // ordinary fields, so they count as well.
                self.collect_field_names(open, n);
                for key in ["flag", "anomaly_flag"] {
                    if let Some(extra) = open
                        .attr_value(key)
                        .filter(|v| !v.trim().is_empty())
                        .map(str::to_string)
                    {
                        self.declared_names.insert(extra);
                    }
                }
            }
        }
    }

    /// A group of fewer than two sequences constrains nothing.
    ///
    /// It used to be dropped in silence: `check` called the config valid and
    /// the run drew repeats anyway. A warning rather than an error — the config
    /// still runs, it just does not do what it was written for.
    /// `1000000` → `1,000,000`. The message names a size a person has to read.
    fn grouped(value: i64) -> String {
        let digits = value.to_string();
        let mut out = String::new();
        for (i, ch) in digits.chars().enumerate() {
            if i > 0 && (digits.len() - i) % 3 == 0 {
                out.push(',');
            }
            out.push(ch);
        }
        out
    }

    /// Field names per pool, gathered before the members are walked.
    ///
    /// A pre-pass rather than a running tally, so a reference is understood
    /// wherever it stands. A validator that only reported "unknown field" for a
    /// pool written at the bottom of the file would report the wrong problem.
    fn collect_pool_fields(&mut self, env: &Element) {
        for child in &env.children {
            if child.kind != Kind::OpenClose || child.name != "pool" {
                continue;
            }
            let Some(name) = child.attr_value("name") else {
                continue;
            };
            let mut fields: Vec<String> = Vec::new();
            for member in &child.children {
                if member.kind != Kind::OpenClose {
                    continue;
                }
                match member.name.as_str() {
                    "sequence" | "mix" | "switch" => {
                        add_member_fields(&mut fields, member, &self.pool_fields);
                    }
                    "uniq" | "distinct" => {
                        for wrapped in &member.children {
                            if wrapped.kind == Kind::OpenClose {
                                add_member_fields(&mut fields, wrapped, &self.pool_fields);
                            }
                        }
                    }
                    _ => {}
                }
            }
            self.pool_fields.insert(name.to_string(), fields);
        }
    }

    /// A member that draws from another pool may only name a pool declared ABOVE.
    ///
    /// The engine builds pools in declaration order, so this is not a style rule:
    /// a pool named below has no table yet when this one is computed, and a pool
    /// naming itself never would. Both used to pass validation and produce a
    /// member with no fields, which surfaced far away as "not a field of R" —
    /// blaming the line that reads for a mistake made in the declaration.
    ///
    /// Declaration order is also the entire cycle check: a cycle cannot be
    /// written down, so there is nothing to detect.
    fn check_pool_member_refs(&mut self, pool: &Element, above: &[String]) {
        let pool_name = pool.attr_value("name").unwrap_or_default().to_string();
        for member in pool_member_nodes(pool) {
            let Some(target) = member_pool_ref(member) else {
                continue;
            };
            if above.iter().any(|p| p == &target) {
                continue;
            }
            let itself = target == pool_name;
            let message = if itself {
                format!("pool \"{pool_name}\" draws from itself")
            } else {
                format!("pool \"{pool_name}\" draws from \"{target}\", which is not declared above it")
            };
            let hint = if itself {
                "A pool is built before its own members exist, so there is nothing to draw. That \
                 order is also why a cycle between pools cannot be written down."
                    .to_string()
            } else {
                format!(
                    "Pools are built in declaration order, so a pool can only read the pools \
                     above it. Move \"{target}\" above \"{pool_name}\". That order is also why a \
                     cycle between pools cannot be written down."
                )
            };
            self.error("TDC236", message, &hint, member.pos);
        }
    }

    /// A `<pool>`'s own attributes and the tags it may hold.
    ///
    /// What is inside a legal child is NOT checked here — the pool's members go
    /// through the same checks the top level gets, which is the whole point of
    /// the construct.
    fn check_pool(&mut self, node: &Element) {
        let name = node.attr_value("name").map(str::trim).unwrap_or("");
        if name.is_empty() {
            self.error(
                "TDC222",
                "<pool> has no name".to_string(),
                "A pool is read by name: <pool name=\"Doctors\" count=\"30\">, then \
                 <gen type=\"pool\" value=\"Doctors\"/>.",
                node.pos,
            );
        }
        let raw = node.attr_value("count").map(str::trim).unwrap_or("");
        if raw.is_empty() {
            let shown = if name.is_empty() {
                String::new()
            } else {
                format!(" name=\"{name}\"")
            };
            self.error(
                "TDC222",
                format!("<pool{shown}> has no count"),
                "count is how many members the table holds — thirty doctors for two thousand \
                 patients: count=\"30\".",
                node.pos,
            );
        } else {
            match raw.parse::<i64>() {
                Ok(count) if count >= 1 => {
                    if count > pool::POOL_MAX_MEMBERS {
                        self.error(
                            "TDC235",
                            format!(
                                "<pool> holds {} members — more than the {} a pool may hold",
                                Self::grouped(count),
                                Self::grouped(pool::POOL_MAX_MEMBERS)
                            ),
                            "A pool is kept in memory for the whole run (measured: ~320 bytes a \
                             member with four fields), so this would cost hundreds of megabytes \
                             before the first row. If you meant the number of ROWS, that is count \
                             on <env>.",
                            node.pos,
                        );
                    } else if count > pool::POOL_WARN_MEMBERS {
                        self.warn(
                            "TDC234",
                            format!(
                                "<pool> holds {} members and stays in memory for the whole run",
                                Self::grouped(count)
                            ),
                            "Measured at ~320 bytes a member with four fields — 100,000 members \
                             cost about 29 MB. It works; it is worth being deliberate about. If \
                             you meant the number of ROWS, that is count on <env>.",
                            node.pos,
                        );
                    }
                }
                _ => self.error(
                    "TDC223",
                    format!("<pool> count \"{raw}\" is not a whole number of members"),
                    "Use a whole number of at least 1 — a pool of nothing has no member to hand \
                     out.",
                    node.pos,
                ),
            }
        }

        for child in &node.children {
            if child.kind != Kind::OpenClose {
                continue;
            }
            let Some(reason) = forbidden_in_pool(&child.name) else {
                continue;
            };
            self.error(
                "TDC230",
                format!("<{}> cannot live inside a <pool>", child.name),
                &format!("{reason}."),
                child.pos,
            );
        }
    }

    /// Publish `Ref.field` for a `<gen type="pool">`, and check what it names.
    fn register_pool_reference(&mut self, sequence: &Element, name: &str) {
        for child in &sequence.children {
            if child.name != "gen" || child.attr_value("type") != Some("pool") {
                continue;
            }
            let pool_name = child.attr_value("value").map(str::trim).unwrap_or("");
            let Some(fields) = self.pool_fields.get(pool_name).cloned() else {
                let declared: Vec<String> = self.pool_fields.keys().cloned().collect();
                self.error(
                    "TDC224",
                    format!(
                        "<gen type=\"pool\"> draws from \"{pool_name}\", which is not a \
                         declared pool"
                    ),
                    &if declared.is_empty() {
                        "Declare it first: <pool name=\"…\" count=\"…\"> inside the same \
                         <env>."
                            .to_string()
                    } else {
                        format!("Declared pools: {}.", declared.join(", "))
                    },
                    child.pos,
                );
                continue;
            };
            self.check_pool_filter(child, pool_name, &fields);
            for field in &fields {
                self.declared_names.insert(format!("{name}.{field}"));
            }
            // The reference itself is a record, not a value: nothing to print.
            self.valueless_names.insert(name.to_string());
            self.pool_references.insert(name.to_string());
        }
    }

    /// What `filter=` may name.
    ///
    /// A qualified `Pool.field` says exactly what it means, so a field the pool
    /// has not got is a certain mistake. An UNQUALIFIED unknown name is left
    /// alone: the expression language reads a bare word as a string literal,
    /// which is how `filter="c == North"` says "northern only".
    fn check_pool_filter(&mut self, gen: &Element, pool_name: &str, fields: &[String]) {
        let Some(expression) = gen.attr_value("filter") else {
            return;
        };
        if expression.trim().is_empty() {
            return;
        }
        for (qualifier, field) in dotted_names(expression) {
            if qualifier != pool_name || fields.iter().any(|f| f == &field) {
                continue;
            }
            self.error(
                "TDC226",
                format!(
                    "filter= reads \"{qualifier}.{field}\", but pool \"{pool_name}\" has no \
                     field \"{field}\""
                ),
                &if fields.is_empty() {
                    format!("Pool \"{pool_name}\" declares no fields.")
                } else {
                    format!("Fields of \"{pool_name}\": {}.", fields.join(", "))
                },
                gen.pos,
            );
        }
        let mut seen: BTreeSet<String> = BTreeSet::new();
        for word in plain_names(expression) {
            if !seen.insert(word.clone()) {
                continue;
            }
            if !fields.iter().any(|f| f == &word) || !self.env_names.contains(&word) {
                continue;
            }
            self.error(
                "TDC232",
                format!(
                    "\"{word}\" in filter= is both a field of pool \"{pool_name}\" and a \
                     sequence — which one is meant is not decidable"
                ),
                &format!(
                    "Rename one of them. Qualifying one side (\"{pool_name}.{word}\") does not \
                     help: the other \"{word}\" still reads as the member's field, so the test \
                     would compare a value with itself."
                ),
                gen.pos,
            );
        }
    }

    fn check_group_sizes(&mut self, env: &Element) {
        for child in &env.children {
            if child.kind != Kind::OpenClose {
                continue;
            }
            let tag = child.name.clone();
            if tag != "uniq" && tag != "distinct" {
                continue;
            }
            // A group wrapper is not a declaration either, so this is the one pass that
            // reaches it — see the note on <pool> above.
            self.check_closed_tag_attrs(&tag, child);
            let members = child
                .children
                .iter()
                .filter(|c| {
                    c.kind == Kind::OpenClose
                        && (c.name == "sequence" || c.name == "mix" || c.name == "switch")
                })
                .count();
            if members >= 2 {
                continue;
            }
            let counted = if members == 0 {
                "no sequences"
            } else {
                "one sequence"
            };
            let hint = if tag == "uniq" {
                "Put at least two <sequence> members in it, or drop the wrapper and write \
                 uniq=\"true\" on the one sequence — that draws without replacement."
            } else {
                "Put at least two <sequence> members in it, or drop the wrapper: there is \
                 nothing for a single value to differ from."
            };
            self.warn(
                "TDC221",
                format!(
                    "<{tag}> wraps {counted} — a group constrains its members against each \
                     other, so it does nothing here"
                ),
                hint,
                child.pos,
            );
        }
    }

    /// A member of an env-level group has to produce one value per row.
    ///
    /// The constraint is stated between sequences, so a compound has no single
    /// value to compare or to make unique. Refusing is the only honest answer:
    /// silently using its first field would enforce something the config did not
    /// ask for.
    fn check_env_group_member(&mut self, sequence: &Element, tag: &str) {
        let gens: Vec<&Element> = sequence
            .children
            .iter()
            .filter(|c| c.kind == Kind::SelfClosing && c.name == "gen")
            .collect();
        let named = gens.iter().filter(|g| g.attr("name").is_some()).count();

        if named > 0 || gens.len() > 1 {
            let name = sequence.attr_value("name").unwrap_or("?").to_string();
            self.error(
                "TDC129",
                format!(
                    "<sequence name=\"{name}\"> inside a config-level <{tag}> must produce a \
                     single value"
                ),
                &format!(
                    "A <{tag}> around sequences uses one value per sequence. Use a simple <gen> or \
                     a <switch> sequence, not a compound (multi-field) one."
                ),
                sequence.pos,
            );
        }
    }

    /// Register `Name.Field` for every field, wherever in the sequence body it
    /// sits.
    fn collect_field_names(&mut self, element: &Element, name: &str) {
        for child in &element.children {
            if child.kind == Kind::SelfClosing && child.name == "gen" {
                if let Some(field) = child.attr_value("name").filter(|f| !f.trim().is_empty()) {
                    self.declared_names.insert(format!("{name}.{field}"));
                }
                // anomaly_flag= sits on the <gen>, not on the <sequence>, and
                // names a real column — referencing it must not read as a typo
                // for a sequence nobody declared.
                if let Some(flag) = child
                    .attr_value("anomaly_flag")
                    .filter(|f| !f.trim().is_empty())
                {
                    self.declared_names.insert(flag.to_string());
                }
                // A malformed repeat is reported by the repeat check; not this
                // pass's business.
                if matches!(repeat::parse(&child.attr_map()), Ok(Some(_))) {
                    self.repeating_names.insert(name.to_string());
                }
                continue;
            }
            // A named `<data>` is a field too — a constant one. It is not a
            // `<gen>`, so the arm above never sees it, and without this a
            // reference to a constant reads as a typo.
            if child.name == "data" {
                if let Some(field) = child.attr_value("name").filter(|f| !f.trim().is_empty()) {
                    self.declared_names.insert(format!("{name}.{field}"));
                }
                continue;
            }
            if child.kind == Kind::OpenClose && child.name == "distinct" {
                self.collect_field_names(child, name);
            }
        }
    }

    /// A sequence must actually produce something, and a compound must name its
    /// fields.
    fn check_sequence_body(&mut self, open: &Element, name: Option<&str>) {
        let mut gens: Vec<&Element> = Vec::new();
        let mut has_compute = false;
        let mut compute_el = None;
        for child in &open.children {
            if child.kind == Kind::SelfClosing && child.name == "gen" {
                gens.push(child);
            } else if child.kind == Kind::OpenClose {
                if child.name == "compute" {
                    has_compute = true;
                    compute_el = Some(child);
                } else if child.name == "distinct" {
                    for g in &child.children {
                        if g.kind == Kind::SelfClosing && g.name == "gen" {
                            gens.push(g);
                        }
                    }
                }
            }
        }

        // A <sequence> holds only <gen> (optionally wrapped in <distinct>). A
        // construct that belongs at env level is a placement mistake — saying so
        // beats letting it fall through to a confusing "no <gen>", which names a
        // symptom rather than the cause.
        let mut misplaced = 0;
        for child in &open.children {
            if tables::MISPLACED_IN_SEQUENCE.contains(&child.name.as_str()) {
                let hint = tables::PLACEMENT_HINTS
                    .iter()
                    .find(|(k, _)| *k == child.name)
                    .map_or("", |(_, h)| *h);
                self.error(
                    "TDC013",
                    format!("<{}> is not allowed directly inside <sequence>", child.name),
                    hint,
                    child.pos,
                );
                misplaced += 1;
            }
        }

        if has_compute && !gens.is_empty() {
            // One <sequence>, two producers. The engine cannot honour both, and the five
            // implementations did not even agree on which one to drop — same config,
            // different data. Refuse instead.
            let pos = compute_el.map_or(open.pos, |c| c.pos);
            self.error(
                "TDC219",
                format!(
                    "<compute> cannot sit beside a <gen> in <sequence name=\"{}\"> \u{2014} \
                     one of the two would be dropped",
                    name.unwrap_or("?")
                ),
                "A sequence either DERIVES its value with <compute> or DRAWS it with <gen>. \
                 Move the <compute> into its own <sequence> and read the drawn one from it \
                 with <field name=\"\u{2026}\"/>.",
                pos,
            );
        }

        if has_compute && gens.is_empty() {
            self.uniq_unsupported(
                open,
                name,
                "<compute> processes the values it reads rather than drawing any of its own, \
                 so it cannot promise uniqueness",
            );
        }

        if gens.is_empty() && !has_compute && misplaced == 0 {
            self.error(
                "TDC036",
                format!(
                    "<sequence name=\"{}\"> has no <gen> child",
                    name.unwrap_or("?")
                ),
                "A sequence needs at least one <gen type=\"…\"/> describing how values are made.",
                open.pos,
            );
            return;
        }

        // Conditional first, exactly as the reference orders it: gens carrying
        // `if` are branches, and a branch has no need of a name.
        if gens.iter().any(|g| g.attr("if").is_some()) {
            self.uniq_unsupported(
                open,
                name,
                "its value is picked per row from <gen if=\"…\"> branches rather than drawn as \
                 one pool, so it cannot promise uniqueness",
            );
            return;
        }

        self.uniq_on_composed(open, name, &gens);

        // Three readings, and the body says which: every gen named is a compound
        // (several columns, no value of its own), one unnamed gen alone is a
        // simple sequence, and anything else COMPOSES — the unnamed gens and the
        // literals concatenate into the sequence's own value while the named
        // ones stay fields beside it. None of the three is an error, so the only
        // thing left to check is that two fields do not share a name.
        let mut field_names: BTreeSet<String> = BTreeSet::new();
        for gen in &gens {
            let Some(field) = gen.attr_value("name").filter(|f| !f.trim().is_empty()) else {
                continue;
            };
            if !field_names.insert(field.to_string()) {
                self.error(
                    "TDC111",
                    format!(
                        "duplicate field name \"{field}\" inside compound <sequence \
                         name=\"{}\">",
                        name.unwrap_or("?")
                    ),
                    "Each <gen name=\"…\"> within a compound sequence must have a unique name.",
                    gen.at("name"),
                );
            }
        }

        // Compound: every gen named, and no literal to compose with. Recorded so
        // a later `parent=` naming this sequence can be refused before the run
        // rather than during it.
        let composes = open
            .children
            .iter()
            .any(|c| c.kind == Kind::Data && !c.text.trim().is_empty());
        if !gens.is_empty() && field_names.len() == gens.len() && !composes {
            if let Some(n) = name {
                self.valueless_names.insert(n.to_string());
            }
        }

        // A simple body — one unnamed gen and nothing else — may say outright
        // what it produces.
        let simple = gens.len() == 1 && field_names.is_empty() && !composes;
        if simple {
            if let (Some(n), Some(values)) = (name, finite_text_values(gens[0])) {
                self.finite_values.insert(n.to_string(), values);
            }
        }
    }

    /// A `<data>` inside a `<sequence>` reads `name` and nothing else.
    ///
    /// It is a literal, or — with a name — a constant field. An output type
    /// belongs on the `<data>` in the `<line>`, where the column is actually
    /// emitted; dropping one here is the silent loss this whole reading was
    /// introduced to end.
    /// `uniq="true"` where the value is not DRAWN, so there is no pool to take from.
    ///
    /// Uniqueness is a property of a draw — without replacement on a simple
    /// sequence, a rearrangement of the columns on a compound one. A computed
    /// result and a conditional pick are neither, so the attribute could only be
    /// ignored, and it used to be in silence: the config claimed the column was
    /// unique and the data disagreed without a word.
    /// `uniq="true"` on a composed value that joins two or more DRAWN parts.
    ///
    /// One drawn part plus constants is fine and honoured: appending a constant
    /// cannot make two different draws collide. Two drawn parts have no fixed
    /// widths, so a unique set of parts is not a unique join — `9` + `15` and
    /// `91` + `5` are the same three characters.
    fn uniq_on_composed(&mut self, open: &Element, name: Option<&str>, gens: &[&Element]) {
        let declared = open.attr("uniq").map(|a| a.value()).unwrap_or("");
        if !declared.trim().eq_ignore_ascii_case("true") {
            return;
        }
        let drawn = gens.iter().filter(|g| g.attr("name").is_none()).count();
        if drawn < 2 {
            return;
        }
        self.error(
            "TDC220",
            format!(
                "uniq=\"true\" cannot be honoured on <sequence name=\"{}\">: its value joins \
                 {drawn} drawn parts, and a unique set of parts is not a unique join when the \
                 parts have no fixed width",
                name.unwrap_or("?")
            ),
            "Give each part its own <sequence> and wrap them in <uniq>\u{2026}</uniq>, with a \
             fixed width per part (length= plus first_zero=\"true\" on a number). Then the join \
             can be split back one way only, so a unique combination is a unique result.",
            open.at("uniq"),
        );
    }

    fn uniq_unsupported(&mut self, open: &Element, name: Option<&str>, why: &str) {
        let declared = open.attr("uniq").map(|a| a.value()).unwrap_or("");
        if !declared.trim().eq_ignore_ascii_case("true") {
            return;
        }
        self.error(
            "TDC218",
            format!(
                "uniq=\"true\" is not allowed on <sequence name=\"{}\">: {why}",
                name.unwrap_or("?")
            ),
            "Put uniq= on the sequences this one reads, or wrap them in <uniq>…</uniq> so their \
             combination is unique across records. When the parts have fixed widths, a unique \
             combination means a unique result.",
            open.at("uniq"),
        );
    }

    fn check_sequence_data_attrs(&mut self, open: &Element) {
        for child in &open.children {
            if child.kind != Kind::Data {
                continue;
            }
            for attr in &child.attrs {
                if attr.name == "name" || attr.name == "comment" {
                    continue;
                }
                self.error(
                    "TDC015",
                    format!(
                        "<data> inside <sequence> does not read \"{}\" — it is ignored",
                        attr.name
                    ),
                    "Inside a <sequence> a <data> is a literal or, with name=\"…\", a constant \
                     field. Output types belong on the <data> in the <line>.",
                    attr.at(),
                );
            }
        }
    }

    fn check_children(&mut self, parent: &Element, parent_name: &str, allowed: &[&str]) {
        for child in &parent.children {
            if allowed.contains(&child.name.as_str()) {
                continue;
            }
            // Two different mistakes, and two different fixes. A construct this
            // language knows is in the wrong place and needs moving; a tag nobody
            // has heard of is a typo and needs correcting. One code for both
            // would tell the author neither.
            match tables::PLACEMENT_HINTS
                .iter()
                .find(|(k, _)| *k == child.name)
            {
                Some((_, hint)) => self.error(
                    "TDC013",
                    format!(
                        "<{}> is not allowed directly inside <{parent_name}>",
                        child.name
                    ),
                    hint,
                    child.pos,
                ),
                None => self.error(
                    "TDC010",
                    format!("unknown child of <{parent_name}>: \"<{}>\"", child.name),
                    &format!("Allowed children: {}.", sorted(allowed).join(", ")),
                    child.pos,
                ),
            }
        }
    }

    fn check_closed_tag_attrs(&mut self, tag: &str, element: &Element) {
        let Some(known) = tables::lookup(&tables::CLOSED_TAG_ATTRIBUTES, tag) else {
            return;
        };
        for (key, _) in element.attr_map() {
            if !known.contains(&key.as_str()) {
                self.error(
                    "TDC015",
                    format!("<{tag}> does not read \"{key}\" — it is ignored"),
                    &format!("Attributes of <{tag}>: {}.", sorted(known).join(", ")),
                    element.at(&key),
                );
            }
        }
    }

    // ── gen ──────────────────────────────────────────────────────────────────

    fn check_gens_in(&mut self, element: &Element) {
        if element.kind == Kind::SelfClosing && element.name == "gen" {
            self.check_gen(element);
            return;
        }
        if element.kind == Kind::OpenClose {
            for inner in &element.children {
                self.check_gens_in(inner);
            }
        }
    }

    fn check_gen(&mut self, gen: &Element) {
        let attrs = gen.attr_map();

        // A conditional gen carries `if` as its branch condition, and a plain one
        // may have one too. An expression here is an expression like any other:
        // left unchecked, a branch that can never be taken looks exactly like a
        // branch nobody happened to hit.
        if let Some(condition) = gen.attr_value("if").map(str::to_string) {
            self.check_if_expression(&condition, gen.at("if"));
            self.pending_expressions
                .push((self.diagnostics.len(), condition, gen.at("if"), false));
        }
        let gen_type = attrs
            .get("type")
            .map(String::as_str)
            .map(str::trim)
            .filter(|t| !t.is_empty());

        match gen_type {
            None => self.error(
                "TDC040",
                "<gen> is missing a required \"type\" attribute".to_string(),
                "Every generator names what it generates.",
                gen.at("name"),
            ),
            Some(t) if !tables::GEN_TYPES.contains(&t) => self.error(
                "TDC041",
                format!("unknown gen type \"{t}\""),
                &format!("Known types: {}.", sorted(&tables::GEN_TYPES).join(", ")),
                gen.at("type"),
            ),
            Some(_) => {}
        }

        self.check_required_value(gen, &attrs, gen_type);
        self.check_number(gen, &attrs, gen_type);
        self.check_regexes(gen, &attrs, gen_type);
        self.check_symbol(gen, &attrs, gen_type);
        self.check_date(gen, &attrs, gen_type);
        self.check_repeat(gen, &attrs, gen_type);

        self.check_gen_attributes(gen, &attrs, gen_type);

        self.check_weight(gen, &attrs, gen_type);
        self.check_source(gen, &attrs, gen_type);
        self.check_http(gen, &attrs, gen_type);
        self.check_running(gen, &attrs, gen_type);
        self.check_mask(gen, &attrs);
        self.check_counter(gen, &attrs, gen_type);
        self.check_date_templates(gen, &attrs, gen_type);
        self.check_case_and_order(gen, &attrs);

        if gen_type == Some("text") {
            if let Some(percent) = attrs.get("percent") {
                let count = split_count(attrs.get("value").map(String::as_str).unwrap_or(""));
                self.check_percent_mask(
                    percent,
                    count,
                    ["TDC051", "TDC052", "TDC053"],
                    gen.at("percent"),
                );
            }
        }

        if gen_type == Some("number") {
            if let (Some(percent), Some(length)) = (attrs.get("percent"), attrs.get("length")) {
                self.check_percent_mask(
                    percent,
                    split_count(length),
                    ["TDC084", "TDC085", "TDC086"],
                    gen.at("percent"),
                );
            }
        }
    }

    /// The `http` generator: everything knowable before the run.
    ///
    /// A missing endpoint, an address that is not a URL, an `in=` naming nothing.
    /// The transport failures — the service down, slow or wrong — cannot be known
    /// until the run and are reported then; these can, and a run that calls a
    /// service is the most expensive kind to discover a typo in.
    /// Everything a running total cannot do without.
    ///
    /// Two things have to hold before the engine sees it, and neither is
    /// discoverable from the row it stands on: it has to say WHAT to accumulate
    /// and HOW, and the column it reads has to be declared ABOVE it — the same
    /// rule `parent=` follows, and for the same reason.
    fn check_running(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("running") {
            return;
        }
        if attrs.get("of").map(|s| s.trim()).unwrap_or("").is_empty() {
            self.error(
                "TDC239",
                "<gen type=\"running\"> does not say what to accumulate".to_string(),
                "Name the column it adds up: of=\"Delta\". A running total reads another \
                 sequence — it draws nothing of its own.",
                gen.pos,
            );
        }
        if attrs
            .get("accumulate")
            .map(|s| s.trim())
            .unwrap_or("")
            .is_empty()
        {
            self.error(
                "TDC239",
                "<gen type=\"running\"> does not say how to accumulate".to_string(),
                &format!(
                    "Add accumulate=\"…\" — one of: {}.",
                    accumulate::OPS.join(", ")
                ),
                gen.pos,
            );
        }
        // `of=` and `reset=` both read a column, so both take the rule. Reported
        // separately: naming the wrong one would send the reader to the wrong
        // attribute.
        for name in ["of", "reset"] {
            let value = attrs.get(name).map(|s| s.trim()).unwrap_or("");
            if value.is_empty() || self.declared_order.iter().any(|d| d == value) {
                continue;
            }
            let hint = if self.declared_order.is_empty() {
                "A running total is built from a column that already exists, so the column it \
                 reads has to come first."
                    .to_string()
            } else {
                format!("Declared above: {}.", self.declared_order.join(", "))
            };
            self.error(
                "TDC240",
                format!("{name}=\"{value}\" is not a sequence declared above this one"),
                &hint,
                gen.at(name),
            );
        }
    }

    fn check_http(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("http") {
            return;
        }

        match attrs.get("src").map(|s| s.trim()).filter(|s| !s.is_empty()) {
            None => self.error(
                "TDC065",
                "<gen type=\"http\"> requires a \"src\" attribute".to_string(),
                "Point it at the service, e.g. src=\"http://127.0.0.1:5566/gen\".",
                gen.at("src"),
            ),
            Some(src) if !is_http_url(src) => self.error(
                "TDC066",
                format!("invalid http src \"{src}\" — must be an http:// or https:// URL"),
                "e.g. src=\"http://127.0.0.1:5566/gen\" or src=\"https://svc.example.com/gen\".",
                gen.at("src"),
            ),
            Some(_) => {}
        }

        if let Some(name) = attrs.get("in").map(|v| v.trim().to_string()) {
            if !self.declared_names.contains(&name) {
                self.error(
                    "TDC067",
                    format!("in=\"{name}\" does not name a sequence declared before this one"),
                    "The value sent per row comes from an earlier <sequence>; declare it above.",
                    gen.at("in"),
                );
            }
        }

        if let Some(on_error) = attrs.get("on_error") {
            if on_error != "fail" && on_error != "empty" {
                self.error(
                    "TDC068",
                    format!("invalid on_error \"{on_error}\" — expected \"fail\" or \"empty\""),
                    "fail (default) stops the run; empty blanks the cell and continues.",
                    gen.at("on_error"),
                );
            }
        }
    }

    /// A `src=` that names a file nobody can read.
    ///
    /// Checked before the run rather than during it: a missing file discovered
    /// on row one of a million-row job has already cost whatever the job cost.
    fn check_source(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("file") && gen_type != Some("pattern") {
            return;
        }
        let Some(src) = trim_to_none(attrs.get("src")) else {
            return;
        };
        let roots = self.data_roots();

        // The same resolution the generator itself performs, or the validator
        // would refuse a config the run would have handled — an @data/ source
        // above all.
        let path = match file::resolve(src, self.base_dir.as_deref(), &roots) {
            Ok(path) => path,
            Err(e) => {
                self.error(
                    "TDC061",
                    e.message().to_string(),
                    "Paths are relative to the config file's own folder.",
                    gen.at("src"),
                );
                return;
            }
        };
        if !std::path::Path::new(&path).is_file() {
            self.error(
                "TDC061",
                format!("cannot read file \"{src}\""),
                "Paths are relative to the config file's own folder.",
                gen.at("src"),
            );
            return;
        }

        if !attrs.contains_key("column") {
            return;
        }
        // A column that names nothing in the file: caught by loading it, which is
        // the only way to know, and cheap next to discovering it a million rows
        // in.
        if let Err(e) = file::load(attrs, self.base_dir.as_deref(), &roots) {
            self.error(
                "TDC062",
                e.message().to_string(),
                "For CSV files, use a header name like column=\"email\" or a 1-based index like \
                 column=\"2\".",
                gen.at("column"),
            );
        }
    }

    /// The folders a file source may name. Absent packs mean none were
    /// configured.
    fn data_roots(&self) -> Vec<String> {
        self.packs
            .as_ref()
            .map(|p| p.data_roots().to_vec())
            .unwrap_or_default()
    }

    /// A `mask=` that does not parse. Caught here rather than on the first row.
    fn check_mask(&mut self, gen: &Element, attrs: &Attrs) {
        let Some(pattern) = attrs.get("mask") else {
            return;
        };
        if let Err(e) = mask::check(pattern) {
            self.error(
                "TDC199",
                e.message().to_string(),
                "Indices are 0-based; ranges use \"..\", e.g. mask=\"x[0..3]\" or \
                 mask=\"w[-1], w[0]\".",
                gen.at("mask"),
            );
        }
    }

    /// Every attribute is spelled right AND read by this generator.
    ///
    /// An ignored attribute is a request the config made and silently did not
    /// get, which is indistinguishable from a typo — and the data comes out
    /// looking fine either way, which is what makes it worth stopping for.
    fn check_gen_attributes(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type == Some("template") {
            self.check_builtin_template_attrs(gen, attrs);
            return;
        }

        let has_distribution = attrs
            .get("distribution")
            .is_some_and(|d| !d.trim().is_empty());

        // Document order, not the map's. `attrs` is a BTreeMap, so iterating it
        // sorts the names alphabetically and a config with two bad attributes
        // reported them back to front — the reference reads them as written, and
        // so does every other implementation.
        let written: Vec<String> = gen.attrs.iter().map(|a| a.name.clone()).collect();
        for name in &written {
            if !tables::GEN_ATTRS.contains(&name.as_str()) {
                self.ignored(
                    gen,
                    name,
                    "Check the spelling against the generator's attributes.",
                );
                continue;
            }

            // A distribution parameter with no distribution asked for shapes
            // nothing.
            if tables::DISTRIBUTION_PARAMS.contains(&name.as_str()) && !has_distribution {
                self.ignored(
                    gen,
                    name,
                    &format!(
                        "\"{name}\" is a parameter of a named distribution — add \
                         distribution=\"…\" for it to mean anything. To bound a plain number, put \
                         the range in value=\"10..20\"."
                    ),
                );
                continue;
            }

            let owners = if name == "range" {
                Some(&tables::RANGE_OWNERS[..])
            } else {
                tables::lookup(&tables::ATTRIBUTE_OWNERS, name)
            };
            if let (Some(owners), Some(t)) = (owners, gen_type) {
                if !owners.contains(&t) {
                    let belongs: Vec<String> = sorted(owners)
                        .iter()
                        .map(|o| format!("type=\"{o}\""))
                        .collect();
                    self.ignored(
                        gen,
                        name,
                        &format!(
                            "\"{name}\" belongs to {} — a type=\"{t}\" generator ignores it.",
                            belongs.join(", ")
                        ),
                    );
                }
            }
        }
    }

    /// The two pack-less template paths, against their own closed parameter sets.
    ///
    /// A pack declares its own parameters and is judged with the registry in
    /// hand; these two are backed by no pack, so nothing else checks them.
    fn check_builtin_template_attrs(&mut self, gen: &Element, attrs: &Attrs) {
        let path = attrs
            .get("value")
            .map(|v| v.trim().to_string())
            .unwrap_or_default();
        let Some(allowed) = tables::lookup(&tables::BUILTIN_TEMPLATE_PARAMS, &path) else {
            for name in attrs.keys() {
                if !tables::GEN_ATTRS.contains(&name.as_str()) {
                    self.ignored(
                        gen,
                        name,
                        "Check the spelling against the generator's attributes.",
                    );
                }
            }
            return;
        };

        for name in attrs.keys() {
            if tables::TEMPLATE_COMMON_ATTRS.contains(&name.as_str())
                || allowed.contains(&name.as_str())
            {
                continue;
            }
            self.ignored(
                gen,
                name,
                &format!("\"{path}\" reads only {}.", sorted(allowed).join(", ")),
            );
        }
    }

    fn ignored(&mut self, gen: &Element, name: &str, why: &str) {
        self.error(
            "TDC015",
            format!("<gen> does not read \"{name}\" — it is ignored"),
            why,
            gen.at(name),
        );
    }

    fn check_required_value(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        let value = attrs.get("value").map(String::as_str);
        let missing = blank(value);
        match gen_type {
            Some("text") => {
                if missing {
                    self.error(
                        "TDC050",
                        "<gen type=\"text\"> requires a \"value\" attribute".to_string(),
                        "It is the comma-separated list to pick from.",
                        gen.pos,
                    );
                }
            }
            Some("file") => {
                if blank(attrs.get("src")) {
                    self.error(
                        "TDC060",
                        "<gen type=\"file\"> requires a \"src\" attribute".to_string(),
                        "Provide the path to a UTF-8 text file with one value per line.",
                        gen.pos,
                    );
                }
                let has_row = attrs.get("row").is_some_and(|r| !r.trim().is_empty());
                if has_row && blank(attrs.get("column")) {
                    self.error(
                        "TDC064",
                        "row-linked file generators require a CSV \"column\" attribute".to_string(),
                        "Use column=\"name\" or column=\"2\" together with row=\"sharedKey\".",
                        gen.at("row"),
                    );
                }
            }
            Some("template") => {
                if missing {
                    self.error(
                        "TDC070",
                        "<gen type=\"template\"> requires a \"value\" attribute".to_string(),
                        "Use a known template path, e.g. person.male.firstName.",
                        gen.pos,
                    );
                    return;
                }
                // An address that names a field is not known until the row is, so
                // there is nothing to look up here. The engine resolves it per row
                // and reports what it cannot find.
                let value = value.expect("checked above");
                if value.contains("${{") {
                    return;
                }
                let path = value.trim();
                if tables::BUILTIN_TEMPLATE_PATHS.contains(&path) {
                    return;
                }
                let Some(packs) = &self.packs else {
                    return;
                };
                if !packs.exists(path, &self.locale) {
                    // The path may be real and only missing DATA for this locale.
                    // Said as its own code because "unknown template path" reads
                    // as a typo and sends the reader hunting for one that is not
                    // there.
                    if self.locale != "en" && packs.exists(path, "en") {
                        self.error(
                            "TDC217",
                            format!(
                                "template path \"{value}\" has no data for locale \"{}\"",
                                self.locale
                            ),
                            "The \"en\" pack ships it. Set local=\"…\" on this <gen> or on \
                             <env>, or choose a path your locale ships.",
                            gen.at("value"),
                        );
                        return;
                    }
                    self.error(
                        "TDC071",
                        format!("unknown template path \"{value}\""),
                        "Check the address against the packs you have.",
                        gen.at("value"),
                    );
                } else if let Err(e) = packs.load(path, &self.locale) {
                    // The address resolves; whether the file behind it is usable
                    // is a separate question, and one worth answering now. A pack
                    // a user wrote themselves is exactly the kind that is
                    // malformed, and finding out on the first row wastes the run.
                    self.error(
                        "TDC170",
                        e.message().to_string(),
                        &format!("Data pack file for \"{path}\"."),
                        gen.at("value"),
                    );
                }
            }
            Some("regex") => {
                if missing {
                    self.error(
                        "TDC095",
                        "<gen type=\"regex\"> requires a \"value\" attribute".to_string(),
                        "Provide a finite regex pattern, e.g. value=\"[A-Z]{2}[0-9]{6}\".",
                        gen.pos,
                    );
                }
            }
            Some("advanced_regex") => {
                if missing {
                    self.error(
                        "TDC128",
                        "<gen type=\"advanced_regex\"> requires a \"value\" attribute".to_string(),
                        "Provide a finite pattern, optionally with a weighted choice.",
                        gen.pos,
                    );
                }
            }
            // Nothing else has a single required attribute.
            _ => {}
        }
    }

    /// The number generator's own parsers decide what is valid.
    ///
    /// A validator with its own idea of a valid range drifts from the generator
    /// that reads it, and then a config passes the check and fails at run time —
    /// the worst of both.
    fn check_number(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("number") {
            return;
        }

        if attrs
            .get("distribution")
            .is_some_and(|d| !d.trim().is_empty())
        {
            for key in ["value", "percent", "length", "include", "exclude"] {
                if attrs.contains_key(key) {
                    self.error(
                        "TDC088",
                        format!(
                            "<gen type=\"number\" distribution=\"...\"> cannot be combined with \
                             \"{key}\""
                        ),
                        &format!(
                            "A distribution replaces the range/percent. Remove \"{key}\", or drop \
                             \"distribution\" to use a range."
                        ),
                        gen.at(key),
                    );
                }
            }
            // The distribution's own parameters: a shape nobody can draw from is
            // an error before the run, not a surprise on the first row.
            if let Err(e) = distribution::parse(attrs) {
                self.error(
                    "TDC089",
                    e.message().to_string(),
                    "Distributions: normal (mean, sd), lognormal (meanlog, sdlog), exponential \
                     (rate), pareto (alpha, xmin). Optional: decimals, min, max.",
                    gen.at("distribution"),
                );
            }
            return;
        }

        let value = attrs.get("value").map(String::as_str);
        if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
            if number::parse_ranges(value).is_err() {
                self.error(
                    "TDC081",
                    format!("invalid number range \"{value}\""),
                    "Expected \"bit\", \"MIN..MAX\", or a list like \"[0..9],[20..29]\".",
                    gen.at("value"),
                );
            }
        }

        if let Some(first_zero) = attrs.get("first_zero") {
            if first_zero != "true" && first_zero != "false" {
                self.error(
                    "TDC082",
                    format!("invalid first_zero \"{first_zero}\" — expected \"true\" or \"false\""),
                    "It decides whether a generated digit string may start with a zero.",
                    gen.at("first_zero"),
                );
            }
        }

        if let Some(length) = attrs.get("length") {
            if !is_valid_length(length) {
                self.error(
                    "TDC083",
                    format!(
                        "invalid length \"{length}\" — expected a positive integer, range, or \
                         comma-separated list"
                    ),
                    "Examples: length=\"10\", length=\"2-10\", length=\"2,10-12\".",
                    gen.at("length"),
                );
            }
        }

        let has_modifier = ["include", "exclude"]
            .iter()
            .any(|k| attrs.get(*k).is_some_and(|v| !v.trim().is_empty()));
        if has_modifier && blank(value) {
            self.error(
                "TDC087",
                "<gen type=\"number\"> include/exclude require a numeric range in \"value\""
                    .to_string(),
                "Add a range first, e.g. value=\"0..9\" exclude=\"3\".",
                gen.pos,
            );
        }
    }

    fn check_regexes(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        let Some(value) = attrs.get("value").filter(|v| !v.trim().is_empty()) else {
            return;
        };
        let limit = match attrs.get("regex_max_length") {
            Some(own) => regex::parse_max_length(Some(own)).unwrap_or(self.document_max_length),
            None => self.document_max_length,
        };

        if gen_type == Some("regex") {
            if let Err(e) = regex::compile(value, limit) {
                self.error(
                    "TDC097",
                    format!("invalid regex generator pattern: {}", e.message()),
                    "The subset is finite: no * or +, and every pattern has a longest output.",
                    gen.at("value"),
                );
            }
        } else if gen_type == Some("advanced_regex") {
            if let Err(e) = advanced_regex::compile(value, limit) {
                self.error(
                    "TDC130",
                    format!("invalid advanced_regex generator pattern: {}", e.message()),
                    "Weighted branches must sum to 100.",
                    gen.at("value"),
                );
            }
        }
    }

    fn check_symbol(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("symbol") {
            return;
        }
        const HINT: &str = "Use value=\"[a-z]\" for an inline set, or \
                            alphabet=\"cyrillic.ru.letters\" for a named one.";

        let value = attrs.get("value").filter(|v| !v.is_empty());
        let alphabet = attrs.get("alphabet").filter(|a| !a.is_empty());

        match (value, alphabet) {
            (Some(_), Some(_)) => self.error(
                "TDC098",
                "<gen type=\"symbol\"> accepts either \"value\" or \"alphabet\", not both"
                    .to_string(),
                HINT,
                gen.at("value"),
            ),
            // Neither an inline set nor a named one: there is nothing to draw a
            // character from, and the generator would produce empty strings for
            // the whole run.
            (None, None) => self.error(
                "TDC098",
                "<gen type=\"symbol\"> requires a \"value\" (inline set) or \"alphabet\" (named)"
                    .to_string(),
                HINT,
                gen.pos,
            ),
            (None, Some(name)) if unicode::chars(name).is_none() => self.error(
                "TDC099",
                format!("unknown alphabet \"{name}\""),
                &format!("Known alphabets: {}.", unicode::names().join(", ")),
                gen.at("alphabet"),
            ),
            _ => {}
        }
    }

    fn check_date(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("date") {
            return;
        }

        if attrs.contains_key("from") != attrs.contains_key("to") {
            self.error(
                "TDC150",
                "<gen type=\"date\"> requires both \"from\" and \"to\" when either is used"
                    .to_string(),
                "Use from=\"2020-01-01\" to=\"2025-12-31\", or value=\"2020-01-01..2025-12-31\".",
                gen.pos,
            );
        }

        if let Some(local) = attrs.get("local").filter(|l| !l.trim().is_empty()) {
            if !date::locales::is_known(local) {
                self.error(
                    "TDC153",
                    format!("unknown date locale \"{local}\""),
                    "A date locale has to be translated deliberately — month names inflect.",
                    gen.at("local"),
                );
            }
        }

        self.check_date_common_attrs(gen, attrs);
        self.check_date_values(gen, attrs);
    }

    /// The dates themselves parse.
    ///
    /// Without this a `from="notadate"` reached the generator and failed there,
    /// which is a crash at render time instead of a diagnostic at validation
    /// time — and the reference reports it here.
    fn check_date_values(&mut self, gen: &Element, attrs: &Attrs) {
        let problem = date_values_problem(attrs);
        if let Some(message) = problem {
            // Whichever attribute the reader would look at first — the complaint
            // is about the span, and pointing at one of its two ends names only
            // half of it.
            self.error(
                "TDC151",
                message,
                "Examples: value=\"2020-01-01..2025-12-31\", value=\"birth\", value=\"today\", \
                 or value=\"now\".",
                gen.at(primary_date_attr(attrs)),
            );
        }
    }

    /// The attributes every date-shaped generator shares: how it is formatted,
    /// and how precise it is.
    ///
    /// Also reached from the pack templates `date.range` and `person.b_day`,
    /// which are dates wearing a different address and would otherwise skip these
    /// checks entirely.
    fn check_date_common_attrs(&mut self, gen: &Element, attrs: &Attrs) {
        if let Some(format) = attrs.get("format") {
            if let Err(e) = date::format::check_format(format) {
                self.error(
                    "TDC152",
                    e.message().to_string(),
                    "Use Moment-like tokens such as YYYY-MM-DD, DD.MM.YYYY, L, LL, or bracket \
                     literals [text].",
                    gen.at("format"),
                );
            }
        }
        if let Some(precision) = attrs.get("precision") {
            if let Err(e) = date::gen::parse_precision(Some(precision), date::gen::Precision::Day) {
                self.error(
                    "TDC154",
                    e.message().to_string(),
                    "Supported: day, second, millisecond.",
                    gen.at("precision"),
                );
            }
        }
    }

    /// `date.range` and `person.b_day`: pack addresses that are date generators.
    ///
    /// They take the same attributes and can be wrong in the same ways, so they
    /// are checked the same way rather than passing through as ordinary template
    /// lookups.
    fn check_date_templates(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("template") {
            return;
        }
        let path = attrs
            .get("value")
            .map(|v| v.trim().to_string())
            .unwrap_or_default();

        if path == "date.range" {
            let Some(range) = attrs.get("range") else {
                self.error(
                    "TDC072",
                    "<gen value=\"date.range\"> requires a \"range\" attribute".to_string(),
                    "Syntax: range=\"YYYY.MM.DD - YYYY.MM.DD\".",
                    gen.pos,
                );
                return;
            };
            match date::parse::legacy_range(range) {
                Ok(_) => self.check_date_common_attrs(gen, attrs),
                Err(e) => self.error(
                    "TDC073",
                    e.message().to_string(),
                    "Expected two valid dates in \"YYYY.MM.DD - YYYY.MM.DD\" form.",
                    gen.at("range"),
                ),
            }
            return;
        }

        if path == "person.b_day" {
            self.check_date_common_attrs(gen, attrs);
            // oldest/youngest on a birth date: whole ages, and in that order.
            if let Err(e) = date::gen::check_birth_ages(attrs) {
                self.error(
                    "TDC151",
                    e.message().to_string(),
                    "",
                    gen.at(primary_date_attr(attrs)),
                );
            }
        }
    }

    /// `value=` and `step=` on a counter have to be numbers.
    fn check_counter(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("increment") && gen_type != Some("decrement") {
            return;
        }
        for name in ["value", "step"] {
            let Some(raw) = attrs.get(name) else {
                continue;
            };
            if !raw.trim().parse::<f64>().is_ok_and(f64::is_finite) {
                self.error(
                    "TDC090",
                    format!("invalid {name} \"{raw}\" — expected a number"),
                    "",
                    gen.at(name),
                );
            }
        }
    }

    /// `accumulate=` needs a list, and its op is one of a short closed set.
    fn check_accumulate(&mut self, gen: &Element, attrs: &Attrs, repeats: bool) {
        if !attrs.contains_key("accumulate") {
            return;
        }
        if let Err(message) = accumulate::parse(attrs) {
            self.error(
                "TDC238",
                message,
                &format!(
                    "accumulate= keeps a running total across a repeat list. One of: {}.",
                    accumulate::OPS.join(", ")
                ),
                gen.at("accumulate"),
            );
        }
        // `type="running"` accumulates down a COLUMN, so it carries the same
        // word with no list in sight. Only the list flavour needs `repeat`.
        if !repeats && attrs.get("type").map(String::as_str) != Some("running") {
            self.error(
                "TDC237",
                "\"accumulate\" has no effect without \"repeat\"".to_string(),
                "accumulate= turns the values of a repeat list into a running total, so there \
                 has to be a list. Add repeat=\"N\", or drop accumulate=.",
                gen.at("accumulate"),
            );
        }
    }

    fn check_repeat(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        let repeats = match repeat::parse(attrs) {
            Ok(spec) => spec.is_some(),
            Err(e) => {
                self.error(
                    "TDC195",
                    e.message().to_string(),
                    "Use repeat=\"3\" for a fixed count or repeat=\"1..5\" for a range (0 to 64).",
                    gen.at("repeat"),
                );
                self.check_accumulate(gen, attrs, true);
                return;
            }
        };

        self.check_accumulate(gen, attrs, repeats);

        if repeats {
            if let Some(reason) = repeat_unsupported_reason(gen_type) {
                self.error(
                    "TDC204",
                    format!(
                        "\"repeat\" is not supported on <gen type=\"{}\"> — {reason}",
                        gen_type.unwrap_or("")
                    ),
                    "Its value comes from the row index, which a variable-length list makes \
                     unknowable.",
                    gen.at("repeat"),
                );
            }
        } else if attrs.contains_key("separator") {
            // A separator with nothing to separate is a request that silently
            // does nothing.
            self.error(
                "TDC198",
                "\"separator\" has no effect without \"repeat\"".to_string(),
                "separator joins the values a repeating gen produces. Add repeat=\"N\", or drop it.",
                gen.at("separator"),
            );
        }
    }

    fn check_weight(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if blank(attrs.get("weight")) {
            return;
        }
        if gen_type != Some("file") {
            self.error(
                "TDC211",
                format!(
                    "\"weight\" applies to <gen type=\"file\">, not type=\"{}\"",
                    gen_type.unwrap_or("")
                ),
                "For inline values, percent= states the shares.",
                gen.at("weight"),
            );
            return;
        }
        if blank(attrs.get("column")) {
            self.error(
                "TDC212",
                "\"weight\" needs \"column\" — the weights live in a second CSV column".to_string(),
                "Name the value column too.",
                gen.at("weight"),
            );
        }
        if attrs.contains_key("order") {
            self.error(
                "TDC213",
                "\"weight\" cannot be combined with \"order\" — that walks rows by position, not \
                 by share"
                    .to_string(),
                "Drop one of them.",
                gen.at("weight"),
            );
        }
    }

    fn check_percent_mask(&mut self, mask: &str, value_count: usize, codes: [&str; 3], at: Pos) {
        let Err(e) = percent_mask::expand(mask, value_count) else {
            return;
        };
        let code = match e.kind {
            percent_mask::MaskKind::Length => codes[0],
            percent_mask::MaskKind::Number => codes[1],
            _ => codes[2],
        };
        let hint = if e.kind == percent_mask::MaskKind::Length {
            "Percent masks may be shorter than value only when missing positions can be inferred. \
             They may never be longer than value."
        } else {
            "Filled positions must be non-negative numbers. Empty positions split the remaining \
             percent equally."
        };
        self.error(code, e.message, hint, at);
    }

    /// `case=` and `order=` take one of a short list, and nothing else.
    fn check_case_and_order(&mut self, gen: &Element, attrs: &Attrs) {
        if let Some(transform) = attrs.get("case") {
            if !transforms::is_case_transform(transform) {
                self.error(
                    "TDC190",
                    format!("unknown case \"{transform}\""),
                    &format!("Supported: {}.", transforms::CASE_TRANSFORMS.join(", ")),
                    gen.at("case"),
                );
            }
        }
        if let Some(order) = attrs.get("order") {
            if order != "random" && order != "sequential" {
                self.error(
                    "TDC191",
                    format!("unknown order \"{order}\""),
                    "Supported: random (the default), sequential.",
                    gen.at("order"),
                );
            }
        }
    }

    // ── mix, switch, case ────────────────────────────────────────────────────

    /// A mix needs branches, and only branches.
    ///
    /// `named` is whether this mix sits at env level and can therefore own a flag
    /// column. A nested one contributes a value to somebody else's column and has
    /// nowhere to put a flag.
    fn check_mix(&mut self, open: &Element, named: bool) {
        let mut cases = 0;
        let mut anomalous = false;
        let mut first_anomalous: Option<&Element> = None;

        for child in &open.children {
            if child.name == "case" {
                cases += 1;
                if child.kind == Kind::OpenClose {
                    if child.attr_value("anomaly") == Some("true") {
                        anomalous = true;
                        first_anomalous.get_or_insert(child);
                    }
                    self.check_closed_tag_attrs("case", child);
                    self.check_case_body(child);
                }
                continue;
            }
            self.error(
                "TDC124",
                format!("unknown child of <mix>: \"<{}>\"", child.name),
                "Allowed children: case.",
                child.pos,
            );
        }

        if cases > 0 {
            if let Some(percent) = open.attr_value("percent").map(str::to_string) {
                self.check_percent_mask(
                    &percent,
                    cases,
                    ["TDC121", "TDC122", "TDC123"],
                    open.at("percent"),
                );
            }
        } else {
            self.error(
                "TDC120",
                "<mix> has no <case> children".to_string(),
                "Add at least one <case>...</case> inside <mix>.",
                open.pos,
            );
        }

        let flag = open.attr_value("flag").map(str::to_string);
        if flag.is_some() && !named {
            self.error(
                "TDC203",
                "\"flag\" on a nested <mix> is not supported — only a named env-level <mix> can \
                 declare one"
                    .to_string(),
                "A flag becomes its own sequence, so it needs a <mix name=\"…\"> at env level.",
                open.at("flag"),
            );
            // One complaint per mix: whether its branches are marked is beside
            // the point once the flag itself cannot exist.
            return;
        }

        if flag.is_none() {
            if let Some(branch) = first_anomalous {
                // A branch marked as the outlier, and nothing recording which
                // rows took it. The label is the only reason to mark it, so the
                // complaint points at the branch.
                self.error(
                    "TDC203",
                    "anomaly=\"true\" on <case> does nothing — the enclosing <mix> declares no \
                     flag=\"…\""
                        .to_string(),
                    "Name the ground-truth column: <mix name=\"…\" flag=\"IsAnomaly\">.",
                    branch.at("anomaly"),
                );
            }
        }

        for listy in ["repeat", "separator"] {
            if open.attr(listy).is_some() {
                self.error(
                    "TDC196",
                    format!(
                        "\"{listy}\" is not supported on <mix> — it picks one branch, it does not \
                         produce a list"
                    ),
                    "Put repeat= on the <gen> inside a <case>, or on a plain <sequence>.",
                    open.at(listy),
                );
            }
        }

        if flag.is_some_and(|f| !f.trim().is_empty()) && cases > 0 && !anomalous {
            // A label that is false on every row is not a label. It reads as
            // ground truth and teaches whatever consumes it that nothing is ever
            // anomalous.
            self.error(
                "TDC202",
                "flag=\"…\" but no <case> is marked anomaly=\"true\" — the column would be all \
                 \"false\""
                    .to_string(),
                "Mark the outlier branch: <case anomaly=\"true\">…</case>.",
                open.at("flag"),
            );
        }
    }

    /// What may sit inside a `<case>`: literal text, one generator, or a nested
    /// mix.
    ///
    /// A nested mix is checked as a nested one — it contributes a value to the
    /// column around it and has nowhere of its own to put a flag.
    fn check_case_body(&mut self, case_el: &Element) {
        for child in &case_el.children {
            match child.kind {
                Kind::Data | Kind::SelfClosing => continue,
                Kind::Map => {}
                Kind::OpenClose => {}
            }
            if child.name == "mix" {
                self.check_mix(child, false);
                continue;
            }
            if child.name == "gen" {
                continue;
            }
            self.error(
                "TDC125",
                format!("unknown child of <case>: \"<{}>\"", child.name),
                "Allowed children: data, gen, mix.",
                child.pos,
            );
        }
    }

    fn check_switch(&mut self, open: &Element, declared: &[String]) {
        match open
            .attr_value("on")
            .map(str::trim)
            .filter(|o| !o.is_empty())
        {
            None => self.error(
                "TDC133",
                "<switch> is missing a required \"on\" attribute".to_string(),
                "A switch looks a value up; \"on\" names the sequence it looks up.",
                open.pos,
            ),
            Some(on) if !declared.iter().any(|d| d == on) => self.error(
                "TDC134",
                format!("<switch on=\"{on}\"> refers to an unknown sequence"),
                "Declare the subject sequence above the switch.",
                open.at("on"),
            ),
            Some(_) => {}
        }

        let mut entries = 0;
        for child in &open.children {
            match (child.kind, child.name.as_str()) {
                (Kind::Map, _) => {
                    entries += 1;
                    self.check_map_rows(child);
                }
                (Kind::OpenClose, "case") => {
                    entries += 1;
                    if blank(child.attr_value("is")) {
                        self.error(
                            "TDC137",
                            "<case> inside <switch> is missing a required \"is\" attribute"
                                .to_string(),
                            "A switch case matches a value; \"is\" is the value it matches.",
                            child.pos,
                        );
                    }
                }
                (Kind::OpenClose, "default") => entries += 1,
                _ => {}
            }
        }

        if entries == 0 {
            self.error(
                "TDC135",
                "<switch> has no entries".to_string(),
                "Add a <map>, a <case is=\"…\">, or a <default>.",
                open.pos,
            );
        }
    }

    /// A `<map>` body: one `KEY:VALUE` per row.
    ///
    /// Entries are separated by commas, and a row with no colon is not a mapping —
    /// it would otherwise become a key with no value, silently absent from the
    /// table the switch reads. A warning rather than an error: the rest of the
    /// table still works, and the run is worth finishing.
    fn check_map_rows(&mut self, element: &Element) {
        let rows: Vec<String> = element
            .text
            .split(',')
            .map(|r| r.trim().to_string())
            .collect();
        for row in rows {
            if row.is_empty() || row.contains(':') {
                continue;
            }
            self.warn(
                "TDC136",
                format!("malformed <map> row \"{row}\" — expected KEY:VALUE"),
                "Each entry is KEY:VALUE, entries separated by commas, multi-key via \"|\" \
                 (US|CA:USD).",
                element.pos,
            );
        }
    }

    // ── block ────────────────────────────────────────────────────────────────

    fn check_block(&mut self, block: &Element) {
        for child in &block.children {
            if child.kind == Kind::OpenClose && child.name == "line" {
                self.check_line(child);
            }
        }
    }

    /// A `<line>` holds text, and only text.
    ///
    /// The block describes the shape of the output, not where values come from. A
    /// generator placed here would produce a value nothing else could reference,
    /// and a construct like a switch would be building a column in the middle of
    /// a layout.
    fn check_line(&mut self, line: &Element) {
        self.check_closed_tag_attrs("line", line);

        // `_item` and `_item_id` exist only while a line walks a list, and both
        // the line's own condition and every <data> inside it may name them.
        let walks_a_list = line.attr_value("each").is_some();

        // `if=` sits on the <line> as well as on each <data> inside it, and an
        // unparsable one has to be caught in both places or a whole line silently
        // never renders.
        if let Some(condition) = line.attr_value("if").map(str::to_string) {
            self.check_if_expression(&condition, line.at("if"));
            self.pending_expressions.push((
                self.diagnostics.len(),
                condition.clone(),
                line.at("if"),
                walks_a_list,
            ));
        }

        if let Some(each) = line.attr_value("each").map(str::to_string) {
            if each.trim().is_empty() {
                self.error(
                    "TDC206",
                    "each=\"\" names no sequence".to_string(),
                    "Give it the name of a repeating sequence, or drop the attribute.",
                    line.at("each"),
                );
            } else if self.declared_names.contains(&each) && !self.repeating_names.contains(&each) {
                // Walking a scalar would emit one line and look like it worked,
                // which is the kind of near-miss that survives review.
                self.error(
                    "TDC207",
                    format!("each=\"{each}\" — that sequence holds one value, not a list"),
                    "Add repeat= to its <gen>, e.g. repeat=\"1..5\", or drop each=.",
                    line.at("each"),
                );
            }

            // A typed column is collected once per record, and an each= line
            // emits several. The two cannot both be true, so the column would
            // silently take whichever element came last.
            for child in &line.children {
                if child.kind != Kind::Data {
                    continue;
                }
                if let Some(column) = child.attr_value("name").filter(|n| !n.trim().is_empty()) {
                    let column = column.to_string();
                    self.error(
                        "TDC209",
                        format!("a named <data name=\"{column}\"> cannot sit inside an each= line"),
                        "Typed columns are collected once per card. For columnar output keep the \
                         list as a list column (type=\"[]…\"); each= is for text and SQL.",
                        line.at("each"),
                    );
                }
            }
        }

        for child in &line.children {
            if child.kind == Kind::SelfClosing && child.name == "gen" {
                self.error(
                    "TDC131",
                    "a <gen> is not allowed inside <line> — the output block is for formatting only"
                        .to_string(),
                    "Declare it as a <sequence> in <env> and reference it with ${{Name}}.",
                    child.pos,
                );
                continue;
            }

            if child.kind == Kind::Data {
                self.check_closed_tag_attrs("data", child);
                self.check_data_type(child, line.pos);
                // The <data> element, not the <line> around it: several <data>
                // pieces can share a line, and pointing at the line would name
                // the wrong one whenever they do.
                let text = child.text.clone();
                self.check_interpolation(&text, child.pos);
                if let Some(condition) = child.attr_value("if").map(str::to_string) {
                    self.check_if_expression(&condition, child.at("if"));
                    self.pending_expressions.push((
                        self.diagnostics.len(),
                        condition.clone(),
                        child.at("if"),
                        walks_a_list,
                    ));
                }
                continue;
            }

            if child.kind == Kind::OpenClose && child.name != "data" {
                self.error(
                    "TDC132",
                    format!(
                        "a <{}> is not allowed inside <line> — the output block is for formatting \
                         only",
                        child.name
                    ),
                    "Move it into <env>.",
                    child.pos,
                );
            }
        }
    }

    /// `type=` on a `<data>`: parsable, and on a piece that is actually a column.
    ///
    /// A type on an unnamed `<data>` is a request that does nothing — only a
    /// named one becomes a column, so the declaration would be quietly dropped.
    fn check_data_type(&mut self, body: &Element, fallback: Pos) {
        let Some(raw) = body.attr_value("type").map(str::to_string) else {
            return;
        };
        let at = body.attr("type").map_or(fallback, |a| a.at());
        if blank(body.attr_value("name")) {
            self.error(
                "TDC194",
                format!("type=\"{raw}\" has no name — only a named <data> becomes a column"),
                "Add name=\"…\" to export this as a typed column, or drop type=.",
                at,
            );
            return;
        }

        // And the type itself has to be one. A declaration nobody can read would
        // otherwise surface only when someone exported to Parquet, which is
        // long after the moment it was written.
        if let Err(e) = ColumnType::parse_output(&raw) {
            self.error(
                "TDC194",
                e.0,
                "Types: bool, int32, int64, uint8/16/32/64, float, float16, double, string, enum, \
                 date, timestamp, decimal(p,s), uuid, json; []T for a list; |null to allow NULL.",
                at,
            );
        }
    }

    /// Every `${{…}}` in a line: the name has to exist, and each filter has to be
    /// one.
    ///
    /// A name nobody declared is printed literally, so a typo reaches the output
    /// looking like data. An unknown filter is simply ignored, so the value comes
    /// out unformatted and correct enough to pass a glance.
    fn check_interpolation(&mut self, text: &str, at: Pos) {
        for body in interpolations(text) {
            let mut parts = body.split('|');
            let name = parts.next().unwrap_or("").trim().to_string();
            if !name.is_empty() && !self.declared_names.contains(&name) && !is_builtin(&name) {
                self.error(
                    "TDC193",
                    format!("\"{name}\" is not a declared sequence — it would be printed literally"),
                    "Declare it in <env>, or change the inject= pattern if the text is meant to be \
                     literal.",
                    at,
                );
            }
            for filter in parts {
                let kind = match filter.find(':') {
                    Some(colon) => &filter[..colon],
                    None => filter,
                }
                .trim()
                .to_string();
                if !kind.is_empty() && !transforms::is_filter_name(&kind) {
                    self.error(
                        "TDC192",
                        format!("unknown interpolation filter \"{kind}\""),
                        &format!("Supported: {}.", transforms::FILTER_NAMES.join(", ")),
                        at,
                    );
                }
            }
        }
    }

    /// The names an `if=` expression uses, checked against what exists.
    ///
    /// An identifier that names no sequence is not an error by itself — it is
    /// how a bare word works: `if="Gender == Male"` compares against the literal
    /// `Male`, and the documentation is written that way throughout. What
    /// decides is WHERE the identifier sits:
    ///
    /// * the whole condition (`if="Ready"`, `if="!Ready"`) — a name. An unknown
    ///   one is its own name as a string, which is never empty, so the branch
    ///   fires on every row.
    /// * the left of a comparison, and anything arithmetic — a name. An unknown
    ///   one equals nothing, so the branch fires on no row.
    /// * the right of a comparison — left alone. `A == B` is a value comparison
    ///   when B is declared and a bare word when it is not, and both are meant.
    ///
    /// A dot is read the same two ways the engine reads it: `Person.FirstName`
    /// is a field of a compound, `Gender.Male` asks whether Gender came out
    /// `Male`. So the root must always exist, and the tail is checked only where
    /// the root is a compound — on a plain sequence the tail is a value, and a
    /// value cannot be known from the config alone.
    fn check_expression_names(&mut self, expression: &str, at: Pos, each: bool) {
        let Ok(parsed) = expr::parse(expression) else {
            return; // Already reported as TDC100; there is no tree to walk.
        };
        self.walk_expression_names(&parsed, at, each, true);
    }

    fn walk_expression_names(&mut self, node: &expr::Expr, at: Pos, each: bool, as_name: bool) {
        match node {
            expr::Expr::Name(name) => {
                if as_name {
                    self.check_expression_name(name, at, each);
                }
            }
            expr::Expr::Member(path) => {
                if as_name {
                    self.check_expression_name(path, at, each);
                }
            }
            expr::Expr::Unary(_, inner) => self.walk_expression_names(inner, at, each, as_name),
            expr::Expr::Binary(op, left, right) => {
                // Each side of && or || is a condition in its own right;
                // arithmetic on a bare word is meaningless, so both sides are
                // names there; on a comparison the right side may be the word to
                // match.
                let logical = op == "&&" || op == "||";
                let comparison = tables::COMPARISON_OPERATORS.contains(&op.as_str());
                self.walk_expression_names(left, at, each, true);
                self.walk_expression_names(right, at, each, logical || !comparison);
            }
            _ => {}
        }
    }

    fn check_expression_name(&mut self, path: &str, at: Pos, each: bool) {
        let (root, tail) = match path.split_once('.') {
            Some((root, tail)) => (root, Some(tail)),
            None => (path, None),
        };

        let known = |validator: &Validator, name: &str| -> bool {
            validator.declared_names.contains(name)
                || is_builtin(name)
                || (each && (name == "_item" || name == "_item_id"))
        };

        if !known(self, root) {
            let hint = if tail.is_none() {
                "A condition that is a bare word is always true. Name a sequence declared in \
                 <env>, or compare against the word: Gender == Male."
            } else {
                "Name a sequence declared in <env>. A word on the RIGHT of a comparison is a \
                 literal and needs no declaration."
            };
            self.error(
                "TDC215",
                format!(
                    "\"{path}\" is not a declared sequence — the condition reads it as the \
                     literal text \"{path}\""
                ),
                hint,
                at,
            );
            return;
        }

        let Some(tail) = tail else { return };

        // On a plain sequence the tail is a VALUE — `Gender.Male` asks whether
        // Gender came out Male — and where the config says outright what it
        // produces, a value that is not among them makes a branch nothing can
        // take.
        if !self.valueless_names.contains(root) {
            let Some(values) = self.finite_values.get(root) else {
                return;
            };
            if values.iter().any(|v| v == tail) {
                return;
            }
            let produces = values.join(", ");
            self.warn(
                "TDC216",
                format!(
                    "\"{path}\" — \"{root}\" never produces \"{tail}\", so this branch can \
                     never be taken"
                ),
                &format!("\"{root}\" produces: {produces}."),
                at,
            );
            return;
        }
        let field = tail.split_once('.').map_or(tail, |(head, _)| head);
        let full = format!("{root}.{field}");
        if self.declared_names.contains(&full) {
            return;
        }
        let fields: Vec<String> = self
            .declared_names
            .iter()
            .filter_map(|n| n.strip_prefix(&format!("{root}.")))
            .map(str::to_string)
            .collect();
        let hint = if fields.is_empty() {
            format!("\"{root}\" has no fields.")
        } else {
            format!("Fields of \"{root}\": {}.", fields.join(", "))
        };
        self.error(
            "TDC215",
            format!("\"{path}\" is not a field of \"{root}\" — the condition can never be true"),
            &hint,
            at,
        );
    }

    fn check_if_expression(&mut self, expression: &str, at: Pos) {
        match expr::parse(expression) {
            Ok(parsed) => self.check_expr_node(&parsed, at),
            Err(e) => self.error(
                "TDC100",
                format!(
                    "invalid if expression \"{}\": {}",
                    clip(expression),
                    e.message()
                ),
                "Supported: comparison, && || !, and arithmetic.",
                at,
            ),
        }
    }

    /// Every operator in a parsed condition, checked against the ones the engine
    /// implements.
    ///
    /// A parser that is more permissive than the evaluator is a trap: the config
    /// is accepted, and the operator it asked for is quietly not the operator it
    /// gets.
    fn check_expr_node(&mut self, node: &expr::Expr, at: Pos) {
        match node {
            expr::Expr::Binary(op, left, right) => {
                if !tables::SUPPORTED_BINARY_OPERATORS.contains(&op.as_str()) {
                    self.error(
                        "TDC101",
                        format!("unsupported operator \"{op}\" in if expression"),
                        &format!(
                            "Supported binary operators: {}.",
                            tables::SUPPORTED_BINARY_OPERATORS.join(" ")
                        ),
                        at,
                    );
                }
                self.check_expr_node(left, at);
                self.check_expr_node(right, at);
            }
            expr::Expr::Computed(inner) => {
                self.error(
                    "TDC103",
                    "computed member access is not supported in if expression".to_string(),
                    "Use plain dotted access like Gender.Male or Person.FirstName.",
                    at,
                );
                self.check_expr_node(inner, at);
            }
            expr::Expr::Unary(op, operand) => {
                if !tables::SUPPORTED_UNARY_OPERATORS.contains(&op.as_str()) {
                    self.error(
                        "TDC102",
                        format!("unsupported unary operator \"{op}\" in if expression"),
                        &format!(
                            "Supported unary operators: {}.",
                            tables::SUPPORTED_UNARY_OPERATORS.join(" ")
                        ),
                        at,
                    );
                }
                self.check_expr_node(operand, at);
            }
            _ => {}
        }
    }

    // ── still to port ────────────────────────────────────────────────────────

    /// A `<compute>` sequence's tree, checked against everything declared so far.
    ///
    /// Its `<field>` references can only name a sequence that already exists —
    /// the value is derived from the row, and a row is built in declaration
    /// order.
    fn check_compute_body(&mut self, sequence: &Element) {
        for child in &sequence.children {
            if child.kind != Kind::OpenClose || child.name != "compute" {
                continue;
            }
            let mut known = self.declared_names.clone();
            known.extend(BUILTINS.iter().map(|b| (*b).to_string()));
            compute_check::ComputeCheck::new(&mut self.diagnostics).check(child, Some(&known));
        }
    }
}

/// The `${{…}}` bodies in a piece of text — `\$\{\{([^}]+)}}` read by hand.
fn interpolations(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut result = Vec::new();
    let mut i = 0;
    while i + 3 < chars.len() {
        if chars[i] != '$' || chars[i + 1] != '{' || chars[i + 2] != '{' {
            i += 1;
            continue;
        }
        // `[^}]+` — the body stops at the first closing brace, so an unbalanced
        // marker is simply not a marker.
        let start = i + 3;
        let mut end = start;
        while end < chars.len() && chars[end] != '}' {
            end += 1;
        }
        if end > start && end + 1 < chars.len() && chars[end + 1] == '}' {
            result.push(chars[start..end].iter().collect());
            i = end + 2;
        } else {
            i += 1;
        }
    }
    result
}

/// A generator type on which `repeat=` is refused, and why.
fn repeat_unsupported_reason(gen_type: Option<&str>) -> Option<&'static str> {
    match gen_type {
        Some("increment" | "decrement" | "timeseries" | "pattern") => Some(
            "its value depends on the row index, which a variable-length list makes unknowable",
        ),
        _ => None,
    }
}

/// A length is a positive integer, a `min-max` range, or a comma-separated list
/// of those.
fn is_valid_length(raw: &str) -> bool {
    raw.split(',').all(|part| {
        let p = part.trim();
        let bounds: Vec<&str> = p.split('-').collect();
        (bounds.len() == 1 || bounds.len() == 2)
            && bounds
                .iter()
                .all(|n| n.trim().parse::<i32>().is_ok_and(|v| v > 0))
    })
}

fn is_http_url(value: &str) -> bool {
    let Some(rest) = value
        .strip_prefix("http://")
        .or_else(|| value.strip_prefix("https://"))
    else {
        return false;
    };
    // A host, and something that is not another scheme separator.
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
}

/// The first date attribute a complaint should point at, in the order the
/// reference tries them.
fn primary_date_attr(attrs: &Attrs) -> &'static str {
    for name in ["value", "range", "from", "to", "oldest", "youngest"] {
        if attrs.contains_key(name) {
            return name;
        }
    }
    "value"
}

/// What is wrong with the dates a `<gen type="date">` names, or `None`.
fn date_values_problem(attrs: &Attrs) -> Option<String> {
    let fail = |e: crate::engine::EngineError| Some(e.message().to_string());

    if let (Some(from), Some(to)) = (attrs.get("from"), attrs.get("to")) {
        if let Err(e) = date::parse::date_time(from) {
            return fail(e);
        }
        if let Err(e) = date::parse::date_time(to) {
            return fail(e);
        }
    }
    if let Some(range) = attrs.get("range") {
        if let Err(e) = date::parse::range(range) {
            return fail(e);
        }
    }

    let value = attrs.get("value").map(|v| v.trim()).unwrap_or("");
    if !value.is_empty() && !matches!(value, "birth" | "today" | "now") {
        let parsed = if value.contains("..") {
            date::parse::range(value).map(|_| ())
        } else {
            date::parse::date_time(value).map(|_| ())
        };
        if let Err(e) = parsed {
            return fail(e);
        }
    }
    if value == "birth" {
        if let Err(e) = date::gen::check_birth_ages(attrs) {
            return fail(e);
        }
    }
    None
}

/// The value, or `None` when it is absent or nothing but space.
fn trim_to_none(value: Option<&String>) -> Option<&str> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// What `string.IsNullOrWhiteSpace` means in the reference: absent, or nothing
/// but space.
fn blank<S: AsRef<str>>(value: Option<S>) -> bool {
    match value {
        None => true,
        Some(v) => v.as_ref().trim().is_empty(),
    }
}

fn split_count(value: &str) -> usize {
    value.split(',').count()
}

/// Names the engine owns; a sequence may not claim one.
pub const BUILTINS: [&str; 6] = ["_count", "_first", "_last", "_item", "_item_id", "_total"];

pub fn is_builtin(name: &str) -> bool {
    BUILTINS.contains(&name)
}

/// One entry of [`declarations`]: the element, and the env-level group it was
/// wrapped in, if any.
struct Declaration<'a> {
    element: &'a Element,
    name: String,
    wrapped_in_group: Option<&'a str>,
    /// A member of a `<pool>`. Checked like any other declaration, but its name
    /// belongs to the pool rather than to the run — a pool holding an `id` must
    /// not collide with the run's own `id`, nor look like an ambiguity.
    in_pool: bool,
}

/// Every sequence-like declaration in `<env>`, in the order they appear.
///
/// A `<uniq>` or `<distinct>` wrapper is not a declaration of its own — it says
/// what must hold between the sequences inside it. So its children are flattened
/// into the same list, and each is checked, named and ordered exactly as if it
/// had been written directly under `<env>`. Anything else would make wrapping a
/// sequence change what the sequence is.
fn declarations(env: &Element) -> Vec<Declaration<'_>> {
    let mut result = Vec::new();
    for child in &env.children {
        if child.kind != Kind::OpenClose {
            continue;
        }
        match child.name.as_str() {
            "sequence" | "mix" | "switch" => result.push(Declaration {
                element: child,
                name: child.name.clone(),
                wrapped_in_group: None,
                in_pool: false,
            }),
            // A pool's members are declarations too — checked exactly as at the
            // top level — but its names are ITS columns, not the run's, so they
            // are marked and kept out of the shared namespace.
            "pool" => {
                for inner in &child.children {
                    if inner.kind != Kind::OpenClose {
                        continue;
                    }
                    match inner.name.as_str() {
                        "sequence" | "mix" | "switch" => result.push(Declaration {
                            element: inner,
                            name: inner.name.clone(),
                            wrapped_in_group: None,
                            in_pool: true,
                        }),
                        "uniq" | "distinct" => {
                            for wrapped in &inner.children {
                                if wrapped.kind == Kind::OpenClose
                                    && (wrapped.name == "sequence"
                                        || wrapped.name == "mix"
                                        || wrapped.name == "switch")
                                {
                                    result.push(Declaration {
                                        element: wrapped,
                                        name: wrapped.name.clone(),
                                        wrapped_in_group: None,
                                        in_pool: true,
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
            group @ ("uniq" | "distinct") => {
                for inner in &child.children {
                    // A <mix> or <switch> inside the group is a member and a
                    // declaration both — without this the name never exists and
                    // every reference to it reads as undeclared.
                    if inner.kind == Kind::OpenClose
                        && (inner.name == "sequence"
                            || inner.name == "mix"
                            || inner.name == "switch")
                    {
                        result.push(Declaration {
                            element: inner,
                            name: inner.name.clone(),
                            wrapped_in_group: Some(group),
                            in_pool: false,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    result
}

/// Sorted, for a hint that lists what IS allowed. The order a table is written
/// in is about readability; the order a message prints in is about being
/// scannable.
fn sorted(values: &[&str]) -> Vec<String> {
    let mut sorted: Vec<String> = values.iter().map(|v| (*v).to_string()).collect();
    sorted.sort();
    sorted
}

/// `^\d+(?:\.\d+)*$`
fn is_version_text(raw: &str) -> bool {
    !raw.is_empty()
        && raw
            .split('.')
            .all(|part| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit()))
}

fn compare_versions(a: &str, b: &str) -> i32 {
    let x: Vec<i64> = a.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    let y: Vec<i64> = b.split('.').map(|p| p.parse().unwrap_or(0)).collect();
    for i in 0..x.len().max(y.len()) {
        let (xi, yi) = (
            x.get(i).copied().unwrap_or(0),
            y.get(i).copied().unwrap_or(0),
        );
        if xi != yi {
            return if xi < yi { -1 } else { 1 };
        }
    }
    0
}

/// The values a sequence will actually produce, when the config says so outright.
///
/// Only one unnamed `<gen type="text" value="a,b,c">` qualifies — a text
/// generator's list is always literal, never a file or a pack, so what is written
/// is what comes out.
///
/// Unless something rewrites it. `case="upper"` turns `Male` into `MALE` and
/// `mask="xxxx"` turns `Female` into `Fema`, so a comparison against the written
/// word would then be wrong in both directions — flagging a config that works and
/// accepting one that never matches. `repeat=` makes the value a list rather than
/// a word. Any of the three, and the values stop being knowable from here.
fn finite_text_values(gen: &Element) -> Option<Vec<String>> {
    if gen.attr_value("type")? != "text" {
        return None;
    }
    for rewrites in ["case", "mask", "repeat"] {
        if gen.attr(rewrites).is_some() {
            return None;
        }
    }
    let raw = gen.attr_value("value").filter(|v| !v.trim().is_empty())?;
    Some(raw.split(',').map(|v| v.trim().to_string()).collect())
}

/// The most of an attribute value a message will quote. The full text is in
/// the config the position already points at; a message quoting 100 KB of it
/// buries every other diagnostic in the report. The same limit lives in the
/// other four implementations; change them together.
const MESSAGE_ECHO_LIMIT: usize = 120;

/// An attribute value, cut to fit inside a one-line message.
fn clip(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() <= MESSAGE_ECHO_LIMIT {
        return value.to_string();
    }
    let hidden = chars.len() - MESSAGE_ECHO_LIMIT;
    let head: String = chars[..MESSAGE_ECHO_LIMIT].iter().collect();
    format!("{head}\u{2026} ({hidden} more chars)")
}

/// Tags refused inside `<pool>`, with the reason each one is refused.
///
/// `<block>` and the fixtures describe a FILE — where records start, what goes
/// between them — and a pool has no file; it is a table other columns read. A
/// nested `<pool>` is refused so a pool stays a flat table: one pool pointing at
/// another says the same thing without making every later feature ask at which
/// depth it applies.
/// Every declaration inside a pool, flattened out of any group wrapper.
fn pool_member_nodes(pool: &Element) -> Vec<&Element> {
    let mut out = Vec::new();
    for member in &pool.children {
        if member.kind != Kind::OpenClose {
            continue;
        }
        match member.name.as_str() {
            "sequence" | "mix" | "switch" => out.push(member),
            "uniq" | "distinct" => {
                for wrapped in &member.children {
                    if wrapped.kind == Kind::OpenClose {
                        out.push(wrapped);
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// The pool a member draws from, when the member is a `<gen type="pool">`.
fn member_pool_ref(node: &Element) -> Option<String> {
    for child in &node.children {
        if child.name != "gen" {
            continue;
        }
        if child.attr_value("type") != Some("pool") {
            continue;
        }
        return Some(child.attr_value("value").unwrap_or_default().trim().to_string());
    }
    None
}

/// What one member contributes to its pool's field list.
///
/// Usually its own name. A member that is itself a reference to another pool
/// contributes that pool's fields under its name instead — `at` pointing at
/// `Clinics` gives `at.city`, and no bare `at`, because a record has no value to
/// print. Only pools declared ABOVE are visible, which is exactly what the
/// engine can compute and therefore what the reader is allowed to write.
fn add_member_fields(
    fields: &mut Vec<String>,
    node: &Element,
    known: &BTreeMap<String, Vec<String>>,
) {
    let Some(name) = node.attr_value("name") else {
        return;
    };
    let nested = member_pool_ref(node).and_then(|target| known.get(&target));
    match nested {
        None => fields.push(name.to_string()),
        Some(inner) => {
            for field in inner {
                fields.push(format!("{name}.{field}"));
            }
        }
    }
}

fn forbidden_in_pool(tag: &str) -> Option<&'static str> {
    match tag {
        "block" => Some("a pool has no output of its own — it is a table other columns read"),
        "before" | "after" | "before_block" | "after_block" | "delimiter_block" | "before_line"
        | "after_line" | "delimiter_line" => {
            Some("fixtures describe a file, and a pool is not written to one")
        }
        "pool" => {
            Some("a pool stays a flat table — point one pool at another instead of nesting them")
        }
        _ => None,
    }
}

/// The `A.B` pairs in an expression, for the one filter mistake that is certain.
fn dotted_names(expression: &str) -> Vec<(String, String)> {
    let words = plain_names_with_dots(expression);
    words
        .into_iter()
        .filter_map(|w| {
            let (left, right) = w.split_once('.')?;
            if right.contains('.') {
                return None;
            }
            Some((left.to_string(), right.to_string()))
        })
        .collect()
}

/// Bare identifiers, which is all a filter's ambiguity check needs.
fn plain_names(expression: &str) -> Vec<String> {
    plain_names_with_dots(expression)
        .into_iter()
        .filter(|w| !w.contains('.'))
        .collect()
}

fn plain_names_with_dots(expression: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    for ch in expression.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || (ch == '.' && !current.is_empty()) {
            current.push(ch);
        } else if !current.is_empty() {
            out.push(std::mem::take(&mut current));
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out.into_iter()
        .filter(|w| {
            w.chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        })
        .collect()
}
