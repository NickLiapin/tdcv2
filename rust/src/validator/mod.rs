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

use crate::expr::match_key::match_key;
use crate::sequence::pool;

use std::collections::{BTreeMap, BTreeSet};

use crate::date;
use crate::date::calendar;
use crate::distribution::percent_mask;
use crate::errors::Diagnostic;
use crate::expr;
use crate::format::{mask, transforms};
use crate::generators::{accumulate, advanced_regex, file, number, regex, repeat, stat};
use crate::numbers;
use crate::output::column_type::ColumnType;
use crate::packs::DataPacks;
use crate::stats::{dist_params, distribution};
use crate::unicode;

/// A tag's attributes, unquoted and by name.
type Attrs = std::collections::BTreeMap<String, String>;
use crate::parser::ast::{is_gen, Document, Element, Kind};
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

    // A pack file the address scan read and could not place — TDC171. Reported
    // after the walk because the scan is what the walk's own lookups trigger:
    // asking before it has run would always find nothing.
    if let Some(packs) = v.packs.as_ref() {
        v.diagnostics.extend(packs.header_warnings());
    }
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
    /// The run length from `<env count="…">`. Needed by checks whose answer
    /// depends on SIZE rather than shape — a `uniq` column costs nothing at a
    /// hundred rows and gigabytes at ten million.
    env_count: i64,
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
    /// Of those fields, the ones whose value list the config writes down — TDC225.
    pool_field_values: BTreeMap<String, BTreeMap<String, Vec<String>>>,
    /// Every pool a `<gen type="pool">` names, gathered before the walk — TDC231.
    pools_read: BTreeSet<String>,
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
    pending_expressions: Vec<(usize, String, Pos, bool, Option<BTreeSet<String>>)>,
    /// The names the expression being walked right now may see, where they are
    /// NOT the run's. A `<pool>` member reads its own pool and nothing else: the
    /// table is built before any row exists, so a condition naming an env column
    /// is constant-false on every member. `None` is every expression outside a
    /// pool.
    expr_scope: Option<BTreeSet<String>>,
    /// Every `filter=` seen, and where its complaint belongs in the report.
    ///
    /// Held back for the same reason an `if=` is: the column a filter compares
    /// against may be declared BELOW the reference, and the run resolves that
    /// happily. `(at, expression, pool, field, other, pos)`.
    pending_pool_filters: Vec<(usize, String, String, String, String, Pos)>,
    /// Those of them that produce a list, which is what `each=` may walk.
    repeating_names: BTreeSet<String>,
}

impl Validator {
    /// One invented tag, one answer — wherever it turns up.
    ///
    /// Containers used to differ twice over: five said nothing at all, and the
    /// ones that did spoke in three wordings. The CODES stay as they are (they
    /// are published), but the note is what a reader acts on, so it is built
    /// here for every container alike.
    fn unknown_child(&mut self, parent: &str, name: &str, code: &str, allowed: &[&str], at: Pos) {
        // Sorted, because the four other implementations sort and a reader scanning
        // for a name finds it faster in a list that has an order.
        let mut names: Vec<&str> = allowed.to_vec();
        names.sort_unstable();
        let hint = format!("Allowed inside <{parent}>: {}.", names.join(", "));
        self.error(
            code,
            format!("unknown child of <{parent}>: \"<{name}>\""),
            &hint,
            at,
        );
    }

    /// Report every child of `el` that is not on `allowed`.
    ///
    /// TDC013 means "a tag this language knows, in the wrong place" and TDC010
    /// "a tag nobody has heard of", so the sentence follows the code rather than
    /// the call site — otherwise a reader gets one code and the other's wording.
    fn check_contained(&mut self, el: &Element, parent: &str, code: &str, allowed: &[&str]) {
        let bad: Vec<(String, Pos)> = el
            .children
            .iter()
            .filter(|c| !allowed.contains(&c.name.as_str()) && c.name != "comment")
            .map(|c| (c.name.clone(), c.pos))
            .collect();
        for (name, pos) in bad {
            if code == "TDC013" {
                let mut names: Vec<&str> = allowed.to_vec();
                names.sort_unstable();
                self.error(
                    "TDC013",
                    format!("<{name}> is not allowed directly inside <{parent}>"),
                    &format!("Allowed inside <{parent}>: {}.", names.join(", ")),
                    pos,
                );
            } else {
                self.unknown_child(parent, &name, code, allowed, pos);
            }
        }
    }

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

        // Two second passes, pools before expressions. Both splice their
        // complaints back at the position the attribute was found, so the report
        // still reads top to bottom; running the pool pass first is what makes
        // the two independent — an expression's recorded position is relative to
        // the walk, and re-splicing it after another pass has inserted would need
        // that pass's shifts as well.
        self.run_pending_pool_filters();

