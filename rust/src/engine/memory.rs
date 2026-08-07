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

use super::per_row;
use super::{invalid, not_ported, EngineError, EngineResult, RowSource};
use crate::compute;
use crate::date;
use crate::distribution::percent_mask;
use crate::expr::evaluate;
use crate::expr::evaluate as expr;
use crate::format::interpolate::{self, Lookup};
use crate::format::{mask, transforms};
use crate::generators::accumulate;
use crate::generators::date_offset;
use crate::generators::stat;
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
/// Publish a statistic over the whole run: ONE value, on every row.
///
/// Reads its source out of the columns rather than drawing anything, exactly as
/// a running total does — which is why adding one leaves every other column
/// where it was.
fn stat_column(
    spec: &SequenceSpec,
    gen: &Gen,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
    count: usize,
) -> EngineResult<()> {
    let of = gen.attrs.get("of").map(|s| s.trim()).unwrap_or("");
    let Some(source) = columns.get(of).cloned() else {
        return Ok(()); // unknown column — the validator reports it
    };
    let Some(op) = stat::read_op(&gen.attrs) else {
        return Ok(()); // no op — likewise
    };
    // A bad decimals= is a diagnostic, not a crash.
    let Ok(decimals) = stat::parse_decimals(&gen.attrs) else {
        return Ok(());
    };
    let values: Vec<Option<String>> = source.into_iter().take(count).collect();
    match stat::statistic(&values, &op, decimals) {
        Ok(answer) => {
            columns.insert(spec.name.clone(), vec![Some(answer); count]);
            Ok(())
        }
        Err(message) => invalid(&message),
    }
}

