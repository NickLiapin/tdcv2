//! Turning a parse tree into the [`Config`] the engines read.
//!
//! Everything here is a faithful port of the reference's builder, including the
//! order the decisions are made in. Two of those orderings are load bearing and
//! called out where they happen: a sequence is tested for *conditional* before
//! *compound*, and a `<compute>` child wins over any `<gen>`.

use std::collections::BTreeMap;

use crate::model::{
    Branch, Case, CasePart, Config, DataPart, Field, Fixtures, Gen, Item, Line, Mix, PoolSpec,
    SequenceSpec, Source, Switch, SwitchEntry,
};
use crate::parser::ast::{Document, Element, Kind};

const DEFAULT_COUNT: i32 = 10;
const DEFAULT_LOCALE: &str = "en";
const DEFAULT_INJECT: &str = "${{%}}";

/// The cap on what one regex generator may expand to, when nothing says otherwise.
pub const DEFAULT_REGEX_MAX_LENGTH: i32 = 32;

/// A config the builder cannot turn into a run.
///
/// Distinct from a validator diagnostic: these are the two structural facts the
/// engine cannot proceed without at all, so they are reported before validation
/// rather than collected alongside it.
#[derive(Clone, Debug)]
pub struct BuildError {
    pub message: String,
}

impl std::fmt::Display for BuildError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for BuildError {}

fn err<T>(message: impl Into<String>) -> Result<T, BuildError> {
    Err(BuildError {
        message: message.into(),
    })
}

/// An `<name>…</name>` child, ignoring self-closing and raw-text ones.
///
/// The reference looks only for open/close contexts here, so `<block/>` is not
/// a `<block>`. Matching it would be friendlier and would accept a config the
/// other four reject.
fn open_child<'a>(parent: &'a Element, name: &str) -> Option<&'a Element> {
    parent
        .children
        .iter()
        .find(|c| c.kind == Kind::OpenClose && c.name == name)
}

fn open_child_of_document<'a>(document: &'a Document, name: &str) -> Option<&'a Element> {
    document
        .elements
        .iter()
        .find(|c| c.kind == Kind::OpenClose && c.name == name)
}

