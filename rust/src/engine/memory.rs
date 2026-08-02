//! The in-memory engine: every column materialised, then the block rendered row
//! by row.
//!
//! One generator walks from the start of the seed, column by column in
//! declaration order. That order is the whole contract — a column drawing one
//! value more or fewer than the reference shifts every column after it, so the
//! output is either identical or wrong, never nearly right.
//!
//! What this port does not handle yet REFUSES rather than approximates.
//! Compounds, conditionals, mixes, switches, computes, parents, uniq and
//! distinct all change what a column contains; a port that ignored one would
//! produce a plausible column that answers a different question, which is the
//! failure this project is built to prevent. [`EngineError::Unsupported`] is the
//! honest answer until each is ported.

use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};

use super::{invalid, unsupported, EngineError, EngineResult, RowSource};
use crate::compute;
use crate::date;
use crate::distribution::percent_mask;
use crate::expr::evaluate;
use crate::expr::evaluate as expr;
use crate::format::interpolate::{self, Lookup};
use crate::format::{mask, transforms};
use crate::generators::accumulate;
use crate::generators::{
    advanced_regex, counter, file, http, imperfections, number, rand, regex, repeat, symbol,
};
use crate::model::{
    Branch, Case, CasePart, Config, Field, Gen, Item, Line, Mix, SequenceSpec, Source, Switch,
};
use crate::packs::DataPacks;
use crate::parser::ast::Element;
use crate::parser::config_builder;
use crate::pattern;
use crate::prng::{self, seekable, Sfc32};
use crate::sequence::pool::{self, PoolTable};
use crate::sequence::uniq;
use crate::stats::{distribution, hamilton, timeseries};

/// Every column already built; text is rendered on demand from those same values.
pub struct MaterializedRows {
    config: Config,
    columns: BTreeMap<String, Vec<Option<String>>>,
    sequence_names: Vec<String>,
    /// Rendered once, when the run is built.
    ///
    /// Rendering can meet an unported *formatting* feature — the values may all
    /// exist and the filter that dresses one of them may not — so it happens
    /// where a `Result` can still be returned, rather than inside
    /// [`RowSource::text`], which has no way to report one.
    rendered: String,
}

impl RowSource for MaterializedRows {
    fn count(&self) -> usize {
        self.config.count.max(0) as usize
    }

    fn sequence_names(&self) -> &[String] {
        &self.sequence_names
    }

    fn value(&self, column: &str, row: usize) -> Option<&str> {
        self.columns.get(column)?.get(row)?.as_deref()
    }

    fn text(&self) -> String {
        self.rendered.clone()
    }
}

/// What building a column needs beyond the column itself.
///
/// Carried as one value rather than three parameters because every function on
/// the path needs all of it and none of it changes during a run. The clock is
/// here for the same reason the seed is in the config: `value="today"` and
/// `person.b_day` read it, and a generator that reached for the system clock
/// itself could not be pinned by a fixture.
pub struct Env<'a> {
    pub config: &'a Config,
    pub packs: &'a DataPacks,
    pub now_millis: i64,
    /// Where a relative `src=` resolves from — the config file's own folder, not
    /// whatever directory the program was started in.
    pub base_dir: Option<&'a str>,
    /// `row="key"` — the plan every sequence on one key follows.
    ///
    /// Interior mutability because this is the one thing here the run
    /// accumulates: the first sequence to use a key draws the row indexes and
    /// every later one follows them, which is what makes a city and its postcode
    /// come from one real record.
    row_links: RefCell<BTreeMap<String, RowLinkPlan>>,
}

impl<'a> Env<'a> {
    pub fn new(
        config: &'a Config,
        packs: &'a DataPacks,
        now_millis: i64,
        base_dir: Option<&'a str>,
    ) -> Self {
        Self {
            config,
            packs,
            now_millis,
            base_dir,
            row_links: RefCell::new(BTreeMap::new()),
        }
    }
}

/// One row link's plan: which row of the file each record reads.
#[derive(Clone, Debug)]
struct RowLinkPlan {
    source_key: String,
    indexes: Vec<usize>,
}

/// Run a config and hold the result.
pub fn run(config: &Config, now_millis: i64) -> EngineResult<MaterializedRows> {
    run_with(config, now_millis, None, None)
}

/// The same, reading packs from where the caller names and resolving a relative
/// `src=` against `base_dir`.
pub fn run_with(
    config: &Config,
    now_millis: i64,
    packs: Option<DataPacks>,
    base_dir: Option<&str>,
) -> EngineResult<MaterializedRows> {
    let packs = match packs {
        Some(packs) => packs,
        None => DataPacks::discover()?,
    };
    run_in(config, &packs, now_millis, base_dir)
}

/// The same, over packs the caller already holds.
pub fn run_in(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
) -> EngineResult<MaterializedRows> {
    let env = Env::new(config, packs, now_millis, base_dir);
    let mut columns = build_columns(&env)?;
    resolve_http(&env, &mut columns)?;
    let sequence_names = columns
        .keys()
        .filter(|name| !name.starts_with('_'))
        .cloned()
        .collect();
    let rendered = emit(config, &columns)?;
    Ok(MaterializedRows {
        config: config.clone(),
        columns,
        sequence_names,
        rendered,
    })
}

/// Render straight to text, without keeping the rows.
pub fn render(config: &Config, now_millis: i64) -> EngineResult<String> {
    render_in(config, now_millis, None)
}

/// The same, resolving a relative `src=` against the config file's own folder.
pub fn render_in(config: &Config, now_millis: i64, base_dir: Option<&str>) -> EngineResult<String> {
    Ok(run_with(config, now_millis, None, base_dir)?.rendered)
}

// ── columns ──────────────────────────────────────────────────────────────────

/// Compute every `<pool>` declared in the config, once, before any row exists.
///
/// A pool is built by the ORDINARY column machinery with `count` set to the
/// member count instead of the row count — which is the whole reason a `<uniq>`,
/// a `<mix>`, an `if=` or a `parent=` inside a pool behaves exactly as it does
/// outside one, with nothing here to make it so.
/// Publish a running total.
///
/// Reads its source out of the columns rather than drawing anything: a running
/// total consumes no randomness at all, which is why adding one leaves every
/// other column exactly where it was.
fn running_column(
    spec: &SequenceSpec,
    gen: &Gen,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
    count: usize,
) -> EngineResult<()> {
    let of = gen.attrs.get("of").map(|s| s.trim()).unwrap_or("");
    let Some(source) = columns.get(of).cloned() else {
        return Ok(()); // unknown column — the validator reports it
    };
    let Some(op) = accumulate::read(&gen.attrs) else {
        return Ok(()); // no op — likewise
    };
    let reset_name = gen.attrs.get("reset").map(|s| s.trim()).unwrap_or("");
    let reset_at = if reset_name.is_empty() {
        None
    } else {
        columns.get(reset_name).cloned()
    };
    let base = gen
        .attrs
        .get("base")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    let values: Vec<Option<String>> = source.into_iter().take(count).collect();
    match accumulate::apply_column(&values, &op, base, reset_at.as_deref()) {
        Ok(built) => {
            columns.insert(spec.name.clone(), built);
            Ok(())
        }
        Err(message) => invalid(&message),
    }
}

pub fn build_pool_tables(env: &Env) -> EngineResult<BTreeMap<String, PoolTable>> {
    let mut tables: BTreeMap<String, PoolTable> = BTreeMap::new();
    for spec in &env.config.pools {
        if spec.name.is_empty() || spec.count < 1 {
            continue; // the validator already said so
        }
        let mut inner = env.config.clone();
        inner.count = spec.count;
        inner.seed = pool::pool_seed(&env.config.seed, &spec.name);
        inner.sequences = spec.sequences.clone();
        inner.env_uniq_groups = spec.uniq_groups.clone();
        inner.env_distinct_groups = spec.distinct_groups.clone();
        inner.pools = Vec::new();
        let inner_env = Env::new(&inner, env.packs, env.now_millis, env.base_dir);
        // The pools already built — so a MEMBER can reference one, exactly as a
        // row does. Declaration order is the whole cycle check: a pool sees only
        // the pools above it.
        let built = build_columns_with(&inner_env, Some(&tables))?;

        let mut fields: Vec<String> = Vec::new();
        let mut columns: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for member in &spec.sequences {
            // A member that references another pool publishes ONLY `name.field`
            // — a record has no value of its own — which is why the dotted keys
            // are matched here too.
            for (key, values) in &built {
                if key != &member.name && !key.starts_with(&format!("{}.", member.name)) {
                    continue;
                }
                fields.push(key.clone());
                columns.insert(
                    key.clone(),
                    values
                        .iter()
                        .map(|v| v.clone().unwrap_or_default())
                        .collect(),
                );
            }
        }
        tables.insert(
            spec.name.clone(),
            PoolTable {
                name: spec.name.clone(),
                count: spec.count as usize,
                fields,
                columns,
            },
        );
    }
    Ok(tables)
}