/// A date measured from another date. Reads a sibling column, so it lives here
/// beside `running` and `stat` rather than in the generator dispatch.
#[allow(clippy::too_many_arguments)]
fn date_offset_column(
    spec: &SequenceSpec,
    gen: &Gen,
    columns: &mut BTreeMap<String, Vec<Option<String>>>,
    instants: &mut BTreeMap<String, Vec<Option<i64>>>,
    wants_instant: &BTreeSet<String>,
    count: usize,
    prng: &mut Sfc32,
    locale: Option<&str>,
) -> EngineResult<()> {
    let of = date_offset::source_of(&gen.attrs).to_string();
    let Some(source) = columns.get(&of).cloned() else {
        return Ok(()); // unknown column — the validator reports it
    };
    let (values, own) = date_offset::build(
        &spec.name,
        &gen.attrs,
        &source,
        instants.get(&of),
        count,
        prng,
        locale,
        wants_instant.contains(&spec.name),
    )?;
    columns.insert(spec.name.clone(), values);
    if let Some(kept) = own {
        instants.insert(spec.name.clone(), kept);
    }
    Ok(())
}

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
    // The REAL value behind a date column's text, for the columns some offset reads.
    //
    // A date cell holds a PRESENTATION: `02/03/2026` in an en locale, `03.02.2026`
    // in a ru one, `March 2` under format="MMMM D". Reading a date back out of that
    // is guesswork at best and impossible at worst — the last form has thrown the
    // year away. So the column that produced it keeps what it actually generated,
    // and an offset measures from THAT. Only the columns named by some `of=` are
    // kept, so a config with no offset in it pays nothing.
    let mut instants: BTreeMap<String, Vec<Option<i64>>> = BTreeMap::new();
    let wants_instant: BTreeSet<String> = env
        .config
        .sequences
        .iter()
        .filter_map(|spec| match &spec.source {
            Source::Gen(gen) if date_offset::is_offset(&gen.gen_type, &gen.attrs) => {
                Some(date_offset::source_of(&gen.attrs).to_string())
            }
            _ => None,
        })
        .collect();

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
    // What each finished column's exact layout gave each row, by column name. A child that
    // filters on one of them is ordered by its RANK there, not by row order.
    let mut layouts: BTreeMap<String, per_row::ExactLayout> = BTreeMap::new();

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
        // In the order the column BUILDS them, which for a child is its rank inside
        // the parent's exact layout rather than plain row order.
        let rows = per_row::ordered_rows(spec.parent.as_deref(), &mask, &layouts);
        let applicable = rows.len();

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
            // A statistic over the whole run. Resolved here for the same reason
            // and by the same rule: it reads a column that already exists, so
            // `of=` has to name a sequence declared above it.
            if gen.gen_type == "stat" {
                stat_column(spec, gen, &mut columns, count)?;
                continue;
            }
            // A date measured from another date, for the same reason and by the
            // same rule: it reads a column that already exists.
            if date_offset::is_offset(&gen.gen_type, &gen.attrs) {
                date_offset_column(
                    spec,
                    gen,
                    &mut columns,
                    &mut instants,
                    &wants_instant,
                    count,
                    &mut prng,
                    env.config.locale.as_deref(),
                )?;
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
                columns.insert(spec.name.clone(), spread(&rows, values, count));
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
                columns.insert(spec.name.clone(), spread(&rows, values, count));
            }

            Source::Gen(gen) => {
                let mut anomaly_flags = vec![false; applicable];
                let stream = per_row::Stream::with_rows(&env.config.seed, &spec.name, rows.clone());
                let flag_named = gen
                    .attr("anomaly_flag")
                    .map(str::trim)
                    .is_some_and(|f| !f.is_empty());
                // With `repeat` the anomaly label is a LIST parallel to the values, saying
                // which ELEMENT spiked rather than merely that one did.
                let mut repeat_flags: Option<Vec<String>> = None;
                let values = match repeat::parse(&gen.attrs)? {
                    // A listed column lays every element of every row out at once and reads
                    // the slots the length plan gave the row; anything drawn takes one
                    // sub-stream per element. Which of the two is the streaming engine's own
                    // split.
                    Some(repeat_spec) => match listed_values(gen, env)? {
                        Some((values, percents)) => {
                            let mut modify = element_modifier(gen, &repeat_spec, &stream)?;
                            super::repeat_keyed::build_layout(
                                &repeat_spec,
                                &values,
                                &percents,
                                applicable,
                                &stream,
                                &mut modify,
                            )?
                        }
                        None => {
                            let element =
                                Gen::new(gen.gen_type.clone(), repeat::without(&gen.attrs));
                            let mut collected = flag_named.then(Vec::new);
                            let built = super::repeat_keyed::build_draws(
                                &repeat_spec,
                                applicable,
                                &stream,
                                |_, element_prng, flag| {
                                    let drawn = generate(&element, 1, element_prng, env)?;
                                    let done =
                                        finish(drawn, &element.attrs, element_prng, Some(flag))?;
                                    Ok(done.into_iter().next().unwrap_or_default())
                                },
                                collected.as_mut(),
                            )?;
                            repeat_flags = collected;
                            built
                        }
                    },
                    None => {
                        // A column some `<gen type="date" of="…">` measures from keeps the
                        // instant it generated beside the text it renders. Nothing else asks,
                        // so nothing else allocates.
                        let mut collected: Option<Vec<Option<i64>>> = (gen.gen_type == "date"
                            && wants_instant.contains(&spec.name))
                        .then(Vec::new);
                        let built = column_values_into(
                            gen,
                            applicable,
                            &mut prng,
                            env,
                            Some(&stream),
                            Some(&mut anomaly_flags),
                            Some(&mut layouts),
                            collected.as_mut(),
                        )?;
                        if let Some(drawn) = collected {
                            // Laid over the real rows exactly as the values are: a filtered
                            // column builds compacted and is spread afterwards, so the two must
                            // be spread the same way or an offset would measure row 3 from
                            // row 1's date.
                            let mut over = vec![None; count];
                            for (i, row) in rows.iter().enumerate() {
                                over[*row] = drawn.get(i).copied().flatten();
                            }
                            instants.insert(spec.name.clone(), over);
                        }
                        built
                    }
                };
                columns.insert(spec.name.clone(), spread(&rows, values, count));

                if let Some(flag_name) = gen
                    .attr("anomaly_flag")
                    .map(str::trim)
                    .filter(|f| !f.is_empty())
                {
                    // The ground-truth companion: which rows the run chose to spike. It
                    // shares the parent mask, so the label is absent exactly where the value
                    // is — a detector trained on this cannot learn from a label the data
                    // never had. With `repeat` the label is a LIST parallel to the values,
                    // saying which ELEMENT spiked rather than merely that one did.
                    let labels = repeat_flags.unwrap_or_else(|| {
                        anomaly_flags
                            .into_iter()
                            .map(|on| if on { "true" } else { "false" }.to_string())
                            .collect()
                    });
                    columns.insert(flag_name.to_string(), spread(&rows, labels, count));
                }
            }

            Source::Mix(mix) => {
                let mut flags = vec![false; applicable];
                // The '#switch' suffix is a stable historical key: the streaming engine
                // spells it that way so a <mix> keeps the values of the <switch> it replaced.
                let stream = per_row::Stream::with_rows(
                    &env.config.seed,
                    &format!("{}#switch", spec.name),
                    rows.clone(),
                );
                let values = mix_values(
                    mix,
                    applicable,
                    &mut prng,
                    Some(&mut flags),
                    env,
                    Some(&stream),
                    &columns,
                )?;
                columns.insert(spec.name.clone(), spread(&rows, values, count));

                if let Some(flag_name) =
                    mix.flag.as_deref().map(str::trim).filter(|f| !f.is_empty())
                {
                    // The ground-truth companion: which rows took a case declared
                    // anomalous. A detector trained on this cannot learn from a
                    // label the data never had.
                    columns.insert(
                        flag_name.to_string(),
                        spread(
                            &rows,
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
                let values =
                    switch_values(sw, count, &mut prng, &columns, env, &spec.name, &layouts)?;
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
                // Unnamed parts are numbered among ALL parts, literals included, because that
                // is how the streaming engine numbers them.
                let mut unnamed = 0usize;

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
                            let part = per_row::Stream::with_rows(
                                &env.config.seed,
                                &format!("{}.{}", spec.name, field.name),
                                rows.clone(),
                            );
                            produced.push((
                                field.name.clone(),
                                column_values(
                                    &field.gen,
                                    applicable,
                                    &mut prng,
                                    env,
                                    Some(&part),
                                    None,
                                    Some(&mut layouts),
                                )?,
                            ));
                        }
                        Item::Gen(gen) => {
                            let part = per_row::Stream::with_rows(
                                &env.config.seed,
                                &format!("{}#p{unnamed}", spec.name),
                                rows.clone(),
                            );
                            unnamed += 1;
                            let values = if uniq_draw {
                                super::uniq_simple::build(
                                    &spec.name, gen, applicable, &mut prng, env,
                                )?
                            } else {
                                column_values(
                                    gen,
                                    applicable,
                                    &mut prng,
                                    env,
                                    Some(&part),
                                    None,
                                    Some(&mut layouts),
                                )?
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
                    enforce_distinct(spec, &fields, &mut produced, applicable, env, &rows, None)?;
                }

                // Only when something unnamed actually composed it. A body of
                // nothing but named items has no value of its own, and
                // `${{Name}}` stays the literal marker that says you meant a
                // field.
                if composes_own_value(items) {
                    columns.insert(spec.name.clone(), spread(&rows, composed, count));
                }
                for (field_name, values) in produced {
                    columns.insert(
                        format!("{}.{field_name}", spec.name),
                        spread(&rows, values, count),
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
                    let stream = per_row::Stream::with_rows(
                        &env.config.seed,
                        &format!("{}.{}", spec.name, field.name),
                        rows.clone(),
                    );
                    produced.push((
                        field.name.clone(),
                        column_values(
                            &field.gen,
                            applicable,
                            &mut prng,
                            env,
                            Some(&stream),
                            None,
                            Some(&mut layouts),
                        )?,
                    ));
                }
                // Both run over FINISHED fields: a group's members must all
                // exist before the constraint between them means anything.
                if !spec.distinct_groups.is_empty() {
                    enforce_distinct(spec, fields, &mut produced, applicable, env, &rows, None)?;
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
                        spread(&rows, values, count),
                    );
                }
            }

            Source::Branches(branches) => {
                let (values, flag_columns) =
                    conditional(&spec.name, branches, count, &mut prng, &columns, env)?;
                columns.insert(spec.name.clone(), values);
                for (flag_name, flag_values) in flag_columns {
                    columns.insert(flag_name, flag_values);
                }
            }
        }
    }

    // Both run over finished columns, for the same reason the per-sequence ones
    // do — and after the loop, because a group may name a sequence declared last.
    enforce_env_distinct(env, &mut columns, count)?;
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
/// `shared_prng` is for a PACK BODY, which is a nested build with no seed of its
/// own: there is nothing to key a repair stream by, so the replacement comes off
/// the prng the body was handed. The reference draws exactly this distinction,
/// and a Spanish or Portuguese full name — two given names and two surnames,
/// each pair `<distinct>` — is where it shows.
fn enforce_distinct(
    spec: &SequenceSpec,
    fields: &[Field],
    produced: &mut [(String, Vec<String>)],
    count: usize,
    env: &Env,
    rows: &[usize],
    mut shared_prng: Option<&mut Sfc32>,
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
                    // Each attempt has a stream of its own, named for the field and the
                    // attempt number — the same names the streaming engine redraws under, so
                    // both engines land on the same replacement.
                    let drawn = match shared_prng.as_deref_mut() {
                        Some(prng) => generate(&field.gen, 1, prng, env)?,
                        None => {
                            let row = rows.get(i).copied().unwrap_or(i);
                            let mut one = seekable::generator(
                                &env.config.seed,
                                &format!("{}.{field_name}#d{attempts}", spec.name),
                                row as i32,
                            );
                            generate(&field.gen, 1, &mut one, env)?
                        }
                    };
                    value = drawn.into_iter().next().unwrap_or_default();
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

    // Already unique as drawn? Then there is nothing to rearrange, and moving values anyway
    // would only make this engine disagree with the exact one, which checks the same thing
    // first and leaves a passing draw untouched. Cheap enough to always ask: one pass, one set.
    // NUL joins the tuple because a generated value cannot contain it, so no two different
    // tuples can join into the same key.
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let collided = (0..count).any(|i| {
        let key = columns
            .iter()
            .map(|c| c.get(i).map(String::as_str).unwrap_or(""))
            .collect::<Vec<_>>()
            .join("\0");
        !seen.insert(key)
    });
    if !collided {
        return Ok(());
    }

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
                    // Named for the sequence and the attempt, exactly as the streaming engine
                    // names it, so the replacement is the same value on both engines.
                    let mut one = seekable::generator(
                        &env.config.seed,
                        &format!("{name}#ed{attempts}"),
                        i as i32,
                    );
                    value = one_scalar(spec, &mut one, env)?;
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
            Ok(
                mix_values(mix, 1, prng, Some(&mut flags), env, None, &BTreeMap::new())?
                    .into_iter()
                    .next()
                    .unwrap_or_default(),
            )
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
    values: Vec<String>,
    attrs: &BTreeMap<String, String>,
    prng: &mut Sfc32,
    anomaly_flags: Option<&mut [bool]>,
) -> EngineResult<Vec<String>> {
    finish_into(values, attrs, prng, anomaly_flags, None)
}

/// `finish`, also clearing the instant behind any cell `missing=` blanked.
///
/// A blanked cell no longer shows the date it was built from, so a column
/// measuring from this one must find nothing there rather than produce a date on
/// a row whose source says nothing. `mask=`/`case=` change only the SPELLING,
/// which is exactly what the instant outlives.
pub(super) fn finish_into(
    mut values: Vec<String>,
    attrs: &BTreeMap<String, String>,
    prng: &mut Sfc32,
    anomaly_flags: Option<&mut [bool]>,
    instants: Option<&mut Vec<Option<i64>>>,
) -> EngineResult<Vec<String>> {
    if let Some(anomaly) = imperfections::parse_anomaly(attrs)? {
        imperfections::apply_anomaly(&mut values, anomaly, prng, anomaly_flags);
    }
    if let Some(missing) = imperfections::parse_missing(attrs)? {
        let before = values.clone();
        imperfections::apply_missing(&mut values, &missing, prng);
        if let Some(sink) = instants {
            for i in 0..values.len().min(sink.len()) {
                if values[i] != before[i] {
                    sink[i] = None;
                }
            }
        }
    }
    format_values(values, attrs)
}

/// `case=` and `mask=`, which reach the same code the `|upper` and `|mask:` filters do so the
/// three ways of asking cannot drift apart.
fn format_values(
    mut values: Vec<String>,
    attrs: &BTreeMap<String, String>,
) -> EngineResult<Vec<String>> {
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
/// `finish`, with the anomaly and missing draws taken from a stream rather than in order.
fn finish_with(
    mut values: Vec<String>,
    attrs: &BTreeMap<String, String>,
    prng: &mut Sfc32,
    mut anomaly_flags: Option<&mut [bool]>,
    stream: Option<&per_row::Stream>,
) -> EngineResult<Vec<String>> {
    if let Some(anomaly) = imperfections::parse_anomaly(attrs)? {
        match stream {
            Some(s) => {
                for i in 0..values.len() {
                    let selected = anomaly.probability > 0.0
                        && per_row::purpose_draw(s, "#anom", s.row_at(i)) < anomaly.probability;
                    if let Some(flags) = anomaly_flags.as_deref_mut() {
                        flags[i] = selected;
                    }
                    if selected {
                        values[i] = imperfections::spike(&values[i], anomaly.factor);
                    }
                }
            }
            None => imperfections::apply_anomaly(&mut values, anomaly, prng, anomaly_flags.take()),
        }
    }
    if let Some(missing) = imperfections::parse_missing(attrs)? {
        match stream {
            Some(s) if missing.probability > 0.0 => {
                for (i, value) in values.iter_mut().enumerate() {
                    if per_row::purpose_draw(s, "#miss", s.row_at(i)) < missing.probability {
                        *value = missing.token.clone();
                    }
                }
            }
            Some(_) => {}
            None => imperfections::apply_missing(&mut values, &missing, prng),
        }
    }
    format_values(values, attrs)
}

/// A `<gen type="template">` pointing at a pack that carries its own shares.
///
/// A synthetic address (`person.b_day` and its kind) is resolved inside the generator and has
/// no pack file behind it, so asking the registry would fail rather than answer.
fn weighted_template_pack(gen: &Gen, env: &Env) -> EngineResult<Option<(Vec<String>, Vec<f64>)>> {
    if gen.gen_type != "template" {
        return Ok(None);
    }
    let path = gen.attr_or("value", "");
    let locale = gen
        .attr("local")
        .or(env.config.locale.as_deref())
        .unwrap_or("en");
    if path.is_empty() || !env.packs.exists(path, locale) {
        return Ok(None);
    }
    let entry = env.packs.load(path, locale)?;
    Ok(match (entry.weighted(), entry.percents.clone()) {
        (true, Some(percents)) => Some((entry.values.clone(), percents)),
        _ => None,
    })
}

/// Whether a pack GENERATOR apportions a share over the whole column. Its values are computed
/// rather than listed, so there is no list to lay out.
fn pack_needs_whole_column(gen: &Gen, env: &Env) -> bool {
    if gen.gen_type != "template" {
        return false;
    }
    let path = gen.attr_or("value", "");
    let locale = gen
        .attr("local")
        .or(env.config.locale.as_deref())
        .unwrap_or("en");
    // The same question the router asks, answered from the same place: this
    // engine and the router disagreeing about one pack would put the column on
    // the per-row path in an engine chosen precisely because it must not be.
    !path.is_empty() && env.packs.needs_whole_column(path, locale)
}

/// A weighted file column read as a value list and its shares.
fn weighted_file_values(gen: &Gen, env: &Env) -> EngineResult<Option<(Vec<String>, Vec<f64>)>> {
    let roots = env.packs.data_roots();
    Ok(file::load_weighted(&gen.attrs, env.base_dir, roots)?
        .map(|w| (w.values.clone(), w.percents.clone())))
}

/// One generator's finished values for a whole column, keyed the way the streaming engine
/// keys them.
///
/// Three shapes, and which one applies is the streaming engine's own split:
///
///   * a LISTED column — a `text` list, a weighted file column, a weighted pack — is laid out
///     exactly over the rows and permuted, never picked per row;
///   * an independent generator is built ROW BY ROW off `(seed, stream_id, row)`, with the
///     modifiers applied inside that loop so `anomaly=` spends the row's own draw;
///   * everything else keeps the older shape: generate the column, then finish it.
///
/// Without a `stream` — an inline generator, a nested pack body — all three collapse to the
/// last, which is what those callers want.
#[allow(clippy::too_many_arguments)]
pub(super) fn column_values(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    stream: Option<&per_row::Stream>,
    anomaly_flags: Option<&mut [bool]>,
    layouts: Option<&mut BTreeMap<String, per_row::ExactLayout>>,
) -> EngineResult<Vec<String>> {
    column_values_into(gen, count, prng, env, stream, anomaly_flags, layouts, None)
}

/// `column_values`, also keeping the instants behind a date column some offset reads.
#[allow(clippy::too_many_arguments)]
pub(super) fn column_values_into(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    stream: Option<&per_row::Stream>,
    anomaly_flags: Option<&mut [bool]>,
    layouts: Option<&mut BTreeMap<String, per_row::ExactLayout>>,
    mut instants: Option<&mut Vec<Option<i64>>>,
) -> EngineResult<Vec<String>> {
    let Some(stream) = stream else {
        let drawn = generate_into(gen, count, prng, env, instants.as_deref_mut())?;
        return finish_into(drawn, &gen.attrs, prng, anomaly_flags, instants);
    };

    if let Some((values, percents)) = listed_values(gen, env)? {
        let laid = per_row::exact_text_layout(&values, &percents, count, stream, layouts);
        return finish_keyed(laid, gen, prng, anomaly_flags, Some(stream));
    }

    // Two types the streaming engine builds INLINE: the value follows the position, and only
    // the one draw that perturbs it is keyed by the row.
    match gen.gen_type.as_str() {
        "timeseries" => {
            let built = timeseries_keyed(&gen.attrs, count, stream)?;
            return finish_keyed(built, gen, prng, anomaly_flags, Some(stream));
        }
        "pattern" => {
            let built = pattern_keyed(&gen.attrs, count, env, stream)?;
            return finish_keyed(built, gen, prng, anomaly_flags, Some(stream));
        }
        _ => {}
    }

    // A weighted choice inside an advanced_regex — `(?%{RU:70|US:20|DE:10})` — is a quota over
    // the column like any other share. Decided one row at a time it awards every row to the
    // largest share: 100% RU, not 70/20/10.
    let weighted = weighted_template_pack(gen, env)?.is_some()
        || (gen.gen_type == "advanced_regex"
            && advanced_regex::has_weighted_choice(gen.attr_or("value", "")));
    let whole_column = pack_needs_whole_column(gen, env);
    if per_row::per_row_buildable(gen, count, weighted, whole_column) {
        let mut out = Vec::with_capacity(count);
        let mut flags = anomaly_flags;
        for i in 0..count {
            let mut row_prng = per_row::row_generator(stream, stream.row_at(i));
            // One row's instant lands in its own scratch: the inner call knows nothing of `i`,
            // and a later `missing=` pass has to line up with the values it just blanked.
            let mut scratch: Option<Vec<Option<i64>>> = instants.as_ref().map(|_| Vec::new());
            let drawn = generate_into(gen, 1, &mut row_prng, env, scratch.as_mut())?;
            let mut one = [false];
            let done = finish_into(
                drawn,
                &gen.attrs,
                &mut row_prng,
                Some(&mut one),
                scratch.as_mut(),
            )?;
            out.push(done.into_iter().next().unwrap_or_default());
            if let Some(store) = flags.as_deref_mut() {
                store[i] = one[0];
            }
            if let (Some(sink), Some(row)) = (instants.as_deref_mut(), scratch) {
                sink.push(row.into_iter().next().flatten());
            }
        }
        return Ok(out);
    }

    let drawn = generate(gen, count, prng, env)?;
    finish_keyed(drawn, gen, prng, anomaly_flags, Some(stream))
}

/// `anomaly=`, `missing=` and the formatting layer for ONE element of a repeating LISTED
/// column.
///
/// The two probability draws come off the row's `#anom` and `#miss` streams with a budget of
/// the row's maximum length, so element k always gets the same uniform however long its row
/// turned out to be.
fn element_modifier<'a>(
    gen: &'a Gen,
    spec: &repeat::Spec,
    stream: &'a per_row::Stream,
) -> EngineResult<impl FnMut(usize, String, usize) -> String + 'a> {
    let anomaly = imperfections::parse_anomaly(&gen.attrs)?.filter(|a| a.probability > 0.0);
    let missing = imperfections::parse_missing(&gen.attrs)?.filter(|m| m.probability > 0.0);
    let mask_attr = gen.attr("mask").map(str::to_string);
    let case_name = gen
        .attr("case")
        .filter(|c| transforms::is_case_transform(c))
        .map(str::to_string);

    let budget = spec.max.max(1) as usize;
    let mut anom_at = anomaly
        .as_ref()
        .map(|_| super::repeat_keyed::element_uniforms(stream, "#anom", budget));
    let mut miss_at = missing
        .as_ref()
        .map(|_| super::repeat_keyed::element_uniforms(stream, "#miss", budget));

    Ok(move |row: usize, value: String, k: usize| -> String {
        let mut out = value;
        if let (Some(a), Some(draw)) = (anomaly.as_ref(), anom_at.as_mut()) {
            if draw(row, k) < a.probability {
                out = imperfections::spike(&out, a.factor);
            }
        }
        if let (Some(m), Some(draw)) = (missing.as_ref(), miss_at.as_mut()) {
            if draw(row, k) < m.probability {
                out = m.token.clone();
            }
        }
        if let Some(pattern) = mask_attr.as_deref() {
            out = mask::apply(pattern, &out).unwrap_or(out);
        }
        if let Some(case) = case_name.as_deref() {
            out = transforms::apply_case(case, &out);
        }
        out
    })
}