/// The whole config, as the engines need it.
///
/// `default_locale` fills in for a config that declares no `<env local="…">` —
/// it comes from the project's `tdcv2.config.json`, and it is a DEFAULT, never
/// an override. Letting it beat what the config declares would make a config
/// that says `local="ru"` produce English wherever a config file existed, which
/// `init` always writes.
pub fn build(document: &Document, default_locale: Option<&str>) -> Result<Config, BuildError> {
    let Some(tdc) = open_child_of_document(document, "tdc") else {
        return err("document has no <tdc> root element");
    };

    let env = open_child(tdc, "env");
    let env_attrs = env.map(Element::attr_map).unwrap_or_default();

    // regex_max_length sits on <tdc>, not <env>: it is a safety limit for the
    // whole document rather than a property of one run's data.
    let regex_max_length = parse_max_length(tdc.attr_value("regex_max_length"))?;

    let count = match env_attrs.get("count") {
        Some(raw) => match raw.trim().parse::<i32>() {
            Ok(value) => value,
            Err(_) => return err(format!("count must be an integer, got \"{raw}\"")),
        },
        None => DEFAULT_COUNT,
    };

    let mut sequences: Vec<SequenceSpec> = Vec::new();
    let mut fixtures = Fixtures::default();
    let mut env_uniq: Vec<Vec<String>> = Vec::new();
    let mut env_distinct: Vec<Vec<String>> = Vec::new();
    let mut pools: Vec<PoolSpec> = Vec::new();

    if let Some(env) = env {
        for child in env.children.iter().filter(|c| c.kind == Kind::OpenClose) {
            match child.name.as_str() {
                "sequence" => sequences.push(sequence(child)?),
                "pool" => pools.push(pool(child)?),

                // <uniq> and <distinct> around whole sequences, rather than
                // around the fields of one. The wrapper says what must hold
                // between them; its children are ordinary sequences.
                "uniq" => {
                    let group = wrapped_sequences(child, &mut sequences)?;
                    if group.len() >= 2 {
                        env_uniq.push(group);
                    }
                }
                "distinct" => {
                    let group = wrapped_sequences(child, &mut sequences)?;
                    if group.len() >= 2 {
                        env_distinct.push(group);
                    }
                }

                "mix" => sequences.push(mix_sequence(child)),
                "switch" => sequences.push(switch_sequence(child)),
                "before" => fixtures.before = lines(child),
                "after" => fixtures.after = lines(child),
                "before_block" => fixtures.before_block = lines(child),
                "after_block" => fixtures.after_block = lines(child),
                "delimiter_block" => fixtures.delimiter_block = lines(child),
                "before_line" => fixtures.before_line = lines(child),
                "after_line" => fixtures.after_line = lines(child),
                "delimiter_line" => fixtures.delimiter_line = lines(child),
                // Anything else in <env> is not modelled yet. Silence here is a
                // known gap, not a decision that it is unimportant — the
                // fixtures that use it will surface it.
                _ => {}
            }
        }
    }

    let Some(block) = open_child(tdc, "block") else {
        return err("<tdc> has no <block> child — nothing to render");
    };

    let locale = env_attrs
        .get("local")
        .cloned()
        .unwrap_or_else(|| match default_locale {
            Some(l) if !l.trim().is_empty() => l.to_string(),
            _ => DEFAULT_LOCALE.to_string(),
        });

    Ok(Config {
        count,
        seed: env_attrs.get("seed").cloned().unwrap_or_default(),
        locale: Some(locale),
        inject: Some(
            env_attrs
                .get("inject")
                .cloned()
                .unwrap_or_else(|| DEFAULT_INJECT.to_string()),
        ),
        regex_max_length,
        sequences,
        block: lines(block),
        fixtures,
        mode: env_attrs.get("mode").cloned(),
        engine: env_attrs.get("engine").cloned(),
        env_uniq_groups: env_uniq,
        env_distinct_groups: env_distinct,
        pools,
    })
}

/// A `<pool>`, read with the very same walk its enclosing `<env>` gets.
///
/// That is the whole design in one function: nothing here knows what a member
/// is, because a member of a pool is a member of an `<env>`. Lenient about a
/// missing name or an unreadable count — the validator is what says so, and
/// declaring the failure twice lets the two drift apart.
fn pool(node: &Element) -> Result<PoolSpec, BuildError> {
    let attrs = node.attr_map();
    let count = attrs
        .get("count")
        .and_then(|raw| raw.trim().parse::<i32>().ok())
        .unwrap_or(0);

    let mut sequences: Vec<SequenceSpec> = Vec::new();
    let mut uniq: Vec<Vec<String>> = Vec::new();
    let mut distinct: Vec<Vec<String>> = Vec::new();
    for child in node.children.iter().filter(|c| c.kind == Kind::OpenClose) {
        match child.name.as_str() {
            "sequence" => sequences.push(sequence(child)?),
            "mix" => sequences.push(mix_sequence(child)),
            "switch" => sequences.push(switch_sequence(child)),
            "uniq" => {
                let group = wrapped_sequences(child, &mut sequences)?;
                if group.len() >= 2 {
                    uniq.push(group);
                }
            }
            "distinct" => {
                let group = wrapped_sequences(child, &mut sequences)?;
                if group.len() >= 2 {
                    distinct.push(group);
                }
            }
            _ => {}
        }
    }

    Ok(PoolSpec {
        name: attrs.get("name").cloned().unwrap_or_default(),
        count,
        sequences,
        uniq_groups: uniq,
        distinct_groups: distinct,
    })
}

/// A positive `regex_max_length`, or the default when the attribute is absent.
pub fn parse_max_length(raw: Option<&str>) -> Result<i32, BuildError> {
    let Some(raw) = raw else {
        return Ok(DEFAULT_REGEX_MAX_LENGTH);
    };
    match raw.trim().parse::<i32>() {
        Ok(value) if value > 0 => Ok(value),
        _ => err(format!(
            "regex_max_length must be a positive integer, got \"{raw}\""
        )),
    }
}