/// Publish one member of a pool per row, under `Ref.field` for every field.
///
/// One pick per ROW, shared by every field: that is what makes the first name
/// and the last name in a row belong to the same doctor. Not one pick per field,
/// which is exactly how "Дмитрий Иванова" would get out.
fn pool_reference(
    spec: &SequenceSpec,
    gen: &Gen,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
    mask: &[bool],
    count: usize,
    tables: &BTreeMap<String, PoolTable>,
    seed: &str,
) -> EngineResult<()> {
    let pool_name = gen.attr_or("value", "").trim().to_string();
    let table = match tables.get(&pool_name) {
        Some(t) if t.count > 0 => t,
        _ => return Ok(()), // unknown pool — the validator reports it
    };

    let expression = gen.attr_or("filter", "").trim().to_string();
    let equality = if expression.is_empty() {
        None
    } else {
        pool::parse_equality_filter(&expression, table, &|name| columns.contains_key(name))
    };
    let buckets = equality
        .as_ref()
        .map(|(field, _)| pool::bucket_by_field(table, field));

    let mut members: Vec<isize> = Vec::with_capacity(count);
    for row in 0..count {
        if !mask.get(row).copied().unwrap_or(false) {
            members.push(-1);
            continue;
        }
        if expression.is_empty() {
            members.push(pool::pick_member(seed, &spec.name, table, row) as isize);
            continue;
        }
        let (eligible, detail) = match (&equality, &buckets) {
            (Some((_, column)), Some(buckets)) => {
                let wanted = columns
                    .get(column)
                    .and_then(|c| c.get(row).cloned().flatten())
                    .unwrap_or_default();
                let found = buckets.get(&wanted).cloned().unwrap_or_default();
                (found, format!(" ({column}=\"{wanted}\")"))
            }
            _ => {
                let scope = RowScope {
                    columns,
                    table,
                    row,
                };
                let mut found = Vec::new();
                for m in 0..table.count {
                    let member_scope = MemberScope {
                        outer: &scope,
                        member: m,
                    };
                    if expr::as_condition(&expression, &member_scope)? {
                        found.push(m);
                    }
                }
                (found, String::new())
            }
        };
        if eligible.is_empty() {
            return invalid(&pool::no_candidate_message(
                &pool_name,
                &expression,
                row,
                &detail,
            ));
        }
        let slot = seekable::next_int(
            seed,
            &pool::ref_stream(&spec.name),
            row as i32,
            eligible.len() as i32,
        ) as usize;
        members.push(eligible[slot] as isize);
    }

    for field in &table.fields {
        let empty = Vec::new();
        let column = table.columns.get(field).unwrap_or(&empty);
        let values: Vec<Option<String>> = members
            .iter()
            .map(|m| {
                if *m < 0 {
                    None
                } else {
                    Some(column.get(*m as usize).cloned().unwrap_or_default())
                }
            })
            .collect();
        columns.insert(format!("{}.{}", spec.name, field), values);
    }
    Ok(())
}

/// The row's own columns, for the general filter path.
struct RowScope<'a> {
    columns: &'a BTreeMap<String, Vec<Option<String>>>,
    table: &'a PoolTable,
    row: usize,
}

/// A candidate member's fields first, then the row's columns.
///
/// A qualified `Pool.field` always means the member's field — the escape hatch
/// TDC232 points at. A name that is both a field and a column is refused by the
/// validator, so this never has to guess.
struct MemberScope<'a> {
    outer: &'a RowScope<'a>,
    member: usize,
}

impl MemberScope<'_> {
    fn field(&self, name: &str) -> Option<String> {
        let prefix = format!("{}.", self.outer.table.name);
        let key = name.strip_prefix(&prefix).unwrap_or(name);
        self.outer
            .table
            .columns
            .get(key)
            .map(|c| c.get(self.member).cloned().unwrap_or_default())
    }
}

impl expr::Scope for MemberScope<'_> {
    fn has(&self, name: &str) -> bool {
        self.field(name).is_some() || self.outer.columns.contains_key(name)
    }

    fn value(&self, name: &str) -> String {
        if let Some(found) = self.field(name) {
            return found;
        }
        self.outer
            .columns
            .get(name)
            .and_then(|c| c.get(self.outer.row).cloned().flatten())
            .unwrap_or_default()
    }
}

fn build_columns(env: &Env) -> EngineResult<BTreeMap<String, Vec<Option<String>>>> {
    build_columns_with(env, None)
}