/// `<gen type="timeseries" noise=…>` keyed by the row.
///
/// The value follows the POSITION — a series read at a point of the run — while the noise
/// follows the ROW, on the dedicated `:ts` stream the streaming engine uses. Same two names,
/// same two uniforms, same series.
fn timeseries_keyed(
    attrs: &BTreeMap<String, String>,
    count: usize,
    stream: &per_row::Stream,
) -> EngineResult<Vec<String>> {
    let spec = timeseries::parse(attrs)?;
    let noisy = spec.has_noise();
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let z = if noisy {
            let u = seekable::uniforms(
                &stream.seed,
                &format!("{}:ts", stream.id),
                stream.row_at(i) as i32,
                2,
            );
            timeseries::standard_normal(u[0], u[1])
        } else {
            0.0
        };
        result.push(crate::numbers::to_fixed(
            timeseries::value_at(&spec, i as i64, z),
            spec.decimals,
        ));
    }
    Ok(result)
}

/// `<gen type="pattern">` keyed by the row.
///
/// As with timeseries: the curve is read at the POSITION, and the one draw that places the
/// value inside its band is keyed by the ROW on the streaming engine's `:pat` stream.
fn pattern_keyed(
    attrs: &BTreeMap<String, String>,
    count: usize,
    env: &Env,
    stream: &per_row::Stream,
) -> EngineResult<Vec<String>> {
    let gen = crate::pattern::PatternGen::of(attrs, env.base_dir, env.packs.data_roots())?;
    let draws = gen.draws();
    let denom = if count > 1 { (count - 1) as f64 } else { 1.0 };
    let mut result = Vec::with_capacity(count);
    for i in 0..count {
        let u = if draws {
            seekable::uniforms(
                &stream.seed,
                &format!("{}:pat", stream.id),
                stream.row_at(i) as i32,
                1,
            )[0]
        } else {
            0.0
        };
        result.push(gen.value_at(i as f64 / denom, u, 1.0 / denom));
    }
    Ok(result)
}

