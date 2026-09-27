//! The `<compute>` tree, checked before it runs.
//!
//! Compute is a small language of its own, and its mistakes are the quiet kind:
//! a `<use>` nobody bound reads as empty, a `<choose>` with no fallback produces
//! nothing when every branch misses, a second `<result>` silently wins over the
//! first. None of that stops a run — it produces a check digit that is wrong, in
//! a file of a million records that all look plausible.
//!
//! So the whole tree is walked here: unknown tags, bindings, arity, encodings,
//! and the wrapper children each construct needs. Diagnostics TDC180 through
//! TDC189.

use std::collections::BTreeSet;

use crate::errors::Diagnostic;
use crate::format::mask;
use crate::parser::ast::{Attr, Element, Kind};

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

/// Every tag of the compute language, and the attributes each one reads — the
/// same table as the reference's `compute/attributes.ts`, in the same order,
/// because the order is the order a near name is looked for in. A name not
/// listed for its tag is refused (TDC015): nothing checked these names before,
/// and `<join seperator="-">` quietly joined with nothing.
const ATTRIBUTES: [(&str, &[&str]); 48] = [
    // literals and references
    ("int", &["v"]),
    ("str", &["v"]),
    ("list", &["v"]),
    ("field", &["name"]),
    ("use", &["name"]),
    ("current", &[]),
    ("current_index", &[]),
    ("acc", &[]),
    // binding
    ("let", &["name"]),
    // collections
    ("each", &[]),
    ("reduce", &[]),
    ("join", &["sep"]),
    ("split", &["sep"]),
    ("at", &["default"]),
    ("length", &[]),
    // arithmetic
    ("add", &[]),
    ("subtract", &[]),
    ("multiply", &[]),
    ("divide", &[]),
    ("mod", &[]),
    // encoding and conversion
    ("encode", &["as"]),
    ("to_number", &[]),
    ("pad", &["width", "fill"]),
    ("concat", &[]),
    ("upper", &[]),
    ("lower", &[]),
    ("capitalize", &[]),
    ("title", &[]),
    ("mask", &["pattern"]),
    ("slice", &["from", "to"]),
    ("replace", &["from", "to"]),
    ("trim", &[]),
    ("group", &["size", "sep"]),
    // conditionals and the role wrappers
    ("choose", &[]),
    ("when", &[]),
    ("otherwise", &[]),
    ("test", &[]),
    ("then", &[]),
    ("result", &[]),
    ("over", &[]),
    ("do", &[]),
    ("init", &[]),
    ("in", &[]),
    ("index", &[]),
    // predicates
    ("equals", &[]),
    ("greater_than", &[]),
    ("less_than", &[]),
    ("is_digit", &[]),
];

/// The attributes `tag` reads, or `None` for a tag the language does not have.
fn attributes_of(tag: &str) -> Option<&'static [&'static str]> {
    ATTRIBUTES.iter().find(|(t, _)| *t == tag).map(|(_, a)| *a)
}

/// Accepted on every compute tag and read by none: a note for the reader, as on
/// every other tag.
const ANY_TAG_ATTRIBUTE: &str = "comment";

/// Common spellings of an attribute under another name, and the one the tag
/// reads. Offered only when the tag does read it: `separator=` is what `<gen>`
/// calls it, so it is what a hand used to `<gen>` writes on a `<join>`.
fn other_spelling(name: &str) -> Option<&'static str> {
    match name {
        "separator" | "seperator" | "delimiter" => Some("sep"),
        "value" | "val" => Some("v"),
        _ => None,
    }
}

/// Whether `node` lacks `attr` because it was written under a name the tag does
/// not read. The checks that complain about a MISSING value stand down for such
/// a tag: the misspelling has been reported, on the tag it belongs to, and the
/// missing value is only its echo. `<int val="7"/>` was refused as `<int v="">`
/// — a spelling nobody wrote.
fn written_under_another_name(node: &Element, attr: &str) -> bool {
    if node.attr(attr).is_some() {
        return false;
    }
    let known = attributes_of(&node.name).unwrap_or(&[]);
    node.attrs
        .iter()
        .any(|a| a.name != ANY_TAG_ATTRIBUTE && !known.contains(&a.name.as_str()))
}

