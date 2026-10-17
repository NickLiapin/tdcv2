//! Which engine a config gets.
//!
//! The three engines agree: one config, one seed, one set of bytes, whichever
//! engine renders it — that is what `fixtures/cross-language/engines.json` pins
//! down. What differs is what each engine can do at all, and at what cost in
//! memory. So routing is still part of the contract, but for a narrower reason:
//! a config sent to an engine that cannot answer its question does not fail, it
//! answers a smaller question — an exact share becomes a per-row guess — and
//! the output is wrong in every row while looking perfectly plausible.
//!
//! A config does not name an engine — it states a constraint, and the router
//! picks the fastest engine that can honour it. `mode="memory"` means the whole
//! run may be held at once; `mode="disk"` means it may not. Naming an engine
//! outright with `engine="1|2|3"` skips all of this, which is what makes it
//! useful for a benchmark and a poor default for everything else.
//!
//! The interesting decisions are the ones that route a disk-mode config back to
//! memory. Each marks something whose answer depends on the whole column — an
//! interpolated pack address, an exact share declared inside a pack, a weighted
//! draw of a linked row. Answered a row at a time they do not fail; they quietly
//! produce data that is wrong in a way nobody notices, which is the worst
//! outcome available and the reason these checks exist.

use super::{invalid, EngineResult};
use crate::generators::advanced_regex;
use crate::model::{Config, Gen, SequenceSpec, Source, Switch};
use crate::packs::DataPacks;

/// The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk.
///
/// `packs` is what the pack-driven rule reads — a generator declares its shares
/// inside its own file, so there is no way to see them without opening it.
/// `None` skips that one rule and answers from the config alone, which is what a
/// caller that has no registry to hand can honestly do.
pub fn resolve(config: &Config, packs: Option<&DataPacks>) -> EngineResult<u8> {
    Ok(explain(config, packs)?.engine)
}

/// How each engine is named next to its number.
pub fn engine_label(engine: u8) -> &'static str {
    match engine {
        1 => "in memory",
        2 => "streaming",
        _ => "exact, on disk",
    }
}

/// The engine a run uses, and why — what `check` prints.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineChoice {
    pub engine: u8,
    pub why: String,
    /// Engine 3 was asked for and engine 1 runs the config instead.
    pub downgraded: bool,
}

impl EngineChoice {
    fn new(engine: u8, why: impl Into<String>) -> Self {
        EngineChoice {
            engine,
            why: why.into(),
            downgraded: false,
        }
    }

    /// One line for `check`: the engine, its name, and the reason.
    pub fn describe(&self) -> String {
        let named = format!("engine {} ({})", self.engine, engine_label(self.engine));
        if self.downgraded {
            format!("runs on {named}, not engine 3: {}", self.why)
        } else {
            format!("runs on {named}: {}", self.why)
        }
    }
}

/// The engine a config runs on, and the reason in words.
///
/// Engine 3 asked for by name runs a config the disk route sends to engine 1 on
/// engine 1, and says so. It always did that, silently, at the last moment — the
/// lazy build refused and the in-memory engine took over — which left nothing
/// for `check` to report and, past the row count where a run splits itself into
/// threads, handed each worker a refusal it could not take over from. Deciding
/// it here, before the run, is the same answer every implementation gives.
pub fn explain(config: &Config, _packs: Option<&DataPacks>) -> EngineResult<EngineChoice> {
    // `engine=` wins over `mode=` — except when the two contradict. `mode="sequential"`
    // is not a preference about speed, it is a promise that row N is computed after row
    // N-1, which only engine 1 keeps. Letting `engine="2"` override it silently produced
    // the worst possible message: a run failing with "add mode=sequential" to a config
    // that already said it.
    if trim_to_none(config.mode.as_deref()) == Some("sequential") {
        if let Some(forced) = trim_to_none(config.engine.as_deref()) {
            if forced != "1" {
                return invalid(&format!(
                    "engine=\"{forced}\" contradicts mode=\"sequential\": rows must be \
                     computed in order, and only engine 1 does that. Drop one of the two."
                ));
            }
        }
    }
    if let Some(forced) = trim_to_none(config.engine.as_deref()) {
        let engine = match forced {
            "1" => 1,
            "2" => 2,
            "3" => 3,
            other => {
                return invalid(&format!(
                    "invalid engine \"{other}\" — expected \"1\" (in-memory), \"2\" \
                     (streaming), or \"3\" (exact-on-disk)"
                ))
            }
        };
        if engine == 3 {
            let disk = disk_route(config);
            if disk.engine == 1 {
                return Ok(EngineChoice {
                    downgraded: true,
                    ..disk
                });
            }
        }
        return Ok(EngineChoice::new(
            engine,
            format!("engine=\"{forced}\" on <env>"),
        ));
    }

    match trim_to_none(config.mode.as_deref()) {
        Some("memory") => return Ok(EngineChoice::new(1, "mode=\"memory\" on <env>")),
        // Rows strictly in order, so `prev()` has a previous row. Engine 2 resolves ANY
        // row in O(1) without touching the one before it — that is its design, and it is
        // what this mode cannot be built on. The cost is engine 1's: the run is held in
        // memory.
        Some("sequential") => return Ok(EngineChoice::new(1, "mode=\"sequential\" on <env>")),
        // "stream" is the old name for asking for Engine 2 outright, from before
        // mode described the constraint rather than the engine. Kept working;
        // the router is not consulted.
        Some("stream") => return Ok(EngineChoice::new(2, "mode=\"stream\" on <env>")),
        Some(other) if other != "disk" => {
            return invalid(&format!(
                "invalid mode \"{other}\" — expected \"memory\", \"disk\" or \"sequential\""
            ))
        }
        // No mode at all means disk: a config says how big its run is, not how
        // to hold it, and the engine that can stream is the right default for a
        // generator whose whole point is volume.
        _ => {}
    }
    Ok(disk_route(config))
}