/// The sequences inside an env-level `<uniq>` or `<distinct>`, declared as they
/// go.
///
/// Wrapping changes what must hold between them, not what they are, so each is
/// built exactly as it would have been on its own and the wrapper keeps only the
/// names.
fn wrapped_sequences(
    wrapper: &Element,
    sequences: &mut Vec<SequenceSpec>,
) -> Result<Vec<String>, BuildError> {
    let mut names = Vec::new();
    for inner in wrapper.children.iter() {
        if inner.kind != Kind::OpenClose {
            continue;
        }
        // A <mix> is a member like any other: a group rearranges whole columns
        // between rows, and a mix keeps its value multiset whatever the order,
        // so its percentages survive the move. A <switch> joins too, but the
        // group may only move its value between rows that share a subject.
        let spec = match inner.name.as_str() {
            "sequence" => sequence(inner)?,
            "mix" => mix_sequence(inner),
            "switch" => switch_sequence(inner),
            _ => continue,
        };
        if !spec.name.is_empty() {
            names.push(spec.name.clone());
        }
        sequences.push(spec);
    }
    Ok(names)
}

/// A standalone `<mix name="…">` in `<env>` is a sequence.
fn mix_sequence(element: &Element) -> SequenceSpec {
    SequenceSpec {
        name: element.attr_value("name").unwrap_or_default().to_string(),
        parent: element.attr_value("parent").map(str::to_string),
        source: Source::Mix(mix_of(element)),
        distinct_groups: Vec::new(),
        uniq: false,
    }
}

fn mix_of(element: &Element) -> Mix {
    let cases = element
        .children
        .iter()
        .filter(|c| c.kind == Kind::OpenClose && c.name == "case")
        .map(case_spec)
        .collect();
    Mix {
        percent: element.attr_value("percent").map(str::to_string),
        flag: element.attr_value("flag").map(str::to_string),
        cases,
    }
}

/// A case body: literal text, generators and nested mixes, concatenated in order.
fn case_spec(element: &Element) -> Case {
    let mut parts = Vec::new();
    for child in &element.children {
        match child.kind {
            Kind::Data => parts.push(CasePart::Text(child.text.clone())),
            Kind::SelfClosing if child.name == "gen" => parts.push(CasePart::Gen(gen_of(child))),
            Kind::OpenClose if child.name == "mix" => {
                parts.push(CasePart::Mix(Box::new(mix_of(child))));
            }
            _ => {}
        }
    }
    Case {
        parts,
        anomaly: element.attr_value("anomaly") == Some("true"),
    }
}

fn gen_of(element: &Element) -> Gen {
    let attrs = element.attr_map();
    let gen_type = attrs.get("type").cloned().unwrap_or_default();
    Gen::new(gen_type, attrs)
}

fn switch_sequence(element: &Element) -> SequenceSpec {
    let mut entries: Vec<SwitchEntry> = Vec::new();
    let mut fallback: Option<Case> = None;

    for child in &element.children {
        match child.kind {
            Kind::Map => entries.extend(map_entries(&child.text)),
            Kind::OpenClose if child.name == "case" => {
                let keys = split_keys(child.attr_value("is").unwrap_or_default());
                if !keys.is_empty() {
                    entries.push(SwitchEntry {
                        keys,
                        value: case_spec(child),
                    });
                }
            }
            Kind::OpenClose if child.name == "default" => fallback = Some(case_spec(child)),
            // Nothing else is meaningful inside a <switch>; the validator names it.
            _ => {}
        }
    }

    SequenceSpec {
        name: element.attr_value("name").unwrap_or_default().to_string(),
        parent: element.attr_value("parent").map(str::to_string),
        source: Source::Switch(Switch {
            on: element.attr_value("on").unwrap_or_default().to_string(),
            entries,
            fallback,
        }),
        distinct_groups: Vec::new(),
        uniq: false,
    }
}

