//! The config as the engines need it: parsed once, then read many times.
//!
//! A deliberately small model — only what the golden fixtures exercise. Growing
//! it one verified fixture at a time is the point: a wider model with nothing
//! checking it would just be a guess about the reference implementation's
//! behaviour.

use std::collections::BTreeMap;

use crate::parser::ast::Element;

/// A single `<gen>`: its type plus every attribute, unparsed.
///
/// Attributes stay as text here on purpose. What `value="18..65"` means depends
/// on `type=`, and deciding that at build time would put the generators' rules
/// in the parser.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Gen {
    pub gen_type: String,
    pub attrs: BTreeMap<String, String>,
}

impl Gen {
    pub fn new(gen_type: impl Into<String>, attrs: BTreeMap<String, String>) -> Self {
        Self {
            gen_type: gen_type.into(),
            attrs,
        }
    }

    pub fn attr(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }

    pub fn attr_or<'a>(&'a self, name: &str, fallback: &'a str) -> &'a str {
        self.attr(name).unwrap_or(fallback)
    }
}

/// One piece of a `<case>` body: literal text, a generator, or a nested mix.
///
/// A case concatenates its pieces, which is what lets a branch read as `A-`
/// followed by a pattern rather than as a separate prefix column.
#[derive(Clone, Debug)]
pub enum CasePart {
    Text(String),
    Gen(Gen),
    Mix(Box<Mix>),
}

/// One branch of a `<mix>` or `<switch>`.
#[derive(Clone, Debug)]
pub struct Case {
    pub parts: Vec<CasePart>,
    /// `<case anomaly="true">` — a label only. It injects nothing; the branch's
    /// own generator produces the outlier, and the flag column marks who chose
    /// it.
    pub anomaly: bool,
}

/// `<mix name="X" percent="80,20">` — several ways to build one value,
/// apportioned exactly.
///
/// Different from a conditional sequence: a conditional asks about another
/// column, a mix asks for a share of the run. It is how a column gets a rare
/// shape — 2% malformed addresses, 5% legacy-format ids — in a stated
/// proportion rather than an approximate one.
#[derive(Clone, Debug)]
pub struct Mix {
    pub percent: Option<String>,
    /// The name of a companion column marking the rows that took an anomalous
    /// case.
    pub flag: Option<String>,
    pub cases: Vec<Case>,
}

/// One `<switch>` entry: keys, and how to build the value when one matches.
#[derive(Clone, Debug)]
pub struct SwitchEntry {
    pub keys: Vec<String>,
    pub value: Case,
}

/// `<switch name="X" on="Subject">` — a lookup table.
///
/// A pure function of the subject's value, so unlike everything else here it
/// consumes no randomness of its own beyond what its cases' generators use.
/// Currency from country, tax rate from region: the pairing is a fact, not a
/// choice.
#[derive(Clone, Debug)]
pub struct Switch {
    pub on: String,
    pub entries: Vec<SwitchEntry>,
    pub fallback: Option<Case>,
}

/// One field of a compound sequence: a `<gen name="X">` inside a sequence.
#[derive(Clone, Debug)]
pub struct Field {
    pub name: String,
    pub gen: Gen,
}

/// One branch of a conditional sequence; `if_expr` is `None` on the fallback.
#[derive(Clone, Debug)]
pub struct Branch {
    pub if_expr: Option<String>,
    pub gen: Gen,
}

/// One item of a composed sequence's body, in source order.
///
/// A named `<gen>` or `<data>` is a field; an unnamed one is part of the
/// sequence's own value.
#[derive(Clone, Debug)]
pub enum Item {
    /// A named `<gen>` — a field, reached as `Name.Field`.
    Field(Field),
    /// An unnamed `<gen>` — drawn, and concatenated into the value.
    Gen(Gen),
    /// A `<data>` literal between the gens.
    Text(String),
    /// A named `<data>` — a constant field, and the only one that costs no draw.
    Constant { name: String, text: String },
}

/// How a column produces its value. Exactly one shape, which is why this is an
/// enum and not the pile of mutually-exclusive optional fields the other four
/// implementations carry — there, a sequence with both `Fields` and `Branches`
/// set is representable and merely never built.
#[derive(Clone, Debug)]
pub enum Source {
    /// A single value per row.
    Gen(Gen),
    /// A compound: several named values that belong together, each registered
    /// under `Name.Field`. A generated address is one thing, not four unrelated
    /// columns that happen to sit next to each other.
    Fields(Vec<Field>),
    /// A body read as ONE ordered list: unnamed items concatenate into the
    /// sequence's own value, named ones are fields beside it.
    ///
    /// One list rather than two, because a sequence's gens draw in declaration
    /// order and that order is part of the cross-language contract. Splitting
    /// the body into "fields" and "parts" would make the draw order something to
    /// remember instead of something the shape guarantees.
    Items(Vec<Item>),
    /// A conditional: the first branch whose condition holds produces the
    /// value, so a column can depend on another column's value.
    Branches(Vec<Branch>),
    Mix(Mix),
    Switch(Switch),
    /// A `<compute>` tree — a value derived rather than drawn. Kept as the parse
    /// tree, because the compute layer is its own little language and reading it
    /// is that layer's job, not the builder's.
    Compute(Box<Element>),
}