/// `mode="disk"`, the default: the fastest engine the config allows, and why.
fn disk_route(config: &Config) -> EngineChoice {
    // A template address that names a field resolves per row against the other
    // columns; only the in-memory engine has them all.
    if let Some(name) = gen_owner(config, |gen| {
        gen.gen_type == "template" && is_dynamic(gen.attr_or("value", ""))
    }) {
        return EngineChoice::new(1, format!("\"{name}\" picks its pack per row"));
    }

    // weight= with row= draws a linked record to an exact quota, which needs the
    // global total.
    if let Some(name) = gen_owner(config, |gen| {
        gen.gen_type == "file"
            && trim_to_none(gen.attr("weight")).is_some()
            && trim_to_none(gen.attr("row")).is_some()
    }) {
        return EngineChoice::new(
            1,
            format!("\"{name}\" draws a weighted row of a file (weight= with row=)"),
        );
    }

    // A pack generator that declares its own shares used to be routed here, and for
    // a real reason: resolved a row at a time the quota was computed over a single
    // row and every row went to the largest share. The streaming builder plans such
    // a body over the COLUMN now, so the reason is gone — and keeping the rule after
    // the refusal went was worse than nothing, because the config still landed on
    // the engine that holds the whole table. Measured on a 5,000,000-row
    // `hu.person.male.fullName` column: the in-memory engine wanted 2 GB and died
    // under a 512 MB cap, while the streaming path finished it inside 512 MB.
    //
    // One shape still belongs here — a body carrying its own `<valid>` — and it
    // arrives the way every other unstreamable config does: refused by name.

    // uniq on a DRAWN value takes WITHOUT REPLACEMENT — simple or composed alike — the pool and the
    // taken-set span the whole column, which only the in-memory engine holds.
    let counting = |t: &str| t == "increment" || t == "decrement";
    if let Some(spec) = config.sequences.iter().find(|s| {
        use crate::model::config::{Item, Source};
        s.uniq
            && match &s.source {
                Source::Gen(gen) => !counting(&gen.gen_type),
                Source::Items(items) => items
                    .iter()
                    .any(|i| matches!(i, Item::Gen(gen) if !counting(&gen.gen_type))),
                _ => false,
            }
    }) {
        return EngineChoice::new(1, format!("uniq=\"true\" on \"{}\"", spec.name));
    }
    // A network call is not reproducible, so it never runs on the reproducible
    // path.
    if let Some(name) = gen_owner(config, |gen| gen.gen_type == "http") {
        return EngineChoice::new(1, format!("\"{name}\" calls a web service"));
    }
    // A <switch> branch that declares a share the streaming engines cannot lay over the right
    // rows. They refuse such a branch rather than apportion it over the wrong denominator, and a
    // refusal reached at build time is not a fallback for every caller. Decide it here,
    // statically, where every path sees the same answer.
    if let Some(name) = unstreamable_switch_percent(config) {
        return EngineChoice::new(
            1,
            format!("a share inside \"{name}\" needs the whole column"),
        );
    }
    // A column derived from other rows — a running total, a statistic, a date offset — is
    // refused by name by the streaming builder. Deciding it here keeps that refusal from
    // reaching a parallel worker, which has nothing to fall back to.
    if let Some(name) = gen_owner(config, |gen| gen.gen_type == "running") {
        return EngineChoice::new(1, format!("\"{name}\" adds up the rows before it"));
    }
    if let Some(name) = gen_owner(config, |gen| gen.gen_type == "stat") {
        return EngineChoice::new(1, format!("\"{name}\" is computed over every row"));
    }
    if let Some(name) = gen_owner(config, |gen| {
        gen.gen_type == "date" && trim_to_none(gen.attr("of")).is_some()
    }) {
        return EngineChoice::new(
            1,
            format!("\"{name}\" is a date offset from another column"),
        );
    }
    // `parent="Name"` with no value narrows a column to the rows where the parent produced
    // anything, which needs the parent's whole column. Same reason as the three above.
    for spec in &config.sequences {
        let parent = spec.parent.as_deref().unwrap_or("").trim();
        if parent.is_empty() {
            continue;
        }
        if parent
            .find('.')
            .is_none_or(|dot| parent[dot + 1..].is_empty())
        {
            return EngineChoice::new(
                1,
                format!("\"{}\" has parent=\"{parent}\" with no value", spec.name),
            );
        }
    }
    match exact_reason(config) {
        Some(why) => EngineChoice::new(3, why),
        None => EngineChoice::new(2, "every column can be built one row at a time"),
    }
}