/// `finish`, with the two modifier draws taken from the column's own `#anom` and `#miss`
/// streams when the type is one the streaming engine builds inline.
fn finish_keyed(
    values: Vec<String>,
    gen: &Gen,
    prng: &mut Sfc32,
    anomaly_flags: Option<&mut [bool]>,
    stream: Option<&per_row::Stream>,
) -> EngineResult<Vec<String>> {
    match stream.filter(|_| per_row::is_inline_anomaly(&gen.gen_type)) {
        Some(s) => finish_with(values, &gen.attrs, prng, anomaly_flags, Some(s)),
        None => finish(values, &gen.attrs, prng, anomaly_flags),
    }
}

/// The value list and the shares a column lays out, when its values are LISTED.
fn listed_values(gen: &Gen, env: &Env) -> EngineResult<Option<(Vec<String>, Vec<f64>)>> {
    if gen.attr("order") == Some("sequential") {
        return Ok(None);
    }
    if gen.attrs.contains_key("weight") {
        // `row=` links whole rows of the file; the choice is not this column's.
        if !gen.attr("row").map(str::trim).unwrap_or("").is_empty() {
            return Ok(None);
        }
        return weighted_file_values(gen, env);
    }
    if let Some(pack) = weighted_template_pack(gen, env)? {
        return Ok(Some(pack));
    }
    if gen.gen_type != "text" {
        return Ok(None);
    }
    let values = split_text(gen.attr_or("value", ""));
    let shares = per_row::shares_of(gen.attr("percent"), values.len());
    Ok(Some((values, shares)))
}