/// The same, with the pools already built handed in — which is how a POOL body
/// is materialised, so that one of its members can draw from a pool above it.
fn build_columns_with(
    env: &Env,
    prebuilt: Option<&BTreeMap<String, PoolTable>>,
) -> EngineResult<BTreeMap<String, Vec<Option<String>>>> {
    let count = env.config.count.max(0) as usize;
    let mut columns: BTreeMap<String, Vec<Option<String>>> = BTreeMap::new();

    // Built-ins first. They are positional, consume no randomness, and are
    // therefore identical for a given count no matter what else the config does.
    let mut counts = Vec::with_capacity(count);
    let mut first = Vec::with_capacity(count);
    let mut last = Vec::with_capacity(count);
    let mut total = Vec::with_capacity(count);
    for i in 0..count {
        counts.push(Some((i + 1).to_string()));
        first.push(Some(if i == 0 { "true" } else { "false" }.to_string()));
        last.push(Some(
            if i + 1 == count { "true" } else { "false" }.to_string(),
        ));
        total.push(Some(count.to_string()));
    }
    columns.insert("_count".to_string(), counts);
    columns.insert("_first".to_string(), first);
    columns.insert("_last".to_string(), last);
    columns.insert("_total".to_string(), total);

    let mut prng = prng::create(&env.config.seed);

    // Pools first, and off a DERIVED seed. A pool must be invisible to every
    // column it does not feed: adding one leaves the ids, the ages and the names
    // exactly where they were, so an old snapshot still matches.
    let tables = match prebuilt {
        Some(built) => built.clone(),
        None => build_pool_tables(env)?,
    };

    for spec in &env.config.sequences {
        // Named one by one rather than as "that shape": each is a separate piece
        // of work, and a single message would hide which one is actually holding
        // a config up.
        let mask = parent_mask(spec, &columns, count)?;
        let applicable = mask.iter().filter(|on| **on).count();

        // A reference to a <pool>: this row gets one member, and every field of
        // that member is published under `Ref.field`. Resolved HERE, in
        // declaration order, so a later `<switch on="Doc.city">` finds it.
        if let Source::Gen(gen) = &spec.source {
            if gen.gen_type == "pool" {
                pool_reference(
                    spec,
                    gen,
                    &mut columns,
                    &mask,
                    count,
                    &tables,
                    &env.config.seed,
                )?;
                continue;
            }
            // A running total down a column. Resolved HERE, in declaration
            // order, so it reads a column that already exists — which is also
            // why `of=` must name a sequence declared above it.
            if gen.gen_type == "running" {
                running_column(spec, gen, &mut columns, count)?;
                continue;
            }
        }

        match &spec.source {
            // `common.vehicle.model.${{Brand}}` — the pack to draw from is
            // decided by another column, so the address is not known until the
            // row is. Handled here rather than in the generator, because this is
            // the only place the sibling columns exist.
            Source::Gen(gen)
                if gen.gen_type == "template" && gen.attr_or("value", "").contains("${{") =>
            {
                let values = dynamic_template(gen, &mask, &columns, &mut prng, env)?;
                columns.insert(spec.name.clone(), spread(&mask, values, count));
            }

            // A single column cannot be both proportional and unique, so —
            // unlike the compound path, which only rearranges — uniq changes
            // the draw: without replacement, one PRNG draw per pick.
            Source::Gen(gen)
                if spec.uniq && gen.gen_type != "increment" && gen.gen_type != "decrement" =>
            {
                let values = if applicable == 0 {
                    Vec::new()
                } else {
                    super::uniq_simple::build(&spec.name, gen, applicable, &mut prng, env)?
                };
                columns.insert(spec.name.clone(), spread(&mask, values, count));
            }

            Source::Gen(gen) => {
                let mut anomaly_flags = vec![false; applicable];
                let values = match repeat::parse(&gen.attrs)? {
                    // The per-value passes run INSIDE, on the flat slot buffer,
                    // so anomaly, missing and formatting come out per element of
                    // the list rather than over the joined cell.
                    Some(spec) => {
                        let element = Gen::new(gen.gen_type.clone(), repeat::without(&gen.attrs));
                        repeat::build(&spec, applicable, &mut prng, |slots, prng| {
                            let drawn = generate(&element, slots, prng, env)?;
                            finish(drawn, &gen.attrs, prng, None)
                        })?
                    }
                    None => {
                        let drawn = generate(gen, applicable, &mut prng, env)?;
                        finish(drawn, &gen.attrs, &mut prng, Some(&mut anomaly_flags))?
                    }
                };
                columns.insert(spec.name.clone(), spread(&mask, values, count));

                if let Some(flag_name) = gen
                    .attr("anomaly_flag")
                    .map(str::trim)
                    .filter(|f| !f.is_empty())
                {
                    // The ground-truth companion: which rows the run chose to
                    // spike. A detector trained on this cannot learn from a
                    // label the data never had.
                    // Shares the parent mask, so the label is absent exactly
                    // where the value is — a detector trained on this cannot
                    // learn from a label the data never had.
                    columns.insert(
                        flag_name.to_string(),
                        spread(
                            &mask,
                            anomaly_flags
                                .into_iter()
                                .map(|on| if on { "true" } else { "false" }.to_string())
                                .collect(),
                            count,
                        ),
                    );
                }
            }

            Source::Mix(mix) => {
                let mut flags = vec![false; applicable];
                let values = mix_values(mix, applicable, &mut prng, Some(&mut flags), env)?;
                columns.insert(spec.name.clone(), spread(&mask, values, count));

                if let Some(flag_name) =
                    mix.flag.as_deref().map(str::trim).filter(|f| !f.is_empty())
                {
                    // The ground-truth companion: which rows took a case declared
                    // anomalous. A detector trained on this cannot learn from a
                    // label the data never had.
                    columns.insert(
                        flag_name.to_string(),
                        spread(
                            &mask,
                            flags
                                .into_iter()
                                .map(|on| if on { "true" } else { "false" }.to_string())
                                .collect(),
                            count,
                        ),
                    );
                }
            }

            Source::Switch(sw) => {
                let values = switch_values(sw, count, &mut prng, &columns, env)?;
                columns.insert(spec.name.clone(), values);
            }

            Source::Compute(tree) => {
                // Derived, not drawn: it reads the columns already built and
                // takes no randomness, which is why declaration order alone
                // decides what it can see.
                let mut derived = Vec::with_capacity(count);
                for row in 0..count {
                    derived.push(Some(compute_row(tree, &columns, row)?));
                }
                columns.insert(spec.name.clone(), derived);
            }

            Source::Items(items) => {
                // The body in declaration order — one pass, because the order
                // the gens draw in is part of the contract and taking the named
                // ones first would shift every column after this sequence.
                let mut composed = vec![String::new(); applicable];
                let mut produced: Vec<(String, Vec<String>)> = Vec::new();

                // `uniq="true"` on a composed value. A concatenation is unique
                // exactly when the join is injective — true when ONE part is
                // drawn and the rest are constants, because appending a constant
                // cannot make two different draws collide. Two drawn parts is the
                // variable-width trap and the validator refuses it (TDC220), so
                // this counts rather than assumes.
                let drawn_parts = items.iter().filter(|i| matches!(i, Item::Gen(_))).count();
                let uniq_draw = spec.uniq && drawn_parts == 1;

                for item in items {
                    match item {
                        Item::Text(text) => {
                            for cell in composed.iter_mut() {
                                cell.push_str(text);
                            }
                        }
                        // A constant costs no draw at all — that is the whole
                        // reason it exists rather than a one-value generator.
                        Item::Constant { name, text } => {
                            produced.push((name.clone(), vec![text.clone(); applicable]));
                        }
                        Item::Field(field) => {
                            let drawn = generate(&field.gen, applicable, &mut prng, env)?;
                            produced.push((
                                field.name.clone(),
                                finish(drawn, &field.gen.attrs, &mut prng, None)?,
                            ));
                        }
                        Item::Gen(gen) => {
                            let values = if uniq_draw {
                                super::uniq_simple::build(
                                    &spec.name, gen, applicable, &mut prng, env,
                                )?
                            } else {
                                let drawn = generate(gen, applicable, &mut prng, env)?;
                                finish(drawn, &gen.attrs, &mut prng, None)?
                            };
                            for (cell, value) in composed.iter_mut().zip(values) {
                                cell.push_str(&value);
                            }
                        }
                    }
                }

                if !spec.distinct_groups.is_empty() {
                    let fields: Vec<Field> = items
                        .iter()
                        .filter_map(|item| match item {
                            Item::Field(field) => Some(field.clone()),
                            _ => None,
                        })
                        .collect();
                    enforce_distinct(spec, &fields, &mut produced, applicable, &mut prng, env)?;
                }

                // Only when something unnamed actually composed it. A body of
                // nothing but named items has no value of its own, and
                // `${{Name}}` stays the literal marker that says you meant a
                // field.
                if composes_own_value(items) {
                    columns.insert(spec.name.clone(), spread(&mask, composed, count));
                }
                for (field_name, values) in produced {
                    columns.insert(
                        format!("{}.{field_name}", spec.name),
                        spread(&mask, values, count),
                    );
                }
            }

            Source::Fields(fields) => {
                // Every field draws from the SHARED stream, in declaration
                // order. That is what keeps a compound coherent: the city and
                // the postcode of one generated address belong to the same row,
                // not to two independent ones. Interleaving them differently
                // would still produce plausible values and pair the wrong ones.
                let mut produced: Vec<(String, Vec<String>)> = Vec::with_capacity(fields.len());
                for field in fields {
                    let drawn = generate(&field.gen, applicable, &mut prng, env)?;
                    produced.push((
                        field.name.clone(),
                        finish(drawn, &field.gen.attrs, &mut prng, None)?,
                    ));
                }
                // Both run over FINISHED fields: a group's members must all
                // exist before the constraint between them means anything.
                if !spec.distinct_groups.is_empty() {
                    enforce_distinct(spec, fields, &mut produced, applicable, &mut prng, env)?;
                }
                if spec.uniq {
                    enforce_uniq_redrawing(
                        spec,
                        fields,
                        &mut produced,
                        applicable,
                        &mut prng,
                        env,
                    )?;
                }

                for (name, values) in produced {
                    columns.insert(
                        format!("{}.{name}", spec.name),
                        spread(&mask, values, count),
                    );
                }
            }

            Source::Branches(branches) => {
                let values = conditional(branches, count, &mut prng, &columns, env)?;
                columns.insert(spec.name.clone(), values);
            }
        }
    }

    // Both run over finished columns, for the same reason the per-sequence ones
    // do — and after the loop, because a group may name a sequence declared last.
    enforce_env_distinct(env, &mut columns, count, &mut prng)?;
    enforce_env_uniq(env.config, &mut columns, count)?;

    Ok(columns)
}

// ── uniq and distinct ────────────────────────────────────────────────────────

/// How many redraws a `<distinct>` field gets before its source is called too small.
const DISTINCT_FUSE: usize = 100;

/// How many independent redraws before a `uniq=` config is declared impossible.
const UNIQ_REDRAW_ATTEMPTS: usize = 8;