        // Now that every name is known, the expressions can be checked — and
        // each complaint goes back where its attribute was, so the report stays
        // in source order.
        let pending = std::mem::take(&mut self.pending_expressions);
        let mut shift = 0usize;
        for (at_index, condition, pos, each, scope) in pending {
            let before = self.diagnostics.len();
            let outer = match scope {
                None => None,
                Some(names) => Some(std::mem::replace(&mut self.declared_names, names)),
            };
            self.check_expression_names(&condition, pos, each);
            if let Some(names) = outer {
                self.declared_names = names;
            }
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
        // Both containers are read by taking the FIRST of their kind, so a second
        // one is dropped whole — every sequence it declares, every line it lays
        // out — and the run finishes looking healthy while half the config
        // produced nothing. The same silent discard TDC014 refuses for the
        // self-closing spelling, one level up. Reported on the SECOND one: the
        // first is what runs, so the second is the surprise.
        let mut seen: BTreeMap<String, usize> = BTreeMap::new();
        for child in &tdc.children {
            let name = child.name.clone();
            if child.kind == Kind::OpenClose && (name == "env" || name == "block") {
                let count = seen.entry(name.clone()).or_insert(0);
                *count += 1;
                if *count > 1 {
                    self.error(
                        "TDC270",
                        format!(
                            "<tdc> holds more than one <{name}> — only the first is read, and \
                             this one is discarded whole"
                        ),
                        if name == "env" {
                            "Every sequence declared here would be missing at render time. Move \
                             them into the first <env>."
                        } else {
                            "Every line laid out here would be missing from the output. Move \
                             them into the first <block>, or use <line if=\"\u{2026}\"> to \
                             switch layouts per row."
                        },
                        child.pos,
                    );
                }
            }
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

    /// `uniq` over many rows holds the whole column in memory — say so first.
    ///
    /// A `<pool>` has warned since TDC234; `uniq` does the same thing and said
    /// nothing. 250 bytes a value is MEASURED — peak RSS against row count, the
    /// slope over an eight-fold range; the table is in the TypeScript reference,
    /// `typescript/src/validator/uniq-memory.ts`.
    fn check_uniq_memory(&mut self, open: &Element, named: Option<&str>) {
        const BYTES_PER_VALUE: i64 = 250;
        const WARN_ROWS: i64 = 100_000;
        if open
            .attr_value("uniq")
            .map(str::trim)
            .map(str::to_lowercase)
            .as_deref()
            != Some("true")
        {
            return;
        }
        if self.env_count < WARN_ROWS {
            return;
        }
        let bytes = self.env_count * BYTES_PER_VALUE;
        let mb = bytes as f64 / 1024.0 / 1024.0;
        let size = if mb >= 1024.0 {
            format!("{:.1} GB", mb / 1024.0)
        } else {
            format!("{} MB", Self::grouped(mb.round() as i64))
        };
        self.warn(
            "TDC236",
            format!(
                "uniq on \"{}\" holds all {} values in memory for the whole run — about {}",
                named.unwrap_or("?"),
                Self::grouped(self.env_count),
                size
            ),
            "Drawing without replacement means remembering what has been drawn, so this cannot \
             stream: the config runs on the in-memory engine whatever mode= asks for. Measured at \
             about 250 bytes a value. It works — it is worth being deliberate about at this size.",
            open.pos,
        );
    }

    /// A `percent` share that asks for less than one whole row.
    ///
    /// `percent` is an exact quota over the rows that reach it, not a chance
    /// rolled per row. Ten percent of a five-row subset asks for HALF a record,
    /// and half a record cannot be emitted — so the branch produces one or none
    /// and the seed alone decides which. The engine rounds and says nothing,
    /// which is how a column that came out empty reads as a config that was
    /// never written rather than one that rounded away.
    ///
    /// The denominator is knowable for the shapes people write: `count` at the
    /// top of `<env>`, `count` x a parent's share, or `count` x the share a
    /// `<switch>` branch matches. Where the subject writes no shares of its own
    /// this stays SILENT — a check that guessed would fire on working configs
    /// and be turned off.
    fn check_small_shares(&mut self, env: &Element) {
        if self.env_count <= 0 {
            return;
        }
        let mut shares: BTreeMap<String, BTreeMap<String, f64>> = BTreeMap::new();

        for child in &env.children {
            match child.name.as_str() {
                "sequence" => self.read_sequence_shares(child, &mut shares),
                "mix" => {
                    let rows = self.rows_of(child.attr_value("parent"), &shares);
                    self.report_thin(child, branch_count(child), rows);
                }
                "switch" => self.read_switch_shares(child, &shares),
                _ => {}
            }
        }
    }

    /// Record what a sequence's values are worth, and check its own share.
    fn read_sequence_shares(
        &mut self,
        seq: &Element,
        shares: &mut BTreeMap<String, BTreeMap<String, f64>>,
    ) {
        let rows = self.rows_of(seq.attr_value("parent"), shares);

        let gens: Vec<&Element> = seq.children.iter().filter(|c| c.name == "gen").collect();
        if gens.len() != 1 {
            return;
        }
        let gen = gens[0];
        if gen.attr_value("type") != Some("text") {
            return;
        }

        let values: Vec<&str> = gen
            .attr_value("value")
            .unwrap_or("")
            .split(',')
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .collect();
        let Some(mask) = gen.attr_value("percent") else {
            return;
        };
        if values.is_empty() {
            return;
        }
        let Some(percents) = safe_expand(mask, values.len()) else {
            return;
        };

        if let (Some(name), Some(_)) = (seq.attr_value("name"), rows) {
            let mut table = BTreeMap::new();
            for (value, percent) in values.iter().zip(percents.iter()) {
                table.insert((*value).to_string(), percent / 100.0);
            }
            shares.insert(name.to_string(), table);
        }

        self.report_thin(gen, values.len(), rows);
    }

    /// Each `<case is="X">`, with the rows that value takes.
    fn read_switch_shares(
        &mut self,
        switch: &Element,
        shares: &BTreeMap<String, BTreeMap<String, f64>>,
    ) {
        let Some(table) = switch.attr_value("on").and_then(|on| shares.get(on)) else {
            return;
        };

        for case in switch.children_named("case") {
            let Some(is) = case.attr_value("is") else {
                continue;
            };
            // `is="US|CA"` matches either, so the branch takes both their shares.
            let mut fraction = 0.0;
            let mut known = true;
            for key in is.split('|').map(str::trim) {
                match table.get(key) {
                    Some(share) => fraction += share,
                    None => known = false,
                }
            }
            if !known {
                continue;
            }
            let rows = self.env_count as f64 * fraction;
            for inner in case.children_named("mix") {
                self.report_thin(inner, branch_count(inner), Some(rows));
            }
        }
    }

    /// Rows reaching something with this `parent`, or `None` when unresolvable.
    fn rows_of(
        &self,
        parent: Option<&str>,
        shares: &BTreeMap<String, BTreeMap<String, f64>>,
    ) -> Option<f64> {
        let Some(parent) = parent.map(str::trim).filter(|p| !p.is_empty()) else {
            return Some(self.env_count as f64);
        };
        let at = parent.find('.')?;
        let share = shares.get(&parent[..at])?.get(&parent[at + 1..])?;
        Some(self.env_count as f64 * share)
    }

    /// Report the smallest share that asks for less than a row, once per element.
    fn report_thin(&mut self, el: &Element, branches: usize, rows: Option<f64>) {
        let Some(rows) = rows.filter(|r| *r > 0.0) else {
            return;
        };
        if branches == 0 {
            return;
        }
        let Some(mask) = el.attr_value("percent") else {
            return;
        };
        // `repeat=` plans the quota over ELEMENTS, not rows: three per row over
        // four rows is twelve draws, and `repeat="1..3"` does not even fix how
        // many. Rows is the wrong denominator here, so say nothing.
        if !el.attr_value("repeat").unwrap_or("").trim().is_empty() {
            return;
        }
        let Some(percents) = safe_expand(mask, branches) else {
            return;
        };

        let mut worst: Option<f64> = None;
        for percent in percents {
            if percent <= 0.0 {
                continue; // a zero share asks for nothing on purpose
            }
            if percent / 100.0 * rows >= 1.0 {
                continue;
            }
            if worst.is_none_or(|w| percent < w) {
                worst = Some(percent);
            }
        }
        let Some(worst) = worst else {
            return;
        };

        self.warn(
            "TDC251",
            format!(
                "percent=\"{}\" over {} rows asks for {} records — the result is 0 or 1, and \
                 the seed decides which",
                two_places(worst),
                two_places(rows),
                two_places(worst / 100.0 * rows)
            ),
            "A share below one whole row cannot be emitted, so the branch fires once or not at \
             all. Raise the share, or raise count= until the share covers a whole row.",
            el.pos,
        );
    }

    fn check_env(&mut self, env: &Element) {
        self.locale = env.attr_value("local").unwrap_or("en").to_string();

        if let Some(count) = env.attr_value("count").map(str::to_string) {
            if let Ok(n) = count.trim().parse::<i64>() {
                if n >= 0 {
                    self.env_count = n;
                }
            }
            if !count.trim().parse::<i32>().is_ok_and(|n| n >= 0) {
                self.error(
                    "TDC020",
                    format!("invalid count \"{count}\" — expected a non-negative integer"),
                    "count is how many records to generate.",
                    env.at("count"),
                );
            }
        }

        // A share below one whole row: its own pass, because the denominator of a
        // <mix> in a switch branch belongs to the switch and not to the walk below.
        self.check_small_shares(env);

        if let Some(inject) = env.attr_value("inject").map(str::to_string) {
            // The renderer splits on `(.+)%(.+)`, so the pattern needs a `%` with
            // something on BOTH sides. Counting the `%` alone let "%%" and "%x"
            // through: they have one, they cannot be split, and the renderer
            // quietly stopped interpolating.
            // Exactly what `(.+)%(.+)` asks: SOME `%` with at least one
            // character on each side. Testing only the first one would refuse
            // the documented `%{%}%`, whose usable `%` is the middle one.
            let splittable = inject
                .char_indices()
                .any(|(i, c)| c == '%' && i > 0 && i + c.len_utf8() < inject.len());
            if !splittable {
                let message = if inject.contains('%') {
                    format!(
                        "inject pattern \"{inject}\" has nothing on both sides of its \"%\" \
                         — interpolation will never match"
                    )
                } else {
                    format!(
                        "inject pattern \"{inject}\" has no \"%\" placeholder — interpolation \
                         will never match"
                    )
                };
                self.error(
                    "TDC021",
                    message,
                    "The `%` is where the sequence name goes, and it needs an opening and a \
                     closing part around it: inject=\"${{{{%}}}}\", inject=\"[%]\", \
                     inject=\"%{{%}}%\".",
                    env.at("inject"),
                );
            }
        }

        self.check_children(env, "env", &tables::ENV_CHILDREN);
        // ENV_GROUP_CHILDREN was written down when the unknown-child holes were
        // closed and then never read, so an invented tag inside an env-level
        // <uniq> or <distinct> was accepted in silence here while the reference
        // refused it. Measured before this line existed: `<banana/>` inside a
        // group was TDC010 in TypeScript and nothing at all in the four ports.
        for child in &env.children {
            if child.name == "uniq" || child.name == "distinct" {
                let group = child.name.clone();
                self.check_children(child, &group, &tables::ENV_GROUP_CHILDREN);
            }
        }
        self.check_asserts(env);
        self.check_closed_tag_attrs("env", env);
        self.check_group_sizes(env);
        // Pools first, and only their shape: a reference may stand above the
        // pool it names, and complaining about an unknown field in that case
        // would report a problem the author does not have.
        self.collect_pool_fields(env);
        self.collect_pool_field_values(env);
        self.collect_pool_references(env);
        let mut pools_above: Vec<String> = Vec::new();
        // A fixture holds text and <line>s. Anything else was ignored in silence.
        let fixtures: Vec<Element> = env
            .children
            .iter()
            .filter(|c| c.kind == Kind::OpenClose && is_fixture_tag(&c.name))
            .cloned()
            .collect();
        for f in &fixtures {
            self.check_fixture_children(f);
        }
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
                self.check_pool_is_read(child);
            }
        }

        let mut names: BTreeSet<String> = BTreeSet::new();
        let mut declared: Vec<String> = Vec::new();
        self.declared_order.clear();

        for declaration in declarations(env) {
            let tag = declaration.name.clone();
            if tag == "sequence" && declaration.wrapped_in_group.is_some() {
                let group = declaration.wrapped_in_group.unwrap();
                self.check_env_group_member(declaration.element, group);
                self.check_group_derived_member(declaration.element, group);
            }
            let in_pool = declaration.pool.is_some();
            // Every expression deferred while this declaration is walked is a
            // pool member's or the run's, and the two see different names.
            self.expr_scope = declaration
                .pool
                .as_ref()
                .map(|p| self.pool_fields.get(p).cloned().unwrap_or_default())
                .map(|fields| fields.into_iter().collect());
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
                    // Size, not shape: what this column will COST at this run length.
                    self.check_uniq_memory(open, named);
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
                    // A pool reference draws no column of its own — it hands the row a
                    // whole member from a table built before the run — so there is
                    // nothing to take without replacement.
                    if open.children.iter().any(|c| {
                        c.name == "gen" && c.attr("type").map(|a| a.value()) == Some("pool")
                    }) {
                        self.uniq_unsupported(
                            open,
                            Some(n),
                            "it draws a whole member from a <pool> rather than a column of its own, so there is nothing to draw without replacement — put uniq= on a <sequence> inside the <pool> to make the members distinct",
                        );
                    }
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
        self.expr_scope = None;
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

    /// The values each pool field can hold, where the config says them outright.
    ///
    /// A member whose body is one unnamed `<gen type="text" value="A,B">`
    /// produces nothing but `A` and `B`, so the set recorded here is a SUPERSET
    /// of what the built pool will hold — a pool of two members drawn from three
    /// values holds at most two of them. That direction is what TDC225 needs: a
    /// value outside the superset can match no member, whatever the draw.
    fn collect_pool_field_values(&mut self, env: &Element) {
        for child in &env.children {
            if child.kind != Kind::OpenClose || child.name != "pool" {
                continue;
            }
            let Some(name) = child.attr_value("name") else {
                continue;
            };
            let mut fields: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for member in pool_member_nodes(child) {
                let Some(field) = member.attr_value("name") else {
                    continue;
                };
                if let Some(values) = literal_text_values(member) {
                    fields.insert(field.to_string(), values);
                }
            }
            self.pool_field_values.insert(name.to_string(), fields);
        }
    }

    /// Every pool named by a `<gen type="pool" value="…">`, anywhere under `<env>`.
    ///
    /// Collected in one descent rather than tallied during the walk, because a
    /// reference may stand above the pool it names and TDC231 has to know about
    /// it by the time that pool is reached.
    fn collect_pool_references(&mut self, node: &Element) {
        for child in &node.children {
            if child.name == "gen" {
                if child.attr_value("type") == Some("pool") {
                    self.pools_read
                        .insert(child.attr_value("value").unwrap_or("").trim().to_string());
                }
                continue;
            }
            if child.kind == Kind::OpenClose {
                self.collect_pool_references(child);
            }
        }
    }

    /// A pool nobody draws from.
    ///
    /// A warning rather than an error, on the same reasoning as TDC234: the
    /// config runs, and every row is exactly what it would have been. What it
    /// costs is the build — a pool is computed in full before the first row and
    /// held in memory for the whole run — so an unread `count="50000"` is paid
    /// for and thrown away. It is also the shape a rename leaves behind, where
    /// the reference points at a new pool and the old one sits there looking
    /// deliberate.
    fn check_pool_is_read(&mut self, pool: &Element) {
        let Some(name) = pool.attr_value("name").filter(|n| !n.trim().is_empty()) else {
            return;
        };
        if self.pools_read.contains(name) {
            return;
        }
        let name = name.to_string();
        self.warn(
            "TDC231",
            format!("pool \"{name}\" is never drawn from"),
            &format!(
                "A pool is built in full before the first row and kept in memory for the \
                 whole run, so an unread one costs its members for nothing. Read it with \
                 <gen type=\"pool\" value=\"{name}\"/>, or remove it."
            ),
            pool.pos,
        );
    }

    /// The put-aside filters, decided now that every column is known.
    ///
    /// What can be said before a single value exists: the member's field and the
    /// other side of the `==` each draw from a set the config writes down, and
    /// when those two sets do not overlap the filter can never match — not on
    /// some row, on every row. The run already refuses that, on row one, after
    /// building the pool; saying it at check time costs nothing and names both
    /// lists.
    ///
    /// Only DISJOINT sets are reported. A value that is merely rare is a refusal
    /// waiting for the row that draws it, and reporting it here would also refuse
    /// `percent="100,0"`, which never draws that value at all.
    fn run_pending_pool_filters(&mut self) {
        let pending = std::mem::take(&mut self.pending_pool_filters);
        let mut shift = 0usize;
        for (at_index, expression, pool, field, other, pos) in pending {
            let Some(field_values) = self
                .pool_field_values
                .get(&pool)
                .and_then(|byfield| byfield.get(&field))
                .filter(|values| !values.is_empty())
                .cloned()
            else {
                continue;
            };
            // A name no sequence has is a bare word, and the expression language
            // reads a bare word as its own text — that is how
            // `filter="clinic == North"` says "northern only". So it is a set of
            // exactly one value.
            let is_column = self.declared_names.contains(&other);
            let other_values = if is_column {
                self.finite_values.get(&other).cloned()
            } else {
                Some(vec![other.clone()])
            };
            let Some(other_values) = other_values.filter(|values| !values.is_empty()) else {
                continue;
            };
            // Compared the way `==` compares two texts, so the check cannot refuse a
            // config the run would have answered. Raw text refused `code == Want`
            // where the members hold 01,02,03 and the column produces 1,2,3 — the
            // same question written with one extra term matched every row.
            let field_keys: BTreeSet<String> = field_values.iter().map(|v| match_key(v)).collect();
            if other_values
                .iter()
                .any(|v| field_keys.contains(&match_key(v)))
            {
                continue;
            }

            let message = if is_column {
                format!(
                    "filter=\"{expression}\" can never match — no value \"{other}\" produces \
                     is a \"{field}\" any member of pool \"{pool}\" could hold"
                )
            } else {
                format!(
                    "filter=\"{expression}\" can never match — no member of pool \"{pool}\" \
                     holds \"{field}\" = \"{other}\""
                )
            };
            let produced = if is_column {
                format!("\"{other}\" produces: {}. ", other_values.join(", "))
            } else {
                String::new()
            };
            let hint = format!(
                "\"{field}\" is drawn from: {}. {produced}A filter narrows the members a row \
                 may draw from, and every row would be left with none.",
                field_values.join(", ")
            );
            self.diagnostics.insert(
                at_index + shift,
                Diagnostic::error("TDC225", message, &hint, pos),
            );
            shift += 1;
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
                format!(
                    "pool \"{pool_name}\" draws from \"{target}\", which is not declared above it"
                )
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
        let name = node.attr_value("name").map(|s| s.trim()).unwrap_or("");
        if name.is_empty() {
            self.error(
                "TDC222",
                "<pool> has no name".to_string(),
                "A pool is read by name: <pool name=\"Doctors\" count=\"30\">, then \
                 <gen type=\"pool\" value=\"Doctors\"/>.",
                node.pos,
            );
        }
        let raw = node.attr_value("count").map(|s| s.trim()).unwrap_or("");
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

        let unknown: Vec<(String, Pos)> = node
            .children
            .iter()
            .filter(|c| {
                !tables::POOL_CHILDREN.contains(&c.name.as_str())
                    && forbidden_in_pool(&c.name).is_none()
                    && c.name != "comment"
                    && c.name != "data"
            })
            .map(|c| (c.name.clone(), c.pos))
            .collect();
        for (name, pos) in unknown {
            // Neither branch below said anything about a name it did not know, and
            // the `kind != OpenClose` skip meant a self-closing invention was not
            // even looked at. Tags with a reason of their own keep TDC230.
            self.unknown_child("pool", &name, "TDC010", &tables::POOL_CHILDREN, pos);
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
            let pool_name = child.attr_value("value").map(|s| s.trim()).unwrap_or("");
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

        // The little language itself. The name checks below are about THIS pool's fields and
        // say nothing about whether the expression is runnable at all.
        self.check_expression_at(expression, gen.at("filter"), "filter= expression", "a");

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

        // `field == Something` — the one filter shape a check can decide,
        // recognised the same way the engine's fast path recognises it, by
        // looking at the text rather than a parsed tree, so what the reader sees
        // and what is checked are the same thing.
        let sides: Vec<&str> = expression.split("==").collect();
        if sides.len() != 2 {
            return;
        }
        let left = sides[0].trim();
        let right = sides[1].trim();
        if !is_plain_name(left) || !is_plain_name(right) {
            return;
        }
        let left_is_field = fields.iter().any(|f| f == left);
        let right_is_field = fields.iter().any(|f| f == right);
        // Both sides a field compares the candidate with itself, which is a
        // different mistake and not one this check can speak to.
        if left_is_field == right_is_field {
            return;
        }
        let (field, other) = if left_is_field {
            (left, right)
        } else {
            (right, left)
        };
        self.pending_pool_filters.push((
            self.diagnostics.len(),
            expression.trim().to_string(),
            pool_name.to_string(),
            field.to_string(),
            other.to_string(),
            gen.pos,
        ));
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
        let gens: Vec<&Element> = sequence.children.iter().filter(|c| is_gen(c)).collect();
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

    /// A DERIVED column inside a `<uniq>` or `<distinct>` group.
    ///
    /// A group is a rearrangement: it keeps every member's multiset of values and permutes
    /// the columns until each record is unique. Sound for drawn columns — a draw means the
    /// same wherever it lands — and destructive for a derived one, whose value is a
    /// statement ABOUT the row it was computed for. Measured on the reference, `<uniq>` over
    /// `A` (1..5) and `F = A * 10` gave `2|20  3|20  3|30  2|30  5|50`: two rows of five
    /// saying that ten times three is twenty, with `check` calling the config valid.
    ///
    /// A `<compute>` is the same case from the other side — `f(x)` is `f(x)`, so it has no
    /// pool to draw from and no column of its own to rearrange.
    fn check_group_derived_member(&mut self, sequence: &Element, tag: &str) {
        let name = sequence.attr_value("name").unwrap_or("?").to_string();
        for child in &sequence.children {
            if child.kind == Kind::OpenClose && child.name == "compute" {
                self.error(
                    "TDC296",
                    format!(
                        "<sequence name=\"{name}\"> holds a <compute>, which cannot be a member \
                         of <{tag}>: it derives its value from other columns, so it has nothing \
                         of its own to rearrange and cannot keep the group's promise"
                    ),
                    &format!(
                        "Put the <{tag}> around the <gen> sequences the <compute> READS. Its \
                         value follows them, so arranging the inputs arranges the result."
                    ),
                    child.pos,
                );
                return;
            }
            if !is_gen(child) {
                continue;
            }
            let attrs = child.attr_map();
            let gen_type = attrs.get("type").map(String::as_str);
            if !is_derived(gen_type, &attrs) {
                continue;
            }
            let described = match gen_type {
                Some("date") => "a date measured from another column (of=)".to_string(),
                Some(other) => format!("a type=\"{other}\" column"),
                None => "a computed column".to_string(),
            };
            self.error(
                "TDC296",
                format!(
                    "<sequence name=\"{name}\"> holds {described}, which cannot be a member of \
                     <{tag}>: the group rearranges finished columns, and a computed value moved \
                     to another row no longer describes that row"
                ),
                &format!(
                    "Put the {tag} group around the columns this one READS, and leave the \
                     computed column outside it. It follows whatever the group arranges, so it \
                     stays true row by row."
                ),
                child.pos,
            );
            return;
        }
    }

    /// `expr=` is what a formula IS, and every name in it must be a column declared above.
    fn check_formula(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("formula") {
            return;
        }
        let source = attrs.get("expr").map(|s| s.trim()).unwrap_or("");
        if source.is_empty() {
            self.error(
                "TDC294",
                "<gen type=\"formula\"> needs expr=\"\u{2026}\"".to_string(),
                "The expression is what the column IS: expr=\"Weight / (Height * Height)\".",
                gen.at("type"),
            );
            return;
        }
        self.check_param_names(gen, "expr", source);
    }

    /// A derived column cannot be ONE BRANCH of a per-row choice.
    ///
    /// `running`, `stat`, a date offset and `formula` are built once, for the whole column,
    /// in declaration order. An `if=` asks for something else entirely: a value chosen row by
    /// row. The two cannot both be true, and the run used to die with a message that read
    /// like an unfinished engine rather than a config that cannot mean anything.
    fn check_derived_not_conditional(
        &mut self,
        gen: &Element,
        attrs: &Attrs,
        gen_type: Option<&str>,
    ) {
        if !is_derived(gen_type, attrs) {
            return;
        }
        if attrs.get("if").map(|s| s.trim()).unwrap_or("").is_empty() {
            return;
        }
        let described = gen_type.unwrap_or("");
        self.error(
            "TDC295",
            format!(
                "a type=\"{described}\" column is built for the whole run, so it cannot carry if="
            ),
            "It reads other columns in declaration order and produces one column, not a value \
             chosen per row. Put the condition where the value is USED \u{2014} `<data \
             if=\"\u{2026}\">` \u{2014} or compute the column unconditionally and branch on it \
             afterwards.",
            gen.at("if"),
        );
    }

    /// `read="quantile"` — the file as a sorted sample rather than a bag of values.
    ///
    /// Everything refused here asks for TWO readings of one file at once. `weight=` says the
    /// shares live in a second column; `read="quantile"` says the values ARE the
    /// distribution. `row=` links several columns to one LINE, and a quantile answer is a
    /// point between two of them. `order="sequential"` walks the list in order, which a
    /// distribution has no notion of.
    fn check_quantile_read(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("file") {
            return;
        }
        let read = attrs.get("read").map(|s| s.trim()).unwrap_or("");
        let sample = attrs.get("sample").map(|s| s.trim()).unwrap_or("");

        if attrs.contains_key("read") && read != "quantile" {
            self.error(
                "TDC297",
                format!(
                    "read=\"{read}\" is not a way of reading a file \u{2014} the only one is \
                     \"quantile\""
                ),
                "Leave read= off to pick one of the file's values at random, or write \
                 read=\"quantile\" to read the file as a sorted sample and land anywhere on it.",
                gen.at("read"),
            );
            return;
        }

        if attrs.contains_key("sample") && sample != "exact" {
            self.error(
                "TDC297",
                format!(
                    "sample=\"{sample}\" is not a sampling mode \u{2014} the only one is \"exact\""
                ),
                "Leave sample= off to draw from the distribution row by row, or write \
                 sample=\"exact\" to sweep it evenly so the run reproduces the sample with no \
                 sampling noise.",
                gen.at("sample"),
            );
        }

        if attrs.contains_key("sample") && read != "quantile" {
            self.error(
                "TDC297",
                "sample= only means something beside read=\"quantile\"".to_string(),
                "It chooses between drawing from the distribution and sweeping it evenly, and a \
                 file read as a plain list of values has no distribution to sweep.",
                gen.at("sample"),
            );
        }

        if read != "quantile" {
            return;
        }

        for (name, why, hint) in [
            (
                "weight",
                "weight= puts the shares in a COLUMN beside the values, and read=\"quantile\" \
                 says the values are the distribution themselves \u{2014} how often one appears \
                 in the file IS its share",
                "Keep one of the two readings. A countable value wants weight= and its exact \
                 quota; a measured one wants the quantile read, which also fills in the values \
                 between the observations.",
            ),
            (
                "row",
                "row= links several columns to one LINE of the file, and a quantile answer is \
                 not a line: it is a point between two of them",
                "To keep a record together, read the file as lines with row= and leave read= \
                 off.",
            ),
        ] {
            if attrs.get(name).map(|s| s.trim()).unwrap_or("").is_empty() {
                continue;
            }
            self.error(
                "TDC297",
                format!("{name}= cannot be combined with read=\"quantile\": {why}"),
                hint,
                gen.at(name),
            );
        }

        if attrs.get("order").map(|s| s.trim()) == Some("sequential") {
            self.error(
                "TDC297",
                "order=\"sequential\" cannot be combined with read=\"quantile\"".to_string(),
                "Walking a list in order and sampling a distribution are different jobs: one \
                 hands out the file's lines one after another, the other says where on the \
                 sorted sample a row lands.",
                gen.at("order"),
            );
        }
    }

    /// Register `Name.Field` for every field, wherever in the sequence body it
    /// sits.
    fn collect_field_names(&mut self, element: &Element, name: &str) {
        for child in &element.children {
            if is_gen(child) {
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
            if is_gen(child) {
                gens.push(child);
            } else if child.kind == Kind::OpenClose {
                if child.name == "compute" {
                    has_compute = true;
                    compute_el = Some(child);
                } else if child.name == "distinct" {
                    for g in &child.children {
                        if is_gen(g) {
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
        let unknown: Vec<(String, Pos)> = open
            .children
            .iter()
            .filter(|c| {
                !tables::SEQUENCE_CHILDREN.contains(&c.name.as_str())
                    && !tables::MISPLACED_IN_SEQUENCE.contains(&c.name.as_str())
                    && c.name != "comment"
            })
            .map(|c| (c.name.clone(), c.pos))
            .collect();
        for (name, pos) in unknown {
            // Used to pass in SILENCE: the config validated, exit 0, and the run
            // went ahead as if the tag had done something.
            self.unknown_child("sequence", &name, "TDC010", &tables::SEQUENCE_CHILDREN, pos);
            misplaced += 1;
        }
        let wrappers: Vec<Element> = open
            .children
            .iter()
            .filter(|c| c.name == "distinct" || c.name == "uniq")
            .cloned()
            .collect();
        for w in &wrappers {
            let tag = w.name.clone();
            self.check_contained(w, &tag, "TDC010", &tables::DISTINCT_CHILDREN);
        }
        for child in &open.children {
            if tables::MISPLACED_IN_SEQUENCE.contains(&child.name.as_str()) {
                let hint = tables::PLACEMENT_HINTS
                    .iter()
                    .find(|(k, _)| *k == child.name)
                    .map_or("", |(_, h)| *h);
                self.error(
                    "TDC013",
                    format!("<{}> is not allowed directly inside <sequence>", child.name),
                    &format!("{hint} Allowed inside <sequence>: {}.", {
                        let mut n = tables::SEQUENCE_CHILDREN.to_vec();
                        n.sort_unstable();
                        n.join(", ")
                    }),
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
        self.uniq_drops_gen_attrs(open, name, &gens);
        self.uniq_with_distinct(open, name);
        self.row_link_order(&gens);

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

        // The shape TDC246 refuses inside a `<case>`, one level out. A sequence
        // mints the ground-truth column only where the flagged gen IS its value:
        // a `name=` turns the gen into a FIELD and a second part makes it one
        // piece of a joined string, and in both the engine minted nothing while
        // `check` called the config valid. The anomaly still fired — the values
        // came out perturbed — so the only thing missing was the record of WHICH
        // rows, and `${{NAME}}` reached the output as its own literal text.
        let simple = gens.len() == 1 && field_names.is_empty() && !composes;
        if !simple {
            for gen in &gens {
                let Some(flag) = gen.attr_value("anomaly_flag") else {
                    continue;
                };
                self.error(
                    "TDC283",
                    format!(
                        "anomaly_flag=\"{}\" is not read on a <gen> that is one part of its \
                         <sequence>",
                        flag.trim()
                    ),
                    "The flag records which ROWS were made outliers, and a sequence built from \
                     several parts has no row-level column to put it in. Move this <gen> into a \
                     <sequence> of its own \u{2014} that also gives you the value as its own \
                     column.",
                    gen.at("anomaly_flag"),
                );
            }
        }
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
    /// `<distinct>` inside a `uniq="true"` sequence.
    ///
    /// They are documented as independent and they are not. `<distinct>` repairs
    /// a row so its fields differ; `uniq` afterwards rearranges the whole columns
    /// and knows nothing about which pairings the repair ruled out. Measured on
    /// twelve rows over exactly twelve legal distinct pairs, the run still
    /// produced `s,s` and `q,q`.
    fn uniq_with_distinct(&mut self, open: &Element, name: Option<&str>) {
        let declared = open.attr("uniq").map(|a| a.value()).unwrap_or("");
        if !declared.trim().eq_ignore_ascii_case("true") {
            return;
        }
        if !open.children.iter().any(|c| c.name == "distinct") {
            return;
        }
        self.error(
            "TDC267",
            format!(
                "uniq=\"true\" on <sequence name=\"{}\"> cannot be combined with <distinct>: \
                 the uniq arrangement rearranges the finished columns and does not know which \
                 pairings <distinct> ruled out, so the repair is undone",
                name.unwrap_or("?")
            ),
            "Keep one of the two. <distinct> is about a single record (its fields differ); uniq= \
             is about the whole column (no record repeats). For both at once, give each field \
             its own <sequence>, wrap them in <uniq>\u{2026}</uniq>, and put the <distinct> at \
             env level.",
            open.at("uniq"),
        );
    }

    /// `order="sequential"` on SOME members of a `row=` link.
    ///
    /// `row="k"` exists to keep a record together: every generator carrying the
    /// key reads the SAME line. `order="sequential"` picks a line too, by the
    /// row's position. Two rules choosing the same line, and only one can win —
    /// measured on the files guide's own users.csv, John was paired with Johnson
    /// when John is Smith. Narrow on purpose: when EVERY member is sequential
    /// they agree, and the records hold.
    fn row_link_order(&mut self, gens: &[&Element]) {
        let mut keys: Vec<&str> = Vec::new();
        for gen in gens {
            if let Some(k) = gen.attr("row").map(|a| a.value().trim()) {
                if !k.is_empty() && !keys.contains(&k) {
                    keys.push(k);
                }
            }
        }
        for key in keys {
            let group: Vec<&&Element> = gens
                .iter()
                .filter(|g| g.attr("row").map(|a| a.value().trim()) == Some(key))
                .collect();
            if group.len() < 2 {
                continue;
            }
            let walking: Vec<&&&Element> = group
                .iter()
                .filter(|g| g.attr("order").map(|a| a.value().trim()) == Some("sequential"))
                .collect();
            if walking.is_empty() || walking.len() == group.len() {
                continue;
            }
            let plain = group.len() - walking.len();
            let offender = walking[0];
            self.error(
                "TDC282",
                format!(
                    "order=\"sequential\" on part of the row=\"{key}\" link: {} of {} members \
                     walk the file in order and {plain} pick a line per record, so they stop \
                     reading the same line",
                    walking.len(),
                    group.len()
                ),
                "row= exists to keep the fields of one record together. Either give every member \
                 of the link order=\"sequential\", so they walk in step, or drop it from this one.",
                offender.at("order"),
            );
        }
    }

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

    /// Attributes that reach the value AFTER it is drawn, and so cannot survive
    /// a draw without replacement. Each can make two distinct draws print the
    /// same text — a mask hides the digits that told them apart, `case` folds
    /// `ab` and `AB` together, `missing` writes the same blank on many rows,
    /// `repeat` turns the cell into a list.
    const DROPPED_BY_UNIQ: [&str; 9] = [
        "mask",
        "case",
        "missing",
        "missing_as",
        "repeat",
        "separator",
        "distinct",
        "anomaly",
        "anomaly_flag",
    ];

    /// `uniq="true"` on a simple sequence whose `<gen>` also asks for formatting.
    ///
    /// The uniq path produces the column directly and never reaches the pipeline
    /// that applies these attributes, so they used to vanish in silence.
    /// Applying them instead would break the promise the other way round. So the
    /// combination is refused, and the attribute is named.
    ///
    /// `increment` and `decrement` are exempt: unique by construction, they keep
    /// their ordinary build and their formatting runs as it does anywhere else.
    fn uniq_drops_gen_attrs(&mut self, open: &Element, name: Option<&str>, gens: &[&Element]) {
        let declared = open.attr("uniq").map(|a| a.value()).unwrap_or("");
        if !declared.trim().eq_ignore_ascii_case("true") {
            return;
        }
        // Every <gen> the uniq construction replaces: the ONE unnamed gen of a
        // simple sequence, or ALL the fields of a compound one. Looking only at
        // the simple shape missed the case that mattered — a compound carrying
        // missing="0.4" produced ZERO blanks over twelve rows.
        let simple = gens.len() == 1 && gens[0].attr("name").is_none();
        let members: Vec<&&Element> = if simple {
            gens.iter().collect()
        } else {
            gens.iter().filter(|g| g.attr("name").is_some()).collect()
        };
        if members.is_empty() {
            return;
        }
        let mut asked: Vec<&str> = Vec::new();
        for gen in &members {
            let kind = gen.attr("type").map(|a| a.value()).unwrap_or("");
            if kind == "increment" || kind == "decrement" {
                continue;
            }
            for a in Self::DROPPED_BY_UNIQ {
                if gen.attr(a).is_some() && !asked.contains(&a) {
                    asked.push(a);
                }
            }
        }
        if asked.is_empty() {
            return;
        }
        let listed = asked
            .iter()
            .map(|a| format!("{a}="))
            .collect::<Vec<_>>()
            .join(", ");
        self.error(
            "TDC267",
            format!(
                "uniq=\"true\" on <sequence name=\"{}\"> cannot be combined with {listed} on \
                 its <gen>: a draw without replacement produces the values directly, so nothing \
                 that rewrites them afterwards runs",
                name.unwrap_or("?")
            ),
            "Two ways out. Drop the attribute if the uniqueness is what you wanted \u{2014} or \
             drop uniq= and keep the formatting, since a masked, blanked or repeated column \
             cannot be unique as text anyway: a mask maps different values onto the same \
             characters.",
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
                    format!("<{tag}> has no \"{key}\" attribute"),
                    &format!("Attributes of <{tag}>: {}.", sorted(known).join(", ")),
                    element.at(&key),
                );
            }
        }
    }

    // ── gen ──────────────────────────────────────────────────────────────────

    fn check_gens_in(&mut self, element: &Element) {
        if is_gen(element) {
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
            self.defer_expression(condition, gen.at("if"), false);
            // A pool reference publishes a whole MEMBER, and a `<gen>` carrying
            // `if` becomes a conditional branch the pool resolver does not
            // recognise — so no `Ref.field` column was registered and
            // `${{Ref.name}}` reached the output as its own literal text, on
            // every row including the ones the condition selected.
            if attrs.get("type").map(String::as_str) == Some("pool") {
                self.error(
                    "TDC268",
                    "if= is not supported on <gen type=\"pool\">: the reference publishes a \
                     whole MEMBER, and a conditional one would register no fields at all"
                        .to_string(),
                    "To leave some rows without a member, use parent=\"\u{2026}\" \u{2014} it \
                     masks the reference the same way it masks any other sequence, and the \
                     fields come out empty on the rows it excludes.",
                    gen.at("if"),
                );
            }
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

        // Before the per-type checks, and INSTEAD of them when it fires: a value
        // holding ${{…}} is not the value its generator will try to parse, so
        // letting the generator also complain would put a wrong explanation
        // beside the right one.
        if self.check_attr_interpolation(gen, &attrs, gen_type) {
            return;
        }

        self.check_required_value(gen, &attrs, gen_type);
        self.check_number(gen, &attrs, gen_type);
        self.check_regexes(gen, &attrs, gen_type);
        self.check_symbol(gen, &attrs, gen_type);
        self.check_date(gen, &attrs, gen_type);
        self.check_timeseries(gen, &attrs, gen_type);
        self.check_sequential_repeat(gen, &attrs);
        self.check_repeat(gen, &attrs, gen_type);

        self.check_gen_attributes(gen, &attrs, gen_type);

        self.check_weight(gen, &attrs, gen_type);
        // Before the source path is resolved: a file read the wrong way is a mistake about
        // the READING, and hearing "no such file" first would send the reader looking in the
        // wrong place.
        self.check_quantile_read(gen, &attrs, gen_type);
        self.check_source(gen, &attrs, gen_type);
        self.check_http(gen, &attrs, gen_type);
        self.check_running(gen, &attrs, gen_type);
        self.check_stat(gen, &attrs, gen_type);
        self.check_formula(gen, &attrs, gen_type);
        self.check_derived_not_conditional(gen, &attrs, gen_type);
        self.check_mask(gen, &attrs);
        self.check_counter(gen, &attrs, gen_type);
        self.check_date_templates(gen, &attrs, gen_type);
        self.check_case_and_order(gen, &attrs);
        self.check_imperfections(gen, &attrs, gen_type);

        // `order="sequential"` gives row r element `r mod N` — a rule about POSITION,
        // which leaves no room for a rule about SHARE. The engine ignores the percent
        // outright, and nothing told the user: percent="98,1,1" over a hundred rows came
        // out 34/33/33 from a config `check` had called valid.
        if matches!(gen_type, Some("text") | Some("file"))
            && attrs.get("order").map(|o| o.trim()) == Some("sequential")
        {
            if let Some(percent) = attrs.get("percent") {
                self.error(
                    "TDC271",
                    format!(
                        "percent=\"{percent}\" is not read beside order=\"sequential\": \
                         walking the list in order fixes which value each row gets, so there \
                         is no share left to apportion"
                    ),
                    "Drop order=\"sequential\" to have the shares apportioned exactly, or drop \
                     percent= and take the values in the order they are written \u{2014} each \
                     one as often as the others.",
                    gen.at("percent"),
                );
            }
        }

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

    /// Everything a statistic cannot do without.
    ///
    /// The same two things a running total needs, for the same two reasons: it
    /// has to say WHAT to summarise and WHICH statistic, and the column it reads
    /// has to be declared ABOVE it. The declaration-order complaint is TDC240,
    /// shared with `running` on purpose — the same rule with the same fix.
    fn check_stat(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("stat") {
            return;
        }
        let of = attrs.get("of").map(|s| s.trim()).unwrap_or("");
        if of.is_empty() {
            self.error(
                "TDC262",
                "<gen type=\"stat\"> does not say what to summarise".to_string(),
                "Name the column it reads: of=\"Price\". A statistic reads another sequence — \
                 it draws nothing of its own.",
                gen.pos,
            );
        }
        let raw_op = attrs.get("op").map(|s| s.trim()).unwrap_or("").to_string();
        if raw_op.is_empty() {
            self.error(
                "TDC262",
                "<gen type=\"stat\"> does not say which statistic".to_string(),
                &format!("Add op=\"…\" — one of: {}.", stat::OPS.join(", ")),
                gen.pos,
            );
        } else if let Err(message) = stat::parse_op(attrs) {
            self.error(
                "TDC262",
                message,
                &format!("One of: {}.", stat::OPS.join(", ")),
                gen.at("op"),
            );
        }
        if let Err(message) = stat::parse_decimals(attrs) {
            self.error(
                "TDC262",
                message,
                "decimals= rounds the answer. A mean, a median and a standard deviation are \
                 ratios and print in full without it; sum, min and max keep the exact scale of \
                 the column.",
                gen.at("decimals"),
            );
        }
        if !of.is_empty() && !self.declared_order.iter().any(|d| d == of) {
            let hint = if self.declared_order.is_empty() {
                "A statistic is built from a column that already exists, so the column it reads \
                 has to come first."
                    .to_string()
            } else {
                format!("Declared above: {}.", self.declared_order.join(", "))
            };
            self.error(
                "TDC240",
                format!("of=\"{of}\" is not a sequence declared above this one"),
                &hint,
                gen.at("of"),
            );
        }
    }

    /// Everything a date offset needs said, and nothing that contradicts it.
    ///
    /// `of=` is what turns a date generator from a DRAW into an OFFSET, and the
    /// two are configured by different attributes entirely. That makes the
    /// mistakes here silent ones by nature: a `from=` written beside an `of=`
    /// looks like it bounds the result and does nothing at all, because the
    /// result is wherever the source plus the offset lands.
    ///
    /// The declaration-order complaint is TDC240, shared with `running` and
    /// `stat` — the same rule with the same fix.
    fn check_date_offset(&mut self, gen: &Element, attrs: &Attrs) {
        let of = attrs.get("of").map(|s| s.trim()).unwrap_or("").to_string();
        let plus = attrs
            .get("plus")
            .map(|s| s.trim())
            .unwrap_or("")
            .to_string();
        if plus.is_empty() {
            self.error(
                "TDC264",
                format!("<gen type=\"date\" of=\"{of}\"> does not say how far from it"),
                &format!(
                    "Add plus=\"…\" — {}. A range is drawn per row, so plus=\"3..10d\" is the \
                     length of the stay; a single value is the same distance on every row.",
                    calendar::OFFSET_SYNTAX
                ),
                gen.pos,
            );
        } else {
            match calendar::parse_offset(Some(&plus)) {
                Ok(_) => {}
                Err(calendar::OffsetError::Order) => self.error(
                    "TDC264",
                    format!(
                        "plus=\"{plus}\" counts down, not up — the low bound is above the high one"
                    ),
                    "Write the smaller number first. To measure BACKWARDS, make both negative: \
                     plus=\"-10..-3d\".",
                    gen.at("plus"),
                ),
                Err(_) => self.error(
                    "TDC264",
                    format!("plus=\"{plus}\" is not an offset"),
                    &format!(
                        "One of: {}. A bare number means days.",
                        calendar::OFFSET_SYNTAX
                    ),
                    gen.at("plus"),
                ),
            }
        }

        // Attributes that place a date generator's OWN draw, and so say nothing
        // once `of=` has placed it relative to another column. Listed by name
        // because ignoring them is exactly the failure this exists to prevent.
        for name in [
            "value", "from", "to", "range", "oldest", "youngest", "order", "step",
        ] {
            if !attrs.contains_key(name) {
                continue;
            }
            self.error(
                "TDC264",
                format!("{name}= is not read when the date is measured from of=\"{of}\""),
                &format!(
                    "An offset lands wherever {of} plus the offset lands — {name}= would have to \
                     contradict that to mean anything. Drop it, or drop of= and bound the draw \
                     itself."
                ),
                gen.at(name),
            );
        }

        if !of.is_empty() && !self.declared_order.contains(&of) {
            let hint = if self.declared_order.is_empty() {
                "A date is measured from a column that already exists, so the column it reads \
                 has to come first."
                    .to_string()
            } else {
                format!("Declared above: {}.", self.declared_order.join(", "))
            };
            self.error(
                "TDC240",
                format!("of=\"{of}\" is not a sequence declared above this one"),
                &hint,
                gen.at("of"),
            );
        }
    }

    /// `${{Name}}` written into an attribute that does not read it.
    ///
    /// Interpolation reaches exactly two places: the TEXT inside `<data>`, and
    /// `<gen type="template" value=>`, where a path may be finished by another
    /// column. Everywhere else the braces are eight literal characters — and the
    /// generator that receives them complains about whatever it happens to be
    /// parsing: an invalid number range, an invalid date, a bad quantifier, an
    /// unknown alphabet — while `type="text"` said nothing at all and emitted the
    /// braces. Five messages and one silence for one mistake, none naming it.
    ///
    /// Deliberately blind to WHICH attribute: a list of "attributes that do not
    /// interpolate" would be every attribute but one, and would have to be kept
    /// in step with every generator added later.
    fn check_attr_interpolation(
        &mut self,
        gen: &Element,
        attrs: &Attrs,
        gen_type: Option<&str>,
    ) -> bool {
        let mut found = false;
        let offenders: Vec<String> = attrs
            .keys()
            .filter(|name| attrs.get(name.as_str()).is_some_and(|v| v.contains("${{")))
            // The one place it works: a pack path finished by another column,
            // which is the documented idiom for linked pairs.
            .filter(|name| !(name.as_str() == "value" && gen_type == Some("template")))
            .cloned()
            .collect();
        for name in offenders {
            self.error(
                "TDC263",
                format!("${{{{…}}}} in {name}= is not expanded — the braces are literal text here"),
                "Interpolation reaches the text inside <data> and <gen type=\"template\" value=>, \
                 and nowhere else. To make one column depend on another, read it in an if= \
                 condition, or build the value in a <compute> sequence.",
                gen.at(&name),
            );
            found = true;
        }
        found
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

        // `timeout=` is SECONDS. Left unchecked, the five implementations
        // disagreed twice: four fell back to the default in silence, Python
        // threw at run time — and Python read the attribute as milliseconds,
        // so the documented `timeout="30"` gave up after 30ms.
        if let Some(timeout) = attrs.get("timeout") {
            let ok = timeout
                .trim()
                .parse::<f64>()
                .map(|v| v > 0.0)
                .unwrap_or(false);
            if !ok {
                self.error(
                    "TDC069",
                    format!(
                        "invalid timeout \"{}\" — expected a positive number of seconds",
                        timeout.trim()
                    ),
                    "timeout=\"30\" waits thirty seconds for one answer. Omit it for the default of 30.",
                    gen.at("timeout"),
                );
            }
        }

        // `secret=` is the key a request is signed with. Three spellings, and
        // only the literal is worth saying anything about: a config travels into
        // version control, and the secret would travel with it. A warning rather
        // than an error, because a service on 127.0.0.1 for an afternoon is a
        // real use and refusing it would only teach people to write it somewhere
        // worse.
        if let Some(secret) = attrs.get("secret") {
            let raw = secret.trim();
            if raw.is_empty() {
                self.error(
                    "TDC284",
                    "secret=\"\" has no key to sign with".to_string(),
                    "Name where the key lives: secret=\"env:TDC_HTTP_SECRET\" or \
                     secret=\"file:~/.tdc/service.key\". Remove the attribute to send the \
                     request unsigned.",
                    gen.at("secret"),
                );
            } else if !raw.starts_with("env:") && !raw.starts_with("file:") {
                self.warn(
                    "TDC284",
                    "secret= is written into the config, so it travels wherever the config does"
                        .to_string(),
                    "A config goes into version control and the key goes with it. \
                     secret=\"env:TDC_HTTP_SECRET\" reads it from the environment, \
                     secret=\"file:~/.tdc/service.key\" from a file the repository does not hold.",
                    gen.at("secret"),
                );
            }
        }
    }

    /// A `src=` that names a file nobody can read.
    ///
    /// Checked before the run rather than during it: a missing file discovered
    /// on row one of a million-row job has already cost whatever the job cost.
    /// `missing="p"` and `anomaly="p"`: a probability, and something to spend it on.
    ///
    /// Both were parsed only where they are used, deep in the sequence builder,
    /// so `check` called a config valid and the run then stopped on
    /// `anomaly="10x"`. A check that passes what the very next command refuses is
    /// worse than no check. The generator keeps its own parse as a backstop, for
    /// callers who build a gen through the library without validating.
    ///
    /// The second half is a request that would be honoured and still do nothing.
    /// An anomaly multiplies the selected value by `anomaly_factor`, so a
    /// `value=` list with no number anywhere in it has nothing to perturb and ten
    /// rows come back ordinary with no sign that 30% of them were meant to be
    /// outliers. Only a `type="text"` list is judged: it is the only source whose
    /// whole candidate set is written in the config.
    fn check_imperfections(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        for key in ["anomaly", "missing"] {
            let Some(raw) = trim_to_none(attrs.get(key)) else {
                continue;
            };
            if is_probability(raw) {
                continue;
            }
            self.error(
                "TDC242",
                format!("{key}=\"{raw}\" is not a probability — it must be a number in [0, 1]"),
                if key == "anomaly" {
                    "It is the share of values turned into outliers: anomaly=\"0.05\" spikes \
                     one value in twenty."
                } else {
                    "It is the share of values blanked: missing=\"0.1\" empties one value in ten."
                },
                gen.at(key),
            );
        }

        if gen_type != Some("text") {
            return;
        }
        let Some(raw) = attrs.get("anomaly").map(String::as_str) else {
            return;
        };
        if !is_probability(raw) || raw.parse::<f64>().unwrap_or(0.0) == 0.0 {
            return;
        }
        let Some(listed) = trim_to_none(attrs.get("value")) else {
            return;
        };
        if listed.split(',').any(|piece| is_number(piece.trim())) {
            return;
        }
        self.error(
            "TDC243",
            format!(
                "anomaly=\"{raw}\" has nothing to perturb — no value in \"{listed}\" is a number"
            ),
            "An anomaly multiplies a numeric value by anomaly_factor, so a list of words comes \
             back unchanged. Put the anomaly on a numeric generator, or drop it.",
            gen.at("anomaly"),
        );
    }

    fn check_source(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("file") && gen_type != Some("pattern") {
            return;
        }
        // `y_range=` is the value axis a drawing is brought into, and a drawing
        // has no scale of its own. The generator refuses without it, but a
        // refusal at run time is not enough: a config that passes `check` and
        // then dies is the exact defect this validator exists to close.
        if gen_type == Some("pattern") && trim_to_none(attrs.get("y_range")).is_none() {
            self.error(
                "TDC293",
                "<gen type=\"pattern\"> needs y_range — a drawing has no scale of its own"
                    .to_string(),
                "y_range=\"min..max\" is the value axis the picture is brought into: its floor \
                 is the minimum, its top is the maximum, and nothing leaves the range. Without \
                 it the drawing would be measured against its own ink, so a flat line halfway \
                 up would come out at the floor. Write y_range=\"0..100\" for a percentage \
                 canvas, or the units you actually mean.",
                gen.pos,
            );
        }
        // `src=` is one of three ways to hand a drawing a shape, so its absence
        // is only a mistake when the other two are absent too — the drawing
        // equivalent of a regex with no pattern, which TDC095 and TDC128 have
        // always caught before the run.
        if gen_type == Some("pattern")
            && ["points", "src", "upper"]
                .iter()
                .all(|key| trim_to_none(attrs.get(*key)).is_none())
        {
            self.error(
                "TDC244",
                "<gen type=\"pattern\"> has nothing to draw from".to_string(),
                "Give it a shape: points=\"0,0 1,5 2,3\", src=\"curve.svg\" (or a PNG), or \
                 upper=\"…\" with an optional lower=\"…\" for a band.",
                gen.pos,
            );
            return;
        }
        // `mode=`, `interp=`, `spread=` and `decimals=` — the four drawing attributes whose
        // value is a fixed word or a number. They used to be read only by the generator, so
        // `check` called mode="banana" valid and the run then refused it with a bare sentence
        // and no code. The GENERATOR's own readers are called here rather than their rules
        // repeated: a second copy is a second thing to keep in step, and drifting apart is
        // exactly the failure being closed.
        if gen_type == Some("pattern") {
            // The three that carry a DRAWING go through the same reader the run uses, so a
            // `;` that becomes one curve and points with no width are caught before the run.
            for name in ["points", "upper", "lower", "mode", "interp", "spread", "decimals"] {
                let Some(raw) = attrs.get(name) else { continue };
                let problem = match name {
                    "points" | "upper" | "lower" => crate::pattern::points(raw)
                        .and_then(|pts| crate::pattern::curve::Curve::of(&pts, None, 0, None, crate::pattern::curve::Interp::Linear))
                        .err(),
                    "mode" => crate::pattern::read_mode(raw).err(),
                    "interp" => crate::pattern::read_interp(raw).err(),
                    "spread" => crate::pattern::read_spread(raw).err(),
                    _ => crate::pattern::read_decimals(raw).err(),
                };
                if let Some(err) = problem {
                    self.error(
                        "TDC285",
                        err.to_string(),
                        "Every drawing attribute is checked before the run, so `check` and \
                         the run agree.",
                        gen.at(name),
                    );
                }
            }
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
            // A pack's parameters are open-ended, so the "is this a known name"
            // half cannot run here — but which type reads `order=` does not
            // depend on the pack, and that half is why `order=` and `parent=`
            // sat on a template generator doing nothing.
            let written: Vec<String> = gen.attrs.iter().map(|a| a.name.clone()).collect();
            for name in &written {
                if name == "parent" {
                    self.ignored(
                        gen,
                        name,
                        "parent= selects which rows a whole <sequence> or <mix> builds on; move \
                         it there. A <gen> inside one is already filtered by it.",
                    );
                } else if let Some(owners) = tables::lookup(&tables::ATTRIBUTE_OWNERS, name)
                    .filter(|_| tables::RESERVED_TEMPLATE_ATTRS.contains(&name.as_str()))
                {
                    // A name the pack may claim is the pack's business, and the
                    // pack-parameter check judges it with the registry in hand.
                    // The line is drawn by what the ENGINE reads before the pack
                    // runs; everything else is handed to the pack as an override.
                    if !owners.contains(&"template") {
                        let belongs = owners
                            .iter()
                            .map(|t| format!("type=\"{t}\""))
                            .collect::<Vec<_>>()
                            .join(", ");
                        self.ignored(
                            gen,
                            name,
                            &format!(
                                "\"{name}\" belongs to {belongs} — a type=\"template\" \
                                 generator ignores it."
                            ),
                        );
                    }
                }
            }
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

            // `cycle` says what happens when a WALK runs out. Without a walk
            // there is nothing to run out of: the generator draws, and a draw
            // never ends.
            if name == "cycle" && attrs.get("order").map(|v| v.trim()) != Some("sequential") {
                self.ignored(
                    gen,
                    name,
                    "cycle= says what happens when order=\"sequential\" reaches the end of its \
                     source. Without order=\"sequential\" the generator draws, and a draw never \
                     runs out.",
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

            // A wrapper the type never puts its value through. Separate from the
            // ownership table because the name IS a general wrapper — it works
            // on almost every type, and these two resolve before the layer that
            // applies it.
            if let Some(t) = gen_type {
                if tables::lookup(&tables::WRAPPERS_NOT_READ, t)
                    .is_some_and(|names| names.contains(&name.as_str()))
                {
                    self.ignored(
                        gen,
                        name,
                        &format!(
                            "a type=\"{t}\" generator publishes its number as it stands — the \
                             formatting layer does not run for it. Apply it where the value is \
                             printed instead: ${{{{Total|mask:x}}}}, ${{{{Total|upper}}}}."
                        ),
                    );
                    continue;
                }
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
            if self.check_pack_params(gen, attrs, &path) {
                return;
            }
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

    /// Attributes on a template `<gen>` that the target pack CAN act on.
    ///
    /// A pack whose body declares `<sequence name="domain">` accepts
    /// `domain="…"` from the caller, and the engine replaces that sequence with
    /// the constant. So the attribute is neither a typo nor ignored — refusing
    /// it, as this used to, made a config that runs in the reference fail here.
    ///
    /// Returns false — leaving the ordinary check to run — when nothing is known
    /// about the pack: an unresolvable address, or no registry at all. Guessing
    /// there would produce exactly the false errors this must not create.
    fn check_pack_params(&mut self, gen: &Element, attrs: &Attrs, path: &str) -> bool {
        if path.is_empty() {
            return false;
        }
        let locale = self.locale.clone();
        let Some(packs) = self.packs.as_ref() else {
            return false;
        };
        let Some(declared) = packs.parameter_names(path, &locale) else {
            return false;
        };

        let widths = packs.parameter_widths(path, &locale);

        // A parameter the pack DOES accept, pinned to a value of the wrong width.
        //
        // The packs that carry a check digit compute it over a fixed layout, so a
        // wrong-width value does not shift the layout — it breaks it. Measured on
        // `usa.finance.aba_routing`, whose own `prefix` is 2 characters:
        // `prefix="12345"` aborted the run with `<at>: index 8 is out of range`,
        // naming no file, line or code, and `tail="678"` said nothing at all and
        // wrote a six-digit number that is not a routing number. `check` passed on
        // both. Only reported where the width is a FACT read off the pack's own body.
        let mismatched: Vec<(String, usize, usize)> = attrs
            .iter()
            .filter_map(|(name, value)| {
                let want = *widths.get(name.as_str())?;
                let got = value.chars().count();
                (got != want).then_some((name.clone(), got, want))
            })
            .collect();

        for (name, got, want) in mismatched {
            let at = gen.at(&name);
            self.error(
                "TDC276",
                format!(
                    "\"{name}\" is pinned to {got} characters, and \"{path}\" builds its \
                     value around a {name}= of exactly {want}"
                ),
                &format!(
                    "A pinned parameter replaces the pack's own value, and this pack has a \
                     fixed layout — a check digit is computed over the whole of it. Use a \
                     {name}= of {want} characters, or drop it and let the pack draw its own."
                ),
                at,
            );
        }

        let offenders: Vec<(String, String)> = attrs
            .iter()
            .filter(|(name, _)| {
                // `parent`, `count` and `flag` may sit on a <gen> and are each reported
                // by their own rule; a pack-parameter check must not read them as typos.
                !tables::PACK_WRAPPER_ATTRS.contains(&name.as_str())
                    && !declared.contains(*name)
                    && !matches!(name.as_str(), "parent" | "count" | "flag")
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect();

        for (name, value) in offenders {
            let hint = if declared.is_empty() {
                format!(
                    "This generator takes no parameters — it produces a fixed shape. \
                     Value passed: \"{value}\"."
                )
            } else {
                let names: Vec<&str> = declared.iter().map(String::as_str).collect();
                format!("Parameters of this generator: {}.", names.join(", "))
            };
            let at = gen.at(&name);
            self.error(
                "TDC072",
                format!("\"{name}\" is not a parameter of \"{path}\" — it would be ignored"),
                &hint,
                at,
            );
        }
        true
    }

    fn ignored(&mut self, gen: &Element, name: &str, why: &str) {
        self.error(
            "TDC015",
            format!("<gen> has no \"{name}\" attribute"),
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

    /// Every column an expression-valued distribution parameter names must be declared
    /// ABOVE it.
    ///
    /// The same rule `formula`, `running` and `of=` follow, and for a sharper reason than
    /// a typo: a FORWARD reference makes the two engines disagree — the streaming registry
    /// answers it and the in-memory one does not — so one config would mean two datasets.
    /// TDC240 is shared with them on purpose; it is the same complaint about the same
    /// thing.
    fn check_param_names(&mut self, gen: &Element, param: &str, source: &str) {
        // The little language itself. The name loop below is about which COLUMNS a parameter
        // reads and says nothing about whether the expression is one the evaluator can run.
        let article = if param.starts_with(['a', 'e', 'i', 'o', 'u']) { "an" } else { "a" };
        let kind = if param == "expr" { "expression" } else { "parameter" };
        self.check_expression_at(source, gen.at(param), &format!("{param}= {kind}"), article);

        let Ok(parsed) = expr::parse(source) else {
            return; // Not an expression at all — TDC089 reports it.
        };
        let mut names = std::collections::BTreeSet::new();
        collect_identifiers(&parsed, &mut names);
        for name in names {
            if is_builtin(&name) || self.declared_order.contains(&name) {
                continue;
            }
            let hint = if self.declared_order.is_empty() {
                "A parameter reads a column that already exists, so the column it reads has \
                 to come first."
                    .to_string()
            } else {
                format!("Declared above: {}.", self.declared_order.join(", "))
            };
            self.error(
                "TDC240",
                format!("\"{name}\" in {param}= is not a sequence declared above this one"),
                &hint,
                gen.at(param),
            );
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
            // A parameter written as an EXPRESSION is resolved per row against the other
            // columns, so its VALUE is not knowable here. Stand a plausible number in its
            // place and check everything else — the distribution's name, the parameters
            // it requires, the attributes it refuses — so writing `lambda="Traffic * 0.5"`
            // does not buy silence about the rest of the generator.
            //
            // `1` is the stand-in because every parameter of every distribution accepts
            // it: the positive ones are happy, the unbounded ones do not care. A parameter
            // that resolves to something the distribution rejects — a negative `sd` — is
            // caught by the run, where the value finally exists, with this same message.
            let dynamic = dist_params::expression_params(attrs);
            for name in &dynamic {
                self.check_param_names(gen, name, attrs.get(*name).map_or("", String::as_str));
            }
            let mut for_check = attrs.clone();
            for name in &dynamic {
                for_check.insert((*name).to_string(), "1".to_string());
            }
            // The distribution's own parameters: a shape nobody can draw from is
            // an error before the run, not a surprise on the first row.
            if let Err(e) = distribution::parse(&for_check) {
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

        // A blank value= is a written attribute, not an absent one. Skipping it here let the
        // generator fall back to its default range and invent numbers for a config that had
        // named none: value="" produced 4 2 8 while the reference refused the same file.
        let value = attrs.get("value").map(String::as_str);
        if let Some(value) = value {
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

        let has_include = attrs.get("include").is_some_and(|v| !v.trim().is_empty());
        let has_exclude = attrs.get("exclude").is_some_and(|v| !v.trim().is_empty());
        let has_modifier = has_include || has_exclude;
        // `include`/`exclude` turn the draw into a pick from an explicit set of
        // WHOLE numbers, so a fractional value can never be in it: `decimals`
        // described a draw that is no longer happening. The engine dropped it
        // and emitted integers, and a config asking for 7.71 got 8 in silence.
        let decimals = attrs.get("decimals").map(|v| v.trim()).unwrap_or("");
        if has_modifier && !decimals.is_empty() && decimals != "0" {
            let which = if has_include && has_exclude {
                "include/exclude"
            } else if has_include {
                "include"
            } else {
                "exclude"
            };
            self.error(
                "TDC255",
                format!("decimals=\"{decimals}\" cannot be combined with {which}"),
                "include= and exclude= build a set of whole numbers and pick one uniformly, so \
                 there are no fractional values to round. Drop decimals=, or bound the range \
                 with value= instead of a set.",
                gen.at("decimals"),
            );
        }
        if has_modifier && blank(value) {
            self.error(
                "TDC087",
                "<gen type=\"number\"> include/exclude require a numeric range in \"value\""
                    .to_string(),
                "Add a range first, e.g. value=\"0..9\" exclude=\"3\".",
                gen.pos,
            );
        }
        self.check_decimals_reach_something(gen, attrs);
        self.check_first_zero_is_reachable(gen, attrs);
    }

    /// `decimals=` only describes a draw that HAS a fractional part.
    ///
    /// Two shapes reached the generator and were dropped there:
    ///
    /// ```text
    /// <gen type="number" length="4" decimals="2"/>               -> 4566
    /// <gen type="number" value="1..9" length="3" decimals="2"/>  -> 3.78
    /// ```
    ///
    /// The first has no range, so the generator produces a digit STRING — an
    /// identifier — and there is nothing to round. The second has one, so
    /// `decimals` wins and `length` is discarded instead: a fractional value
    /// has no integer width to pad to.
    fn check_decimals_reach_something(&mut self, gen: &Element, attrs: &Attrs) {
        let decimals = attrs.get("decimals").map(|s| s.trim()).unwrap_or("");
        if decimals.is_empty() || decimals == "0" {
            return;
        }
        let value = attrs.get("value").map(|s| s.trim()).unwrap_or("");
        if value.is_empty() {
            self.error(
                "TDC277",
                format!(
                    "decimals=\"{decimals}\" has nothing to round — without value= this \
                     generator produces a digit string"
                ),
                "Give it a range to draw from: value=\"0..100\" decimals=\"2\". A number with \
                 only length= is an identifier of that many digits, and an identifier has no \
                 decimal places.",
                gen.at("decimals"),
            );
            return;
        }
        let length = attrs.get("length").map(|s| s.trim()).unwrap_or("");
        if !length.is_empty() {
            self.error(
                "TDC278",
                format!(
                    "length=\"{length}\" is not read beside decimals=\"{decimals}\" — a \
                     fractional value has no integer width to pad"
                ),
                "Keep one of them: decimals= for a fractional value over the range, or length= \
                 for a whole number padded to a fixed width.",
                gen.at("length"),
            );
        }
    }

    /// `first_zero="false"` the range can never satisfy.
    ///
    /// A drawn value is padded to `length` with zeros, so it avoids a leading
    /// one only by being wide enough on its own. When the range's largest value
    /// has fewer digits than the width, EVERY draw needs padding — and the
    /// generator answered by redrawing a hundred times and emitting the
    /// forbidden shape anyway.
    fn check_first_zero_is_reachable(&mut self, gen: &Element, attrs: &Attrs) {
        if attrs.get("first_zero").map(|s| s.trim()) != Some("false") {
            return;
        }
        let value = attrs
            .get("value")
            .map(|s| s.trim())
            .unwrap_or("")
            .to_string();
        let length = attrs.get("length").map(|s| s.trim()).unwrap_or("");
        if value.is_empty() || length.is_empty() {
            return;
        }
        // A malformed range or length is already reported above.
        let (Ok(choices), Ok(ranges)) = (
            crate::generators::number::parse_length_choices(length),
            crate::generators::number::parse_ranges(&value),
        ) else {
            return;
        };
        let Some(biggest) = ranges.iter().map(|r| r.max).max() else {
            return;
        };
        // A value renders without a leading zero at width W only if it has at
        // least W digits of its own, which needs max >= 10^(W-1).
        let unreachable: Vec<i64> = choices
            .iter()
            .flat_map(|c| i64::from(c.min)..=i64::from(c.max))
            .filter(|&w| w > 1 && (biggest as f64) < 10f64.powi(w as i32 - 1))
            .collect();
        let Some(&smallest) = unreachable.iter().min() else {
            return;
        };
        let digits = if unreachable.len() == 1 {
            format!("{} digits", unreachable[0])
        } else {
            format!("{smallest} digits")
        };
        let low = 10i64.pow(u32::try_from(smallest - 1).unwrap_or(0));
        let high = 10i64.pow(u32::try_from(smallest).unwrap_or(1)) - 1;
        self.error(
            "TDC279",
            format!(
                "first_zero=\"false\" cannot be honoured — no value in \"{value}\" reaches \
                 {digits}, so every draw has to be padded"
            ),
            &format!(
                "The widest value the range offers is {biggest}. Widen the range — \
                 value=\"{low}..{high}\" — or drop length=, or allow the zero."
            ),
            gen.at("first_zero"),
        );
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

    /// `step=` on a walked date axis: what it may say, and that anything reads it.
    /// `plus=` on a date that is not measured from anything.
    ///
    /// `plus=` belongs to the offset and nothing else reads it, so a lone `plus="3d"`
    /// was dropped in silence and the column came out as ordinary drawn dates. "Shift
    /// this column by three days" is the natural misreading of it — and this generator
    /// already refuses `step=` and `weekdays=` on a drawn date for exactly that reason.
    fn check_date_plus_without_of(&mut self, gen: &Element, attrs: &Attrs) {
        if attrs.get("plus").is_none() {
            return;
        }
        self.error(
            "TDC264",
            "<gen type=\"date\" plus=\"…\"> does not say what it is measured from".to_string(),
            "Add of=\"Name\" to measure from another date column — plus= is how far from it, \
             and on its own there is nothing to be far from. To move every drawn date, move \
             the range.",
            gen.at("plus"),
        );
    }

    fn check_date_step(&mut self, gen: &Element, attrs: &Attrs) {
        let Some(raw) = attrs.get("step") else {
            return;
        };
        let raw = raw.trim();
        match date::calendar::parse_step(Some(raw)) {
            Err(reason) => {
                // The two failures read differently because they ARE different:
                // one is a spelling nobody meant, the other a step whose meaning
                // would depend on which half was applied first.
                let mixed = reason == date::calendar::StepError::Mixed;
                self.error(
                    "TDC247",
                    if mixed {
                        format!("step=\"{raw}\" mixes a calendar unit with a fixed one")
                    } else {
                        format!("step=\"{raw}\" is not a step this engine can walk")
                    },
                    &if mixed {
                        "A month is 28 to 31 days, so \"one month and fifteen days\" depends on \
                         which is applied first. Write one or the other: 45d, or 1mo."
                            .to_string()
                    } else {
                        format!(
                            "Write {}. A bare number means days, so step=\"2\" is every other day.",
                            date::calendar::STEP_SYNTAX
                        )
                    },
                    gen.at("step"),
                );
            }
            Ok(_) => {
                if attrs.get("order").map(|o| o.trim()) != Some("sequential") {
                    self.error(
                        "TDC248",
                        format!(
                            "step=\"{raw}\" has no order=\"sequential\" on the same <gen> — \
                             nothing walks the range"
                        ),
                        "Add order=\"sequential\" to walk the range one step at a time, or remove \
                         step= and let the dates be drawn at random.",
                        gen.at("step"),
                    );
                }
            }
        }
    }

    /// `weekdays="mon..fri"` — which weekdays a walked axis keeps.
    ///
    /// A FILTER, not a step: the spacing stops being even, since Friday to Monday
    /// is a three-day jump. That is why it is a separate attribute — one word for
    /// both operations would stop them being combinable, and "every 15 minutes,
    /// but only on working days" is exactly what gets asked for.
    fn check_date_weekdays(&mut self, gen: &Element, attrs: &Attrs) {
        let Some(raw) = attrs.get("weekdays") else {
            return;
        };
        let raw = raw.trim();
        if date::calendar::parse_weekdays(Some(raw)).is_none() {
            self.error(
                "TDC249",
                format!("unknown weekday in weekdays=\"{raw}\""),
                &format!(
                    "Names are {} — a span like \"mon..fri\" or a list like \"sun,wed\".",
                    date::calendar::weekday_names()
                ),
                gen.at("weekdays"),
            );
            return;
        }

        if attrs.get("order").map(|o| o.trim()) != Some("sequential") {
            self.error(
                "TDC248",
                format!(
                    "weekdays=\"{raw}\" has no order=\"sequential\" on the same <gen> — nothing \
                     walks the range"
                ),
                "Add order=\"sequential\" to walk the range and keep only these days, or remove \
                 weekdays= and let the dates be drawn at random.",
                gen.at("weekdays"),
            );
            return;
        }

        if let Ok(step) = date::calendar::parse_step(attrs.get("step").map(String::as_str)) {
            if date::calendar::fixes_weekday(step) {
                // Two different reasons wear one code, and they must not wear one
                // sentence.
                //
                // A whole number of weeks really does land on the same weekday every
                // time, so the filter matches every row or none. Measured on the STEP
                // rather than on its spelling, so `14d` is caught as surely as `2w`.
                //
                // A CALENDAR step does not: 15 January 2026 is a Thursday, 15 February
                // a Sunday, 15 March a Sunday, 15 April a Wednesday. The combination is
                // still refused — a month holds a different number of days each time —
                // but for its own reason.
                let written = attrs.get("step").map(|v| v.trim()).unwrap_or("");
                let whole_weeks = step.months == 0;
                self.error(
                    "TDC250",
                    if whole_weeks {
                        format!(
                            "weekdays=\"{raw}\" cannot narrow step=\"{written}\" — that step \
                             already fixes the weekday"
                        )
                    } else {
                        format!(
                            "weekdays=\"{raw}\" cannot narrow step=\"{written}\" — a calendar \
                             step is not measured in days"
                        )
                    },
                    if whole_weeks {
                        "A whole number of weeks lands on the same weekday every time, so this \
                         would match every row or none. Use a step that is not a multiple of a \
                         week, or drop weekdays=."
                    } else {
                        "A month and a year hold a different number of days each time, so which \
                         rows survive the filter follows the calendar rather than anything \
                         written here. Use a step measured in days or hours, or drop weekdays=."
                    },
                    gen.at("weekdays"),
                );
            }
        }
    }

    /// `peak_at=` — which row the seasonal wave is highest on.
    ///
    /// A wave is `amplitude·cos(2π·(i − peak)/period)`, so `peak_at` names the
    /// row it peaks on. Without it the peak sits a quarter period in, which is
    /// where a plain sine already peaked — and for a year of daily rows that is
    /// early April, the one season nobody means by "warmer in summer".
    ///
    /// It is a ROW, not a shift: 182 of 365 is the first of July, and `period`
    /// is already counted in rows.
    /// `repeat=` together with `order="sequential"`.
    ///
    /// Well defined apart, undefined together — and the engines proved it by
    /// disagreeing: engine 1 gave the row several elements that were all the
    /// SAME value and never advanced, engines 2 and 3 dropped the repeat list
    /// and emitted one walking value. `check` called that valid, so the author
    /// got data that looks plausible and is wrong differently per engine.
    fn check_sequential_repeat(&mut self, gen: &Element, attrs: &Attrs) {
        if attrs.get("order").map(|v| v.trim()) != Some("sequential") {
            return;
        }
        let Some(repeat) = attrs.get("repeat").map(|v| v.trim().to_string()) else {
            return;
        };
        if repeat.is_empty() {
            return;
        }
        // Point at `repeat=`: a walked column is what the author asked for and can keep.
        self.error(
            "TDC254",
            format!("repeat=\"{repeat}\" cannot be combined with order=\"sequential\""),
            "A walked list and a repeating list are two different columns, and together they \
             have no one answer — the engines disagree about what they produce. Keep \
             order=\"sequential\" for a column that walks its source one value per row, or keep \
             repeat= for several drawn values per row.",
            gen.at("repeat"),
        );
    }

    fn check_timeseries(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("timeseries") {
            return;
        }
        let Some(raw) = attrs.get("peak_at").map(|v| v.trim().to_string()) else {
            return;
        };

        if raw.parse::<f64>().is_err() {
            self.error(
                "TDC252",
                format!("peak_at=\"{raw}\" is not a number"),
                "peak_at is the row the seasonal wave peaks on, counted like period= — \
                 peak_at=\"182\" over period=\"365\" puts the peak at the first of July.",
                gen.at("peak_at"),
            );
            return;
        }

        // A wave needs a length before it can have a highest point. Without
        // `period` there is no wave at all, so `peak_at` would be read by nobody.
        let period = attrs
            .get("period")
            .and_then(|p| p.trim().parse::<f64>().ok())
            .unwrap_or(0.0);
        if period <= 0.0 {
            self.error(
                "TDC253",
                format!(
                    "peak_at=\"{raw}\" has no period= on the same <gen> — there is no wave to \
                     place a peak on"
                ),
                "Add period= (the length of one season, in rows), or remove peak_at=.",
                gen.at("peak_at"),
            );
        }
    }

    fn check_date(&mut self, gen: &Element, attrs: &Attrs, gen_type: Option<&str>) {
        if gen_type != Some("date") {
            return;
        }
        // `of=` makes this an OFFSET rather than a draw: a different set of
        // attributes configures it, and a different set of mistakes is possible.
        // Its own checks REPLACE the ones below rather than joining them —
        // everything here is about how a draw is bounded, so it would be a second
        // complaint about the same attribute, naming a rule that no longer
        // applies to it.
        if !attrs.get("of").map(|s| s.trim()).unwrap_or("").is_empty() {
            self.check_date_offset(gen, attrs);
            return;
        }

        // `from=` alone is an OPEN axis when the range is WALKED: the end of such
        // an axis is start + count x step, a consequence rather than an input. On
        // a DRAWN date one end genuinely means nothing, and that is what this
        // refuses.
        let walked = attrs.get("order").map(|o| o.trim()) == Some("sequential");
        let open_axis = walked && attrs.contains_key("from") && !attrs.contains_key("to");
        if !open_axis && attrs.contains_key("from") != attrs.contains_key("to") {
            self.error(
                "TDC150",
                "<gen type=\"date\"> requires both \"from\" and \"to\" when either is used"
                    .to_string(),
                "Use from=\"2020-01-01\" to=\"2025-12-31\", or value=\"2020-01-01..2025-12-31\".",
                gen.pos,
            );
        }

        self.check_date_plus_without_of(gen, attrs);
        self.check_date_step(gen, attrs);
        self.check_date_weekdays(gen, attrs);

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

        self.check_env_locale_has_dates(gen, attrs);
        self.check_date_common_attrs(gen, attrs);
        self.check_date_values(gen, attrs);
        self.check_one_date_spelling(gen, attrs);
        self.check_date_range_not_reversed(gen, attrs);
    }

    /// `<env local="af">` with a date the run will render in ENGLISH.
    ///
    /// The same value is refused outright on `<gen type="date" local="af">`
    /// (TDC153) and was silently downgraded here. Refusing it on `<env local=>`
    /// would be wrong — a locale can be a perfectly good source of NAMES and
    /// still ship no month names, and refusing would forbid the Afrikaans name
    /// pack because Afrikaans dates are missing.
    ///
    /// So this warns, and only when the format actually reads the locale.
    /// `YYYY-MM-DD` is the same in every language and says nothing; a missing
    /// `format=` does, because the default `L` is a layout the locale chooses.
    /// Bracketed text is stripped first: `[LL]` is a literal, not a token.
    fn check_env_locale_has_dates(&mut self, gen: &Element, attrs: &Attrs) {
        if self.locale.is_empty() || date::locales::is_known(&self.locale) {
            return;
        }
        if attrs.get("local").is_some() {
            return; // its own local= is TDC153's business
        }
        if let Some(format) = attrs.get("format").filter(|f| !f.trim().is_empty()) {
            let mut outside = String::new();
            let mut inside = false;
            for ch in format.chars() {
                match ch {
                    '[' => inside = true,
                    ']' => inside = false,
                    c if !inside => outside.push(c),
                    _ => {}
                }
            }
            let reads_locale = ["MMMM", "MMM", "dddd", "ddd", "L"]
                .iter()
                .any(|t| outside.contains(t));
            if !reads_locale {
                return;
            }
        }
        let locale = self.locale.clone();
        self.warn(
            "TDC272",
            format!(
                "<env local=\"{locale}\"> ships no date translations, so this date renders in \
                 English"
            ),
            &format!(
                "Date locales: {}. Use format=\"YYYY-MM-DD\" \u{2014} or any format without \
                 month or weekday names \u{2014} to get the same text in every language, or \
                 accept the English month names.",
                date::locales::NAMES.join(", ")
            ),
            gen.pos,
        );
    }

    /// The dates themselves parse.
    ///
    /// Without this a `from="notadate"` reached the generator and failed there,
    /// which is a crash at render time instead of a diagnostic at validation
    /// time — and the reference reports it here.
    /// One spelling of the range, not two.
    ///
    /// `value=`, the `from`/`to` pair and `range=` are three ways to say the
    /// same thing, and the generator reads them in that order and stops.
    /// Writing two put one of them in the file and did nothing with the other,
    /// without a word:
    ///
    /// ```text
    /// value="2020-05-05" from="1990-01-01" to="1990-12-31"   ->  1990-05-11
    /// value="today" from="1990-01-01" to="1990-12-31"        ->  2026-08-08
    /// ```
    fn check_one_date_spelling(&mut self, gen: &Element, attrs: &Attrs) {
        let mut spellings: Vec<&str> = Vec::new();
        if attrs.get("value").map(|v| !v.trim().is_empty()) == Some(true) {
            spellings.push("value=");
        }
        if attrs.get("from").is_some() || attrs.get("to").is_some() {
            spellings.push("from=/to=");
        }
        if attrs.get("range").is_some() {
            spellings.push("range=");
        }
        if spellings.len() < 2 {
            return;
        }
        let listed = format!(
            "{} and {}",
            spellings[..spellings.len() - 1].join(", "),
            spellings[spellings.len() - 1]
        );
        let count = if spellings.len() == 2 {
            "two spellings"
        } else {
            "three spellings"
        };
        self.error(
            "TDC280",
            format!(
                "<gen type=\"date\"> carries {listed} — they are {count} of the same range, and only the first is read"
            ),
            "Keep one: value=\"2020-01-01..2025-12-31\", or from=\"2020-01-01\" to=\"2025-12-31\", or range=\"2020-01-01..2025-12-31\". value=\"today\", \"now\" and \"birth\" are spellings too, so they cannot carry a from/to either.",
            gen.pos,
        );
    }

    /// A range whose end is before its start, refused rather than swapped.
    ///
    /// The draw took `min` and `max` of the two ends, so `from="2020-01-01"
    /// to="2010-01-01"` produced perfectly plausible dates from the range the
    /// author did NOT write. The date page already states the rule for `plus=`:
    /// write the smaller bound first, and a typo is refused rather than quietly
    /// swapped.
    fn check_date_range_not_reversed(&mut self, gen: &Element, attrs: &Attrs) {
        let mut pairs: Vec<(String, String, &str)> = vec![(
            attrs
                .get("from")
                .map(|v| v.trim())
                .unwrap_or("")
                .to_string(),
            attrs.get("to").map(|v| v.trim()).unwrap_or("").to_string(),
            "to",
        )];
        let raw = attrs
            .get("range")
            .or_else(|| attrs.get("value"))
            .map(|v| v.trim())
            .unwrap_or("")
            .to_string();
        if let Some(dots) = raw.find("..") {
            if dots > 0 {
                let where_ = if attrs.get("range").is_some() {
                    "range"
                } else {
                    "value"
                };
                pairs.push((raw[..dots].to_string(), raw[dots + 2..].to_string(), where_));
            }
        }
        for (start_raw, end_raw, where_) in pairs {
            if start_raw.is_empty() || end_raw.is_empty() {
                continue;
            }
            // Already reported by the value checks above when unparseable.
            let (Ok(start), Ok(end)) = (
                date::parse::date_time(&start_raw),
                date::parse::date_time(&end_raw),
            ) else {
                continue;
            };
            if date::to_epoch_millis(start.value) <= date::to_epoch_millis(end.value) {
                continue;
            }
            self.error(
                "TDC281",
                format!(
                    "the range ends before it starts — \"{end_raw}\" is earlier than \"{start_raw}\""
                ),
                &format!(
                    "Write the smaller bound first: \"{end_raw}\"..\"{start_raw}\". A reversed range used to be swapped silently, which meant drawing from a range nobody wrote."
                ),
                gen.at(where_),
            );
        }
    }

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
        self.check_distinct(gen, attrs, repeats, gen_type);

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

    /// `distinct="true"` — the row's values are drawn without replacement.
    ///
    /// Four refusals, and each one is a proof rather than a guess. They exist because the
    /// alternative in every case is a config that says something and silently gets
    /// something else.
    fn check_distinct(
        &mut self,
        gen: &Element,
        attrs: &Attrs,
        repeats: bool,
        gen_type: Option<&str>,
    ) {
        let Some(raw) = attrs.get("distinct") else {
            return;
        };
        let word = raw.trim();
        if word != "true" && word != "false" {
            self.error(
                "TDC289",
                format!("\"distinct\" takes true or false, not \"{word}\""),
                "distinct=\"true\" draws a repeat list without replacement. Omit it, or write \
                 distinct=\"false\".",
                gen.at("distinct"),
            );
            return;
        }
        if word == "false" {
            return;
        }

        // One value cannot repeat itself, so the attribute would be read and then do
        // nothing — the accepted-and-ignored failure this project keeps closing.
        if !repeats {
            self.error(
                "TDC290",
                "\"distinct\" has no effect without \"repeat\"".to_string(),
                "distinct= stops one cell holding the same value twice, so there has to be a \
                 list. Add repeat=\"N\" or repeat=\"A..B\", or drop distinct=.",
                gen.at("distinct"),
            );
            return;
        }

        // `percent` is an EXACT quota over the whole run; `distinct` is a guarantee inside
        // one row. Holding both would cost either streaming or the randomness of the
        // sample, so the pair is refused.
        if attrs.contains_key("percent") {
            self.error(
                "TDC291",
                "\"percent\" and \"distinct\" cannot both be on one <gen>".to_string(),
                "percent= promises exact proportions across the whole run; distinct= trades \
                 that promise away for a guarantee inside each row, so the two cannot both \
                 hold. Drop one — or put the proportions on a <mix> or <switch> outside, with \
                 repeat= on the <gen> inside.",
                gen.at("percent"),
            );
        }

        // The pool is only knowable up front for the types that carry it in the config.
        // Where it is not — a pack file, a regex — the same refusal fires at run time.
        let Some(pool) = distinct_pool_size(gen_type, attrs) else {
            return;
        };
        let Ok(Some(spec)) = repeat::parse(attrs) else {
            return; // A malformed repeat= is already reported as TDC195.
        };
        let longest = spec.max as usize;
        if longest > pool {
            self.error(
                "TDC292",
                format!(
                    "\"repeat\" asks for up to {longest} different values, but the list holds only {pool}"
                ),
                &format!(
                    "With distinct=\"true\" a value cannot be used twice in one cell, so {longest} of them cannot be found. Lower repeat=, or widen value=."
                ),
                gen.at("repeat"),
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
            if child.name == "gen" {
                self.check_case_gen(child);
            }
            match child.kind {
                Kind::Data | Kind::SelfClosing => continue,
                Kind::Map => {}
                Kind::OpenClose => {}
            }
            if child.name == "mix" {
                self.check_mix(child, false);
                continue;
            }
            if child.name == "switch" {
                // A `<switch>` inside a `<case>` looks its subject up over the rows of that
                // branch. Held to every rule the env-level form is, except that it has no name.
                let declared = self.declared_order.clone();
                self.check_switch_form(child, &declared, false);
                continue;
            }
            if child.name == "gen" {
                continue;
            }
            self.error(
                "TDC125",
                format!("unknown child of <case>: \"<{}>\"", child.name),
                "Allowed children: data, gen, mix, switch.",
                child.pos,
            );
        }
    }

    /// A `<gen>` written inside a `<case>`.
    ///
    /// `anomaly_flag="NAME"` mints a ground-truth column beside a sequence's value.
    /// A case body is a CONCATENATION of parts, so a flag written on one part
    /// describes that part rather than the row, and there is no honest column to
    /// mint. `<mix flag="NAME">` asks the same question where it has an answer.
    /// Until this check the attribute was accepted here and did nothing, and the
    /// only sign was `${{NAME}}` reaching the data as literal characters.
    /// A fixture holds text and `<line>`s. Anything else was ignored in silence
    /// unless it happened to be a generator inside a `<line>`.
    fn check_fixture_children(&mut self, fixture: &Element) {
        let f = fixture.clone();
        let tag = fixture.name.clone();
        self.check_contained(&f, &tag, "TDC131", &tables::FIXTURE_CHILDREN);
    }

    fn check_case_gen(&mut self, gen: &Element) {
        // `if=` on a `<gen>` inside a `<case>` — accepted by the grammar, read by
        // nothing. A case body is several parts JOINED into one value, so a
        // condition on one part has no answer to give: if it were false, the part
        // would have to become something, and there is no honest candidate. The
        // branch already carries its own condition. It used to be accepted and
        // ignored, so the value appeared on EVERY row.
        if gen.attr_value("if").is_some() {
            self.error(
                "TDC269",
                "if= is not read on a <gen> inside a <case>: a case body is several parts \
                 joined, so a condition on one part has no value to fall back to"
                    .to_string(),
                "Put the condition on the branch \u{2014} <case if=\"\u{2026}\"> \u{2014} or \
                 move the <gen> into a <sequence> of its own, where a false condition falls \
                 through to the next <gen>.",
                gen.at("if"),
            );
        }
        let Some(flag) = gen.attr_value("anomaly_flag").map(str::trim) else {
            return;
        };
        self.error(
            "TDC246",
            format!("anomaly_flag=\"{flag}\" is not read on a <gen> inside a <case>"),
            "A case body is several parts joined, so a flag on one part does not describe the \
             row. Put flag=\"NAME\" on the <mix> instead, or move the <gen> into a <sequence> \
             of its own.",
            gen.at("anomaly_flag"),
        );
    }

    fn check_switch(&mut self, open: &Element, declared: &[String]) {
        self.check_switch_form(open, declared, true);
    }

    /// `named` is false for the form written inside a `<case>`: it contributes a value to that
    /// branch rather than a column of its own, so it has no name to declare and nothing can
    /// interpolate it. Every other rule is the same, from this one function.
    fn check_switch_form(&mut self, open: &Element, declared: &[String], named: bool) {
        if !named && open.attr_value("name").is_some() {
            self.error(
                "TDC245",
                "\"name\" on a nested <switch> is not supported — only an env-level <switch> \
                 becomes a column"
                    .to_string(),
                "A nested <switch> contributes its value to the <case> around it. Nothing can \
                 interpolate it, so a name would name nothing. Move it to <env> if you want \
                 ${{Name}}.",
                open.at("name"),
            );
        }
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
        let mut unknown: Vec<(String, Pos)> = Vec::new();
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
                    self.check_case_body(child);
                }
                (Kind::OpenClose, "default") => {
                    entries += 1;
                    self.check_case_body(child);
                }
                (_, "comment") | (Kind::Data, _) => {}
                _ => {
                    // The catch-all used to be empty, so an invented tag here
                    // passed without a word — self-closing or not.
                    unknown.push((child.name.clone(), child.pos));
                }
            }
        }
        for (name, pos) in unknown {
            self.unknown_child("switch", &name, "TDC124", &tables::SWITCH_CHILDREN, pos);
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
        // These two were missed when the other containers were closed: an invented
        // tag in either passed in silence while the same tag one level up did not.
        // The brief report put the implementations side by side and the gap showed.
        let b = block.clone();
        self.check_contained(&b, "block", "TDC013", &tables::BLOCK_CHILDREN);
        for child in &block.children {
            if child.kind == Kind::OpenClose && child.name == "line" {
                let l = child.clone();
                self.check_contained(&l, "line", "TDC013", &tables::LINE_CHILDREN);
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
        let mut line_condition = line.attr_value("if").map(str::to_string);

        // `if=` sits on the <line> as well as on each <data> inside it, and an
        // unparsable one has to be caught in both places or a whole line silently
        // never renders.
        if let Some(condition) = line.attr_value("if").map(str::to_string) {
            self.check_if_expression(&condition, line.at("if"));
            self.defer_expression(condition.clone(), line.at("if"), walks_a_list);
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
            if is_gen(child) {
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
                // The same rule one level up: a conditional <line> holding a typed column. The
                // column is collected once per card either way, so the condition is dropped.
                if line_condition.is_some() {
                    if let Some(column) = child.attr_value("name").map(str::trim) {
                        if !column.is_empty() {
                            self.error(
                                "TDC209",
                                format!(
                                    "<line if=\"\u{2026}\"> holds the typed column <data \
                                     name=\"{column}\">, so the condition cannot be honoured"
                                ),
                                "A column has one cell per card, collected whether or not the \
                                 line was rendered \u{2014} the condition would be dropped and \
                                 the typed file would disagree with the text one. Put the \
                                 condition on the sequence instead (<gen if=\u{2026}>) and \
                                 declare the column nullable: an empty cell in a nullable column \
                                 is a NULL.",
                                line.at("if"),
                            );
                            line_condition = None;
                        }
                    }
                }
                self.check_closed_tag_attrs("data", child);
                self.check_data_type(child, line.pos);
                // The <data> element, not the <line> around it: several <data>
                // pieces can share a line, and pointing at the line would name
                // the wrong one whenever they do.
                let text = child.text.clone();
                self.check_interpolation(&text, child.pos);
                // A named <data> declares a typed output COLUMN, and a column has one
                // cell per card — the columnar writer collects it whether or not the
                // line was rendered, so the condition was dropped and the typed file
                // disagreed with the text rendering of the same config.
                if child.attr_value("if").is_some() {
                    if let Some(column) = child.attr_value("name").map(str::trim) {
                        if !column.is_empty() {
                            self.error(
                                "TDC209",
                                format!(
                                    "<data name=\"{column}\"> declares a typed column, so its \
                                     if= cannot be honoured"
                                ),
                                "A column has one cell per card, collected whether or not the line was rendered \u{2014} the condition would be dropped and the typed file would disagree with the text one. Put the condition on the sequence instead (<gen if=\u{2026}>) and declare the column nullable: an empty cell in a nullable column is a NULL.",
                                child.at("if"),
                            );
                        }
                    }
                }
                if let Some(condition) = child.attr_value("if").map(str::to_string) {
                    self.check_if_expression(&condition, child.at("if"));
                    self.defer_expression(condition.clone(), child.at("if"), walks_a_list);
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
            if self.pool_references.contains(&name) {
                // A reference draws a whole MEMBER, so it has no single value to
                // print. Without this it reached the output as literal text: a
                // name that exists, resolves to nothing, and says nothing.
                let fields: Vec<String> = self
                    .declared_names
                    .iter()
                    .filter_map(|n| n.strip_prefix(&format!("{name}.")))
                    .map(str::to_string)
                    .collect();
                let shown: Vec<String> = fields
                    .iter()
                    .map(|field| format!("${{{{{name}.{field}}}}}"))
                    .collect();
                self.error(
                    "TDC229",
                    format!(
                        "\"{name}\" draws a whole member from a pool — it has no value of its \
                         own to print"
                    ),
                    &if fields.is_empty() {
                        format!("Read one of its fields: ${{{{{name}.field}}}}.")
                    } else {
                        format!("Read a field: {}.", shown.join(", "))
                    },
                    at,
                );
                continue;
            }
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
                let colon = filter.find(':');
                let kind = match colon {
                    Some(c) => &filter[..c],
                    None => filter,
                }
                .trim()
                .to_string();
                let arg = colon.map(|c| filter[c + 1..].to_string());

                // A mask with no pattern has nothing to keep, and the engine
                // answered that literally: it returned the empty string and the
                // column came out blank. Every other bare filter is a whole
                // transform on its own, so this one reads like them and is not.
                if kind == "mask" && arg.as_ref().map(|a| a.trim().is_empty()) != Some(false) {
                    self.error(
                        "TDC256",
                        "the \"mask\" filter needs a pattern — ${{X|mask}} empties the column"
                            .to_string(),
                        "Write the pattern after a colon: ${{X|mask:xxx-xx}}. `x` keeps a \
                         character, `w` keeps a whole word, `*` hides one — see the masks guide.",
                        at,
                    );
                    continue;
                }
                // The same parse the `mask=` attribute gets. Written as a filter
                // it reached the renderer unchecked.
                if kind == "mask" {
                    if let Some(pattern) = arg.as_ref() {
                        if let Err(err) = mask::check(pattern) {
                            self.error(
                                "TDC199",
                                err.message().to_string(),
                                "Indices are 0-based; ranges use \"..\", e.g. mask:x[0..3] or \
                                 mask:w[-1], w[0].",
                                at,
                            );
                        }
                    }
                    continue;
                }
                if !kind.is_empty() && !transforms::is_filter_name(&kind) {
                    self.error(
                        "TDC192",
                        format!("unknown interpolation filter \"{kind}\""),
                        &format!("Supported: {}.", transforms::FILTER_NAMES.join(", ")),
                        at,
                    );
                    continue;
                }
                // The name is known. Now the part after the colon, which reached
                // the renderer unread until TDC273/TDC274/TDC275.
                self.check_filter_arg(&kind, arg.as_deref(), at);
            }
        }
    }

    /// The ARGUMENT of an interpolation filter — the part after the colon.
    ///
    /// The filter NAME has been checked since TDC192, and a mask pattern since
    /// TDC199/TDC256. The argument of every other filter reached the renderer
    /// unread, and the renderer is lenient by design: `apply_group` returns the
    /// value untouched when the size is not a usable number, `apply_compact`
    /// when the base is outside 2..36. That leniency is right at render time —
    /// one bad row must not abort a million-row run — but it means the config
    /// says one thing and the output does another, with nothing said anywhere.
    ///
    /// Not refused, deliberately: `group` and `compact` with no argument (both
    /// have a documented default), `csv:;` (the delimiter is accepted and
    /// ignored on purpose), and a negative `slice` index. Only a from/to pair of
    /// the SAME sign can be proven empty; with mixed signs the answer depends on
    /// the value's length, and a refusal has to be a proof.
    fn check_filter_arg(&mut self, kind: &str, arg: Option<&str>, at: Pos) {
        /// `-3`, `0`, `12` — nothing else. `parse::<i64>()` alone accepts `+5`.
        fn whole_number(text: &str) -> Option<i64> {
            let t = text.trim();
            let body = t.strip_prefix('-').unwrap_or(t);
            if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            t.parse::<i64>().ok()
        }

        const NO_ARGUMENT: [&str; 6] = ["trim", "sql", "upper", "lower", "capitalize", "title"];

        if NO_ARGUMENT.contains(&kind) {
            if let Some(a) = arg {
                self.error(
                    "TDC274",
                    format!(
                        "the \"{kind}\" filter takes no argument — \":{a}\" is read by nothing"
                    ),
                    &format!(
                        "Write ${{{{X|{kind}}}}}. Chain filters with more pipes instead: \
                         ${{{{X|trim|{kind}}}}}."
                    ),
                    at,
                );
            }
            return;
        }
        if kind == "replace" && arg.map(|a| a.is_empty() || a.starts_with(',')) != Some(false) {
            self.error(
                "TDC275",
                "the \"replace\" filter needs something to look for — ${{X|replace}} changes \
                 nothing"
                    .to_string(),
                "Write both parts: ${{X|replace:from,to}}. Leave the second empty to delete: \
                 ${{X|replace:-,}}.",
                at,
            );
            return;
        }
        if kind == "slice" {
            let Some(a) = arg.filter(|a| !a.trim().is_empty()) else {
                self.error(
                    "TDC273",
                    "the \"slice\" filter needs a start index — ${{X|slice}} keeps the whole \
                     value"
                        .to_string(),
                    "Write ${{X|slice:0,4}} for the first four characters, or ${{X|slice:-3}} \
                     for the last three. Indices are 0-based and the end is exclusive.",
                    at,
                );
                return;
            };
            let mut parts = a.splitn(2, ',');
            let start = whole_number(parts.next().unwrap_or(""));
            let raw_to = parts.next();
            let end = raw_to.filter(|t| !t.trim().is_empty()).map(whole_number);
            if start.is_none() || end == Some(None) {
                self.error(
                    "TDC273",
                    format!(
                        "\"slice:{a}\" is not a pair of indices — the value comes out unsliced"
                    ),
                    "Indices are whole numbers, 0-based, end exclusive: ${{X|slice:0,4}}. A \
                     negative index counts from the end: ${{X|slice:-3}}.",
                    at,
                );
                return;
            }
            // Same sign, so the ORDER is decidable without knowing the length.
            if let (Some(f), Some(Some(t))) = (start, end) {
                if (f >= 0) == (t >= 0) && f > t {
                    self.error(
                        "TDC273",
                        format!("\"slice:{a}\" ends before it starts — the column comes out empty"),
                        &format!(
                            "Swap them: ${{{{X|slice:{t},{f}}}}}. The end is exclusive, so 0,4 is \
                             four characters."
                        ),
                        at,
                    );
                }
            }
            return;
        }
        if kind == "group" {
            if let Some(a) = arg.filter(|a| !a.is_empty()) {
                let size = whole_number(a.split(',').next().unwrap_or(""));
                if size.is_none_or(|n| n <= 0) {
                    self.error(
                        "TDC273",
                        format!(
                            "\"group:{a}\" is not a group size — the value comes out ungrouped"
                        ),
                        "The size is a whole number above zero, counted from the RIGHT: \
                         ${{X|group:3}} \u{2192} 1 234 567. A separator follows it: \
                         ${{X|group:4,-}}.",
                        at,
                    );
                }
            }
            return;
        }
        if kind == "compact" {
            if let Some(a) = arg.filter(|a| !a.is_empty()) {
                let base = whole_number(a);
                if base.is_none_or(|n| !(2..=36).contains(&n)) {
                    self.error(
                        "TDC273",
                        format!(
                            "\"compact:{a}\" is not a base between 2 and 36 — the number comes \
                             out unchanged"
                        ),
                        "The base is a whole number from 2 to 36; 36 is the default and the \
                         shortest. Base 1 has no digits to write with, and there are only 36 \
                         letters and digits.",
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

    /// `<assert that="…" says="…"/>` — the two attributes it cannot do without.
    ///
    /// An assertion is the one construct whose whole worth is that it FAILS, so
    /// a half-written one is worse than none: the config carries a check, the
    /// reader believes the run was verified, and nothing was ever compared.
    ///
    /// The expression is not re-checked here. `that=` is the `if=` language, so
    /// it takes the same syntax pass now and the same put-aside name pass once
    /// every sequence is known — a typo in a column name is reported exactly as
    /// it is in `if=`, because it IS that mistake.
    fn check_asserts(&mut self, env: &Element) {
        for child in env
            .children
            .iter()
            .filter(|c| c.kind == Kind::SelfClosing && c.name == "assert")
        {
            // A self-closing tag is not reached by the walk that checks closed-tag
            // attributes, so an unknown one on <assert> would pass in silence.
            self.check_closed_tag_attrs("assert", child);
            let that = child.attr_value("that").unwrap_or("").trim().to_string();
            let says = child.attr_value("says").unwrap_or("").trim().to_string();
            if that.is_empty() {
                self.error(
                    "TDC265",
                    "<assert> has no condition — that= is required".to_string(),
                    "Write the property the run must have, in the if= language, over whole-run \
                     columns: <assert that=\"Rows == 700\" says=\"…\"/>. The numbers come from \
                     <gen type=\"stat\">.",
                    child.at("that"),
                );
                continue;
            }
            if says.is_empty() {
                self.error(
                    "TDC266",
                    format!("<assert that=\"{that}\"> has no message — says= is required"),
                    "When this fails, says= is what the reader is told. An expression alone \
                     leaves them to work out what it was for, months later, in a CI log.",
                    child.at("says"),
                );
            }
            let at = child.at("that");
            self.check_if_expression(&that, at);
            self.defer_expression(that, at, false);
        }
    }

    /// Put an expression aside, together with the names it will be checked
    /// against.
    ///
    /// The scope is taken HERE rather than at the end: by then a pool's members
    /// have left the walk, and checking one of their conditions against the run's
    /// names got it wrong in both directions — a sibling field read as
    /// undeclared, and an env column read as fine.
    fn defer_expression(&mut self, expression: String, at: Pos, each: bool) {
        self.pending_expressions.push((
            self.diagnostics.len(),
            expression,
            at,
            each,
            self.expr_scope.clone(),
        ));
    }

    /// The little language, wherever it is written.
    ///
    /// `if=` is the oldest home and its wording is quoted in the docs, so it keeps the
    /// default. `expr=`, `filter=` and a distribution parameter reach the same evaluator and
    /// so have to be refused by the same list — until they were wired in here, a misspelled
    /// function passed `check` and killed the run with a bare `unknown function`.
    fn check_if_expression(&mut self, expression: &str, at: Pos) {
        self.check_expression_at(expression, at, "if expression", "an");
    }

    fn check_expression_at(&mut self, expression: &str, at: Pos, label: &str, article: &str) {
        match expr::parse(expression) {
            Ok(parsed) => self.check_expr_node(&parsed, at, label, article),
            Err(e) => match xml_entity(expression) {
                None => self.error(
                    "TDC100",
                    format!(
                        "invalid {} \"{}\": {}",
                        label,
                        clip(expression),
                        e.message()
                    ),
                    "Supported: comparison, && || !, and arithmetic.",
                    at,
                ),
                Some((found, means)) => self.error(
                    "TDC100",
                    format!(
                        "invalid {} \"{}\": TDC does not expand XML entities, \
                         so \"{}\" is {} literal characters, not \"{}\"",
                        label,
                        clip(expression),
                        found,
                        found.len(),
                        means
                    ),
                    &format!(
                        "write {means} directly — the config is XML-shaped but it is not XML, \
                         and the raw character is what the expression parser reads"
                    ),
                    at,
                ),
            },
        }
    }

    /// Every operator in a parsed condition, checked against the ones the engine
    /// implements.
    ///
    /// A parser that is more permissive than the evaluator is a trap: the config
    /// is accepted, and the operator it asked for is quietly not the operator it
    /// gets.
    fn check_expr_node(&mut self, node: &expr::Expr, at: Pos, label: &str, article: &str) {
        match node {
            expr::Expr::Array(items) => {
                // Reached only when nothing marked it as an `in` right-hand
                // side: the Binary arm checks its own right operand first.
                self.error(
                    "TDC259",
                    "a [list] is only allowed on the right of \"in\"".to_string(),
                    "Write Country in [US, CA, MX]. A list has no meaning on its own.",
                    at,
                );
                for item in items {
                    self.check_expr_node(item, at, label, article);
                }
            }
            expr::Expr::Conditional(test, consequent, alternate) => {
                self.check_expr_node(test, at, label, article);
                self.check_expr_node(consequent, at, label, article);
                self.check_expr_node(alternate, at, label, article);
            }
            expr::Expr::Binary(op, left, right) => {
                if op == "in" {
                    if let expr::Expr::Array(items) = right.as_ref() {
                        // The one place a list belongs: check its items, not it.
                        self.check_expr_node(left, at, label, article);
                        for item in items {
                            self.check_expr_node(item, at, label, article);
                        }
                        return;
                    }
                }
                if !tables::SUPPORTED_BINARY_OPERATORS.contains(&op.as_str()) {
                    self.error(
                        "TDC101",
                        format!("unsupported operator \"{op}\" in {article} {label}"),
                        &format!(
                            "Supported binary operators: {}. Functions: {}. Anything an \
                             expression cannot say, a <compute> sequence can — it has integer \
                             division, remainders, string surgery and checksums — and the \
                             sequence it produces is what if= then compares.",
                            tables::SUPPORTED_BINARY_OPERATORS.join(" "),
                            tables::EXPR_FUNCTION_NAMES.join(", ")
                        ),
                        at,
                    );
                }
                self.check_expr_node(left, at, label, article);
                self.check_expr_node(right, at, label, article);
            }
            expr::Expr::Call(name, args) => {
                match tables::EXPR_FUNCTIONS.iter().find(|(n, _, _)| n == name) {
                    None => {
                        let planned = tables::PLANNED_EXPR_FUNCTIONS.contains(&name.as_str());
                        self.error(
                            "TDC257",
                            if planned {
                                format!("{name}() is not available yet in {article} {label}")
                            } else {
                                format!("unknown function \"{name}\" in {article} {label}")
                            },
                            &if planned {
                                format!(
                                    "TDC computes its own mathematics rather than calling each \
                                     language's, because the libms disagree in the last bit and a \
                                     comparison turns that bit into a different row. So {name} \
                                     arrives once it has been built and pinned to its bits in all \
                                     five implementations, not before. Available today: {}.",
                                    tables::EXPR_FUNCTION_NAMES.join(", ")
                                )
                            } else {
                                format!("Available: {}.", tables::EXPR_FUNCTION_NAMES.join(", "))
                            },
                            at,
                        );
                        return;
                    }
                    Some(&(_, low, high)) => {
                        let n = args.len();
                        if n < low || n > high {
                            let wants = if high == usize::MAX {
                                format!("at least {low}")
                            } else if low == high {
                                format!("exactly {low}")
                            } else {
                                format!("{low} to {high}")
                            };
                            let plural = if high == 1 { "" } else { "s" };
                            self.error(
                                "TDC258",
                                format!("{name}() takes {wants} argument{plural}, got {n}"),
                                "",
                                at,
                            );
                        }
                    }
                }
                if name == "at" {
                    self.check_at_call(args, at);
                }
                for arg in args {
                    self.check_expr_node(arg, at, label, article);
                }
            }
            expr::Expr::Computed(inner) => {
                self.error(
                    "TDC103",
                    "computed member access is not supported in {article} {label}".to_string(),
                    "Use plain dotted access like Gender.Male or Person.FirstName.",
                    at,
                );
                self.check_expr_node(inner, at, label, article);
            }
            expr::Expr::Unary(op, operand) => {
                if !tables::SUPPORTED_UNARY_OPERATORS.contains(&op.as_str()) {
                    self.error(
                        "TDC102",
                        format!("unsupported unary operator \"{op}\" in {article} {label}"),
                        &format!(
                            "Supported unary operators: {}.",
                            tables::SUPPORTED_UNARY_OPERATORS.join(" ")
                        ),
                        at,
                    );
                }
                self.check_expr_node(operand, at, label, article);
            }
            _ => {}
        }
    }

    /// `at(subject, index)`, checked before the run rather than during it.
    ///
    /// Both halves are provable from the text alone. A name always resolves to a
    /// STRING — a `repeat` list arrives joined, never as a list — so
    /// `at(Items, 1)` can only ever answer with nothing, and that nothing is
    /// indistinguishable from a legitimately short row. An index written out as
    /// `-1`, `1.5` or `"one"` is the same kind of mistake one level down.
    ///
    /// The engine refuses both at run time as well; this is the earlier,
    /// better-placed half of the same rule, because `check` points at the
    /// character.
    fn check_at_call(&mut self, args: &[expr::Expr], at: Pos) {
        if args.first().is_some_and(provably_not_a_list) {
            self.error(
                "TDC260",
                "at() needs a list, and this argument is a single value".to_string(),
                "A repeat list reaches an expression as its joined text, so cut it first: \
                 at(split(Items, \",\"), 1).",
                at,
            );
        }
        if let Some(bad) = args.get(1).and_then(bad_index_literal) {
            self.error(
                "TDC261",
                format!("at() index must be a whole number of zero or more, not {bad}"),
                "Elements count from zero: at(list, 0) is the first. Past the end is empty text \
                 — ask count(list) first.",
                at,
            );
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

/// The functions that hand back a list. `at` reads one, and nothing else does
/// today; when a second joins, it goes here and the check above stays put.
const LIST_RETURNING_FUNCTIONS: [&str; 1] = ["split"];

/// Whether a subexpression can be shown, from the text alone, never to be a list.
fn provably_not_a_list(node: &expr::Expr) -> bool {
    match node {
        expr::Expr::Name(_)
        | expr::Expr::Member(_)
        | expr::Expr::Num(_)
        | expr::Expr::Int(_)
        | expr::Expr::Str(_)
        | expr::Expr::Bool(_)
        | expr::Expr::Null => true,
        expr::Expr::Call(name, _) => !LIST_RETURNING_FUNCTIONS.contains(&name.as_str()),
        _ => false,
    }
}

/// A written-out index that is not one, as it should read back in the message.
fn bad_index_literal(node: &expr::Expr) -> Option<String> {
    match node {
        expr::Expr::Str(s) => Some(format!("\"{s}\"")),
        expr::Expr::Int(n) if *n < 0 => Some(n.to_string()),
        expr::Expr::Int(_) => None,
        expr::Expr::Num(d) if d.fract() != 0.0 || *d < 0.0 => Some(numbers::to_text(*d)),
        expr::Expr::Num(_) => None,
        // A parser that does not fold a sign into the literal leaves a minus in
        // front of it; this one folds, so the branch is a belt to the braces.
        expr::Expr::Unary(op, operand) if op == "-" => match operand.as_ref() {
            expr::Expr::Int(n) => Some(format!("-{n}")),
            expr::Expr::Num(d) => Some(format!("-{}", numbers::to_text(*d))),
            _ => None,
        },
        _ => None,
    }
}

/// The `${{…}}` bodies in a piece of text — `\$\{\{([^}]+)}}` read by hand.
/// The XML entities somebody writes in an expression, and what they meant.
///
/// The config LOOKS like XML, so `filter="price &lt;= Budget"` is what a careful
/// person writes. TDC does not expand entities, so the parser sees nine characters
/// where a `<` was meant and reports the character it tripped over, which tells
/// the reader nothing about what to change.
fn xml_entity(expression: &str) -> Option<(&'static str, &'static str)> {
    const ENTITIES: [(&str, &str); 5] = [
        ("&lt;", "<"),
        ("&gt;", ">"),
        ("&amp;", "&"),
        ("&quot;", "\""),
        ("&apos;", "'"),
    ];
    ENTITIES
        .into_iter()
        .find(|(found, _)| expression.contains(found))
}

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
/// How many different values this generator can offer, when the config alone says so.
///
/// `None` means "not knowable here" — never a guess. A pack file, a regex or a date shape is
/// read while generating, so those fall to the run-time refusal instead.
fn distinct_pool_size(gen_type: Option<&str>, attrs: &Attrs) -> Option<usize> {
    let value = attrs.get("value").map(|v| v.trim()).unwrap_or("");
    if value.is_empty() {
        return None;
    }
    match gen_type {
        Some("text") => Some(
            value
                .split(',')
                .map(str::trim)
                .collect::<std::collections::BTreeSet<_>>()
                .len(),
        ),
        // A one-character symbol draws from its inline set, so the set IS the pool. Only the
        // plain shape is counted: a named `alphabet`, `include`/`exclude`, or a length above
        // one all change the answer, and a refusal built on a guess is worse than no refusal.
        Some("symbol") => {
            let plain = blank(attrs.get("alphabet"))
                && blank(attrs.get("include"))
                && blank(attrs.get("exclude"))
                && matches!(
                    attrs.get("length").map(|v| v.trim()).unwrap_or(""),
                    "" | "1"
                );
            if !plain {
                return None;
            }
            crate::unicode::char_set::parse(value).ok().map(|chars| {
                chars
                    .into_iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
            })
        }
        Some("number") => {
            let dots = value.find("..")?;
            if !blank(attrs.get("decimals")) {
                return None;
            }
            // Only whole-number ranges have a countable pool.
            let lo: i64 = value[..dots].trim().parse().ok()?;
            let hi: i64 = value[dots + 2..].trim().parse().ok()?;
            if hi < lo {
                return None;
            }
            Some((hi - lo + 1) as usize)
        }
        _ => None,
    }
}

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

/// A `<gen>` whose whole COLUMN is read from other columns rather than drawn.
///
/// A date is on the list only when `of=` makes it one: without it a date draws like
/// anything else.
fn is_derived(gen_type: Option<&str>, attrs: &Attrs) -> bool {
    match gen_type {
        Some("formula" | "running" | "stat") => true,
        Some("date") => !attrs.get("of").map(|s| s.trim()).unwrap_or("").is_empty(),
        _ => false,
    }
}

/// Every bare name an expression mentions, the root of a dotted path included.
///
/// A distribution parameter is a NUMBER, so every identifier in one has to be a column —
/// unlike `if=`, where an unknown name is a legitimate bare word. That is what makes
/// checking them all correct here and wrong there.
fn collect_identifiers(node: &expr::Expr, found: &mut std::collections::BTreeSet<String>) {
    match node {
        expr::Expr::Name(name) => {
            found.insert(name.clone());
        }
        expr::Expr::Member(path) => {
            found.insert(path.split('.').next().unwrap_or(path).to_string());
        }
        expr::Expr::Unary(_, inner) | expr::Expr::Computed(inner) => {
            collect_identifiers(inner, found);
        }
        expr::Expr::Binary(_, left, right) => {
            collect_identifiers(left, found);
            collect_identifiers(right, found);
        }
        expr::Expr::Conditional(test, yes, no) => {
            collect_identifiers(test, found);
            collect_identifiers(yes, found);
            collect_identifiers(no, found);
        }
        expr::Expr::Call(_, args) | expr::Expr::Array(args) => {
            for arg in args {
                collect_identifiers(arg, found);
            }
        }
        _ => {}
    }
}

/// One entry of [`declarations`]: the element, and the env-level group it was
/// wrapped in, if any.
struct Declaration<'a> {
    element: &'a Element,
    name: String,
    wrapped_in_group: Option<&'a str>,
    /// The `<pool>` this is a member of, if any. Checked like any other
    /// declaration, but its name belongs to the pool rather than to the run — a
    /// pool holding an `id` must not collide with the run's own `id`, nor look
    /// like an ambiguity — and its `if=` reads the pool's fields, not the run's.
    pool: Option<String>,
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
                pool: None,
            }),
            // A pool's members are declarations too — checked exactly as at the
            // top level — but its names are ITS columns, not the run's, so they
            // are marked and kept out of the shared namespace.
            "pool" => {
                let pool_name = child.attr_value("name").map(str::to_string);
                for inner in &child.children {
                    if inner.kind != Kind::OpenClose {
                        continue;
                    }
                    match inner.name.as_str() {
                        "sequence" | "mix" | "switch" => result.push(Declaration {
                            element: inner,
                            name: inner.name.clone(),
                            wrapped_in_group: None,
                            pool: pool_name.clone(),
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
                                        pool: pool_name.clone(),
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
                            pool: None,
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

/// The literal `value=` list of a member whose body is a single plain text gen.
fn literal_text_values(member: &Element) -> Option<Vec<String>> {
    let gens: Vec<&Element> = member.children.iter().filter(|c| c.name == "gen").collect();
    if gens.len() != 1 || gens[0].attr("name").is_some() {
        return None;
    }
    finite_text_values(gens[0])
}

/// A bare identifier, which is what both sides of a decidable `filter=` must be.
fn is_plain_name(text: &str) -> bool {
    let mut chars = text.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// True when the text is a finite number — the same test the generators apply.
fn is_number(raw: &str) -> bool {
    raw.parse::<f64>().map(f64::is_finite).unwrap_or(false)
}

/// True when the text is a probability the generators will accept.
fn is_probability(raw: &str) -> bool {
    matches!(raw.parse::<f64>(), Ok(p) if p.is_finite() && (0.0..=1.0).contains(&p))
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
        return Some(
            child
                .attr_value("value")
                .unwrap_or_default()
                .trim()
                .to_string(),
        );
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
        None => {
            fields.push(name.to_string());
            // A COMPOUND member publishes `Name.Field` for each of its named gens, and the
            // pool exposes those under the same dotted name — the engine does it, so the
            // CLI must accept it. `${{Seen.addr.city}}` printed `Paris` on a run and was
            // TDC193 on a check.
            for gen in node.children.iter().filter(|c| c.name == "gen") {
                if let Some(field) = gen.attr_value("name") {
                    if !field.trim().is_empty() {
                        fields.push(format!("{name}.{}", field.trim()));
                    }
                }
            }
        }
        Some(inner) => {
            for field in inner {
                fields.push(format!("{name}.{field}"));
            }
        }
    }
}

fn is_fixture_tag(tag: &str) -> bool {
    matches!(
        tag,
        "before"
            | "after"
            | "before_block"
            | "after_block"
            | "delimiter_block"
            | "before_line"
            | "after_line"
            | "delimiter_line"
    )
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

/// How many `<case>` branches a `<mix>` holds.
fn branch_count(mix: &Element) -> usize {
    mix.children_named("case").count()
}

/// The mask, or `None` when it does not parse — somebody else's diagnostic.
fn safe_expand(mask: &str, values: usize) -> Option<Vec<f64>> {
    percent_mask::expand(mask, values).ok()
}

/// Two decimals at most, and no trailing zeros — `0.5`, not `0.50`.
fn two_places(value: f64) -> String {
    let rounded = (value * 100.0).round() / 100.0;
    if (rounded - rounded.round()).abs() < f64::EPSILON {
        format!("{}", rounded.round() as i64)
    } else {
        format!("{rounded}")
    }
}