pub(super) fn generate(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
) -> EngineResult<Vec<String>> {
    generate_into(gen, count, prng, env, None)
}

/// One generator's values, optionally keeping the instants behind a date column.
///
/// `instants` is threaded rather than derived afterwards because a date's cell is
/// a RENDERING — `02/03/2026` in an en locale, `03.02.2026` in a ru one — and
/// reading a date back out of that is a guess. The column that produced it keeps
/// what it generated, and an offset measures from THAT.
pub(super) fn generate_into(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    instants: Option<&mut Vec<Option<i64>>>,
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
                return not_ported(&format!("{gate}= on <gen>"));
            }
        }
    }

    match gen.gen_type.as_str() {
        "text" => text(gen, count, prng),
        "number" if gen.attrs.contains_key("distribution") => distributed(&gen.attrs, count, prng),
        "number" => number::generate(&gen.attrs, count, prng),
        // The same rule over a date range: row i is the i-th step from the start.
        // The axis is arithmetic rather than a list, so a long range costs
        // nothing to walk.
        "date" if gen.attrs.get("order").map(String::as_str) == Some("sequential") => {
            let axis =
                date::gen::date_axis(&gen.attrs, env.config.locale.as_deref(), env.now_millis)?;
            let cycle = gen.attrs.get("cycle").map(String::as_str) != Some("false");
            (0..count)
                .map(|i| match axis.size {
                    // An OPEN axis has no size and never wraps: row i is simply
                    // the i-th step.
                    None => Ok(axis.at(i as i64)),
                    Some(size) => Ok(axis.at(sequential_index(size as usize, i, cycle)? as i64)),
                })
                .collect()
        }
        "date" => date::gen::generate_into(
            &gen.attrs,
            env.config.locale.as_deref(),
            env.now_millis,
            count,
            prng,
            instants,
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
        other => not_ported(&format!("<gen type=\"{other}\">")),
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
    stream: Option<&per_row::Stream>,
    columns: &BTreeMap<String, Vec<Option<String>>>,
) -> EngineResult<Vec<String>> {
    let mut parts: Vec<String> = vec![String::new(); count];
    // Parts are numbered among ALL of them, literals included: the streaming engine numbers
    // them off the same list, and a different count here would key the same part under a
    // different name.
    for (p, part) in case.parts.iter().enumerate() {
        let sub = stream.map(|s| s.named(&format!("{}#p{p}", s.id)));
        let values: Vec<String> = match part {
            CasePart::Text(text) => vec![text.clone(); count],
            CasePart::Gen(gen) => column_values(gen, count, prng, env, sub.as_ref(), None, None)?,
            CasePart::Mix(mix) => mix_values(mix, count, prng, None, env, sub.as_ref(), columns)?,
            CasePart::Switch(sw) => {
                nested_switch_values(sw, count, prng, env, sub.as_ref(), columns)?
            }
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
    stream: Option<&per_row::Stream>,
    columns: &BTreeMap<String, Vec<Option<String>>>,
) -> EngineResult<Vec<String>> {
    if mix.cases.is_empty() {
        return Ok(vec![String::new(); count]);
    }

    let percents = match mix.percent.as_deref().map(str::trim) {
        None | Some("") => vec![100.0 / mix.cases.len() as f64; mix.cases.len()],
        Some(mask) => percent_mask::expand(mask, mix.cases.len())
            .map_err(|e| EngineError::Invalid(e.message))?,
    };

    // An inline mix inside a pack generator body has nothing to key by, so the older
    // arrangement stands there.
    let Some(stream) = stream else {
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
            let values = case_values(case, rows.len(), prng, env, None, columns)?;
            for (row, value) in rows.into_iter().zip(values) {
                result[row] = value;
            }
        }
        return Ok(result);
    };

    // Which case a row takes is the same exact layout a weighted list gets: a quota per case,
    // permuted over the rows. So the choice follows from the row alone, and the shares still
    // come out to the digit over the whole run.
    let mut pct_prng = prng::create(&format!("{}|{}|pct", stream.seed, stream.id));
    let counts = hamilton::counts_per_value(count as i32, &percents, &mut pct_prng);
    let layout_key = crate::prng::permute::key(&stream.seed, &stream.id);

    // Case c owns slots [cum_lo[c], cum_lo[c] + counts[c]).
    let mut cum_lo = Vec::with_capacity(counts.len());
    let mut acc = 0;
    for c in &counts {
        cum_lo.push(acc);
        acc += c;
    }

    // The permutation both ways. The streaming engine asks "which slot is this row?"; building
    // a case's body needs the reverse, "which row holds slot s?".
    let mut slot_of = vec![0i32; count];
    let mut position_of_slot = vec![0usize; count];
    for (i, at) in slot_of.iter_mut().enumerate() {
        let slot = crate::prng::permute::apply(i as i32, count as i32, layout_key);
        *at = slot;
        position_of_slot[slot as usize] = i;
    }
    let case_of_slot = |slot: i32| -> usize {
        for c in 0..counts.len() {
            if slot < cum_lo[c] + counts[c] {
                return c;
            }
        }
        counts.len() - 1
    };

    let mut result = vec![String::new(); count];
    for (c, case) in mix.cases.iter().enumerate() {
        let quota = counts[c];
        if quota == 0 {
            continue;
        }
        let positions: Vec<usize> = (0..quota)
            .map(|local| position_of_slot[(cum_lo[c] + local) as usize])
            .collect();
        let rows: Vec<usize> = positions.iter().map(|&p| stream.row_at(p)).collect();
        let sub = per_row::Stream::with_rows(&stream.seed, &format!("{}#c{c}", stream.id), rows);
        let values = case_values(case, quota as usize, prng, env, Some(&sub), columns)?;
        for (local, &position) in positions.iter().enumerate() {
            result[position] = values[local].clone();
        }
    }

    if let Some(flags) = flags {
        // The label reads the same slot-to-case mapping the value did, so the two cannot
        // disagree on a row — which is the whole point of a ground-truth column.
        for i in 0..count {
            flags[i] = mix.cases[case_of_slot(slot_of[i])].anomaly;
        }
    }

    Ok(result)
}

/// `<switch on="Subject">` — look the subject's value up in the table.
///
/// An entry is built over THE ROWS THAT CHOSE IT, exactly as a mix builds a case
/// over the rows it won. Every entry used to be built over the whole run and the
/// values that landed on rows belonging to another branch were dropped, so a
/// `<mix percent="20,80">` inside `<case is="Male">` apportioned its 20% across
/// all the rows rather than across the men. Measured over 100 runs of 10 rows
/// split 5/5: 0, 1 or 2 survivors, and 23 runs with none at all, where the config
/// plainly asked for one man in five.
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
    name: &str,
    layouts: &BTreeMap<String, per_row::ExactLayout>,
) -> EngineResult<Vec<Option<String>>> {
    // Group the rows by branch BEFORE generating: the subject's whole column is already here.
    let subject = columns.get(&sw.on);
    let mut entry_rows: Vec<Vec<usize>> = vec![Vec::new(); sw.entries.len()];
    let mut fallback_rows: Vec<usize> = Vec::new();
    for i in 0..count {
        let key = subject
            .and_then(|c| c.get(i))
            .and_then(|v| v.as_deref())
            .unwrap_or("");
        match sw
            .entries
            .iter()
            .position(|entry| entry.keys.iter().any(|k| k == key))
        {
            Some(e) => entry_rows[e].push(i),
            None => fallback_rows.push(i),
        }
    }

    /// One branch over its own rows. A branch no row chose draws nothing: a quota over zero
    /// rows is not a quota.
    ///
    /// `ranked` is the rows in the order the STREAMING engine numbers them; `None` when they
    /// cannot be numbered, and then the branch is built over the whole run and read at the row
    /// — which is what the streaming engine does with such a branch, and the two must agree.
    #[allow(clippy::too_many_arguments)]
    fn place(
        case: &Case,
        rows: &[usize],
        ranked: Option<Vec<usize>>,
        stream_id: String,
        count: usize,
        prng: &mut Sfc32,
        env: &Env,
        out: &mut [Option<String>],
        columns: &BTreeMap<String, Vec<Option<String>>>,
    ) -> EngineResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let Some(ranked) = ranked else {
            if !case_carries_percent(case) {
                // The streaming engines cannot number the rows of a multi-key branch or of
                // <default>, so they build those over the whole run and read the row they want.
                // This engine has to do the same or the two would answer differently on a
                // config neither of them refuses.
                let stream = per_row::Stream::new(&env.config.seed, &stream_id);
                let whole = case_values(case, count, prng, env, Some(&stream), columns)?;
                for &row in rows {
                    out[row] = Some(whole[row].clone());
                }
                return Ok(());
            }
            // It declares a share, so the streaming engines refuse it and the router sends the
            // whole config here: no other engine will ever produce this column, and it is free
            // to be exact. The quota goes over the branch's OWN rows, in row order.
            let stream = per_row::Stream::with_rows(&env.config.seed, &stream_id, rows.to_vec());
            let values = case_values(case, rows.len(), prng, env, Some(&stream), columns)?;
            for (local, &row) in rows.iter().enumerate() {
                out[row] = Some(values[local].clone());
            }
            return Ok(());
        };
        let stream = per_row::Stream::with_rows(&env.config.seed, &stream_id, ranked.clone());
        let values = case_values(case, ranked.len(), prng, env, Some(&stream), columns)?;
        for (local, &row) in ranked.iter().enumerate() {
            out[row] = Some(values[local].clone());
        }
        Ok(())
    }

    let mut result = vec![None; count];
    for (e, entry) in sw.entries.iter().enumerate() {
        let ranked = ranked_branch_rows(&sw.on, &entry.keys, &entry_rows[e], layouts);
        place(
            &entry.value,
            &entry_rows[e],
            ranked,
            format!("{name}#sw{e}"),
            count,
            prng,
            env,
            &mut result,
            columns,
        )?;
    }
    if let Some(case) = &sw.fallback {
        // <default> holds the rows no entry matched — a complement, which no layout enumerates.
        place(
            case,
            &fallback_rows,
            None,
            format!("{name}#swdef"),
            count,
            prng,
            env,
            &mut result,
            columns,
        )?;
    }
    Ok(result)
}