/// `<distinct>` — fields inside one group must differ from each other within a row.
///
/// Redraw on collision, field by field, in declaration order. A person's city of
/// birth and city of residence come from the same list and are usually
/// different; without this they coincide about as often as the list is short.
///
/// Redrawing APPENDS to the stream, so the result stays deterministic. The fuse
/// is there because a one-value list can never satisfy two fields, and spinning
/// forever would say far less than naming the problem.
#[allow(clippy::too_many_arguments)]
fn enforce_distinct(
    spec: &SequenceSpec,
    fields: &[Field],
    produced: &mut [(String, Vec<String>)],
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<()> {
    for group in &spec.distinct_groups {
        let members: Vec<usize> = group
            .iter()
            .filter_map(|name| produced.iter().position(|(n, _)| n == name))
            .collect();
        if members.len() < 2 {
            continue;
        }

        for i in 0..count {
            let mut seen: Vec<String> = Vec::new();
            for slot in &members {
                let field_name = produced[*slot].0.clone();
                let Some(field) = fields.iter().find(|f| f.name == field_name) else {
                    continue;
                };
                let mut value = produced[*slot].1[i].clone();
                let mut attempts = 0usize;
                while seen.contains(&value) {
                    if attempts >= DISTINCT_FUSE {
                        return invalid(&format!(
                            "<distinct> in sequence \"{}\": could not find a value for field \
                             \"{field_name}\" different from the others after {DISTINCT_FUSE} \
                             attempts — its source likely has too few distinct values.",
                            spec.name
                        ));
                    }
                    attempts += 1;
                    value = generate(&field.gen, 1, prng, env)?
                        .into_iter()
                        .next()
                        .unwrap_or_default();
                }
                produced[*slot].1[i] = value.clone();
                seen.push(value);
            }
        }
    }
    Ok(())
}

/// `uniq="true"` — no two rows carry the same tuple.
///
/// The values are only rearranged, never replaced, so a declared `percent=`
/// share comes through untouched. Uniqueness and an exact distribution are not a
/// trade here. Checked before any output: a cheap upper bound first, then the
/// builder's own answer.
fn arrange_unique(produced: &mut [(String, Vec<String>)], count: usize) -> Result<(), usize> {
    let columns: Vec<Vec<String>> = produced.iter().map(|(_, v)| v.clone()).collect();
    let column_counts: Vec<Vec<usize>> = columns.iter().map(|c| uniq::value_counts(c)).collect();

    let upper = uniq::upper_bound(&column_counts);
    if count > upper {
        return Err(upper);
    }

    let arranged = uniq::arrange(&columns);
    if arranged.distinct < count {
        return Err(arranged.distinct);
    }

    for (slot, column) in produced.iter_mut().zip(arranged.columns) {
        slot.1 = column;
    }
    Ok(())
}

/// `uniq="true"`, and a fresh draw when the first one happened to be
/// unarrangeable.
///
/// The arranger may only rearrange what was drawn — that is what keeps
/// `percent=` exact. But when nothing pins the proportions, a lopsided draw is
/// an accident of sampling rather than something to protect, and refusing the
/// whole run over it blames the value lists for a problem they do not have.
///
/// This runs ONLY where the arranger failed, so no config that works today
/// shifts by a byte — a successful run consumes exactly the draws it always did.
///
/// When the columns come from an exact quota, a redraw returns the same multiset
/// in a different order and cannot help. That is detected after one attempt and
/// reported as what it is, rather than retried seven more times for nothing.
#[allow(clippy::too_many_arguments)]
fn enforce_uniq_redrawing(
    spec: &SequenceSpec,
    fields: &[Field],
    produced: &mut [(String, Vec<String>)],
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<()> {
    if arrange_unique(produced, count).is_ok() {
        return Ok(());
    }

    let first_signature = uniq_signature(produced);
    let mut best = 0usize;
    for attempt in 0..UNIQ_REDRAW_ATTEMPTS {
        for (slot, field) in produced.iter_mut().zip(fields) {
            let drawn = generate(&field.gen, count, prng, env)?;
            slot.1 = finish(drawn, &field.gen.attrs, prng, None)?;
        }

        // The same value frequencies mean the draw is quota-fixed: every further
        // attempt would produce this multiset again.
        let quota_fixed = attempt == 0 && uniq_signature(produced) == first_signature;
        match arrange_unique(produced, count) {
            Ok(()) => return Ok(()),
            Err(achievable) => {
                best = best.max(achievable);
                if quota_fixed {
                    return invalid(&format!(
                        "uniq: sequence \"{}\" cannot produce {count} unique combinations. Its \
                         values are drawn to an exact share (percent=, or a weighted pack), so \
                         their proportions are fixed by the env.config, and those proportions allow \
                         at most {achievable} distinct rows. Add more values to a field (more \
                         distinct names, wider ranges…), relax the share, or lower the count.",
                        spec.name
                    ));
                }
            }
        }
    }

    invalid(&format!(
        "uniq: sequence \"{}\" cannot produce {count} unique combinations — \
         {UNIQ_REDRAW_ATTEMPTS} independent draws each topped out around {best} distinct rows. \
         Its fields do not hold enough distinct values between them. Add more values to a field \
         (more distinct names, wider ranges…) or lower the count.",
        spec.name
    ))
}

/// Per field, its value frequencies sorted — what changes when a draw is not
/// quota-fixed.
fn uniq_signature(produced: &[(String, Vec<String>)]) -> String {
    produced
        .iter()
        .map(|(_, values)| {
            let mut counts = uniq::value_counts(values);
            counts.sort_unstable();
            counts
                .iter()
                .map(usize::to_string)
                .collect::<Vec<_>>()
                .join(",")
        })
        .collect::<Vec<_>>()
        .join("|")
}

/// Env-level `<distinct>`: the wrapped sequences differ from each other on every
/// row.
fn enforce_env_distinct(
    env: &Env,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<()> {
    for group in &env.config.env_distinct_groups {
        let members = scalar_members(group, env.config, columns);
        if members.len() < 2 {
            continue;
        }

        for i in 0..count {
            let mut seen: Vec<String> = Vec::new();
            for name in &members {
                let Some(spec) = env.config.sequence(name) else {
                    continue;
                };
                let mut value = columns
                    .get(name)
                    .and_then(|c| c.get(i))
                    .and_then(Option::clone)
                    .unwrap_or_default();
                let mut attempts = 0usize;
                while seen.contains(&value) {
                    if attempts >= DISTINCT_FUSE {
                        return invalid(&format!(
                            "<distinct> across sequences: could not find a value for sequence \
                             \"{name}\" different from the others after {DISTINCT_FUSE} \
                             attempts — its source likely has too few distinct values."
                        ));
                    }
                    attempts += 1;
                    value = one_scalar(spec, prng, env)?;
                }
                if let Some(column) = columns.get_mut(name) {
                    column[i] = Some(value.clone());
                }
                seen.push(value);
            }
        }
    }
    Ok(())
}

/// Env-level `<uniq>`: no two rows carry the same tuple across the wrapped
/// sequences.
fn enforce_env_uniq(
    config: &Config,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
    count: usize,
) -> EngineResult<()> {
    for group in &config.env_uniq_groups {
        let members = scalar_members(group, config, columns);
        if members.len() < 2 {
            continue;
        }

        // Only the rows where EVERY member has a value: a row one member skips
        // has no tuple to make unique, and forcing one would invent a value the
        // config never asked for.
        let rows: Vec<usize> = (0..count)
            .filter(|i| {
                members.iter().all(|name| {
                    columns
                        .get(name)
                        .and_then(|c| c.get(*i))
                        .is_some_and(Option::is_some)
                })
            })
            .collect();
        if rows.is_empty() {
            continue;
        }

        let label = members.join(" × ");
        let mut by_row: BTreeMap<usize, Vec<String>> = BTreeMap::new();

        for block in partition_rows(&rows, &subjects_of(&members, config), columns) {
            let grid: Vec<Vec<String>> = members
                .iter()
                .map(|name| {
                    block
                        .iter()
                        .map(|row| columns[name][*row].clone().unwrap_or_default())
                        .collect()
                })
                .collect();
            let counts: Vec<Vec<usize>> = grid.iter().map(|c| uniq::value_counts(c)).collect();

            let upper = uniq::upper_bound(&counts);
            if block.len() > upper {
                return invalid(&uniq_group_message(&label, rows.len(), upper));
            }

            let arranged = uniq::arrange(&grid);
            if arranged.distinct < block.len() {
                return invalid(&uniq_group_message(&label, rows.len(), arranged.distinct));
            }

            for (k, row) in block.iter().enumerate() {
                by_row.insert(
                    *row,
                    (0..members.len())
                        .map(|m| arranged.columns[m][k].clone())
                        .collect(),
                );
            }
        }

        // Blocks are made unique on their own; two of them could still meet on
        // the same tuple when the subjects share a value (a name in both
        // lists). Rare, but silence here would be a broken promise.
        let seen: BTreeSet<Vec<String>> = rows
            .iter()
            .map(|row| by_row.get(row).cloned().unwrap_or_default())
            .collect();
        if seen.len() < rows.len() {
            return invalid(&uniq_group_message(&label, rows.len(), seen.len()));
        }

        for (m, name) in members.iter().enumerate() {
            if let Some(column) = columns.get_mut(name) {
                for row in &rows {
                    if let Some(values) = by_row.get(row) {
                        column[*row] = Some(values[m].clone());
                    }
                }
            }
        }
    }
    Ok(())
}

fn uniq_group_message(label: &str, need: usize, available: usize) -> String {
    format!(
        "uniq: group \"{label}\" cannot produce {need} unique combinations — the values drawn \
         for these sequences allow at most {available} distinct rows. Add more values to a member \
         (more distinct names, wider ranges…) or lower the count."
    )
}

/// The subjects the group's `<switch>` members are keyed by, in order, without
/// repeats. Empty when no member is a switch, which is the ordinary case and
/// leaves the behaviour exactly as it was.
fn subjects_of(members: &[String], config: &Config) -> Vec<String> {
    let mut subjects: Vec<String> = Vec::new();
    for name in members {
        if let Some(spec) = config.sequence(name) {
            if let Source::Switch(switch) = &spec.source {
                if !subjects.contains(&switch.on) {
                    subjects.push(switch.on.clone());
                }
            }
        }
    }
    subjects
}

/// Split the rows into blocks that may be shuffled among themselves.
///
/// With no switch member there is one block holding every row — the old
/// behaviour, bit for bit. With one, rows are grouped by the value of its
/// subject, so male rows only ever trade with male rows: a switch's value
/// answers the subject of ITS row.
fn partition_rows(
    rows: &[usize],
    subjects: &[String],
    columns: &BTreeMap<String, Vec<Option<String>>>,
) -> Vec<Vec<usize>> {
    if subjects.is_empty() {
        return vec![rows.to_vec()];
    }
    let mut blocks: BTreeMap<Vec<String>, Vec<usize>> = BTreeMap::new();
    for row in rows {
        let key: Vec<String> = subjects
            .iter()
            .map(|s| {
                columns
                    .get(s)
                    .and_then(|c| c.get(*row).cloned().flatten())
                    .unwrap_or_default()
            })
            .collect();
        blocks.entry(key).or_default().push(*row);
    }
    blocks.into_values().collect()
}

fn scalar_members(
    group: &[String],
    config: &Config,
    columns: &BTreeMap<String, Vec<Option<String>>>,
) -> Vec<String> {
    group
        .iter()
        .filter(|name| {
            config.sequence(name).is_some_and(|spec| {
                matches!(
                    spec.source,
                    Source::Gen(_) | Source::Mix(_) | Source::Switch(_)
                )
            }) && columns.contains_key(*name)
        })
        .cloned()
        .collect()
}

/// One fresh value from a sequence — what a `<distinct>` collision redraws.
fn one_scalar(spec: &SequenceSpec, prng: &mut Sfc32, env: &Env) -> EngineResult<String> {
    match &spec.source {
        Source::Gen(gen) => {
            let drawn = generate(gen, 1, prng, env)?;
            Ok(finish(drawn, &gen.attrs, prng, None)?
                .into_iter()
                .next()
                .unwrap_or_default())
        }
        Source::Mix(mix) => {
            let mut flags = vec![false; 1];
            Ok(mix_values(mix, 1, prng, Some(&mut flags), env)?
                .into_iter()
                .next()
                .unwrap_or_default())
        }
        _ => Ok(String::new()),
    }
}

/// The passes that run over a FINISHED column, in this order: outliers, then
/// blanks, then formatting.
///
/// The order is the contract. Spiking after blanking would multiply an empty
/// string, and formatting before either would format a value that is about to be
/// replaced.
pub(super) fn finish(
    mut values: Vec<String>,
    attrs: &BTreeMap<String, String>,
    prng: &mut Sfc32,
    anomaly_flags: Option<&mut [bool]>,
) -> EngineResult<Vec<String>> {
    if let Some(anomaly) = imperfections::parse_anomaly(attrs)? {
        imperfections::apply_anomaly(&mut values, anomaly, prng, anomaly_flags);
    }
    if let Some(missing) = imperfections::parse_missing(attrs)? {
        imperfections::apply_missing(&mut values, &missing, prng);
    }
    // `case=` and `mask=` reach the same code the `|upper` and `|mask:` filters
    // do, so the three ways of asking cannot drift apart.
    if let Some(case) = attrs.get("case").map(String::as_str) {
        if !transforms::is_case_transform(case) {
            return invalid(&format!(
                "case: unknown transform \"{case}\" — expected upper, lower, capitalize or title"
            ));
        }
        for value in values.iter_mut() {
            *value = transforms::apply_case(case, value);
        }
    }
    if let Some(pattern) = attrs.get("mask").map(String::as_str) {
        for value in values.iter_mut() {
            *value = mask::apply(pattern, value)?;
        }
    }
    Ok(values)
}

/// One column's worth of values, drawn from the shared stream.
pub(super) fn generate(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    // Attributes that change what a generator produces are refused before the
    // generator runs, so a column never silently ignores one it was given.
    // `anomaly`, `missing`, `case` and `mask` are NOT here: those are passes over
    // the finished column, and they run in `finish`. Neither is `repeat`, which
    // is handled a level up — it decides how many values a column needs before
    // the generator is asked for any.
    // `weight` and `row` belong to the file generator. On anything else they are
    // refused rather than dropped — the validator says so as TDC211, and an
    // engine that silently ignored one would produce a column the config did not
    // ask for.
    if gen.gen_type != "file" {
        for gate in ["weight", "row"] {
            if gen.attrs.contains_key(gate) {
                return unsupported(&format!("{gate}= on <gen>"));
            }
        }
    }

    match gen.gen_type.as_str() {
        "text" => text(gen, count, prng),
        "number" if gen.attrs.contains_key("distribution") => distributed(&gen.attrs, count, prng),
        "number" => number::generate(&gen.attrs, count, prng),
        "date" => date::gen::generate(
            &gen.attrs,
            env.config.locale.as_deref(),
            env.now_millis,
            count,
            prng,
        ),
        "regex" => regex::generate(&gen.attrs, count, env.config.regex_max_length, prng),
        "advanced_regex" => {
            advanced_regex::generate(&gen.attrs, count, env.config.regex_max_length, prng)
        }
        "file" => file_values(gen, count, prng, env),
        "pattern" => pattern::generate(
            &gen.attrs,
            count,
            prng,
            env.base_dir,
            env.packs.data_roots(),
        ),
        "symbol" => symbol::generate(&gen.attrs, count, prng),
        "timeseries" => timeseries::generate(&gen.attrs, count, prng),
        "template" => template_values(gen, count, prng, env),
        // Filled in a second pass, after every ordinary column exists: an http
        // gen may read another sequence through in=, and that sequence has to
        // be there first. It draws nothing here, which is also what keeps the
        // columns after it on the same stream position they would have had.
        "http" => Ok(vec![String::new(); count]),
        "increment" => counter::generate(&gen.attrs, count, true),
        "decrement" => counter::generate(&gen.attrs, count, false),
        other => unsupported(&format!("<gen type=\"{other}\">")),
    }
}

/// The second pass: fill every http column now that the ordinary ones exist.
///
/// It cannot happen in declaration order, because `in=` may name a sequence and
/// one batch carries the whole column — the input has to be complete before the
/// call goes out. A batch rather than a call per row is the difference between a
/// handful of requests and a million.
fn resolve_http(
    env: &Env,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
) -> EngineResult<()> {
    let count = env.config.count.max(0) as usize;
    for spec in &env.config.sequences {
        let Some(gen) = spec.gen() else { continue };
        if gen.gen_type != "http" {
            continue;
        }

        let inputs = match gen
            .attr("in")
            .map(str::trim)
            .filter(|name| !name.is_empty())
        {
            None => None,
            Some(name) => {
                let column = columns.get(name);
                Some(
                    (0..count)
                        .map(|i| {
                            column
                                .and_then(|c| c.get(i))
                                .and_then(Option::as_ref)
                                .cloned()
                                .unwrap_or_default()
                        })
                        .collect::<Vec<String>>(),
                )
            }
        };

        let values = http::fetch(
            gen.attr_or("src", ""),
            count,
            inputs.as_deref(),
            Some(&http::seed_for(&env.config.seed, &spec.name)),
            http::on_error(&gen.attrs),
            http::timeout_ms(gen.attr("timeout")),
        )
        .map_err(|e| {
            EngineError::Invalid(format!(
                "http service for sequence \"{}\" {}",
                spec.name,
                e.message()
                    .strip_prefix("http service at ")
                    .map_or_else(|| e.message().to_string(), |rest| format!("at {rest}"))
            ))
        })?;

        if let Some(target) = columns.get_mut(&spec.name) {
            for (i, value) in values.into_iter().take(count).enumerate() {
                target[i] = Some(value);
            }
        }
    }
    Ok(())
}

/// Whether a composed body builds a value of its own.
///
/// A body of nothing but named items — fields and constants — has none.
pub(super) fn composes_own_value(items: &[Item]) -> bool {
    items
        .iter()
        .any(|item| matches!(item, Item::Gen(_) | Item::Text(_)))
}

/// `<gen type="file">` — the four shapes, in the order the reference tries them.
fn file_values(gen: &Gen, count: usize, prng: &mut Sfc32, env: &Env) -> EngineResult<Vec<String>> {
    let attrs = &gen.attrs;
    let roots = env.packs.data_roots();

    if attrs.get("order").map(String::as_str) == Some("sequential") {
        let rows = file::load(attrs, env.base_dir, roots)?;
        let cycle = attrs.get("cycle").map(String::as_str) != Some("false");
        return (0..count)
            .map(|i| pick_sequential(&rows, i, cycle))
            .collect();
    }

    if let Some(row_key) = attrs
        .get("row")
        .map(|r| r.trim().to_string())
        .filter(|r| !r.is_empty())
    {
        return linked_file_values(&row_key, attrs, count, prng, env);
    }

    if let Some(weighted) = file::load_weighted(attrs, env.base_dir, roots)? {
        // A weight is a raw count, honoured exactly: 20000 and 10000 over 30000
        // rows give precisely those, not "about twice as many".
        return Ok(hamilton::distribute(
            count as i32,
            &weighted.values,
            &weighted.percents,
            prng,
        ));
    }

    file::generate(attrs, count, env.base_dir, roots, prng)
}

/// `row="key"` — every sequence on the same key reads the same row of the file.
///
/// The first sequence to use a key draws the plan — one row index per record —
/// and every later one follows it. That is the whole point: a city and its
/// postcode taken from one real record are consistent, where two independent
/// draws produce a pairing no validator would accept.
///
/// Because only the first draws, adding a second field to an existing link
/// consumes no further randomness and leaves every other column exactly where it
/// was.
fn linked_file_values(
    row_key: &str,
    attrs: &BTreeMap<String, String>,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    let source = file::load_rows(attrs, env.base_dir, env.packs.data_roots())?;

    let existing = env.row_links.borrow().get(row_key).cloned();
    let plan = match existing {
        Some(plan) => {
            if plan.source_key != source.source_key {
                return invalid(&format!(
                    "sequence: row link \"{row_key}\" cannot mix different file sources"
                ));
            }
            if plan.indexes.len() != count {
                return invalid(&format!(
                    "sequence: row link \"{row_key}\" cannot be reused with a different row count"
                ));
            }
            plan
        }
        None => {
            let indexes = match file::weighted_rows(attrs, &source)? {
                // With weight=, the shared rows follow the file's counts exactly;
                // every linked field then reads those same rows.
                Some(weighted) => {
                    hamilton::distribute(count as i32, &weighted.values, &weighted.percents, prng)
                        .iter()
                        .map(|i| i.parse().unwrap_or(0))
                        .collect()
                }
                None => (0..count)
                    .map(|_| rand::next_int(prng, 0, source.rows.len() as i32).max(0) as usize)
                    .collect(),
            };
            let plan = RowLinkPlan {
                source_key: source.source_key.clone(),
                indexes,
            };
            env.row_links
                .borrow_mut()
                .insert(row_key.to_string(), plan.clone());
            plan
        }
    };

    Ok(plan
        .indexes
        .iter()
        .map(|i| file::cell_at(&source, *i))
        .collect())
}

/// A `<case>` body: its pieces, concatenated, over every row it covers.
///
/// Built over the row COUNT it is given rather than lazily, because a case may
/// hold a generator and every draw that generator makes is part of the shared
/// stream — whether or not the branch it belongs to is the one that wins.
fn case_values(
    case: &Case,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    let mut parts: Vec<String> = vec![String::new(); count];
    for part in &case.parts {
        let values: Vec<String> = match part {
            CasePart::Text(text) => vec![text.clone(); count],
            CasePart::Gen(gen) => generate(gen, count, prng, env)?,
            CasePart::Mix(mix) => mix_values(mix, count, prng, None, env)?,
        };
        for (slot, value) in parts.iter_mut().zip(values) {
            slot.push_str(&value);
        }
    }
    Ok(parts)
}

/// `<mix percent="80,20">` — several ways to build one value, apportioned exactly.
///
/// The apportionment happens first, over the whole column; then each case is
/// generated for exactly the rows it won, in declaration order. Generating every
/// case for every row and throwing most away would produce the same column and a
/// different stream — so the count handed to each case is what makes this agree.
fn mix_values(
    mix: &Mix,
    count: usize,
    prng: &mut Sfc32,
    flags: Option<&mut Vec<bool>>,
    env: &Env,
) -> EngineResult<Vec<String>> {
    if mix.cases.is_empty() {
        return Ok(vec![String::new(); count]);
    }

    let percents = match mix.percent.as_deref().map(str::trim) {
        None | Some("") => vec![100.0 / mix.cases.len() as f64; mix.cases.len()],
        Some(mask) => percent_mask::expand(mask, mix.cases.len())
            .map_err(|e| EngineError::Invalid(e.message))?,
    };

    let indices: Vec<usize> = (0..mix.cases.len()).collect();
    let selected = hamilton::distribute(count as i32, &indices, &percents, prng);

    let mut result = vec![String::new(); count];
    if let Some(flags) = flags {
        for (i, chosen) in selected.iter().enumerate() {
            flags[i] = mix.cases[*chosen].anomaly;
        }
    }

    for (c, case) in mix.cases.iter().enumerate() {
        let rows: Vec<usize> = (0..count).filter(|i| selected[*i] == c).collect();
        if rows.is_empty() {
            continue;
        }
        let values = case_values(case, rows.len(), prng, env)?;
        for (row, value) in rows.into_iter().zip(values) {
            result[row] = value;
        }
    }

    Ok(result)
}

/// `<switch on="Subject">` — look the subject's value up in the table.
///
/// Every entry is built over every row, not only the matching ones, for the same
/// reason a mix builds each case over the rows it won: a case may hold a
/// generator, and its draws belong to the stream whether or not that key came up.
///
/// A row with no match and no `<default>` is EMPTY rather than a failure — a
/// country with no entry in a currency table has no currency, and `None` is how
/// that is said. Writing `""` would claim it had one that happened to be blank.
fn switch_values(
    sw: &Switch,
    count: usize,
    prng: &mut Sfc32,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    env: &Env,
) -> EngineResult<Vec<Option<String>>> {
    let mut built = Vec::with_capacity(sw.entries.len());
    for entry in &sw.entries {
        built.push(case_values(&entry.value, count, prng, env)?);
    }
    let fallback = match &sw.fallback {
        Some(case) => Some(case_values(case, count, prng, env)?),
        None => None,
    };

    let subject = columns.get(&sw.on);
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let key = subject
            .and_then(|c| c.get(i))
            .and_then(|v| v.as_deref())
            .unwrap_or("");
        let picked = sw
            .entries
            .iter()
            .position(|entry| entry.keys.iter().any(|k| k == key))
            .map(|e| built[e][i].clone())
            .or_else(|| fallback.as_ref().map(|f| f[i].clone()));
        result.push(picked);
    }
    Ok(result)
}

/// `<gen type="number" distribution="normal" …/>` — a column shaped like real data.
///
/// Every distribution spends a FIXED number of draws per row, and the uniforms
/// are nudged into the open interval first: inverse-CDF sampling takes
/// logarithms, and at exactly zero those are infinite.
fn distributed(
    attrs: &std::collections::BTreeMap<String, String>,
    count: usize,
    prng: &mut Sfc32,
) -> EngineResult<Vec<String>> {
    let spec = distribution::parse(attrs)?;
    let mut result = Vec::with_capacity(count);
    for _ in 0..count {
        let uniforms: Vec<f64> = (0..spec.draws)
            .map(|_| seekable::open_unit(prng.next()))
            .collect();
        result.push(distribution::format(
            distribution::sample(&spec, &uniforms),
            &spec,
        ));
    }
    Ok(result)
}

/// A template whose address names another column.
///
/// The row decides where its value comes from: a car's model list depends on its
/// make, a region's cities on its country. That is the difference between data
/// that is merely plausible per column and data that holds together across a
/// record.
///
/// One row at a time, necessarily — the address changes with it — and only on
/// the rows the parent selected, so a filtered-out row draws nothing rather than
/// drawing from whatever address an empty interpolation happens to produce.
fn dynamic_template(
    gen: &Gen,
    mask: &[bool],
    columns: &BTreeMap<String, Vec<Option<String>>>,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    let template = gen.attr_or("value", "").to_string();
    let locale = match gen.attr("local").map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => l.to_string(),
        None => env.config.locale_or_default().to_string(),
    };

    let mut result = Vec::new();
    for (row, on) in mask.iter().enumerate() {
        if !on {
            continue;
        }
        let lookup = RowLookup { columns, row };
        let address = interpolate::apply(&template, env.config.inject.as_deref(), &lookup)?;

        let mut attrs = gen.attrs.clone();
        attrs.insert("value".to_string(), address);
        attrs.insert("local".to_string(), locale.clone());
        let resolved = Gen::new("template", attrs);

        let built = template_values(&resolved, 1, prng, env)?;
        result.push(built.into_iter().next().unwrap_or_default());
    }
    Ok(result)
}

/// Which rows a column applies to.
///
/// `parent="Gender"` means "wherever Gender has a value"; `parent="Gender.Male"`
/// means "wherever Gender is Male". A child may only name a parent declared
/// BEFORE it, which is why this reads the columns built so far rather than the
/// config.
fn parent_mask(
    spec: &SequenceSpec,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    count: usize,
) -> EngineResult<Vec<bool>> {
    let Some(parent) = spec.parent.as_deref() else {
        return Ok(vec![true; count]);
    };

    let (parent_name, parent_value) = match parent.find('.') {
        Some(dot) => (&parent[..dot], Some(&parent[dot + 1..])),
        None => (parent, None),
    };

    let Some(column) = columns.get(parent_name) else {
        return invalid(&format!(
            "sequence \"{}\" references unknown parent \"{parent_name}\". Parent \
             sequences must be declared before their children.",
            spec.name
        ));
    };

    Ok((0..count)
        .map(|i| match parent_value {
            None => column.get(i).is_some_and(Option::is_some),
            Some(want) => column.get(i).and_then(Option::as_deref) == Some(want),
        })
        .collect())
}

/// Lay dense produced values back over the full row range, leaving filtered rows
/// `None`.
///
/// `None` means "this row is outside the column's parent filter", which renders
/// as empty rather than as a neighbour's value shifted up — the failure a dense
/// array would produce silently.
fn spread(mask: &[bool], produced: Vec<String>, count: usize) -> Vec<Option<String>> {
    let mut values = vec![None; count];
    let mut next = 0usize;
    for (i, on) in mask.iter().enumerate().take(count) {
        if *on {
            values[i] = produced.get(next).cloned();
            next += 1;
        }
    }
    values
}

/// A conditional sequence: the first branch whose condition holds wins.
///
/// Every branch is generated in FULL, for every row, even though at most one
/// value survives on each. That is not waste to be optimised away — the draws a
/// branch takes are part of the stream, so generating only the winning branch
/// would make the whole run depend on which branch happened to win, and two
/// engines would stop agreeing.
fn conditional(
    branches: &[Branch],
    count: usize,
    prng: &mut Sfc32,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    env: &Env,
) -> EngineResult<Vec<Option<String>>> {
    if count == 0 {
        return Ok(Vec::new());
    }

    let mut built = Vec::with_capacity(branches.len());
    for branch in branches {
        let drawn = generate(&branch.gen, count, prng, env)?;
        built.push(finish(drawn, &branch.gen.attrs, prng, None)?);
    }

    let mut result = vec![None; count];
    for (i, slot) in result.iter_mut().enumerate() {
        for (b, branch) in branches.iter().enumerate() {
            let holds = match &branch.if_expr {
                None => true,
                Some(condition) => condition_at(condition, columns, i)?,
            };
            if holds {
                *slot = Some(built[b][i].clone());
                break;
            }
        }
    }
    Ok(result)
}

/// One `if=` expression, against one row.
fn condition_at(
    source: &str,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    row: usize,
) -> EngineResult<bool> {
    let scope = RowLookup { columns, row };
    evaluate::as_condition(source, &scope)
}

/// One row of a `<compute>` sequence, against the columns already built.
fn compute_row(
    tree: &Element,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    row: usize,
) -> EngineResult<String> {
    let fields = ColumnFields { columns, row };
    compute::evaluate(tree, &fields).map_err(|e| EngineError::Invalid(e.message))
}

/// The columns of one row, as the compute layer sees them.
struct ColumnFields<'a> {
    columns: &'a BTreeMap<String, Vec<Option<String>>>,
    row: usize,
}