/// One declared column.
#[derive(Clone, Debug)]
pub struct SequenceSpec {
    pub name: String,
    /// `None`, `"Name"` or `"Name.value"` — the rows this column applies to.
    /// Declaration order matters: a child may only name a parent declared
    /// before it.
    pub parent: Option<String>,
    pub source: Source,
    pub distinct_groups: Vec<Vec<String>>,
    pub uniq: bool,
}

impl SequenceSpec {
    pub fn gen(&self) -> Option<&Gen> {
        match &self.source {
            Source::Gen(g) => Some(g),
            _ => None,
        }
    }

    pub fn is_mix(&self) -> bool {
        matches!(self.source, Source::Mix(_))
    }

    pub fn is_switch(&self) -> bool {
        matches!(self.source, Source::Switch(_))
    }

    pub fn is_computed(&self) -> bool {
        matches!(self.source, Source::Compute(_))
    }

    pub fn is_compound(&self) -> bool {
        matches!(self.source, Source::Fields(_))
    }

    pub fn is_conditional(&self) -> bool {
        matches!(self.source, Source::Branches(_))
    }
}

/// One `<data>` piece of a line.
#[derive(Clone, Debug, Default)]
pub struct DataPart {
    pub text: String,
    /// The `if` attribute. A part whose condition is false contributes
    /// nothing — which is how a trailing comma is omitted on the last record.
    pub if_expr: Option<String>,
    /// `name="…"` — present when the piece is a COLUMN rather than decoration.
    /// Text output ignores it; a columnar format uses it as the column's name.
    pub name: Option<String>,
    /// `type="…"` — a declared column type, or `None` to let the generator
    /// feeding it decide.
    pub part_type: Option<String>,
}

/// One `<line>` of output: its `<data>` children, in order.
#[derive(Clone, Debug, Default)]
pub struct Line {
    pub parts: Vec<DataPart>,
    /// The `if` attribute. A line whose condition is false is dropped whole —
    /// and it is dropped before the delimiters are placed, so the line above it
    /// does not keep a separator pointing at nothing.
    pub if_expr: Option<String>,
    pub each: Option<String>,
}

/// Text emitted around the repeating body.
///
/// Each is a list of lines, empty when the config does not declare that block.
/// The three scopes nest: the `*_block` pair wraps one record, the `*_line` pair
/// wraps every line inside it, and the two delimiters go only *between* records
/// and between lines, never after the last one. That last distinction is the
/// whole reason a JSON config can be written at all — it is what keeps a
/// trailing comma off the final record.
#[derive(Clone, Debug, Default)]
pub struct Fixtures {
    pub before: Vec<Line>,
    pub after: Vec<Line>,
    pub before_block: Vec<Line>,
    pub after_block: Vec<Line>,
    pub delimiter_block: Vec<Line>,
    pub before_line: Vec<Line>,
    pub after_line: Vec<Line>,
    pub delimiter_line: Vec<Line>,
}

/// A `<pool>`: a small table computed once, before the rows.
///
/// A pool is a miniature `<env>` — its body holds the same `<sequence>`,
/// `<mix>`, `<switch>`, `<uniq>` and `<distinct>` and means the same thing by
/// them. So it carries the fields an `<env>` does, and the engine builds it
/// with the ordinary machinery, handed the member count where it usually gets
/// the row count.
#[derive(Clone, Debug)]
pub struct PoolSpec {
    pub name: String,
    /// How many members. Separate from `<env count>` — thirty doctors, two
    /// thousand patients.
    pub count: i32,
    /// The member's columns, in declaration order.
    pub sequences: Vec<SequenceSpec>,
    pub uniq_groups: Vec<Vec<String>>,
    pub distinct_groups: Vec<Vec<String>>,
}

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub count: i32,
    pub seed: String,
    pub locale: Option<String>,
    pub inject: Option<String>,
    pub regex_max_length: i32,
    pub sequences: Vec<SequenceSpec>,
    pub block: Vec<Line>,
    pub fixtures: Fixtures,
    /// `<env mode="memory"|"disk">` — how much of a run may be held at once, or
    /// `None` when the config does not say.
    pub mode: Option<String>,
    /// `<env engine="1"|"2"|"3">` — an engine asked for outright.
    pub engine: Option<String>,
    pub env_uniq_groups: Vec<Vec<String>>,
    pub env_distinct_groups: Vec<Vec<String>>,
    pub pools: Vec<PoolSpec>,
}

impl Config {
    /// A copy with the runtime parameters replaced; a `None` argument keeps what
    /// `<env>` declared.
    ///
    /// Code wins over the file. A test that pins `seed` needs that value to hold
    /// even when the config it borrowed carries a seed of its own — otherwise
    /// the override would be advice rather than a setting.
    pub fn with_overrides(
        mut self,
        count: Option<i32>,
        seed: Option<&str>,
        locale: Option<&str>,
    ) -> Self {
        if let Some(count) = count {
            self.count = count;
        }
        if let Some(seed) = seed {
            self.seed = seed.to_string();
        }
        if let Some(locale) = locale {
            self.locale = Some(locale.to_string());
        }
        self
    }

    pub fn with_engine(mut self, engine: impl Into<String>) -> Self {
        self.engine = Some(engine.into());
        self
    }

    /// The locale actually in force, which is `en` when nothing named one.
    pub fn locale_or_default(&self) -> &str {
        self.locale.as_deref().unwrap_or("en")
    }

    pub fn sequence(&self, name: &str) -> Option<&SequenceSpec> {
        self.sequences.iter().find(|s| s.name == name)
    }
}