/// A compact `<map>` table: comma-separated rows of `KEYS:VALUE`.
///
/// Split on the *first* colon only, so a value may contain colons — a time of
/// day or a namespaced identifier survives on the right-hand side.
fn map_entries(text: &str) -> Vec<SwitchEntry> {
    let mut result = Vec::new();
    for raw_row in text.split(',') {
        let row = raw_row.trim();
        if row.is_empty() {
            continue;
        }
        let Some(colon) = row.find(':') else { continue };
        let keys = split_keys(&row[..colon]);
        if keys.is_empty() {
            continue;
        }
        let value = row[colon + 1..].trim().to_string();
        result.push(SwitchEntry {
            keys,
            value: Case {
                parts: vec![CasePart::Text(value)],
                anomaly: false,
            },
        });
    }
    result
}

/// `US|CA|MX` — any one of them selects the entry.
fn split_keys(raw: &str) -> Vec<String> {
    raw.split('|')
        .map(str::trim)
        .filter(|k| !k.is_empty())
        .map(str::to_string)
        .collect()
}

fn sequence(element: &Element) -> Result<SequenceSpec, BuildError> {
    let attrs = element.attr_map();
    let name = attrs.get("name").cloned().unwrap_or_default();
    let parent = attrs.get("parent").cloned();

    let mut gens: Vec<BTreeMap<String, String>> = Vec::new();
    let mut distinct_groups: Vec<Vec<String>> = Vec::new();
    // The body in source order, kept beside `gens` so the ordinary shapes are
    // read exactly as they were and only a body that composes takes the new
    // path.
    let mut items: Vec<Item> = Vec::new();
    let mut saw_data = false;
    let mut unnamed_gens = 0usize;

    for child in &element.children {
        if child.kind == Kind::Data {
            saw_data = true;
            match child.attr_value("name").filter(|n| !n.is_empty()) {
                Some(field) => items.push(Item::Constant {
                    name: field.to_string(),
                    text: child.text.clone(),
                }),
                None => {
                    if !child.text.is_empty() {
                        items.push(Item::Text(child.text.clone()));
                    }
                }
            }
            continue;
        }

        if child.kind == Kind::SelfClosing && child.name == "gen" {
            let gen_attrs = child.attr_map();
            items.push(item_of(&gen_attrs, &mut unnamed_gens));
            gens.push(gen_attrs);
            continue;
        }

        // A <distinct> wrapper holds gens that must differ from each other
        // within one row. Its children are ordinary fields of the compound; the
        // wrapper only records the constraint.
        if child.kind == Kind::OpenClose && child.name == "distinct" {
            let mut group = Vec::new();
            for inner in &child.children {
                if inner.kind == Kind::SelfClosing && inner.name == "gen" {
                    let gen_attrs = inner.attr_map();
                    if let Some(field_name) = gen_attrs.get("name") {
                        if !field_name.is_empty() {
                            group.push(field_name.clone());
                        }
                    }
                    items.push(item_of(&gen_attrs, &mut unnamed_gens));
                    gens.push(gen_attrs);
                }
            }
            // A group of one carries no constraint — there is nothing for it to
            // differ from.
            if group.len() >= 2 {
                distinct_groups.push(group);
            }
        }
    }

    // A <compute> sequence derives its value instead of drawing one, so it has
    // no <gen> at all. This is how a check digit lives as editable pack data
    // rather than as engine code.
    if let Some(compute) = open_child(element, "compute") {
        return Ok(SequenceSpec {
            name,
            parent,
            source: Source::Compute(Box::new(compute.clone())),
            distinct_groups: Vec::new(),
            uniq: false,
        });
    }

    if gens.is_empty() {
        return err(format!("sequence \"{name}\" has no <gen> child"));
    }

    // Conditional is checked first, so a branch written as `<gen if="...">` is
    // not asked for a name it has no use for.
    if gens.iter().any(|g| g.contains_key("if")) {
        let branches = gens
            .into_iter()
            .map(|mut attrs| {
                // `if` is the branch's condition, not a setting the generator
                // should see.
                let condition = attrs.remove("if");
                let gen_type = attrs.get("type").cloned().unwrap_or_default();
                Branch {
                    if_expr: condition,
                    gen: Gen::new(gen_type, attrs),
                }
            })
            .collect::<Vec<Branch>>();
        return Ok(SequenceSpec {
            name,
            parent,
            source: Source::Branches(branches),
            distinct_groups: Vec::new(),
            uniq: false,
        });
    }

    // Composed when the body is not simply one unnamed gen or a set of named
    // ones: the unnamed gens and the literals build the sequence's own value and
    // the named ones stay fields beside it. Checked before compound, because a
    // body with both readings is the composed one — that is where `${{Name}}`
    // gets a value.
    if saw_data || (unnamed_gens > 0 && gens.len() > 1) {
        return Ok(SequenceSpec {
            name,
            parent,
            source: Source::Items(items),
            distinct_groups,
            uniq: attrs.get("uniq").map(String::as_str) == Some("true"),
        });
    }

    // Compound when there is more than one gen, or when the only one is named —
    // the second case lets a one-field compound be written deliberately.
    if gens.len() > 1 || gens[0].contains_key("name") {
        let fields = gens
            .into_iter()
            .filter_map(|attrs| {
                let field_name = attrs.get("name")?.clone();
                if field_name.is_empty() {
                    return None;
                }
                let gen_type = attrs.get("type").cloned().unwrap_or_default();
                Some(Field {
                    name: field_name,
                    gen: Gen::new(gen_type, attrs),
                })
            })
            .collect::<Vec<Field>>();

        return Ok(SequenceSpec {
            name,
            parent,
            source: Source::Fields(fields),
            distinct_groups,
            uniq: attrs.get("uniq").map(String::as_str) == Some("true"),
        });
    }

    // `uniq` travels to the simple shape too — a draw without replacement
    // (engine/uniq_simple.rs); dropping it silently was the bug that made
    // 100 "unique" names repeat.
    let only = gens.into_iter().next().expect("checked non-empty above");
    let gen_type = only.get("type").cloned().unwrap_or_default();
    Ok(SequenceSpec {
        name,
        parent,
        source: Source::Gen(Gen::new(gen_type, only)),
        distinct_groups: Vec::new(),
        uniq: attrs.get("uniq").map(String::as_str) == Some("true"),
    })
}