impl compute::Fields for ColumnFields<'_> {
    fn get(&self, name: &str) -> Option<String> {
        self.columns.get(name)?.get(self.row)?.clone()
    }
}

/// How many redraws a `<valid>` constraint gets before the pack is called impossible.
const VALID_FUSE: usize = 100;

/// A pack whose body is a rule rather than a list.
///
/// Two shapes: a lone `<gen>`, which is just that generator; or a COMPOSED body
/// — local sequences, an output template, and an optional `<valid>` predicate.
/// The composed form is how an identifier with a check digit lives as editable
/// data instead of engine code.
fn pack_generator(
    body: &str,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    // A body holding <sequence> or <data> is composed; anything else is a lone
    // <gen>.
    if !body.contains("<sequence") && !body.contains("<data") {
        let gen =
            config_builder::parse_gen_tag(body).map_err(|e| EngineError::Invalid(e.message))?;
        return generate(&gen, count, prng, env);
    }

    let pack =
        config_builder::parse_pack_body(body).map_err(|e| EngineError::Invalid(e.message))?;
    let mut local: BTreeMap<String, Vec<Option<String>>> = BTreeMap::new();
    for spec in &pack.sequences {
        let values = materialize_local(spec, count, prng, env, &local)?;
        local.insert(spec.name.clone(), values);
    }

    if let Some(valid) = &pack.validate {
        enforce_valid(&pack, valid, &mut local, count, prng, env)?;
    }

    let mut rendered = Vec::with_capacity(count);
    for row in 0..count {
        let lookup = RowLookup {
            columns: &local,
            row,
        };
        rendered.push(interpolate::apply(
            &pack.output,
            env.config.inject.as_deref(),
            &lookup,
        )?);
    }
    Ok(rendered)
}