/// Does this `<case>` body declare a share that the denominator has to be right for?
fn case_carries_percent(case: &Case) -> bool {
    case.parts.iter().any(|part| match part {
        CasePart::Mix(mix) => !mix.percent.as_deref().unwrap_or("").trim().is_empty(),
        CasePart::Gen(gen) => !gen.attr_or("percent", "").trim().is_empty(),
        // A nested switch declares no share of its own; each of ITS branches is judged
        // separately, where the refusal that matters is raised.
        CasePart::Text(_) | CasePart::Switch(_) => false,
    })
}

/// A `<switch>` written inside a `<case>` — the nested form.
///
/// It looks its subject up over THE ROWS OF THE BRANCH IT SITS IN. `stream` already carries
/// those rows and this part's name, so position `i` here is the same cell the streaming engine
/// resolves at the absolute row.
///
/// A branch of a nested switch is never RANKED: its rows are an intersection of two partitions
/// — the enclosing branch's and the inner subject's — and the streaming engines cannot number an
/// intersection one row at a time. A branch that declares a share is refused there, the router
/// sends the config here, and the quota goes over the branch's own rows. One that declares none
/// is built over the enclosing branch's rows, which is what the streaming engines do.
fn nested_switch_values(
    sw: &Switch,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    stream: Option<&per_row::Stream>,
    columns: &BTreeMap<String, Vec<Option<String>>>,
) -> EngineResult<Vec<String>> {
    let stream_id = stream.map(|s| s.id.clone()).unwrap_or_default();
    let row_of = |i: usize| stream.map_or(i, |s| s.row_at(i));
    let subject = columns.get(&sw.on);

    let mut entry_positions: Vec<Vec<usize>> = vec![Vec::new(); sw.entries.len()];
    let mut fallback_positions: Vec<usize> = Vec::new();
    for i in 0..count {
        let row = row_of(i);
        let key = subject
            .and_then(|c| c.get(row))
            .and_then(|v| v.as_deref())
            .unwrap_or("");
        match sw
            .entries
            .iter()
            .position(|entry| entry.keys.iter().any(|k| k == key))
        {
            Some(e) => entry_positions[e].push(i),
            None => fallback_positions.push(i),
        }
    }

    let mut out = vec![String::new(); count];
    let mut place_branch = |case: &Case,
                            positions: &[usize],
                            id: String,
                            prng: &mut Sfc32,
                            out: &mut Vec<String>|
     -> EngineResult<()> {
        if positions.is_empty() {
            return Ok(());
        }
        if !case_carries_percent(case) {
            let sub = per_row::Stream {
                seed: env.config.seed.clone(),
                id: id.clone(),
                rows: stream.and_then(|s| s.rows.clone()),
            };
            let whole = case_values(case, count, prng, env, Some(&sub), columns)?;
            for &i in positions {
                out[i] = whole[i].clone();
            }
            return Ok(());
        }
        let rows: Vec<usize> = positions.iter().map(|&i| row_of(i)).collect();
        let sub = per_row::Stream::with_rows(&env.config.seed, &id, rows);
        let values = case_values(case, positions.len(), prng, env, Some(&sub), columns)?;
        for (local, &position) in positions.iter().enumerate() {
            out[position] = values[local].clone();
        }
        Ok(())
    };

    for (e, entry) in sw.entries.iter().enumerate() {
        place_branch(
            &entry.value,
            &entry_positions[e],
            format!("{stream_id}#sw{e}"),
            prng,
            &mut out,
        )?;
    }
    if let Some(case) = &sw.fallback {
        place_branch(
            case,
            &fallback_positions,
            format!("{stream_id}#swdef"),
            prng,
            &mut out,
        )?;
    }
    Ok(out)
}