/// One `<gen>` as a body item: a field when named, a drawn part otherwise.
fn item_of(attrs: &BTreeMap<String, String>, unnamed: &mut usize) -> Item {
    let gen_type = attrs.get("type").cloned().unwrap_or_default();
    match attrs.get("name").filter(|n| !n.is_empty()) {
        Some(field) => Item::Field(Field {
            name: field.clone(),
            gen: Gen::new(gen_type, attrs.clone()),
        }),
        None => {
            *unnamed += 1;
            Item::Gen(Gen::new(gen_type, attrs.clone()))
        }
    }
}

/// Every `<line>` under a container, each flattened to its data parts.
fn lines(container: &Element) -> Vec<Line> {
    container
        .children
        .iter()
        .filter(|c| c.kind == Kind::OpenClose && c.name == "line")
        .map(|line| {
            let parts = line
                .children
                .iter()
                .filter(|c| c.kind == Kind::Data)
                .map(|data| DataPart {
                    text: data.text.clone(),
                    if_expr: data.attr_value("if").map(str::to_string),
                    name: data.attr_value("name").map(str::to_string),
                    part_type: data.attr_value("type").map(str::to_string),
                })
                .collect();
            Line {
                parts,
                if_expr: line.attr_value("if").map(str::to_string),
                each: line.attr_value("each").map(str::to_string),
            }
        })
        .collect()
}

/// A pack whose body is a lone `<gen>` tag rather than a list of values.
///
/// Some things cannot be listed — every UUID, every account number — so the pack
/// ships the rule that makes one instead. It is written in the same language a
/// config is, and parsed by the same grammar, so a pack author needs no second
/// dialect.
pub fn parse_gen_tag(source: &str) -> Result<Gen, BuildError> {
    let parsed = super::parse(source);
    if !parsed.ok() {
        let problems: Vec<String> = parsed.problems.iter().map(ToString::to_string).collect();
        return err(format!(
            "pack generator did not parse: {}",
            problems.join("; ")
        ));
    }
    for element in &parsed.tree.elements {
        if element.kind == Kind::SelfClosing && element.name == "gen" {
            return Ok(gen_of(element));
        }
    }
    err(format!("pack generator body has no <gen> tag: {source}"))
}