/// One local sequence of a pack body: a computed value, or an ordinary column.
fn materialize_local(
    spec: &SequenceSpec,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    local: &BTreeMap<String, Vec<Option<String>>>,
) -> EngineResult<Vec<Option<String>>> {
    if let Source::Compute(tree) = &spec.source {
        let mut values = Vec::with_capacity(count);
        for row in 0..count {
            values.push(Some(compute_row(tree, local, row)?));
        }
        return Ok(values);
    }

    let Some(gen) = spec.gen() else {
        return unsupported("a pack sequence that is neither a <gen> nor a <compute>");
    };
    let produced = generate(gen, count, prng, env)?;
    Ok(finish(produced, &gen.attrs, prng, None)?
        .into_iter()
        .map(Some)
        .collect())
}

/// Reject and redraw until the pack's `<valid>` predicate holds.
///
/// Some identifiers have combinations that were never issued — a region code
/// that does not exist, a date inside a national ID that never happened.
/// Redrawing APPENDS to the stream, so the result stays deterministic; the fuse
/// is there because a constraint no draw can satisfy would otherwise hang the
/// run rather than report itself.
#[allow(clippy::too_many_arguments)]
fn enforce_valid(
    pack: &config_builder::PackGenerator,
    valid: &Element,
    local: &mut BTreeMap<String, Vec<Option<String>>>,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<()> {
    for row in 0..count {
        let mut attempts = 0usize;
        while !holds(valid, local, row)? {
            attempts += 1;
            if attempts > VALID_FUSE {
                return invalid(&format!(
                    "pack generator: <valid> still fails after {VALID_FUSE} attempts — the \
                     constraint may be impossible"
                ));
            }
            for spec in &pack.sequences {
                let replacement = materialize_local(spec, 1, prng, env, local)?.remove(0);
                if let Some(column) = local.get_mut(&spec.name) {
                    column[row] = replacement;
                }
            }
        }
    }
    Ok(())
}

fn holds(
    valid: &Element,
    local: &BTreeMap<String, Vec<Option<String>>>,
    row: usize,
) -> EngineResult<bool> {
    let fields = ColumnFields {
        columns: local,
        row,
    };
    compute::evaluate_predicate(valid, &fields).map_err(|e| EngineError::Invalid(e.message))
}

/// `<gen type="template" value="person.lastName"/>` — a value out of a pack.
///
/// A weighted pack goes through the SAME apportionment `percent=` uses, not a
/// biased draw: a run of 30,000 rows from a census file contains precisely as
/// many Jameses as the census says, rather than approximately that many.
fn template_values(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    let path = gen.attr_or("value", "");

    // Two template paths are generators rather than packs, resolved before the
    // registry is consulted — which is why no pack file is named after either.
    if path == "person.b_day" {
        return (0..count)
            .map(|_| {
                date::gen::birth_day(
                    &gen.attrs,
                    env.config.locale.as_deref(),
                    env.now_millis,
                    prng,
                )
            })
            .collect();
    }
    if path == "date.range" {
        return date::gen::legacy_range(
            &gen.attrs,
            env.config.locale.as_deref(),
            env.now_millis,
            count,
            prng,
        );
    }

    // The pack may name its own locale, which is how one config mixes a Russian
    // name with a French address.
    let locale = match gen.attr("local").map(str::trim).filter(|l| !l.is_empty()) {
        Some(l) => l,
        None => env.config.locale_or_default(),
    };
    let entry = env.packs.load(path, locale)?;

    if let Some(body) = &entry.generator {
        return pack_generator(body, count, prng, env);
    }

    if let Some(percents) = &entry.percents {
        return Ok(hamilton::distribute(
            count as i32,
            &entry.values,
            percents,
            prng,
        ));
    }

    Ok((0..count)
        .map(|_| {
            let at = (prng.next() * entry.values.len() as f64).floor() as usize;
            entry.values[at.min(entry.values.len() - 1)].clone()
        })
        .collect())
}

/// `<gen type="text" value="a,b,c"/>` — one of a written-down list.
fn text(gen: &Gen, count: usize, prng: &mut Sfc32) -> EngineResult<Vec<String>> {
    let list = split_text(gen.attr_or("value", ""));

    if gen.attr("order") == Some("sequential") {
        // `cycle` defaults to on: a list shorter than the run repeats rather
        // than running out. Only the literal "false" turns it off.
        let cycle = gen.attr("cycle") != Some("false");
        return (0..count)
            .map(|i| pick_sequential(&list, i, cycle))
            .collect();
    }

    let percent = gen.attr_or("percent", "");
    if !percent.is_empty() {
        // Through the shared mask reader, so a partial mask like percent="50"
        // over three values splits the remainder instead of refusing the blanks.
        let shares = percent_mask::expand(percent, list.len())
            .map_err(|e| EngineError::Invalid(e.message))?;
        return Ok(hamilton::distribute(count as i32, &list, &shares, prng));
    }

    Ok((0..count)
        .map(|_| {
            let at = (prng.next() * list.len() as f64).floor() as usize;
            list[at.min(list.len().saturating_sub(1))].clone()
        })
        .collect())
}

/// `value="a, b ,c"` — commas separate, and the space around one does not count.
pub fn split_text(value: &str) -> Vec<String> {
    value.split(',').map(|p| p.trim().to_string()).collect()
}

/// The `i`th element in declaration order, wrapping or stopping at the end.
///
/// Without `cycle`, a run longer than the list leaves the tail empty rather than
/// repeating — which is how a fixture of exactly N rows is written.
/// Row `i` of a list walked in order.
///
/// Running off the end with `cycle="false"` is an ERROR rather than a blank.
/// Silently emitting empty cells for the tail of a run is the failure this
/// project exists to prevent: the file looks the right length and its last
/// thousand rows say nothing.
pub(super) fn pick_sequential(list: &[String], i: usize, cycle: bool) -> EngineResult<String> {
    if list.is_empty() {
        return Ok(String::new());
    }
    if !cycle && i >= list.len() {
        return invalid(&format!(
            "order=\"sequential\" cycle=\"false\": only {} values for {} rows",
            list.len(),
            i + 1
        ));
    }
    Ok(list[i % list.len()].clone())
}

// ── rendering ────────────────────────────────────────────────────────────────

fn emit(config: &Config, columns: &BTreeMap<String, Vec<Option<String>>>) -> EngineResult<String> {
    let fx = &config.fixtures;
    let each = each_info(config)?;
    let count = config.count.max(0) as usize;
    let mut out = String::new();

    emit_lines(&mut out, &fx.before, columns, 0, config, &each)?;
    for row in 0..count {
        emit_lines(&mut out, &fx.before_block, columns, row, config, &each)?;

        // Drop the suppressed lines first. A delimiter belongs between the lines
        // that survive, so deciding that up front is what keeps a separator off
        // the last one.
        let mut active: Vec<&Line> = Vec::new();
        for line in &config.block {
            let keep = match &line.if_expr {
                None => true,
                Some(expr) => condition_at(expr, columns, row)?,
            };
            if keep {
                active.push(line);
            }
        }

        for (i, line) in active.iter().enumerate() {
            emit_lines(&mut out, &fx.before_line, columns, row, config, &each)?;
            out.push_str(&render_line(line, columns, row, config, &each)?);
            emit_lines(&mut out, &fx.after_line, columns, row, config, &each)?;
            if i + 1 < active.len() {
                emit_lines(&mut out, &fx.delimiter_line, columns, row, config, &each)?;
            }
        }

        emit_lines(&mut out, &fx.after_block, columns, row, config, &each)?;
        if row + 1 < count {
            emit_lines(&mut out, &fx.delimiter_block, columns, row, config, &each)?;
        }
    }

    emit_lines(
        &mut out,
        &fx.after,
        columns,
        count.saturating_sub(1),
        config,
        &each,
    )?;
    Ok(out)
}

fn emit_lines(
    to: &mut String,
    lines: &[Line],
    columns: &BTreeMap<String, Vec<Option<String>>>,
    row: usize,
    config: &Config,
    each: &BTreeMap<String, repeat::Spec>,
) -> EngineResult<()> {
    for line in lines {
        to.push_str(&render_line(line, columns, row, config, each)?);
    }
    Ok(())
}

/// The repeating sequences, indexed by name.
///
/// A name that is not here is not a list, so `each=` on it walks nothing.
pub(super) fn each_info(config: &Config) -> EngineResult<BTreeMap<String, repeat::Spec>> {
    let mut result = BTreeMap::new();
    for spec in &config.sequences {
        if let Some(gen) = spec.gen() {
            if let Some(repeat) = repeat::parse(&gen.attrs)? {
                result.insert(spec.name.clone(), repeat);
            }
        }
    }
    Ok(result)
}

/// One line — or, with `each="NAME"`, one line per element of that list.
///
/// Returns the text with its newline already attached, because a line with
/// `each` may produce several and a list with nothing in it must produce NONE at
/// all: a customer with no orders leaves no blank row behind.
fn render_line(
    line: &Line,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    row: usize,
    config: &Config,
    each_info: &BTreeMap<String, repeat::Spec>,
) -> EngineResult<String> {
    let mut template = String::new();
    for part in &line.parts {
        let keep = match &part.if_expr {
            None => true,
            Some(expr) => condition_at(expr, columns, row)?,
        };
        if keep {
            template.push_str(&part.text);
        }
    }

    let list_name = line
        .each
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let Some(list_name) = list_name else {
        let lookup = RowLookup { columns, row };
        let mut text = interpolate::apply(&template, config.inject.as_deref(), &lookup)?;
        text.push('\n');
        return Ok(text);
    };

    let spec = each_info.get(list_name);
    let cell = columns
        .get(list_name)
        .and_then(|c| c.get(row))
        .and_then(Option::as_deref);
    let elements = repeat::split(
        cell,
        spec.map_or(repeat::DEFAULT_SEPARATOR, |s| s.separator.as_str()),
    );

    // Lanes: two repeating sequences write into the same child table, so each
    // gets its own slice of every card's key block rather than sharing one
    // counter.
    let mut lane = 0i64;
    let mut stride = 0i64;
    for (name, info) in each_info {
        if name == list_name {
            lane = stride;
        }
        stride += i64::from(info.max);
    }
    if stride == 0 {
        stride = elements.len() as i64;
    }

    let mut result = String::new();
    for (k, element) in elements.iter().enumerate() {
        let lookup = ElementLookup {
            base: RowLookup { columns, row },
            list_name,
            element,
            item: (k + 1) as i64,
            item_id: repeat::item_key(row as i64 + 1, (k + 1) as i64, lane, stride),
        };
        result.push_str(&interpolate::apply(
            &template,
            config.inject.as_deref(),
            &lookup,
        )?);
        result.push('\n');
    }
    Ok(result)
}

/// The row's view with one element of a list substituted for the list itself,
/// plus the two positional built-ins `_item` and `_item_id`.
///
/// Shallow on purpose: every other column still resolves per record, which is
/// exactly what makes a foreign key on the repeated line point at the right
/// parent on every emitted row.
struct ElementLookup<'a> {
    base: RowLookup<'a>,
    list_name: &'a str,
    element: &'a str,
    item: i64,
    item_id: i64,
}