/// Does this `<case>` body declare a share that the denominator has to be right for?
fn case_carries_percent(case: Option<&crate::model::Case>) -> bool {
    case.is_some_and(|c| {
        c.parts.iter().any(|part| match part {
            crate::model::CasePart::Mix(mix) => {
                !mix.percent.as_deref().unwrap_or("").trim().is_empty()
            }
            crate::model::CasePart::Gen(gen) => !gen.attr_or("percent", "").trim().is_empty(),
            // A nested switch declares no share of its own; each of ITS branches is judged
            // separately, in `unstreamable_switch_percent`.
            crate::model::CasePart::Text(_) | crate::model::CasePart::Switch(_) => false,
        })
    })
}

/// A `<switch>` branch whose share the streaming engines cannot honour.
///
/// They can subset a branch keyed on ONE value of a plain values list — the same bijection
/// `parent="Gender.Male"` uses. They cannot rank a multi-key branch (`US|CA|MX` is a union, and
/// ranks across a union do not compose from the per-value ranks), nor `<default>` (a complement,
/// which nothing enumerates), nor any branch whose subject is not a finite values list.
///
/// Deliberately conservative: anything it cannot prove streamable goes to engine 1, which costs
/// speed on an exotic config and never costs correctness.
/// Every `<switch>` written inside this `<case>` body, at any depth.
fn nested_switches(case: &crate::model::Case, found: &mut Vec<Switch>) {
    for part in &case.parts {
        match part {
            crate::model::CasePart::Switch(sw) => {
                found.push((**sw).clone());
                for entry in &sw.entries {
                    nested_switches(&entry.value, found);
                }
                if let Some(fallback) = &sw.fallback {
                    nested_switches(fallback, found);
                }
            }
            crate::model::CasePart::Mix(mix) => {
                for inner in &mix.cases {
                    nested_switches(inner, found);
                }
            }
            _ => {}
        }
    }
}

fn unstreamable_switch_percent(config: &Config) -> Option<String> {
    let plain_list_values = |name: &str| -> Option<Vec<String>> {
        let subject = config.sequences.iter().find(|s| s.name == name)?;
        let gen = match &subject.source {
            Source::Gen(gen) => gen,
            _ => return None,
        };
        if gen.gen_type != "text"
            || gen.attr_or("order", "") == "sequential"
            || !gen.attr_or("repeat", "").trim().is_empty()
        {
            return None;
        }
        Some(
            gen.attr_or("value", "")
                .split(',')
                .map(|v| v.trim().to_string())
                .collect(),
        )
    };

    // A NESTED switch is never rankable — its branch covers an intersection of two partitions,
    // and there is no O(1) rank inside one. So any share it declares, at any depth, decides
    // engine 1.
    let nested_declares_share = |bodies: Vec<&crate::model::Case>| -> bool {
        let mut found = Vec::new();
        for body in bodies {
            nested_switches(body, &mut found);
        }
        found.iter().any(|nested| {
            case_carries_percent(nested.fallback.as_ref())
                || nested
                    .entries
                    .iter()
                    .any(|e| case_carries_percent(Some(&e.value)))
        })
    };

    config
        .sequences
        .iter()
        .find(|spec| {
            let nested = match &spec.source {
                Source::Switch(sw) => {
                    let mut bodies: Vec<&crate::model::Case> =
                        sw.entries.iter().map(|e| &e.value).collect();
                    if let Some(fallback) = &sw.fallback {
                        bodies.push(fallback);
                    }
                    nested_declares_share(bodies)
                }
                Source::Mix(mix) => nested_declares_share(mix.cases.iter().collect()),
                _ => false,
            };
            if nested {
                return true;
            }
            let Source::Switch(sw) = &spec.source else {
                return false;
            };
            if case_carries_percent(sw.fallback.as_ref()) {
                return true;
            }
            let values = plain_list_values(&sw.on);
            sw.entries.iter().any(|entry| {
                case_carries_percent(Some(&entry.value))
                    && (entry.keys.len() != 1
                        || values
                            .as_ref()
                            .is_none_or(|vs| !vs.contains(&entry.keys[0])))
            })
        })
        .map(|spec| spec.name.clone())
}