/// A composed pack generator: local sequences, an output template, and an
/// optional `<valid>` predicate.
///
/// This is how an identifier with a check digit is expressed as editable data
/// rather than as engine code: the pack declares the parts, computes the digit,
/// and names the shape they join into.
#[derive(Clone, Debug)]
pub struct PackGenerator {
    pub sequences: Vec<SequenceSpec>,
    pub output: String,
    pub validate: Option<Element>,
}

/// Whole-COLUMN declarations, which a pack body cannot honour.
///
/// A pack describes how to build ONE value and is asked for one per row. These
/// two say something about the column as a whole — which values may repeat
/// across rows, and in what order they come out — and answering that needs the
/// row count and every other row, neither of which a pack has. Worse, one pack
/// can be drawn from by several sequences in one config, so there is no single
/// column for the pack to be speaking about.
///
/// `<distinct>` is deliberately NOT here. It reads like a sibling of `uniq=` and
/// is not one: it constrains fields against each other WITHIN one row, which is
/// exactly what a pack can answer on its own — and five shipped full-name packs
/// rely on it to keep a person's two surnames from coming out the same.
const WHOLE_COLUMN_ATTRS: [&str; 2] = ["uniq", "order"];

/// Why this pack sequence is refused, or `None` when there is nothing wrong.
fn whole_column_declaration(sequence: &Element) -> Option<String> {
    let where_ = match sequence.attr_value("name") {
        Some(name) => format!("<sequence name=\"{name}\">"),
        None => "<sequence>".to_string(),
    };
    for attr in WHOLE_COLUMN_ATTRS {
        if sequence.attr_value(attr).unwrap_or("").trim().is_empty() {
            continue;
        }
        return Some(format!(
            "generator declares {attr}= on {where_}, which a pack cannot honour: a pack builds \
             ONE value and is asked for one per row, while {attr}= is a property of the whole \
             column. Declare it on the sequence in the config that draws from this pack instead."
        ));
    }
    None
}

pub fn parse_pack_body(body: &str) -> Result<PackGenerator, BuildError> {
    // Wrapped in a document before parsing, exactly as the reference does, so a
    // pack is written in the same language as a config and read by the same
    // grammar.
    let parsed = super::parse(&format!("<tdc><env count=\"1\">{body}</env></tdc>"));
    if !parsed.ok() {
        let problems: Vec<String> = parsed.problems.iter().map(ToString::to_string).collect();
        return err(format!(
            "pack generator did not parse: {}",
            problems.join("; ")
        ));
    }

    let env = open_child_of_document(&parsed.tree, "tdc").and_then(|tdc| open_child(tdc, "env"));
    let Some(env) = env else {
        return err("pack generator body did not parse");
    };

    let mut sequences = Vec::new();
    let mut output: Option<String> = None;
    for child in &env.children {
        if child.kind == Kind::OpenClose {
            // The same three tags `<env>` reads as a column, because a pack body
            // IS an `<env>` — a standalone `<mix name="s" percent="60,40">` is
            // how a pack declares its own shares. Reading only `<sequence>` here
            // dropped that column silently, and `${{s}}` reached the output as
            // eight literal characters.
            match child.name.as_str() {
                "sequence" => {
                    if let Some(refused) = whole_column_declaration(child) {
                        return err(refused);
                    }
                    sequences.push(sequence(child)?);
                }
                "mix" => sequences.push(mix_sequence(child)),
                "switch" => sequences.push(switch_sequence(child)),
                _ => {}
            }
            continue;
        }
        if child.kind == Kind::Data {
            output = Some(child.text.clone());
        }
    }

    let Some(output) = output else {
        return err("a composed pack generator needs a <data>...</data> output template");
    };

    Ok(PackGenerator {
        sequences,
        output,
        validate: open_child(env, "valid").cloned(),
    })
}