impl Lookup for ElementLookup<'_> {
    fn has(&self, name: &str) -> bool {
        name == self.list_name || name == "_item" || name == "_item_id" || self.base.has(name)
    }

    fn value(&self, name: &str) -> String {
        match name {
            n if n == self.list_name => self.element.to_string(),
            "_item" => self.item.to_string(),
            "_item_id" => self.item_id.to_string(),
            _ => self.base.value(name),
        }
    }
}

/// What a name resolves to on one row.
struct RowLookup<'a> {
    columns: &'a BTreeMap<String, Vec<Option<String>>>,
    row: usize,
}

/// The same view serves the expression layer, so `${{X}}` and `if="X"` can never
/// disagree about what a name means on a row.
impl evaluate::Scope for RowLookup<'_> {
    fn has(&self, name: &str) -> bool {
        Lookup::has(self, name)
    }

    fn value(&self, name: &str) -> String {
        Lookup::value(self, name)
    }
}

impl Lookup for RowLookup<'_> {
    /// Whether the COLUMN exists — not whether this row has a value in it.
    ///
    /// The distinction carries the whole behaviour of an unresolved marker.
    /// `${{Gendre}}` names nothing, so it is left in the output where the first
    /// row makes the typo obvious. `${{Currency}}` on a row whose switch matched
    /// no key names a real column that simply has no value here, and that
    /// renders empty — a country with no entry in a currency table has no
    /// currency, and printing the marker would read as a broken config.
    fn has(&self, name: &str) -> bool {
        self.columns.contains_key(name)
    }

    fn value(&self, name: &str) -> String {
        self.columns
            .get(name)
            .and_then(|c| c.get(self.row))
            .and_then(|v| v.clone())
            .unwrap_or_default()
    }
}