/// Whether disk mode needs the exact engine rather than the streaming one.
///
/// Everything here is a case where a per-row answer and a whole-column answer
/// differ: exact percentages combined with uniqueness, a uniq field that is not
/// a finite list, a child of a parent whose values are not a finite list, a
/// weighted choice inside a pattern. Ordinary exact percentages, uniform
/// uniqueness, switch, distinct and text parent-child all stream.
pub fn needs_exact(config: &Config) -> bool {
    exact_reason(config).is_some()
}

/// Why disk mode needs the exact engine, in words; `None` when it does not.
fn exact_reason(config: &Config) -> Option<String> {
    for spec in &config.sequences {
        if spec.uniq {
            return Some(format!("uniq=\"true\" on \"{}\"", spec.name));
        }
        let weighted = matches!(&spec.source, Source::Gen(gen) if is_weighted_advanced_regex(gen))
            || fields_of(spec).into_iter().any(is_weighted_advanced_regex);
        if weighted {
            return Some(format!(
                "\"{}\" has a weighted choice in advanced_regex",
                spec.name
            ));
        }
        if let Some(parent) = trim_to_none(spec.parent.as_deref()) {
            if !parent_is_finite_text(config, parent) {
                return Some(format!(
                    "\"{}\" has parent=\"{parent}\", which is not a list of values",
                    spec.name
                ));
            }
        }
    }
    // A group REARRANGES the columns it covers — every column keeps its multiset, so every
    // declared share survives — and that cannot be decided a row at a time. The streaming
    // engine could only offer a different answer, and two answers from one seed is the thing
    // this whole design exists to prevent.
    config.env_uniq_groups.first().map(|group| {
        let names: Vec<String> = group.iter().map(|n| format!("\"{n}\"")).collect();
        format!("a <uniq> group over {}", names.join(", "))
    })
}

fn parent_is_finite_text(config: &Config, reference: &str) -> bool {
    let name = match reference.find('.') {
        Some(dot) => &reference[..dot],
        None => reference,
    };
    config
        .sequence(name)
        .and_then(SequenceSpec::gen)
        .is_some_and(|gen| gen.gen_type == "text")
}

/// A `<gen type="advanced_regex">` whose pattern weights its branches —
/// `(?%{70:RU;20:US;10:DE})`.
///
/// A weighted choice is an exact share over the whole column, so it cannot be
/// answered one row at a time. Decided by parsing the pattern and counting, not
/// by searching for the opener: `(?%{` can also appear inside a character class,
/// where it is four ordinary characters.
fn is_weighted_advanced_regex(gen: &Gen) -> bool {
    gen.gen_type == "advanced_regex"
        && advanced_regex::has_weighted_choice(gen.attr_or("value", ""))
}

/// A `<gen type="template">` naming a pack generator that declares a share.
///
/// A dynamic address is left to the rule above it — the pack it names is not
/// known here, and that config is already on its way to engine 1.

/// `common.vehicle.model.${{Brand}}` — an address not known until the row is.
fn is_dynamic(value: &str) -> bool {
    value.contains("${{")
}

/// The first sequence holding a `<gen>` — simple or a compound's field — that passes.
fn gen_owner(config: &Config, test: impl Fn(&Gen) -> bool) -> Option<String> {
    config
        .sequences
        .iter()
        .find(|spec| match &spec.source {
            Source::Gen(gen) => test(gen),
            Source::Fields(fields) => fields.iter().any(|f| test(&f.gen)),
            _ => false,
        })
        .map(|spec| spec.name.clone())
}

/// A compound's fields, or nothing — a simple sequence has none rather than an
/// empty list.
fn fields_of(spec: &SequenceSpec) -> Vec<&Gen> {
    match &spec.source {
        Source::Fields(fields) => fields.iter().map(|f| &f.gen).collect(),
        _ => Vec::new(),
    }
}

fn trim_to_none(value: Option<&str>) -> Option<&str> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}