/// Tags the compute spec describes but this version does not ship, so the
/// diagnostic explains the gap instead of reading like a typo.
/// A list of allowed names, truncated the way every long list in a diagnostic is.
fn candidates(names: &[&str]) -> String {
    const MOST: usize = 6;
    if names.len() <= MOST {
        return names.join(", ");
    }
    format!(
        "{}, … ({} more)",
        names[..MOST].join(", "),
        names.len() - MOST
    )
}

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
    /// A `<let>` above lost its `name=` to a misspelled attribute, so an unbound
    /// `<use>` may well be the one it meant. The misspelling is reported on the
    /// `<let>`; blaming the `<use>` as well points one tag too far down.
    lost_binding: bool,
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
            lost_binding: false,
        };

        // `<compute>` itself reads no attribute, so it is judged against an empty list.
        for attr in &compute_el.attrs {
            self.unread_attribute("compute", &[], attr);
        }
        self.attribute_names(&compute_el.children);

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

        // `<result>` is documented as the single exit of a `<compute>`, and it
        // was not authoritative: the block kept the LAST value-producing child
        // whatever its tag, so a stray sibling written after `<result>` silently
        // overrode it — the very fault TDC189 exists to prevent between two
        // `<result>`s.
        //
        // A `<compute>` with NO `<result>` is left alone on purpose: a body that
        // is simply the value-producing tree is a shape the docs teach and the
        // shared cases use.
        if seen_result {
            for child in nodes(compute_el) {
                if child.name == "result" || child.name == "let" {
                    continue;
                }
                let name = child.name.clone();
                self.report(
                    child,
                    "TDC189",
                    format!("<{name}> sits beside <result> in the same <compute>"),
                    "The value comes from <result>, and a sibling written after it used to \
                     override that in silence. Move this inside <result>, bind it with <let>, or \
                     delete it.",
                );
            }
        }

        self.walk_slot(&compute_el.children, &scope, compute_el, seen_result);
    }

    /// Refuse every attribute a compute tag does not read — the TDC015 `<gen>`
    /// has always had.
    ///
    /// A pass of its own over the whole subtree rather than a check inside the
    /// walk: the walk deliberately skips what it cannot judge — a misspelled
    /// slot, an unknown tag, a predicate out of place — and an attribute inside
    /// one of those is no less misspelled for it. An unknown tag is TDC180's;
    /// there is no list to hold its attributes against.
    fn attribute_names(&mut self, children: &[Element]) {
        for child in children {
            if is_raw(child) {
                self.raw_text(child);
                continue;
            }
            if let Some(known) = attributes_of(&child.name) {
                for attr in &child.attrs {
                    self.unread_attribute(&child.name, known, attr);
                }
            }
            self.attribute_names(&child.children);
        }
    }

    /// `<data>` or `<map>` inside a `<compute>`. They hold raw text, and the
    /// compute language has no text — every value is a tag. The walk skipped
    /// them, so `check` called the config valid and the run then stopped on the
    /// first row, naming no file and no line.
    fn raw_text(&mut self, node: &Element) {
        let tag = if node.kind == Kind::Data {
            "data"
        } else {
            "map"
        };
        self.report(
            node,
            "TDC180",
            format!("<{tag}> is not part of the compute language"),
            "Inside <compute> every value is a tag, and raw text is never read — the run would \
             stop on it. A literal is <str v=\"…\"/>; a column is <field name=\"…\"/>.",
        );
    }

    fn unread_attribute(&mut self, tag: &str, known: &[&str], attr: &Attr) {
        let name = attr.name.as_str();
        if name == ANY_TAG_ATTRIBUTE || known.contains(&name) {
            return;
        }
        let near = crate::errors::closest_match(
            name,
            &known.iter().map(|k| (*k).to_string()).collect::<Vec<_>>(),
        );
        let suggestion = if near.is_empty() {
            other_spelling(name)
                .filter(|o| known.contains(o))
                .unwrap_or("")
                .to_string()
        } else {
            near
        };
        let listed = if known.is_empty() {
            format!("<{tag}> takes no attributes.")
        } else {
            let mut sorted = known.to_vec();
            sorted.sort_unstable();
            format!("Attributes of <{tag}>: {}.", candidates(&sorted))
        };
        let mut d = Diagnostic::error(
            "TDC015",
            format!("<{tag}> has no \"{name}\" attribute"),
            &format!(
                "{listed} Any other name would be ignored, and the value computed as if it \
                 were not written."
            ),
            attr.at(),
        );
        if !suggestion.is_empty() {
            d.suggestion = format!("did you mean \"{suggestion}\"?");
        }
        self.out.push(d);
    }

    /// A slot: `<let>` prefixes bind for the siblings after them, and the last
    /// child is the value.
    ///
    /// A slot holds ONE value, and the evaluator honours that literally: it
    /// computes every child and keeps the last. So a second value did not fail —
    /// it replaced the first, in silence (`<result><str v="a"/><str v="b"/></result>`
    /// printed `b`), and a slot with no value passed `check` and stopped the run.
    /// Both are refused here, on the tag that owns the slot. `extras_reported` is
    /// set where the extra values already have a refusal of their own.
    fn walk_slot(
        &mut self,
        children: &[Element],
        scope: &Scope,
        owner: &Element,
        extras_reported: bool,
    ) {
        let mut bound = scope.vars.clone();
        let mut lost_binding = scope.lost_binding;
        let mut values: Vec<&Element> = Vec::new();
        for child in children {
            if is_raw(child) {
                continue;
            }
            if child.name != "let" {
                values.push(child);
            }
            if child.name == "let" && written_under_another_name(child, "name") {
                lost_binding = true;
                self.walk_slot(
                    &child.children,
                    &scope.with_vars(bound.clone()),
                    child,
                    false,
                );
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
                self.walk_slot(
                    &child.children,
                    &scope.with_vars(bound.clone()),
                    child,
                    false,
                );
                bound.insert(name);
            } else {
                let mut inner = scope.with_vars(bound.clone());
                inner.lost_binding = lost_binding;
                self.walk_expr(child, &inner);
            }
        }
        // Raw text in the slot has its own refusal (TDC180); "holds no value"
        // would be its echo.
        let raw_text = children.iter().any(is_raw);
        match values.split_last() {
            None if !raw_text => self.report(
                owner,
                "TDC187",
                format!("<{}> holds no value", owner.name),
                "It needs one value inside it, after any <let>s. With nothing there the run \
                 would stop on the first row.",
            ),
            Some((last, dropped)) if !extras_reported => {
                for d in dropped {
                    self.report(
                        d,
                        "TDC189",
                        format!(
                            "<{}> is dropped — <{}> holds one value, and only the last is used",
                            d.name, owner.name
                        ),
                        &format!(
                            "This one would be computed and thrown away, and <{}> after it \
                             would win. Keep one value here: name the others with <let>, or \
                             join them with <concat>.",
                            last.name
                        ),
                    );
                }
            }
            _ => {}
        }
    }

    /// A construct that needs one named wrapper child, like `<each><over>…`.
    fn walk_wrapper(&mut self, node: &Element, wrapper: &str, scope: &Scope) {
        for child in nodes(node) {
            if child.name == wrapper {
                self.walk_slot(&child.children, scope, child, false);
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
        if is_raw(node) {
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
        if let Some((to, why)) = renamed_tag(name) {
            self.report(
                node,
                "TDC288",
                format!("<{name}> has been renamed to <{to}>"),
                why,
            );
            return;
        }
        if attributes_of(name).is_none() {
            // The reference falls back to naming the tags a <compute> takes when the unknown
            // one has no note of its own. Without the fallback the refusal said only that the
            // tag is unknown, and left the reader to go and find the list -- on the one
            // diagnostic whose whole job is to point at it.
            let own = hint_for(name);
            let fallback;
            let hint = if own.is_empty() {
                let mut names: Vec<&str> = ATTRIBUTES.iter().map(|(t, _)| *t).collect();
                names.sort_unstable();
                fallback = format!("Allowed inside <compute>: {}.", candidates(&names));
                fallback.as_str()
            } else {
                own
            };
            self.report(
                node,
                "TDC180",
                format!("unknown compute tag <{name}>"),
                hint,
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

            "use" => {
                let bound = node.attr_value("name").unwrap_or("").to_string();
                if !scope.lost_binding
                    && !written_under_another_name(node, "name")
                    && !scope.vars.contains(&bound)
                {
                    self.report(
                        node,
                        "TDC182",
                        format!("<use name=\"{bound}\"> is not bound by an enclosing <let>"),
                        "",
                    );
                }
            }

            "field" => {
                let field = node.attr_value("name").unwrap_or("").to_string();
                if !written_under_another_name(node, "name")
                    && scope.known_fields.is_some_and(|k| !k.contains(&field))
                {
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
                if !is_integer_text(raw.trim()) && !written_under_another_name(node, "v") {
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
                self.walk_slot(&node.children, scope, node, false);
            }

            "list" | "add" | "multiply" | "concat" => {
                // `<list>` has two spellings and reads only the first: with `v=` set the
                // children are never evaluated, so writing both keeps whichever the author
                // was not looking at.
                if node.name == "list"
                    && node.attr_value("v").is_some()
                    && nodes(node).next().is_some()
                {
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
                let pattern = node.attr_value("pattern").unwrap_or("").trim().to_string();
                if written_under_another_name(node, "pattern") {
                    // Reported as the misspelling it is; "needs a pattern=" would be its echo.
                } else if pattern.is_empty() {
                    self.report(
                        node,
                        "TDC256",
                        "<mask> needs a pattern= — without one it returns the empty string"
                            .to_string(),
                        "",
                    );
                } else if let Err(e) = mask::check(&pattern) {
                    // And the pattern itself. `mask=` on a gen and the `mask:`
                    // filter are both pre-checked; this route was not, so the
                    // documented easy typo — `x[1-2]`, a hyphen where the range
                    // wants `..` — passed `check` and aborted the run with no
                    // code, no file and no line.
                    self.report(
                        node,
                        "TDC199",
                        e.message().to_string(),
                        "Indices are 0-based; ranges use \"..\", e.g. pattern=\"x[0..3]\" or \
                         pattern=\"w[-1], w[0]\".",
                    );
                }
                self.walk_slot(&node.children, scope, node, false);
            }

            "encode" => {
                let as_what = node.attr_value("as").unwrap_or("").to_string();
                if !ENCODINGS.contains(&as_what.as_str()) && !written_under_another_name(node, "as")
                {
                    self.report(
                        node,
                        "TDC186",
                        format!("<encode>: unknown encoding \"{as_what}\""),
                        "",
                    );
                }
                self.numeric_builtin_argument(&node.children, "encode");
                self.walk_slot(&node.children, scope, node, false);
            }

            "choose" => self.walk_choose(node, scope),

            "over" => self.report(
                node,
                "TDC181",
                "<over> is only valid inside <each> or <reduce>".to_string(),
                "It names the list being walked. Outside those tags there is nothing to walk.",
            ),

            // A value position cannot hold either: the evaluator has no case for
            // them outside the <choose> that reads them, and stopped the run with
            // "unknown compute tag <when>" on a config `check` called valid.
            "when" | "test" => self.report(
                node,
                "TDC181",
                if name == "when" {
                    "<when> is only valid inside <choose>".to_string()
                } else {
                    "<test> is only valid inside <when>".to_string()
                },
                "It is one branch of a <choose>, and outside one there is nothing to choose \
                 between. Wrap it: <choose><when><test>…</test><then>…</then></when>\
                 <otherwise>…</otherwise></choose>.",
            ),

            // Reaching here means an operand position — a slot binds its <let>s
            // before walking the value. The evaluator stopped on it with no file and
            // no line.
            "let" => self.report(
                node,
                "TDC180",
                "<let> is a binding, not a value — it is valid only ahead of the value in a slot"
                    .to_string(),
                "A <let> names a value for the siblings after it, inside <result>, <then>, <do> \
                 and the like. Here it stands where a value is read. Move it up into the \
                 enclosing slot.",
            ),

            _ => self.walk_slot(&node.children, scope, node, false),
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
                self.walk_slot(&child.children, scope, child, false);
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
                // One question, read first. An empty <test> passed check and
                // stopped the run; a second predicate was never asked, and the
                // branch was taken on the first alone. Neither is walked further:
                // nothing will ever run them.
                let mut predicates = nodes(test);
                match predicates.next() {
                    None => self.report(
                        test,
                        "TDC187",
                        "<test> holds no predicate".to_string(),
                        "It needs one question to answer — <equals>, <greater_than>, \
                         <less_than> or <is_digit>. With nothing there the run would stop on \
                         the first row.",
                    ),
                    Some(predicate) => self.walk_predicate(predicate, scope),
                }
                for extra in predicates {
                    self.report(
                        extra,
                        "TDC189",
                        format!(
                            "<{}> is never asked — <test> holds one predicate, and only the \
                             first is read",
                            extra.name
                        ),
                        "The branch is taken on the first predicate alone. To ask two things, \
                         put a second <choose> inside <then>.",
                    );
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
                self.comparison_literals(node, name);
                for child in nodes(node) {
                    self.walk_expr(child, scope);
                }
            }
            "is_digit" => {
                // It reads its first child and nothing else: a second was never
                // looked at, and none at all stopped the run.
                let count = nodes(node).count();
                if count != 1 {
                    self.report(
                        node,
                        "TDC183",
                        format!("<is_digit> requires exactly 1 child, found {count}"),
                        "",
                    );
                }
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
    /// A `<str>` literal under a comparison, holding something that is not a number.
    ///
    /// The three comparisons work on NUMBERS. A string of digits is accepted and read
    /// as one — `<equals><str v="7"/><int v="7"/></equals>` is true — so the tag is not
    /// "integers only", and refusing every `<str>` would break a config that works. What
    /// cannot work is a `<str>` whose text is not a number: measured, the run stopped
    /// with `expected an integer in <equals>, got the string "ab"`, naming no file, no
    /// line and no code, on a config `check` had called valid.
    ///
    /// Only a LITERAL is checked. What a `<field>` or a `<use>` will hold is not known
    /// before the run, and a refusal here has to be a proof.
    fn comparison_literals(&mut self, node: &Element, tag: &str) {
        for child in node.children.iter().filter(|c| !is_raw(c)) {
            if child.name != "str" {
                continue;
            }
            let raw = child.attr_value("v").unwrap_or("").to_string();
            if is_integer_text(raw.trim()) {
                continue;
            }
            self.report(
                child,
                "TDC287",
                format!("<{tag}> compares numbers, and <str v=\"{raw}\"> is not one"),
                "A <str> holding digits is read as the number it spells, so <str v=\"7\"/> is fine. This one is not a number, so the run would stop on the first row. Use <int>, or <to_number> around the value you meant to compare.",
            );
        }
    }

    fn numeric_builtin_argument(&mut self, children: &[Element], tag: &str) {
        for child in children.iter().filter(|c| !is_raw(c)) {
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
    element.children.iter().filter(|c| !is_raw(c))
}

/// `<data>` and `<map>`: raw text, which no compute tag reads.
fn is_raw(element: &Element) -> bool {
    matches!(element.kind, Kind::Data | Kind::Map)
}

/// Tags that used to be called something else.
///
/// Without this a renamed tag falls through to "unknown compute tag", which tells a
/// reader their spelling is wrong and not what the right one is. The rename is the one
/// moment when the engine knows exactly what was meant, so it says so.
fn renamed_tag(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "var" => Some((
            "use",
            "It never declared anything — <let> binds a name and this reads it back, which is what the new name says. Rename the tag; the name= attribute is unchanged.",
        )),
        _ => None,
    }
}

/// `^-?\d+$`
fn is_integer_text(raw: &str) -> bool {
    let digits = raw.strip_prefix('-').unwrap_or(raw);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}