/// A switch branch's rows in the order the STREAMING engine numbers them, or `None` when it
/// cannot number them at all.
///
/// A branch keyed `Male` of `<switch on="Gender">` is the same subset as `parent="Gender.Male"`,
/// and both engines must lay a quota over it the same way. That order is NOT row order: it is
/// the rank inside the subject's exact layout, which is what `ordered_rows` computes for a child
/// and what the streaming engine's `child_rank_at` hands out. Ordering by row instead put the
/// right COUNT of values on the wrong rows, and the two engines disagreed on a config neither of
/// them refused.
///
/// `None` for a multi-key entry (`US|CA|MX`): its rows are a union of subsets, and ranks across a
/// union do not compose from the per-value ranks.
fn ranked_branch_rows(
    on: &str,
    keys: &[String],
    rows: &[usize],
    layouts: &BTreeMap<String, per_row::ExactLayout>,
) -> Option<Vec<usize>> {
    if keys.len() != 1 {
        return None;
    }
    let plan = layouts.get(on)?;
    let vi = plan.values.iter().position(|v| v == &keys[0])?;
    let lo = plan.cum_hi[vi] - plan.counts[vi];

    let mut ordered = vec![usize::MAX; rows.len()];
    for &row in rows {
        let rank = plan.slot_by_row.get(&row)? - lo;
        if rank < 0 || rank as usize >= ordered.len() {
            return None;
        }
        ordered[rank as usize] = row;
    }
    if ordered.contains(&usize::MAX) {
        return None;
    }
    Some(ordered)
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
fn spread(rows: &[usize], produced: Vec<String>, count: usize) -> Vec<Option<String>> {
    let mut values = vec![None; count];
    for (i, &row) in rows.iter().enumerate() {
        if row < count {
            values[row] = produced.get(i).cloned();
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
    name: &str,
    branches: &[Branch],
    count: usize,
    prng: &mut Sfc32,
    columns: &BTreeMap<String, Vec<Option<String>>>,
    env: &Env,
) -> EngineResult<(Vec<Option<String>>, Vec<(String, Vec<Option<String>>)>)> {
    if count == 0 {
        return Ok((Vec::new(), Vec::new()));
    }

    // Each branch draws under its OWN stream — `Name#if0`, `Name#if1` — the ids the
    // streaming engine gives them. They used to take the run's shared PRNG, which
    // made a branch's values depend on how many draws the columns before it had
    // made, so the two engines produced different data from one seed.
    let mut built = Vec::with_capacity(branches.len());
    for (k, branch) in branches.iter().enumerate() {
        let stream = per_row::Stream::new(&env.config.seed, &format!("{name}#if{k}"));
        let flag_name = branch
            .gen
            .attr("anomaly_flag")
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .map(str::to_string);
        let mut flags = vec![false; count];
        let values = column_values(
            &branch.gen,
            count,
            prng,
            env,
            Some(&stream),
            Some(&mut flags),
            None,
        )?;
        built.push((flag_name, values, flags));
    }

    // One column per DISTINCT name: branches sharing `anomaly_flag="IsOutlier"`
    // share the column, which is the point of writing it on each branch.
    let mut flag_names: Vec<String> = Vec::new();
    for (flag_name, _, _) in &built {
        if let Some(n) = flag_name {
            if !flag_names.contains(n) {
                flag_names.push(n.clone());
            }
        }
    }

    let mut result = vec![None; count];
    let mut flag_columns: Vec<(String, Vec<Option<String>>)> = flag_names
        .iter()
        .map(|n| (n.clone(), vec![None; count]))
        .collect();

    for i in 0..count {
        let mut winner = None;
        for (b, branch) in branches.iter().enumerate() {
            let holds = match &branch.if_expr {
                None => true,
                Some(condition) => condition_at(condition, columns, i)?,
            };
            if holds {
                winner = Some(b);
                break;
            }
        }
        // No branch matched: the row is not covered, so neither the value nor any
        // claim about it exists — every flag column stays absent here, masked
        // exactly like the value.
        let Some(b) = winner else { continue };
        result[i] = Some(built[b].1[i].clone());
        for (column_name, column) in &mut flag_columns {
            // A covered row always has an answer. `false` — not empty — when the
            // branch that produced it cannot spike at all, because "no outlier" is
            // the truth about that row and a detector scored against the column
            // needs it stated rather than left blank.
            let spiked = built[b].0.as_ref() == Some(column_name) && built[b].2[i];
            column[i] = Some(if spiked { "true" } else { "false" }.to_string());
        }
    }
    Ok((result, flag_columns))
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
/// Attributes on a `<gen type="template">` that steer the CALL rather than
/// parameterise the pack behind it. Everything else may replace a same-named
/// local sequence in the pack body.
const RESERVED_TEMPLATE_ATTRS: [&str; 15] = [
    "type",
    "value",
    "local",
    "name",
    "if",
    "comment",
    "anomaly",
    "anomaly_factor",
    "anomaly_flag",
    "missing",
    "missing_as",
    "mask",
    "case",
    "order",
    "cycle",
];

fn pack_generator(
    body: &str,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    caller: Option<&Gen>,
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
        // A caller attribute whose name matches this local sequence replaces it
        // with a constant column: `<gen type="template"
        // value="common.internet.email" domain="example.test"/>` is how a pack is
        // parameterised. It draws nothing, so the rest of the body's
        // deterministic stream is exactly where it would otherwise be.
        let overridden = caller
            .filter(|_| !RESERVED_TEMPLATE_ATTRS.contains(&spec.name.as_str()))
            .and_then(|g| g.attr(&spec.name))
            .map(str::to_string);
        if let Some(value) = overridden {
            local.insert(spec.name.clone(), vec![Some(value); count]);
            continue;
        }
        for (name, values) in materialize_local(spec, count, prng, env, &local)? {
            local.insert(name, values);
        }
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

/// One local sequence of a pack body, as the column or columns it contributes.
///
/// A COMPOUND sequence contributes one column per field, named `sequence.field`
/// — the same shape it has in a config, because the reference runs a pack body
/// through the very sequence builder a config goes through. Every `.tdc` pack
/// that ships is written this way.
fn materialize_local(
    spec: &SequenceSpec,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    local: &BTreeMap<String, Vec<Option<String>>>,
) -> EngineResult<Vec<(String, Vec<Option<String>>)>> {
    if let Source::Compute(tree) = &spec.source {
        let mut values = Vec::with_capacity(count);
        for row in 0..count {
            values.push(Some(compute_row(tree, local, row)?));
        }
        return Ok(vec![(spec.name.clone(), values)]);
    }

    // A `<mix percent>` is how a pack declares a share of its own — 60% of
    // Spanish surnames are two words — and it is laid out over the whole
    // generated column, which is why a config that draws from such a pack is
    // routed here in the first place.
    if let Source::Mix(mix) = &spec.source {
        let values = mix_values(mix, count, prng, None, env, None, &BTreeMap::new())?
            .into_iter()
            .map(Some)
            .collect();
        return Ok(vec![(spec.name.clone(), values)]);
    }

    if let Source::Fields(fields) = &spec.source {
        // Declaration order off the shared prng: a pack body is a nested build
        // with no stream of its own, so the fields of one row draw one after
        // another rather than each keying itself — which is what pairs a given
        // name with the surname beside it.
        let mut by_field: Vec<(String, Vec<String>)> = Vec::with_capacity(fields.len());
        for field in fields {
            let values = generate(&field.gen, count, prng, env)?;
            by_field.push((
                field.name.clone(),
                finish(values, &field.gen.attrs, prng, None)?,
            ));
        }
        // After every field exists, never during: a group's members must all be
        // there before the constraint between them means anything.
        if !spec.distinct_groups.is_empty() {
            enforce_distinct(spec, fields, &mut by_field, count, env, &[], Some(prng))?;
        }
        return Ok(by_field
            .into_iter()
            .map(|(field_name, values)| {
                (
                    format!("{}.{field_name}", spec.name),
                    values.into_iter().map(Some).collect(),
                )
            })
            .collect());
    }

    let Some(gen) = spec.gen() else {
        return not_ported("a pack sequence that is neither a <gen>, a <mix> nor a <compute>");
    };
    let produced = generate(gen, count, prng, env)?;
    let values = finish(produced, &gen.attrs, prng, None)?
        .into_iter()
        .map(Some)
        .collect();
    Ok(vec![(spec.name.clone(), values)])
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
                for (name, mut values) in materialize_local(spec, 1, prng, env, local)? {
                    let replacement = values.remove(0);
                    if let Some(column) = local.get_mut(&name) {
                        column[row] = replacement;
                    }
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
        return pack_generator(body, count, prng, env, Some(gen));
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
/// Which of `size` positions row `i` reads, wrapping unless `cycle="false"`.
///
/// Split out of `pick_sequential` because a walked date range has positions
/// without having a list: its values are computed from an index, and only this
/// part applies.
pub(super) fn sequential_index(size: usize, i: usize, cycle: bool) -> EngineResult<usize> {
    if size == 0 {
        return Ok(0);
    }
    if !cycle && i >= size {
        return invalid(&format!(
            "order=\"sequential\" cycle=\"false\": the source has only {size} values, so row {} \
             has none — shorten count= or lengthen the source",
            i + 1
        ));
    }
    Ok(i % size)
}

pub(super) fn pick_sequential(list: &[String], i: usize, cycle: bool) -> EngineResult<String> {
    if list.is_empty() {
        return Ok(String::new());
    }
    Ok(list[sequential_index(list.len(), i, cycle)?].clone())
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

        // The OUTPUT lines, not the <line> ELEMENTS. One `<line each="Items">`
        // produces as many output lines as the list has elements, and the three
        // per-line fixtures are documented as wrapping "the lines of a record" —
        // so they have to see what the reader sees. They used to see the
        // elements, and <delimiter_line> between the repetitions of an each= line
        // therefore did nothing at all: no comma between the members of an array,
        // in silence.
        let mut emitted: Vec<String> = Vec::new();
        for line in &active {
            emitted.extend(render_line(line, columns, row, config, &each)?);
        }
        for (i, text) in emitted.iter().enumerate() {
            emit_lines(&mut out, &fx.before_line, columns, row, config, &each)?;
            out.push_str(text);
            emit_lines(&mut out, &fx.after_line, columns, row, config, &each)?;
            if i + 1 < emitted.len() {
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
        // A fixture line is one output line, and `render_line` hands back the LINES.
        for text in render_line(line, columns, row, config, each)? {
            to.push_str(&text);
        }
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
) -> EngineResult<Vec<String>> {
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
        return Ok(vec![text]);
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

    let mut result: Vec<String> = Vec::new();
    for (k, element) in elements.iter().enumerate() {
        let lookup = ElementLookup {
            base: RowLookup { columns, row },
            list_name,
            element,
            item: (k + 1) as i64,
            item_id: repeat::item_key(row as i64 + 1, (k + 1) as i64, lane, stride),
        };
        let mut text = interpolate::apply(&template, config.inject.as_deref(), &lookup)?;
        text.push('\n');
        result.push(text);
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
