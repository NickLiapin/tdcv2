//! The streaming engine: a row is computed from its own index, and nothing else
//! is kept.
//!
//! The in-memory engine materialises every column before writing a byte, so a
//! run costs memory proportional to its size. That is the right trade for a
//! thousand rows and impossible for a billion. Here each value is a function of
//! the row number, so memory is proportional to the width of one row and a file
//! of any length costs the same.
//!
//! Two things make that possible, and both live in [`crate::prng`]: draws keyed
//! by `seed | stream | index` instead of taken in order, and a permutation that
//! can be evaluated at one position. The second is what keeps an exact
//! `percent=` exact — the quota is laid out and then shuffled by a bijection
//! nobody has to materialise. The same trick carries everything that divides a
//! column into shares.
//!
//! Columns here are DATA rather than closures. The reference builds a closure
//! per column that captures the engine; a Rust closure cannot borrow the engine
//! it is stored in, so a column says what it is and the engine evaluates it. The
//! shape of the computation is the same, and a column that reads another column
//! — a `<compute>`, an `if=` — simply calls back into the engine.
//!
//! What this engine will not do, it refuses by name rather than approximating. A
//! weighted choice inside `advanced_regex`, a percent-weighted `uniq`, a
//! template address that interpolates a field: each needs the whole column at
//! once, and answering from one row would produce data that looks right and is
//! not. Those configs belong to another engine, and the router sends them there.

use std::cell::RefCell;
use std::collections::BTreeMap;

use super::memory::{self, Env};
use super::{invalid, unsupported, EngineError, EngineResult, RowSource};
use crate::compute;
use crate::date;
use crate::distribution::percent_mask;
use crate::engine::exact_uniq;
use crate::expr::evaluate;
use crate::expr::match_key::match_key;
use crate::format::interpolate::{self, Lookup};
use crate::format::{mask, transforms};
use crate::generators::{date_offset, file, formula, imperfections, number, quantile, repeat};
use crate::model::{
    Case, CasePart, Config, Field, Gen, Item, Line, Mix, SequenceSpec, Source, Switch,
};
use crate::numbers;
use crate::packs::DataPacks;
use crate::parser::ast::Element;
use crate::pattern::PatternGen;
use crate::prng::{self, permute, seekable};
use crate::sequence::pool::{self, PoolTable};
use crate::stats::{hamilton, timeseries};

/// Types whose value is built here and whose modifiers therefore apply here too.
const INLINE_TYPES: [&str; 4] = ["text", "increment", "decrement", "timeseries"];

/// How many redraws `<distinct>` gets before it gives up.
///
/// A fuse, not a tuning knob. Without one, three fields over a pool of two
/// values would loop for as long as the run lasts and look like a hang rather
/// than the impossible request it is.
const DISTINCT_FUSE: usize = 64;

// ── the pieces a column is made of ───────────────────────────────────────────

/// The rows a sequence covers.
///
/// A child of `parent="Gender.Male"` exists only on the male rows, and its own
/// draws are numbered within that subset — otherwise the values it produces
/// would depend on how many rows the parent happened to give it, which is not
/// knowable one row at a time.
#[derive(Clone, Debug)]
struct Domain {
    size: i32,
    of: DomainOf,
}

#[derive(Clone, Debug)]
enum DomainOf {
    /// Every row of the run.
    All,
    /// A child of `parent="Gender.Male"`: the parent sequence and the value it
    /// filters on.
    Child(String, String),
    /// The rows one case of a `<mix>` won.
    ///
    /// A case gets a domain of its own so a generator inside it is numbered
    /// within the rows that chose that case. Without it, two cases drawing from
    /// the same pack would take the same values in the same order.
    MixCase {
        outer: Box<Domain>,
        key: i32,
        lo: i32,
        hi: i32,
    },
}

impl Domain {
    fn all(size: i32) -> Self {
        Self {
            size,
            of: DomainOf::All,
        }
    }
}

/// The per-row passes an inline-built value still needs: outliers, blanks,
/// formatting.
#[derive(Clone, Debug)]
struct Modifier {
    stream: String,
    element_draws: usize,
    anomaly: Option<imperfections::Anomaly>,
    missing: Option<imperfections::Missing>,
    mask: Option<String>,
    case: Option<String>,
}

/// The lengths of a repeating cell, planned before any value exists.
#[derive(Clone, Debug)]
struct RepeatPlan {
    min: i32,
    total_slots: i32,
    row_cum_lo: Vec<i32>,
    slot_offset: Vec<i32>,
}

impl RepeatPlan {
    /// How many values the row at permuted position `p` keeps.
    fn length_at(&self, p: i32) -> i32 {
        self.min + self.group_of(p)
    }

    /// The first slot the row at permuted position `p` owns.
    fn slot_start_at(&self, p: i32) -> i32 {
        let j = self.group_of(p);
        self.slot_offset[j as usize] + (p - self.row_cum_lo[j as usize]) * (self.min + j)
    }

    fn group_of(&self, p: i32) -> i32 {
        let (mut lo, mut hi) = (0usize, self.row_cum_lo.len() - 1);
        while lo < hi {
            // Rounds UP, unlike the search in `run_for`: this one converges on
            // the LAST group whose lower bound the position has passed.
            let mid = (lo + hi).div_ceil(2);
            if p >= self.row_cum_lo[mid] {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        lo as i32
    }
}

/// A column whose values are apportioned exactly, resolved one row at a time.
///
/// The counts are computed once — the same apportionment the in-memory engine
/// uses — and laid out as contiguous runs of slots. A row asks the permutation
/// which slot it owns and looks up the run that contains it. No row needs to
/// know about any other, and the totals still come out exactly as declared.
#[derive(Clone, Debug)]
struct Quota {
    /// Needed by `distinct`, whose per-row draw comes off a `#dist` sub-stream of this id —
    /// the same one the in-memory engine uses, which is what makes the two agree.
    stream_id: String,
    values: Vec<String>,
    /// The declared shares. `counts` is their Hamilton apportionment over the slots; the two
    /// are not interchangeable, because rounding moves a count by one and a `distinct` draw
    /// weighted by counts would then diverge from the reference near a boundary.
    percents: Vec<f64>,
    counts: Vec<i32>,
    cum_hi: Vec<i32>,
    key: i32,
    slot_count: i32,
    domain: Domain,
    repeat: Option<repeat::Spec>,
    plan: Option<RepeatPlan>,
    repeat_key: i32,
    modifier: Option<Modifier>,
}

/// Draw one of `candidates` for `row`, on the reference's own stream.
///
/// Attempt 0 is the plain stream, so a reference in no group produces exactly
/// what it always did. A repair draw is a NEW stream named for the attempt.
/// Both names are part of the cross-language contract.
fn draw_pool_member(
    seed: &str,
    reference: &str,
    candidates: &[usize],
    row: i32,
    attempt: usize,
) -> usize {
    let stream = if attempt == 0 {
        pool::ref_stream(reference)
    } else {
        format!("{}#ed{attempt}", pool::ref_stream(reference))
    };
    let slot = seekable::next_int(seed, &stream, row, candidates.len() as i32) as usize;
    candidates.get(slot).copied().unwrap_or(0)
}

/// Everything one reference needs to answer "which member for this row".
///
/// Cloned into a group so a sibling can be replayed without going back to the
/// config: the group asks each reference before it what it took, and that is a
/// question about the pick, not about any column.
#[derive(Clone)]
struct PoolRefParams {
    name: String,
    table: std::rc::Rc<PoolTable>,
    filter: String,
    equality: Option<(String, String)>,
    buckets: Option<std::rc::Rc<BTreeMap<String, Vec<usize>>>>,
}

#[derive(Clone, Debug)]
enum Column {
    Count,
    First,
    Last,
    Total,
    /// A parent value with no rows of its own: always inactive.
    Absent,
    /// One field of the member a `<gen type="pool">` hands this row.
    ///
    /// A pool is small and computed before the run starts, so it never threatens
    /// bounded memory: what streams is the two thousand patients, not the thirty
    /// doctors. And because the member pick is seekable by row, row 900,000 gets
    /// its doctor without the 899,999 before it existing.
    PoolField {
        table: std::rc::Rc<PoolTable>,
        reference: String,
        field: String,
        filter: String,
        /// `field == Column` bucketed once, so a row costs a map lookup.
        equality: Option<(String, String)>,
        buckets: Option<std::rc::Rc<BTreeMap<String, Vec<usize>>>>,
    },
    /// `read="quantile" sample="exact"` — the row's point on the sorted sample comes
    /// from a scatter over the WHOLE run, so it cannot go down the generic per-row path
    /// (which is handed a count of one and would give every row the median).
    ///
    /// The DRAWN form needs no variant: it is one uniform per row, and the generic path
    /// answers it identically.
    QuantileSweep {
        domain: Domain,
        source: std::rc::Rc<quantile::Source>,
        decimals: usize,
        key: i32,
        modifier: Option<Modifier>,
    },
    /// `order="sequential"` — row r takes element r mod N, so it needs no draw.
    Sequential {
        domain: Domain,
        list: Vec<String>,
        cycle: bool,
        modifier: Option<Modifier>,
    },
    /// The same rule over a date range. The axis is arithmetic rather than a
    /// list, which is what lets this stay seekable and bounded however long the
    /// range is.
    WalkedDate {
        domain: Domain,
        axis: std::rc::Rc<date::gen::Axis>,
        cycle: bool,
        modifier: Option<Modifier>,
    },
    Counter {
        domain: Domain,
        /// The generator's own attributes, so the streaming answer comes from the same
        /// code the in-memory one does — including a fractional `value=`/`step=`.
        attrs: BTreeMap<String, String>,
        up: bool,
        modifier: Option<Modifier>,
    },
    Timeseries {
        domain: Domain,
        spec: timeseries::Spec,
        stream: String,
        modifier: Option<Modifier>,
    },
    Pattern {
        domain: Domain,
        drawing: Box<PatternGen>,
        stream: String,
        modifier: Option<Modifier>,
    },
    Quota(Box<Quota>),
    /// The `anomaly_flag` beside an exactly-apportioned column.
    ///
    /// This path used to publish no flag at all, so a declared
    /// `anomaly_flag="Bad"` registered nothing and `${{Bad}}` reached the output
    /// as its own literal text — a column of `${{Bad}}` in the data, from a
    /// config the in-memory engine renders correctly. The value and the anomaly
    /// draw are both functions of the row here, so the flag is computable one row
    /// at a time like everything else on this engine.
    QuotaFlag(Box<Quota>),
    /// `length="2,10-12" percent="85,15"` — the group is a quota, the digits are
    /// still the row's own draw.
    LengthGroups {
        domain: Domain,
        gen: Gen,
        choices: Vec<number::LengthChoice>,
        cum_hi: Vec<i32>,
        key: i32,
        stream: String,
        modifier: Option<Modifier>,
    },
    /// With `repeat`, each element of the cell is an independent draw on a
    /// stream of its own.
    Repeated {
        domain: Domain,
        gen: Gen,
        separator: String,
        /// `accumulate=`, or `None`. Never applied to the flag list below: a
        /// running total of true/false would mean nothing.
        accumulate: Option<String>,
        plan: RepeatPlan,
        repeat_key: i32,
        stream: String,
        /// `distinct="true"`: the row's values are drawn without replacement. A drawn
        /// generator has no pool to draw down, so this is bounded rejection sampling.
        distinct: bool,
        /// The flag column rather than the value column: a parallel LIST of
        /// booleans, because one boolean could not say which element spiked.
        flags: bool,
    },
    /// `row="key"` — one record of a CSV, the same one for every field on the key.
    LinkedFile {
        domain: Domain,
        source: Box<file::RowSource>,
        stream: String,
        modifier: Option<Modifier>,
    },
    /// Everything else: an independent draw from a generator private to the row.
    Plain {
        domain: Domain,
        gen: Gen,
        stream: String,
    },
    AnomalyFlag {
        domain: Domain,
        gen: Gen,
        stream: String,
        inline: bool,
        probability: f64,
        /// The inline column with its modifiers stripped, so the flag can ask what the
        /// generator produced BEFORE `anomaly=`/`missing=` touched it. A spike replaces a
        /// NUMBER, so a selected word is left exactly as it was, and once `missing=` has
        /// blanked a cell a word and a spiked number look alike.
        raw: Option<Box<Column>>,
        /// How often `missing=` blanks a cell. A blanked cell has no spike to label.
        missing: f64,
    },
    Compute(Box<Element>),
    /// `<gen type="formula">` — arithmetic over this row's other columns.
    ///
    /// Lazy like `Compute`, and for the same reason: it reads siblings and draws nothing,
    /// so the row it belongs to is the only row it needs.
    Formula {
        expr: String,
        decimals: Option<usize>,
    },
    /// A composed sequence's own value: its parts, concatenated per row.
    Composed {
        parts: Vec<Part>,
        /// A named field that draws, when no unnamed part does.
        ///
        /// Only read then. It answers the one question the literals cannot —
        /// whether this row is inside the parent's filter — so the ordinary
        /// path costs nothing.
        witness: Option<Box<Column>>,
    },
    /// A pack body planned over the whole column: its own sequences as columns of
    /// their own, and the text they are assembled into.
    ///
    /// The body's columns are OWNED data, which is what makes this possible at
    /// all — a nested engine cannot be kept alive beside its parent here, but the
    /// columns it built can be taken from it and evaluated by this one.
    PackBody {
        columns: BTreeMap<String, Column>,
        output: String,
        inject: Option<String>,
        /// The seed the nested engine BUILT these columns with. Carried because they are
        /// evaluated by the outer engine, which has a different one — see `body_seeds`.
        seed: std::rc::Rc<str>,
    },
    /// A literal piece of a `<case>` body.
    Text(String),
    /// One column of an exact-uniq arrangement: its quota walk, plus whatever
    /// the collision repair moved.
    ExactUniq(Box<exact_uniq::Resolver>),
    /// A column an env-level `<uniq>` repaired: the column as it was drawn, plus
    /// the handful of rows the repair moved.
    ///
    /// A wrapper rather than a rebuild, because the members of an env-level
    /// group are ordinary sequences built by every other path in this engine —
    /// the repair changes a few hundred values, not how a column is made.
    EnvUniq {
        base: Box<Column>,
        overrides: std::rc::Rc<BTreeMap<i32, String>>,
    },
    /// A value the whole domain shares — an empty `<mix>`, and its flag.
    Constant {
        domain: Domain,
        text: String,
    },
    /// `<mix percent="80,20">` — several ways to build one value, in stated
    /// proportions.
    ///
    /// The same shape as a weighted text column: the shares are apportioned over
    /// the run and the row's slot decides its case.
    Mix {
        domain: Domain,
        cum_hi: Vec<i32>,
        key: i32,
        cases: Vec<Vec<Column>>,
        /// Which cases declared themselves anomalous — this column is the flag
        /// rather than the value.
        anomaly: Option<Vec<bool>>,
    },
    Conditional(Vec<(Option<String>, Box<Column>)>),
    /// A member of a `<distinct>` group, repaired against the others.
    Distinct {
        members: Vec<DistinctMember>,
        groups: Vec<Vec<usize>>,
        at: usize,
        /// The first half of the complaint, which differs between a compound's
        /// group and an env-level one.
        complaint: String,
    },
    Switch {
        on: String,
        entries: Vec<(Vec<String>, Vec<Column>)>,
        fallback: Option<Vec<Column>>,
    },
}

/// One piece of a composed value: a literal, or a column drawn per row.
#[derive(Clone, Debug)]
enum Part {
    Text(String),
    Column(Box<Column>),
}

/// One member of a `<distinct>` group: the column it would have had, and the
/// generator it redraws from when it collides.
#[derive(Clone, Debug)]
struct DistinctMember {
    name: String,
    base: Box<Column>,
    gen: Gen,
    /// The stream a redraw takes, with the attempt number appended.
    stream: String,
}

// ── the engine ───────────────────────────────────────────────────────────────

pub struct StreamEngine<'a> {
    env: Env<'a>,
    /// What this run says about itself while it is still going, if anyone asked.
    on_progress: crate::engine::Watch<'a>,
    seed: std::rc::Rc<str>,
    /// The seed a value is drawn with RIGHT NOW, when it is not the run's own.
    ///
    /// A pack body is built by a nested engine with its own seed — `{run seed}|{column}` — but
    /// the columns it produced are handed back to THIS engine to evaluate, because a nested
    /// engine cannot be kept alive beside its parent here. So everything the body decided at
    /// BUILD time was keyed correctly and everything it drew at VALUE time was keyed by the
    /// outer seed, which is no seed of the body's at all. Measured: a `<mix>` inside a pack body
    /// gave the same six values whatever the column was called, and the same six a plain config
    /// gives — the body seed reached nothing. A stack rather than one slot, because a pack body
    /// may draw from a pack whose body is one too.
    body_seeds: std::cell::RefCell<Vec<std::rc::Rc<str>>>,
    count: i32,
    columns: BTreeMap<String, Column>,
    order: Vec<String>,
    /// The columns a child may filter on: a finite set of values with known
    /// quotas.
    parents: BTreeMap<String, Quota>,
    sequence_names: Vec<String>,
    /// Whether a `uniq` sequence is built to its exact shares and verified, or
    /// given uniform combinations.
    ///
    /// The one setting that separates engine 3 from engine 2. Everything else
    /// about them is the same code, which is the point: an engine chosen for its
    /// memory behaviour must not answer differently from the one that was not.
    exact_uniq: bool,
    /// Every pool, computed before anything streams.
    pool_tables: BTreeMap<String, std::rc::Rc<PoolTable>>,
    /// For a reference inside a config-level `<distinct>`, the whole group in
    /// declaration order — including itself.
    ///
    /// A record has no value of its own to compare, so the group keeps its
    /// promise by IDENTITY: no two of its references hand one row the same
    /// member. Replayed per row rather than materialised, because a pick is a
    /// pure function of the row and bounded memory is the whole point here.
    pool_groups: BTreeMap<String, std::rc::Rc<Vec<PoolRefParams>>>,
    /// The first failure a lookup swallowed, waiting to be re-raised.
    ///
    /// Interpolation and the expression layer cannot return a `Result` — they
    /// answer a name with a string — so a cell that fails inside one is recorded
    /// here and raised by the caller that CAN report it. Not every error can be
    /// raised while the columns are built: `cycle="false"` running off the end of
    /// a list is a property of the row, not of the column.
    failure: RefCell<Option<EngineError>>,
}

/// The one refusal sentence, worded as the reference words it.
///
/// `feature` names what was asked for and `name` the sequence that asked; a
/// refusal the reference words its own way goes through [`unsupported`] with
/// that wording instead of through here.
fn here<T>(feature: &str, name: &str) -> EngineResult<T> {
    unsupported(&format!(
        "stream mode: {feature} (\"{name}\") is not supported yet — run without mode=\"stream\" \
         (the in-memory engine handles it), or remove it."
    ))
}

pub fn render(config: &Config, now_millis: i64) -> EngineResult<String> {
    render_in(config, now_millis, None)
}

/// The same, resolving a relative `src=` against the config file's own folder.
pub fn render_in(config: &Config, now_millis: i64, base_dir: Option<&str>) -> EngineResult<String> {
    let packs = DataPacks::discover()?;
    let engine = StreamEngine::build(config, &packs, now_millis, base_dir)?;
    engine.text_result()
}

/// The run, written into a sink as it is produced, holding one row rather than
/// the whole output.
///
/// This is the entry point a file-bound run wants. `render` above builds the
/// output as one String, which is right for a caller that asked for a String and
/// wrong for one that is about to hand the bytes straight to a file: at two
/// million rows that String, its copy and the materialised cells behind it cost
/// a gigabyte to produce seventy megabytes.
pub fn write_in<W: std::fmt::Write>(
    config: &Config,
    now_millis: i64,
    base_dir: Option<&str>,
    out: &mut W,
    on_progress: crate::engine::Watch<'_>,
) -> EngineResult<()> {
    let packs = DataPacks::discover()?;
    let engine =
        StreamEngine::build_with(config, &packs, now_millis, base_dir, false, on_progress)?;
    engine.write_result(out)
}

/// `std::fmt::Write` reports failure without saying why — the trait has no room
/// for an error. A sink that writes to a file needs somewhere to keep the real
/// cause, so it stores one and this turns the bare failure back into it.
fn write_all<W: std::fmt::Write>(out: &mut W, text: &str) -> EngineResult<()> {
    match out.write_str(text) {
        Ok(()) => Ok(()),
        Err(_) => crate::engine::invalid("cannot write the output"),
    }
}

/// The run as addressable records, computed on demand.
pub fn rows(config: &Config, now_millis: i64) -> EngineResult<StreamRows> {
    let packs = DataPacks::discover()?;
    rows_in(config, &packs, now_millis, None)
}

/// The same, over packs the caller already holds.
pub fn rows_in(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
) -> EngineResult<StreamRows> {
    rows_in_watched(config, packs, now_millis, base_dir, None)
}

/// The same, reporting what it is doing as it goes.
pub fn rows_in_watched(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
    on_progress: crate::engine::Watch<'_>,
) -> EngineResult<StreamRows> {
    let engine = StreamEngine::build_with(config, packs, now_millis, base_dir, false, on_progress)?;
    StreamRows::of(&engine)
}

/// The same again, with `uniq` built exactly rather than uniformly — engine 3.
pub fn rows_exact(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
) -> EngineResult<StreamRows> {
    rows_exact_watched(config, packs, now_millis, base_dir, None)
}

/// The same, reporting what it is doing as it goes.
pub fn rows_exact_watched(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
    on_progress: crate::engine::Watch<'_>,
) -> EngineResult<StreamRows> {
    let engine = StreamEngine::build_with(config, packs, now_millis, base_dir, true, on_progress)?;
    StreamRows::of(&engine)
}

/// A materialised view, for callers that want [`RowSource`].
///
/// Materialised on purpose: the trait hands out `&str` borrowed from the source,
/// and a value computed on demand has nowhere to live. Streaming callers use
/// [`render`], which is the path that keeps memory flat.
pub struct StreamRows {
    count: usize,
    sequence_names: Vec<String>,
    values: BTreeMap<String, Vec<Option<String>>>,
    text: String,
}

impl StreamRows {
    fn of(engine: &StreamEngine) -> EngineResult<Self> {
        let mut values = BTreeMap::new();
        for name in &engine.order {
            let column = &engine.columns[name];
            let mut cells = Vec::with_capacity(engine.count.max(0) as usize);
            for row in 0..engine.count {
                cells.push(engine.value_of(column, row)?);
            }
            values.insert(name.clone(), cells);
        }
        Ok(Self {
            count: engine.count.max(0) as usize,
            sequence_names: engine.sequence_names.clone(),
            values,
            text: engine.text_result()?,
        })
    }
}

impl RowSource for StreamRows {
    fn count(&self) -> usize {
        self.count
    }

    fn sequence_names(&self) -> &[String] {
        &self.sequence_names
    }

    fn value(&self, column: &str, row: usize) -> Option<&str> {
        self.values.get(column)?.get(row)?.as_deref()
    }

    fn text(&self) -> String {
        self.text.clone()
    }
}

impl<'a> StreamEngine<'a> {
    pub fn build(
        config: &'a Config,
        packs: &'a DataPacks,
        now_millis: i64,
        base_dir: Option<&'a str>,
    ) -> EngineResult<StreamEngine<'a>> {
        Self::build_with(config, packs, now_millis, base_dir, false, None)
    }

    /// The same, with `exact_uniq` deciding how a `uniq="true"` sequence is
    /// built — which is the whole of engine 3.
    pub fn build_with(
        config: &'a Config,
        packs: &'a DataPacks,
        now_millis: i64,
        base_dir: Option<&'a str>,
        exact_uniq: bool,
        on_progress: crate::engine::Watch<'a>,
    ) -> EngineResult<StreamEngine<'a>> {
        let mut engine = StreamEngine {
            env: Env::new(config, packs, now_millis, base_dir),
            on_progress,
            seed: std::rc::Rc::from(config.seed.as_str()),
            body_seeds: std::cell::RefCell::new(Vec::new()),
            count: config.count,
            columns: BTreeMap::new(),
            order: Vec::new(),
            parents: BTreeMap::new(),
            sequence_names: Vec::new(),
            exact_uniq,
            // Pools are computed before anything streams — small, and off a
            // derived seed, so bounded memory is untouched and no other column
            // moves.
            pool_groups: BTreeMap::new(),
            pool_tables: super::memory::build_pool_tables(&Env::new(
                config, packs, now_millis, base_dir,
            ))?
            .into_iter()
            .map(|(k, v)| (k, std::rc::Rc::new(v)))
            .collect(),
            failure: RefCell::new(None),
        };
        engine.build_columns()?;
        // The same check the in-memory engine makes, on the same finished run:
        // an assertion that only held on one engine would be a check that
        // depends on how the file was produced.
        crate::sequence::assertions::check(
            &config.asserts,
            &config.sequences,
            &|name, row| engine.value_at(name, row as i32).ok().flatten(),
            &|name| engine.columns.contains_key(name),
            config.count.max(0) as usize,
        )?;
        engine.sequence_names = engine
            .order
            .iter()
            .filter(|n| !n.starts_with('_'))
            .cloned()
            .collect();
        Ok(engine)
    }

    fn put(&mut self, name: &str, column: Column) {
        if !self.columns.contains_key(name) {
            self.order.push(name.to_string());
        }
        self.columns.insert(name.to_string(), column);
    }

    fn build_columns(&mut self) -> EngineResult<()> {
        self.put("_count", Column::Count);
        self.put("_first", Column::First);
        self.put("_last", Column::Last);
        self.put("_total", Column::Total);

        let config = self.env.config;
        let by_name: BTreeMap<&str, &SequenceSpec> = config
            .sequences
            .iter()
            .map(|s| (s.name.as_str(), s))
            .collect();

        for spec in &config.sequences {
            if spec.uniq {
                self.build_uniq(spec)?;
                continue;
            }
            // A reference to a <pool>. A reference under a parent needs the
            // parent's materialised column to know which rows exist at all, so
            // that one goes to the in-memory engine rather than being guessed at.
            if let Source::Gen(gen) = &spec.source {
                if gen.gen_type == "pool" {
                    if spec.parent.is_some() {
                        return here("a pool reference with parent=", &spec.name);
                    }
                    // A `<uniq>` over references keeps its promise by REARRANGING
                    // the picks, and an arrangement cannot be found a row at a
                    // time — it needs the whole column. `<distinct>` is settled
                    // per row and streams fine; this one goes to memory, the
                    // same way a running total does.
                    if config
                        .env_uniq_groups
                        .iter()
                        .any(|g| g.contains(&spec.name))
                    {
                        return here("a pool reference inside a config-level <uniq>", &spec.name);
                    }
                    self.build_pool_reference(spec, gen, config)?;
                    continue;
                }
                // A running total is the one construct that genuinely cannot be
                // answered from a row index: row 900,000,000 IS the sum of
                // everything before it. That is not a gap in the streaming
                // builder, it is what "running" means — so it is refused by name
                // and the router hands the config to the in-memory engine.
                if gen.gen_type == "running" {
                    return unsupported(&format!(
                        "a running total (\"{}\") is the accumulation of every row before it, \
                         so it cannot be computed one row at a time; the in-memory engine \
                         handles it (run without a forced streaming engine)",
                        spec.name
                    ));
                }
                // Arithmetic over the columns beside it. Unlike the two refusals below,
                // a formula reads only its OWN row, so the streaming engine answers it
                // lazily exactly as it answers a `<compute>`.
                if gen.gen_type == "formula" {
                    self.put(
                        &spec.name,
                        Column::Formula {
                            expr: formula::expression_of(&gen.attrs)?,
                            decimals: formula::decimals_of(&gen.attrs)?,
                        },
                    );
                    continue;
                }
                // A statistic over the whole run is the stronger form of the
                // same thing: it is not knowable from the rows SO FAR either,
                // because the rows after this one are part of the answer.
                if gen.gen_type == "stat" {
                    return unsupported(&format!(
                        "a statistic (\"{}\") is computed over every row of the run, including \
                         the ones after this one, so it cannot be computed one row at a time; \
                         the in-memory engine handles it (run without a forced streaming engine)",
                        spec.name
                    ));
                }

                // A date measured from another date reads a SIBLING column as the row is
                // built, and the streaming path has no way to do that yet — the same reason
                // a dynamic template defers. Refused by name, and the router hands the config
                // to the in-memory engine.
                if date_offset::is_offset(&gen.gen_type, &gen.attrs) {
                    return unsupported(&format!(
                        "a date measured from another column (\"{}\") reads that column as the \
                         row is built, and the streaming path has no way to do that yet; the \
                         in-memory engine handles it (run without a forced streaming engine)",
                        spec.name
                    ));
                }
            }

            match &spec.source {
                Source::Compute(tree) => {
                    // Derived from other columns and nothing else, so it
                    // resolves per row for free.
                    self.put(&spec.name, Column::Compute(tree.clone()));
                }
                Source::Mix(mix) => {
                    // "#switch" is what the reference keys a top-level mix by —
                    // the construct was named that before it was named <mix>,
                    // and the stream id is part of the seed contract.
                    let domain = self.domain_of(spec)?;
                    let built = self.build_mix(&format!("{}#switch", spec.name), mix, domain)?;
                    self.put(&spec.name, built.column);
                    if let (Some(name), Some(flag)) = (built.flag_name, built.flag) {
                        self.put(&name, flag);
                    }
                }
                Source::Switch(sw) => {
                    let column = self.build_switch(&spec.name, sw)?;
                    self.put(&spec.name, column);
                }
                Source::Branches(branches) => {
                    // Over every row, and without the parent mask — matching the
                    // reference. A conditional already says which rows it applies
                    // to through its own conditions.
                    let full = Domain::all(self.count);
                    let mut built = Vec::with_capacity(branches.len());
                    let mut flags: Vec<(Option<String>, Option<Column>)> =
                        Vec::with_capacity(branches.len());
                    for (b, branch) in branches.iter().enumerate() {
                        let stream = format!("{}#if{b}", spec.name);
                        let made = self.build_gen(&stream, &branch.gen, full.clone())?;
                        built.push((branch.if_expr.clone(), Box::new(made.column)));
                        flags.push((made.flag_name, made.flag));
                    }
                    self.put(&spec.name, Column::Conditional(built.clone()));

                    // A branch carrying `anomaly_flag="NAME"` mints the companion
                    // ground-truth column. It is a conditional in its own right, over
                    // the SAME conditions: the row's flag comes from whichever branch
                    // produced the row's value. A branch that did not declare this
                    // name answers `false` — not empty — because the row IS covered
                    // and "no outlier" is the truth about it. Rows no branch matched
                    // fall out of Conditional as absent, masking the flag exactly
                    // like the value.
                    let mut named: Vec<String> = Vec::new();
                    for (flag_name, _) in &flags {
                        if let Some(n) = flag_name {
                            if !named.contains(n) {
                                named.push(n.clone());
                            }
                        }
                    }
                    for flag_name in named {
                        let arms = built
                            .iter()
                            .zip(flags.iter())
                            .map(|((cond, _), (owner, flag))| {
                                let column = match (owner.as_ref(), flag) {
                                    (Some(o), Some(f)) if *o == flag_name => f.clone(),
                                    _ => Column::Constant {
                                        domain: full.clone(),
                                        text: "false".to_string(),
                                    },
                                };
                                (cond.clone(), Box::new(column))
                            })
                            .collect();
                        self.put(&flag_name, Column::Conditional(arms));
                    }
                }
                Source::Items(items) => {
                    // The body in declaration order, each part on a stream of
                    // its own so the row stays a function of its index. Parts
                    // are numbered among the UNNAMED ones, so adding a literal
                    // between two gens moves nothing.
                    let domain = self.domain_of(spec)?;
                    let mut parts: Vec<Part> = Vec::new();
                    let mut unnamed = 0usize;
                    let mut witness: Option<Box<Column>> = None;
                    for item in items {
                        match item {
                            Item::Text(text) => parts.push(Part::Text(text.clone())),
                            Item::Constant { name, text } => {
                                self.put(
                                    &format!("{}.{name}", spec.name),
                                    Column::Constant {
                                        domain: domain.clone(),
                                        text: text.clone(),
                                    },
                                );
                            }
                            Item::Field(field) => {
                                let stream = format!("{}.{}", spec.name, field.name);
                                let built = self.build_gen(&stream, &field.gen, domain.clone())?;
                                if witness.is_none() {
                                    witness = Some(Box::new(built.column.clone()));
                                }
                                self.put(&stream, built.column);
                            }
                            Item::Gen(gen) => {
                                let stream = format!("{}#p{unnamed}", spec.name);
                                unnamed += 1;
                                parts.push(Part::Column(Box::new(
                                    self.build_gen(&stream, gen, domain.clone())?.column,
                                )));
                            }
                        }
                    }
                    if memory::composes_own_value(items) {
                        // The witness is kept only when nothing unnamed draws;
                        // otherwise the unnamed parts already answer for the row.
                        let witness = (unnamed == 0).then_some(witness).flatten();
                        self.put(&spec.name, Column::Composed { parts, witness });
                    }
                }

                Source::Fields(fields) => {
                    let domain = self.domain_of(spec)?;
                    for field in fields {
                        // A field's column only: the fields of a compound are
                        // parts of one thing, and a `parent=` or an
                        // `anomaly_flag=` pointing at one is not something the
                        // reference offers.
                        let name = format!("{}.{}", spec.name, field.name);
                        let built = self.build_gen(&name, &field.gen, domain.clone())?;
                        self.put(&name, built.column);
                    }
                    self.apply_distinct(spec, fields)?;
                }
                Source::Gen(gen) => {
                    let domain = self.domain_of(spec)?;
                    let built = self.build_gen(&spec.name, gen, domain)?;
                    self.put(&spec.name, built.column);
                    if let Some(parent) = built.parent {
                        self.parents.insert(spec.name.clone(), parent);
                    }
                    if let (Some(name), Some(flag)) = (built.flag_name, built.flag) {
                        self.put(&name, flag);
                    }
                }
            }
        }

        for group in &config.env_distinct_groups {
            self.apply_env_distinct(group, &by_name)?;
        }

        // Env-level <uniq> comes last, for the same reason <distinct> comes
        // second-to-last: the constraint is about a tuple, so every member has
        // to exist before it can be looked at.
        for group in &config.env_uniq_groups {
            self.apply_env_uniq(group, &by_name)?;
        }
        Ok(())
    }

    fn domain_of(&self, spec: &SequenceSpec) -> EngineResult<Domain> {
        let Some(reference) = trim_to_none(spec.parent.as_deref()) else {
            return Ok(Domain::all(self.count));
        };

        let Some(dot) = reference.find('.') else {
            return here(
                &format!("bare parent=\"{reference}\" (use parent=\"Name.Value\")"),
                &spec.name,
            );
        };
        let (parent_name, parent_value) = (&reference[..dot], &reference[dot + 1..]);

        let Some(parent) = self.parents.get(parent_name) else {
            return here(
                &format!(
                    "parent \"{parent_name}\" (the parent must be a finite-value <sequence> \
                     declared earlier)"
                ),
                &spec.name,
            );
        };
        if parent.repeat.is_some() || !parent.values.iter().any(|v| v == parent_value) {
            return invalid(&format!(
                "sequence \"{}\" filters on parent value \"{reference}\", which the parent never \
                 produces.",
                spec.name
            ));
        }

        let at = parent
            .values
            .iter()
            .position(|v| v == parent_value)
            .expect("just checked");
        Ok(Domain {
            size: parent.counts[at],
            of: DomainOf::Child(parent_name.to_string(), parent_value.to_string()),
        })
    }

    /// Where a row sits among the rows its sequence covers, or `None` when the
    /// sequence does not apply to it.
    fn pop_index_at(&self, domain: &Domain, row: i32) -> EngineResult<Option<i32>> {
        match &domain.of {
            DomainOf::All => Ok(Some(row)),
            DomainOf::Child(name, value) => {
                let parent = self.parents.get(name).expect("checked when built");
                let Some(slot) = self.slot_at(parent, row, 0)? else {
                    return Ok(None);
                };
                let at = parent
                    .values
                    .iter()
                    .position(|v| v == value)
                    .expect("checked when built");
                let lo = if at == 0 { 0 } else { parent.cum_hi[at - 1] };
                // Its rank inside the run is its position among the rows that
                // share this value.
                Ok((slot >= lo && slot < parent.cum_hi[at]).then_some(slot - lo))
            }
            DomainOf::MixCase { outer, key, lo, hi } => {
                let Some(slot) = self.mix_slot_at(outer, *key, row)? else {
                    return Ok(None);
                };
                Ok((slot >= *lo && slot < *hi).then_some(slot - *lo))
            }
        }
    }

    /// The slot a row owns in a `<mix>`'s apportionment.
    fn mix_slot_at(&self, domain: &Domain, key: i32, row: i32) -> EngineResult<Option<i32>> {
        Ok(self
            .pop_index_at(domain, row)?
            .map(|r| permute::apply(r, domain.size, key)))
    }

    /// The slot a row's k-th element owns.
    fn slot_at(&self, quota: &Quota, row: i32, k: i32) -> EngineResult<Option<i32>> {
        let Some(plan) = &quota.plan else {
            let Some(r) = self.pop_index_at(&quota.domain, row)? else {
                return Ok(None);
            };
            return Ok(Some(permute::apply(r, quota.slot_count, quota.key)));
        };
        let Some(p) = self.repeat_pos_at(&quota.domain, quota.repeat_key, row)? else {
            return Ok(None);
        };
        Ok(Some(permute::apply(
            plan.slot_start_at(p) + k,
            quota.slot_count,
            quota.key,
        )))
    }

    fn repeat_pos_at(&self, domain: &Domain, key: i32, row: i32) -> EngineResult<Option<i32>> {
        Ok(self
            .pop_index_at(domain, row)?
            .map(|r| permute::apply(r, domain.size, key)))
    }
}

/// One generator's contribution: its column, whether a child may filter on it,
/// and its flag.
struct Built {
    column: Column,
    parent: Option<Quota>,
    flag_name: Option<String>,
    flag: Option<Column>,
}

impl Built {
    fn plain(column: Column) -> Self {
        Self {
            column,
            parent: None,
            flag_name: None,
            flag: None,
        }
    }
}

impl StreamEngine<'_> {
    /// An inline column, plus the `anomaly_flag` column beside it when one is declared.
    ///
    /// The types built here never route through the per-row builder, so the flag they would
    /// otherwise inherit from it has to be attached explicitly. Leaving it off did not fail
    /// loudly: the column simply did not exist, and `${{IsOut}}` reached the output as its
    /// own literal text.
    ///
    /// `raw` is the same column with its modifiers stripped — what the generator produced
    /// before `anomaly=` and `missing=` ran, which is the only thing that can say whether a
    /// spike could have landed on this row.
    fn inline_built(
        &self,
        column: Column,
        raw: Column,
        gen: &Gen,
        gen_type: &str,
        stream_id: &str,
        domain: &Domain,
    ) -> EngineResult<Built> {
        let attrs = &gen.attrs;
        let anomaly = imperfections::parse_anomaly(attrs)?;
        let flag_name = anomaly
            .and_then(|_| trim_to_none(attrs.get("anomaly_flag").map(String::as_str)))
            .map(str::to_string);
        let flag = anomaly
            .filter(|_| flag_name.is_some())
            .map(|a| Column::AnomalyFlag {
                domain: domain.clone(),
                gen: gen.clone(),
                stream: stream_id.to_string(),
                inline: INLINE_TYPES.contains(&gen_type),
                probability: a.probability,
                raw: Some(Box::new(raw)),
                missing: imperfections::parse_missing(attrs)
                    .ok()
                    .flatten()
                    .map_or(0.0, |m| m.probability),
            });
        Ok(Built {
            column,
            parent: None,
            flag_name,
            flag,
        })
    }

    fn build_gen(&self, stream_id: &str, gen: &Gen, domain: Domain) -> EngineResult<Built> {
        let attrs = &gen.attrs;
        let gen_type = gen.gen_type.as_str();

        if gen_type == "advanced_regex"
            && crate::generators::advanced_regex::has_weighted_choice(gen.attr_or("value", ""))
        {
            // Its shares are exact over a whole column; a per-row draw would send
            // every row to the largest branch and look plausible doing it.
            return here("advanced_regex weighted choice \"(?%{…})\"", stream_id);
        }
        if gen_type == "http" {
            // A network call is not a draw: neither reproducible from a row index nor
            // answerable synchronously, which is what a lazy per-row resolver needs.
            return unsupported(&format!(
                "<gen type=\"http\"> (\"{stream_id}\") is a network call, so it is neither reproducible nor answerable one row at a time; the in-memory engine handles it (run without a forced streaming engine)"
            ));
        }
        if gen_type == "template" && gen.attr_or("value", "").contains("${{") {
            return unsupported(&format!(
                "template value \"{}\" interpolates a field; the in-memory engine resolves it per row",
                gen.attr_or("value", "")
            ));
        }
        if gen_type == "template" {
            // A pack GENERATOR whose quota spans the column — its own `percent=`,
            // or the weighted list its body draws from. This path asks such a
            // generator for one row at a time, and a quota apportioned over a
            // column of one goes entirely to the largest share:
            // `hu.person.male.fullName` returned `Nagy László` on all eight rows,
            // and every `china.geo.streetName` took the 60% suffix. The router
            // keeps these configs away from here; this is the backstop for an
            // engine named outright, and the route to memory for one that was not.
            let address = gen.attr_or("value", "");
            if !address.is_empty()
                && self
                    .env
                    .packs
                    .needs_whole_column(address, self.locale_of(attrs))
            {
                // …unless this engine can plan the body over the column itself,
                // which it now can: the body's own sequences are built at the
                // COLUMN's count, so the share is apportioned over the column and
                // each row mapped into it, exactly as a top-level `percent=`
                // sequence has always been.
                if let Some(built) = self.whole_column_pack_body(gen, stream_id)? {
                    return Ok(built);
                }
                return unsupported(&format!(
                    "a pack generator (\"{stream_id}\") whose value is apportioned across the \
                     whole column — by its own percent=, or by the weighted list its body draws \
                     from — cannot be resolved one row at a time: every row would take the \
                     largest share; the in-memory engine handles it (run without a forced \
                     streaming engine)"
                ));
            }
        }

        // An empty subset — a parent value with no rows of its own.
        if domain.size == 0 {
            return Ok(Built::plain(Column::Absent));
        }

        let repeat = repeat::parse(attrs)?;
        let modifier = self.modifier_for(stream_id, attrs, repeat.as_ref().map_or(1, |r| r.max))?;
        let plan = match &repeat {
            Some(spec) => Some(self.plan_repeat(spec, domain.size, stream_id)),
            None => None,
        };
        let repeat_key = permute::key(&self.seed, &format!("{stream_id}#replen"));

        let weight_column = if gen_type == "file" {
            trim_to_none(attrs.get("weight").map(String::as_str))
        } else {
            None
        };
        if weight_column.is_some() && trim_to_none(attrs.get("row").map(String::as_str)).is_some() {
            return unsupported(
                "weight= combined with row= needs an exact quota over the whole file; the in-memory \
                 engine handles it (run without a forced streaming engine)",
            );
        }

        // order="sequential": row r takes element r mod N. Index-based, so it
        // needs no draw.
        if (gen_type == "text" || gen_type == "file")
            && attrs.get("order").map(String::as_str) == Some("sequential")
            && weight_column.is_none()
        {
            let list = if gen_type == "file" {
                file::load(attrs, self.env.base_dir, self.env.packs.data_roots())?
            } else {
                memory::split_text(gen.attr_or("value", ""))
            };
            let cycle = attrs.get("cycle").map(String::as_str) != Some("false");
            let raw = Column::Sequential {
                domain: domain.clone(),
                list: list.clone(),
                cycle,
                modifier: None,
            };
            return self.inline_built(
                Column::Sequential {
                    domain: domain.clone(),
                    list,
                    cycle,
                    modifier,
                },
                raw,
                gen,
                gen_type,
                stream_id,
                &domain,
            );
        }

        if gen_type == "date" && attrs.get("order").map(String::as_str) == Some("sequential") {
            let axis = date::gen::date_axis(
                attrs,
                gen.attrs
                    .get("local")
                    .map(String::as_str)
                    .or(self.env.config.locale.as_deref()),
                self.env.now_millis,
            )?;
            let cycle = attrs.get("cycle").map(String::as_str) != Some("false");
            let axis = std::rc::Rc::new(axis);
            let raw = Column::WalkedDate {
                domain: domain.clone(),
                axis: axis.clone(),
                cycle,
                modifier: None,
            };
            return self.inline_built(
                Column::WalkedDate {
                    domain: domain.clone(),
                    axis,
                    cycle,
                    modifier,
                },
                raw,
                gen,
                gen_type,
                stream_id,
                &domain,
            );
        }

        if gen_type == "increment" || gen_type == "decrement" {
            let up = gen_type == "increment";
            let raw = Column::Counter {
                domain: domain.clone(),
                attrs: attrs.clone(),
                up,
                modifier: None,
            };
            return self.inline_built(
                Column::Counter {
                    domain: domain.clone(),
                    attrs: attrs.clone(),
                    up,
                    modifier,
                },
                raw,
                gen,
                gen_type,
                stream_id,
                &domain,
            );
        }

        if gen_type == "timeseries" {
            let spec = timeseries::parse(attrs)?;
            let raw = Column::Timeseries {
                domain: domain.clone(),
                spec: spec.clone(),
                stream: stream_id.to_string(),
                modifier: None,
            };
            return self.inline_built(
                Column::Timeseries {
                    domain: domain.clone(),
                    spec,
                    stream: stream_id.to_string(),
                    modifier,
                },
                raw,
                gen,
                gen_type,
                stream_id,
                &domain,
            );
        }

        if gen_type == "pattern" {
            let drawing = PatternGen::of(attrs, self.env.base_dir, self.env.packs.data_roots())?;
            let raw = Column::Pattern {
                domain: domain.clone(),
                drawing: Box::new(drawing.clone()),
                stream: stream_id.to_string(),
                modifier: None,
            };
            return self.inline_built(
                Column::Pattern {
                    domain: domain.clone(),
                    drawing: Box::new(drawing),
                    stream: stream_id.to_string(),
                    modifier,
                },
                raw,
                gen,
                gen_type,
                stream_id,
                &domain,
            );
        }

        // A row-linked file: every field on the key must land on the same record
        // for a given row, and a different one per row. The in-memory engine
        // plans that for the whole column; here the index is re-derived from a
        // stream keyed by the LINK, so the fields agree without one.
        if gen_type == "file" && quantile::is_quantile(attrs) && quantile::is_exact_sample(attrs) {
            let values = file::load(attrs, self.env.base_dir, self.env.packs.data_roots())?;
            let src = attrs.get("src").map(|s| s.trim()).unwrap_or_default();
            let source = quantile::source(&values, src)?;
            let decimals = quantile::decimals_for(attrs, &source);
            return Ok(Built::plain(Column::QuantileSweep {
                domain,
                source: std::rc::Rc::new(source),
                decimals,
                key: prng::permute::key(&self.env.config.seed, &stream_id),
                modifier,
            }));
        }

        if gen_type == "file" && weight_column.is_none() {
            if let Some(row_key) = trim_to_none(attrs.get("row").map(String::as_str)) {
                let source =
                    file::load_rows(attrs, self.env.base_dir, self.env.packs.data_roots())?;
                return Ok(Built::plain(Column::LinkedFile {
                    domain,
                    source: Box::new(source),
                    stream: format!("filerowlink|{row_key}"),
                    modifier,
                }));
            }
        }

        // An exact quota: text, a weighted file column, or a pack that carries
        // its own shares. All three say what share of the run each value takes,
        // and all three honour it the same way.
        let weighted_pack = self.weighted_template_pack(gen)?;
        if gen_type == "text" || weight_column.is_some() || weighted_pack.is_some() {
            let (values, percents) = match weighted_pack {
                Some(pack) => pack,
                None if weight_column.is_some() => {
                    let weighted =
                        file::load_weighted(attrs, self.env.base_dir, self.env.packs.data_roots())?
                            .expect("weight= was just read from the same attributes");
                    (weighted.values, weighted.percents)
                }
                None => {
                    let values = memory::split_text(gen.attr_or("value", ""));
                    let percents = match trim_to_none(attrs.get("percent").map(String::as_str)) {
                        Some(mask) => percent_mask::expand(mask, values.len())
                            .map_err(|e| EngineError::Invalid(e.message))?,
                        None => evenly(values.len()),
                    };
                    (values, percents)
                }
            };
            return Ok(self.quota_column(
                stream_id,
                values,
                &percents,
                domain,
                repeat,
                plan,
                repeat_key,
                modifier,
                attrs
                    .get("anomaly_flag")
                    .map(|n| n.trim().to_string())
                    .filter(|n| !n.is_empty()),
            ));
        }

        // `length="2,10-12" percent="85,15"`: which length group a row gets is an
        // exact quota over the column, so it cannot come from the row's own draw
        // — an apportionment over a single cell always awards it to the largest
        // share, turning 85/15 into 100/0. Plan the groups, map the row into one,
        // and let the digits still come from its own seekable draw.
        if let Some(choices) = number::weighted_length_choices(attrs) {
            let percents = percent_mask::expand(gen.attr_or("percent", ""), choices.len())
                .map_err(|e| EngineError::Invalid(e.message))?;
            let mut prng = prng::create(&format!("{}|{stream_id}|lenpct", self.seed));
            let cum_hi = cumulative(&hamilton::counts_per_value(
                domain.size,
                &percents,
                &mut prng,
            ));
            return Ok(Built::plain(Column::LengthGroups {
                domain,
                gen: gen.clone(),
                choices,
                cum_hi,
                key: permute::key(&self.seed, &format!("{stream_id}#lenpct")),
                stream: stream_id.to_string(),
                modifier,
            }));
        }

        if let Some(spec) = repeat {
            let plan = plan.expect("built beside the spec");
            let column = Column::Repeated {
                domain: domain.clone(),
                gen: Gen::new(gen_type, repeat::without(attrs)),
                separator: spec.separator.clone(),
                accumulate: spec.accumulate.clone(),
                plan: plan.clone(),
                repeat_key,
                stream: stream_id.to_string(),
                distinct: spec.distinct,
                flags: false,
            };
            let flag_name = trim_to_none(attrs.get("anomaly_flag").map(String::as_str))
                .filter(|_| imperfections::parse_anomaly(attrs).ok().flatten().is_some())
                .map(str::to_string);
            let flag = flag_name.as_ref().map(|_| Column::Repeated {
                domain,
                gen: Gen::new(gen_type, repeat::without(attrs)),
                separator: spec.separator,
                accumulate: None,
                plan,
                repeat_key,
                stream: stream_id.to_string(),
                distinct: spec.distinct,
                flags: true,
            });
            return Ok(Built {
                column,
                parent: None,
                flag_name,
                flag,
            });
        }

        // Everything else draws independently, from a generator private to the
        // row. Those types apply their own modifiers inside, so this path must
        // not wrap them again.
        let anomaly = imperfections::parse_anomaly(attrs)?;
        let flag_name = anomaly
            .and_then(|_| trim_to_none(attrs.get("anomaly_flag").map(String::as_str)))
            .map(str::to_string);
        let flag = anomaly
            .filter(|_| flag_name.is_some())
            .map(|a| Column::AnomalyFlag {
                domain: domain.clone(),
                gen: gen.clone(),
                stream: stream_id.to_string(),
                inline: INLINE_TYPES.contains(&gen_type),
                probability: a.probability,
                raw: None,
                missing: imperfections::parse_missing(attrs)
                    .ok()
                    .flatten()
                    .map_or(0.0, |m| m.probability),
            });
        Ok(Built {
            column: Column::Plain {
                domain,
                gen: gen.clone(),
                stream: stream_id.to_string(),
            },
            parent: None,
            flag_name,
            flag,
        })
    }

    fn build_mix(&self, stream_id: &str, mix: &Mix, domain: Domain) -> EngineResult<Built> {
        let flag_name = trim_to_none(mix.flag.as_deref()).map(str::to_string);

        if domain.size == 0 || mix.cases.is_empty() {
            let flag = flag_name.as_ref().map(|_| Column::Constant {
                domain: domain.clone(),
                text: "false".to_string(),
            });
            return Ok(Built {
                column: Column::Constant {
                    domain,
                    text: String::new(),
                },
                parent: None,
                flag_name,
                flag,
            });
        }

        let percents = match trim_to_none(mix.percent.as_deref()) {
            Some(spec) => percent_mask::expand(spec, mix.cases.len())
                .map_err(|e| EngineError::Invalid(e.message))?,
            None => evenly(mix.cases.len()),
        };
        let mut prng = prng::create(&format!("{}|{stream_id}|pct", self.seed));
        let counts = hamilton::counts_per_value(domain.size, &percents, &mut prng);
        let cum_hi = cumulative(&counts);
        let key = permute::key(&self.seed, stream_id);

        let mut cases = Vec::with_capacity(mix.cases.len());
        for (c, case) in mix.cases.iter().enumerate() {
            let lo = if c == 0 { 0 } else { cum_hi[c - 1] };
            let case_domain = Domain {
                size: counts[c],
                of: DomainOf::MixCase {
                    outer: Box::new(domain.clone()),
                    key,
                    lo,
                    hi: cum_hi[c],
                },
            };
            cases.push(self.case_parts(case, &format!("{stream_id}#c{c}"), case_domain)?);
        }

        let flag = flag_name.as_ref().map(|_| Column::Mix {
            domain: domain.clone(),
            cum_hi: cum_hi.clone(),
            key,
            cases: Vec::new(),
            anomaly: Some(mix.cases.iter().map(|c| c.anomaly).collect()),
        });
        Ok(Built {
            column: Column::Mix {
                domain,
                cum_hi,
                key,
                cases,
                anomaly: None,
            },
            parent: None,
            flag_name,
            flag,
        })
    }

    /// A case body assembled from its pieces: literal text, a generator, or a
    /// nested mix.
    fn case_parts(
        &self,
        case: &Case,
        stream_id: &str,
        domain: Domain,
    ) -> EngineResult<Vec<Column>> {
        let mut parts = Vec::with_capacity(case.parts.len());
        for (p, part) in case.parts.iter().enumerate() {
            let stream = format!("{stream_id}#p{p}");
            parts.push(match part {
                CasePart::Text(text) => Column::Text(text.clone()),
                CasePart::Gen(gen) => self.build_gen(&stream, gen, domain.clone())?.column,
                // A nested mix contributes its value only; `flag=` is a
                // top-level idea.
                CasePart::Mix(mix) => self.build_mix(&stream, mix, domain.clone())?.column,
                CasePart::Switch(sw) => self.nested_switch(&stream, sw, domain.clone())?,
            });
        }
        Ok(parts)
    }

    /// A `<switch>` written inside a `<case>` — the nested form.
    ///
    /// Every branch resolves over the SAME domain as the case it sits in. A branch's own rows
    /// are an intersection of two partitions — the enclosing branch's and the inner subject's —
    /// and there is no O(1) rank inside an intersection, which is what an exact share would
    /// need. So a nested branch that declares one is refused here and the router sends the
    /// config to the in-memory engine. A branch that declares none needs no rank: the row
    /// decides which branch answers, and both engines read the same row.
    fn nested_switch(&self, stream_id: &str, sw: &Switch, domain: Domain) -> EngineResult<Column> {
        let mut entries = Vec::with_capacity(sw.entries.len());
        for (e, entry) in sw.entries.iter().enumerate() {
            if Self::carries_percent(Some(&entry.value)) {
                return here(
                    &format!(
                        "a percentage inside <case is=\"{}\"> of a nested <switch on=\"{}\">",
                        entry.keys.join("|"),
                        sw.on
                    ),
                    stream_id,
                );
            }
            entries.push((
                entry.keys.clone(),
                self.case_parts(&entry.value, &format!("{stream_id}#sw{e}"), domain.clone())?,
            ));
        }
        if Self::carries_percent(sw.fallback.as_ref()) {
            return here(
                &format!(
                    "a percentage inside <default> of a nested <switch on=\"{}\">",
                    sw.on
                ),
                stream_id,
            );
        }
        let fallback = match &sw.fallback {
            Some(case) => Some(self.case_parts(case, &format!("{stream_id}#swdef"), domain)?),
            None => None,
        };
        Ok(Column::Switch {
            on: sw.on.clone(),
            entries,
            fallback,
        })
    }

    /// The rows that chose one branch, numbered within themselves.
    ///
    /// Every branch used to get the whole run, which made a `<mix percent="20,80">`
    /// inside `<case is="Male">` apportion its 20% over ALL the rows; the ones
    /// that landed on female rows were then discarded. The subset was never out
    /// of reach — a branch of `<switch on="Gender">` keyed `Male` wants exactly
    /// the domain `parent="Gender.Male"` already gets.
    ///
    /// One key only. A multi-key entry (`US|CA|MX`) is the union of subsets, and
    /// ranks across a union do not compose from the per-value ranks — the
    /// interleaving is what decides them. Refused rather than approximated.
    fn branch_domain(&self, on: &str, keys: &[String]) -> Option<Domain> {
        if keys.len() != 1 {
            return None;
        }
        let parent = self.parents.get(on)?;
        if parent.repeat.is_some() {
            return None;
        }
        let at = parent.values.iter().position(|v| v == &keys[0])?;
        Some(Domain {
            size: parent.counts[at],
            of: DomainOf::Child(on.to_string(), keys[0].clone()),
        })
    }

    /// Does this branch declare a share that the domain has to be right for?
    fn carries_percent(case: Option<&Case>) -> bool {
        case.is_some_and(|c| {
            c.parts.iter().any(|part| match part {
                CasePart::Mix(mix) => !mix.percent.as_deref().unwrap_or("").trim().is_empty(),
                CasePart::Gen(gen) => !gen.attr_or("percent", "").trim().is_empty(),
                // A nested switch declares no share of its own; each of ITS branches is
                // judged in `nested_switch`, where the refusal is raised.
                CasePart::Text(_) | CasePart::Switch(_) => false,
            })
        })
    }

    fn build_switch(&self, name: &str, sw: &Switch) -> EngineResult<Column> {
        let full = Domain::all(self.count);
        let mut entries = Vec::with_capacity(sw.entries.len());
        for (e, entry) in sw.entries.iter().enumerate() {
            let domain = self.branch_domain(&sw.on, &entry.keys);
            if domain.is_none() && Self::carries_percent(Some(&entry.value)) {
                // Cannot be resolved lazily over the right subset, and resolving it over the
                // wrong one is what this change exists to stop. Refuse, and the run falls back
                // to the in-memory engine, which can.
                return here(
                    &format!(
                        "a percentage inside <case is=\"{}\"> of <switch on=\"{}\">",
                        entry.keys.join("|"),
                        sw.on
                    ),
                    name,
                );
            }
            entries.push((
                entry.keys.clone(),
                self.case_parts(
                    &entry.value,
                    &format!("{name}#sw{e}"),
                    domain.unwrap_or_else(|| full.clone()),
                )?,
            ));
        }
        if Self::carries_percent(sw.fallback.as_ref()) {
            // <default> holds the rows no entry matched — a complement, which the quota table
            // does not enumerate. Same refusal, same fallback.
            return here(
                &format!("a percentage inside <default> of <switch on=\"{}\">", sw.on),
                name,
            );
        }
        let fallback = match &sw.fallback {
            Some(case) => Some(self.case_parts(case, &format!("{name}#swdef"), full)?),
            None => None,
        };
        Ok(Column::Switch {
            on: sw.on.clone(),
            entries,
            fallback,
        })
    }

    // ── uniq ─────────────────────────────────────────────────────────────────

    /// `uniq="true"`: no two records share the same combination.
    ///
    /// The in-memory engine draws and then repairs collisions, which needs to
    /// see every row. Here the combination space is treated as a number instead:
    /// the fields are the digits of a mixed-radix counter, and the permutation
    /// turns row `i` into a distinct index in it.
    ///
    /// The price is that the combinations come out uniform. Exact percentages
    /// and uniqueness at the same time need the whole column, so a
    /// percent-weighted uniq is refused here rather than quietly delivered as an
    /// even split.
    fn build_uniq(&mut self, spec: &SequenceSpec) -> EngineResult<()> {
        if !self.exact_uniq {
            // A group REARRANGES whole columns so each keeps its multiset — a promise about
            // the finished column, which no engine can keep a row at a time. This one could
            // only offer something else (a mixed-radix bijection over the combination space,
            // uniform over combinations, ignoring the values actually drawn), and one seed
            // would then mean two datasets. It says so instead. The router sends every uniq to
            // the exact engine; this is the backstop for a forced one.
            return here("uniq (a whole-column rearrangement)", &spec.name);
        }
        let Source::Fields(fields) = &spec.source else {
            return here(
                "uniq on a simple sequence (a whole-column draw)",
                &spec.name,
            );
        };
        if fields.is_empty() {
            return here(
                "uniq on a simple sequence (a whole-column draw)",
                &spec.name,
            );
        }
        if trim_to_none(spec.parent.as_deref()).is_some() {
            return here("uniq combined with a parent", &spec.name);
        }

        self.build_exact_uniq(spec, fields)
    }

    /// The exact-engine version: each column built to its declared shares, then
    /// verified distinct.
    ///
    /// Where the streaming version trades exact percentages for uniqueness, this
    /// one keeps both — at the cost of a pass over the run to check, and a
    /// repair when the check finds collisions.
    fn build_exact_uniq(&mut self, spec: &SequenceSpec, fields: &[Field]) -> EngineResult<()> {
        let mut built = Vec::with_capacity(fields.len());
        for field in fields {
            let gen = &field.gen;
            if gen.gen_type != "text" {
                return here(
                    &format!(
                        "uniq field \"{}\" of type \"{}\" (only text lists)",
                        field.name, gen.gen_type
                    ),
                    &spec.name,
                );
            }

            // Deduplicated in first-seen order, as the streaming pool is: a
            // repeated value would let two slots mean the same thing.
            let mut values: Vec<String> = Vec::new();
            for value in memory::split_text(gen.attr_or("value", "")) {
                if !values.contains(&value) {
                    values.push(value);
                }
            }
            if values.is_empty() {
                return here(
                    &format!("uniq field \"{}\" with an empty value list", field.name),
                    &spec.name,
                );
            }

            let percent = gen.attr_or("percent", "");
            let percents = if percent.is_empty() {
                vec![100.0 / values.len() as f64; values.len()]
            } else {
                percent_mask::expand(percent, values.len())
                    .map_err(|e| EngineError::Invalid(e.message))?
            };

            built.push(exact_uniq::Field {
                id: format!("{}.{}", spec.name, field.name),
                values,
                percents,
            });
        }

        // The run's own folder when there is one, so a temp file lands beside
        // the work rather than wherever the shell happens to point.
        let tmp = self
            .env
            .base_dir
            .map_or_else(std::env::temp_dir, std::path::PathBuf::from);
        let arranged = exact_uniq::arrange(
            &built,
            self.count,
            &self.seed,
            &format!("\"{}\"", spec.name),
            &tmp,
            self.on_progress,
        )?;
        for (id, resolver) in arranged {
            self.put(&id, Column::ExactUniq(Box::new(resolver)));
        }
        Ok(())
    }

    /// Env-level `<uniq>`: the tuple of several sequences is unique across the
    /// run.
    ///
    /// The in-memory engine draws the whole table, finds the repeated tuples and
    /// swaps values until none is left. That is exact and it does not scale:
    /// repeats grow as the SQUARE of the row count.
    ///
    /// Here the columns stay seekable — each is already a function of the row
    /// number — and only the repeats are touched. The repair streams every tuple
    /// through a sort to find them, which is bounded memory, then rearranges the
    /// few offenders in RAM. Its own refusal hands a pathologically tight config
    /// back to the in-memory engine, so nothing is lost when the space really is
    /// too small.
    ///
    /// **This changes the arrangement.** A repaired dataset is not the one the
    /// in-memory engine produced from the same seed. Both are correct — every
    /// tuple distinct, every column's multiset untouched, so the percentages
    /// hold — but they are different arrangements.
    fn apply_env_uniq(
        &mut self,
        group: &[String],
        by_name: &BTreeMap<&str, &SequenceSpec>,
    ) -> EngineResult<()> {
        let members: Vec<String> = group
            .iter()
            .filter(|name| self.columns.contains_key(name.as_str()))
            .cloned()
            .collect();
        if members.len() < 2 {
            return Ok(());
        }
        let label = members.join(" \u{d7} ");

        // The columns a switch member is keyed by. Empty for an ordinary group,
        // and then every row may trade with every other, as it always could.
        let mut subjects: Vec<String> = Vec::new();
        for name in &members {
            let Some(spec) = by_name.get(name.as_str()) else {
                continue;
            };
            if let Source::Switch(switch) = &spec.source {
                if !subjects.contains(&switch.on) && self.columns.contains_key(&switch.on) {
                    subjects.push(switch.on.clone());
                }
            }
        }

        // The run's own folder when there is one, so a temp file lands beside
        // the work rather than wherever the shell happens to point.
        let tmp = self
            .env
            .base_dir
            .map_or_else(std::env::temp_dir, std::path::PathBuf::from);

        // A column here can fail where a quota walk cannot — these are ordinary
        // sequences, and one of them may be a compute tree over a bad
        // expression. The repair asks for a string, so the first failure is put
        // aside and raised the moment it returns, rather than silently becoming
        // an empty value that changes which tuples collide.
        let failure: std::cell::RefCell<Option<EngineError>> = std::cell::RefCell::new(None);
        let repaired = {
            // Shared, not moved: a closure that took `self` would take the
            // engine's `&mut` with it and nothing after this block could touch
            // it. Both of these are plain references, which copy.
            let engine: &StreamEngine<'_> = self;
            let held = &failure;
            let keyed = &subjects;
            let sources: Vec<exact_uniq::Source<'_>> = members
                .iter()
                .map(|name| {
                    Box::new(move |row: i32| engine.value_or_note(name, row, held))
                        as exact_uniq::Source<'_>
                })
                .collect();
            let block: Option<Box<dyn Fn(i32) -> String + '_>> = if keyed.is_empty() {
                None
            } else {
                // Any injective key groups the same rows; the separator cannot
                // appear in a value.
                Some(Box::new(move |row: i32| {
                    keyed
                        .iter()
                        .map(|name| engine.value_or_note(name, row, held))
                        .collect::<Vec<String>>()
                        .join(&exact_uniq::JOIN.to_string())
                }))
            };
            exact_uniq::repair(
                &sources,
                self.count,
                &format!("\"{label}\""),
                &tmp,
                block.as_deref(),
                self.on_progress,
            )
        };
        if let Some(error) = failure.into_inner() {
            return Err(error);
        }
        let overrides = repaired?;
        if overrides.is_empty() {
            return Ok(());
        }

        for (j, name) in members.iter().enumerate() {
            let mut moved: BTreeMap<i32, String> = BTreeMap::new();
            for (row, values) in &overrides {
                moved.insert(*row, values[j].clone());
            }
            let base = self.columns[name].clone();
            self.put(
                name,
                Column::EnvUniq {
                    base: Box::new(base),
                    overrides: std::rc::Rc::new(moved),
                },
            );
        }
        Ok(())
    }

    /// A column's value as the repair wants it: a string, with the first failure
    /// put aside for the caller to raise.
    fn value_or_note(
        &self,
        name: &str,
        row: i32,
        failure: &std::cell::RefCell<Option<EngineError>>,
    ) -> String {
        match self.value_at(name, row) {
            Ok(Some(value)) => value,
            Ok(None) => String::new(),
            Err(error) => {
                let mut held = failure.borrow_mut();
                if held.is_none() {
                    *held = Some(error);
                }
                String::new()
            }
        }
    }

    // ── distinct ─────────────────────────────────────────────────────────────

    /// `<distinct>`: fields of one record that must not repeat each other.
    ///
    /// Two independent draws from the same pool collide about as often as chance
    /// says they should, which reads as a bug in a record where a person cannot
    /// be their own manager. The repair is per row and needs nothing else: a
    /// colliding field redraws on a fresh stream until it differs, and every
    /// implementation redraws in the same order on the same streams.
    fn apply_distinct(&mut self, spec: &SequenceSpec, fields: &[Field]) -> EngineResult<()> {
        let mut names: Vec<String> = Vec::new();
        let mut groups: Vec<Vec<String>> = Vec::new();
        for group in &spec.distinct_groups {
            let present: Vec<String> = group
                .iter()
                .filter(|n| fields.iter().any(|f| f.name == **n))
                .cloned()
                .collect();
            if present.len() >= 2 {
                for name in &present {
                    if !names.contains(name) {
                        names.push(name.clone());
                    }
                }
                groups.push(present);
            }
        }
        if groups.is_empty() {
            return Ok(());
        }

        let members: Vec<DistinctMember> = names
            .iter()
            .map(|name| {
                let gen = fields
                    .iter()
                    .find(|f| f.name == *name)
                    .expect("filtered to present fields")
                    .gen
                    .clone();
                DistinctMember {
                    base: Box::new(self.columns[&format!("{}.{name}", spec.name)].clone()),
                    stream: format!("{}.{name}#d", spec.name),
                    name: name.clone(),
                    gen,
                }
            })
            .collect();
        let complaint = format!(
            "stream mode: <distinct> in sequence \"{}\": could not find a value for field",
            spec.name
        );
        self.put_distinct(&members, &groups, &names, &complaint, |n| {
            format!("{}.{n}", spec.name)
        });
        Ok(())
    }

    /// Env-level `<distinct>`: the named sequences differ from each other on
    /// every row.
    ///
    /// Layered over the columns already built rather than folded into them,
    /// because the constraint is between sequences that are otherwise
    /// independent.
    fn apply_env_distinct(
        &mut self,
        group: &[String],
        by_name: &BTreeMap<&str, &SequenceSpec>,
    ) -> EngineResult<()> {
        let mut names = Vec::new();
        let mut members = Vec::new();
        for name in group {
            let Some(member) = by_name.get(name.as_str()) else {
                continue;
            };
            if !self.columns.contains_key(name) {
                continue;
            }
            match &member.source {
                Source::Mix(_) => {
                    return here(&format!("<distinct> member \"{name}\" is a <mix>"), name)
                }
                Source::Switch(_) => {
                    return here(&format!("<distinct> member \"{name}\" is a <switch>"), name)
                }
                _ => {}
            }
            let Some(gen) = member.gen() else {
                return here(
                    &format!("<distinct> member \"{name}\" (must be a simple sequence)"),
                    name,
                );
            };
            members.push(DistinctMember {
                name: name.clone(),
                base: Box::new(self.columns[name].clone()),
                gen: gen.clone(),
                stream: format!("{name}#ed"),
            });
            names.push(name.clone());
        }
        if members.len() < 2 {
            return Ok(());
        }

        let groups = vec![names.clone()];
        let complaint =
            "stream mode: <distinct> across sequences: could not find a value for sequence"
                .to_string();
        self.put_distinct(&members, &groups, &names, &complaint, |n| n.to_string());
        Ok(())
    }

    fn put_distinct(
        &mut self,
        members: &[DistinctMember],
        groups: &[Vec<String>],
        names: &[String],
        complaint: &str,
        column_name: impl Fn(&str) -> String,
    ) {
        let indexed: Vec<Vec<usize>> = groups
            .iter()
            .map(|g| {
                g.iter()
                    .map(|n| names.iter().position(|m| m == n).expect("a member"))
                    .collect()
            })
            .collect();
        for (at, name) in names.iter().enumerate() {
            self.put(
                &column_name(name),
                Column::Distinct {
                    members: members.to_vec(),
                    groups: indexed.clone(),
                    at,
                    complaint: complaint.to_string(),
                },
            );
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn quota_column(
        &self,
        stream_id: &str,
        values: Vec<String>,
        percents: &[f64],
        domain: Domain,
        repeat: Option<repeat::Spec>,
        plan: Option<RepeatPlan>,
        repeat_key: i32,
        modifier: Option<Modifier>,
        flag_name: Option<String>,
    ) -> Built {
        // With `repeat=` the quota is planned over ELEMENTS rather than rows,
        // because a row holding three values consumes three of them.
        let slot_count = plan.as_ref().map_or(domain.size, |p| p.total_slots);
        let mut prng = prng::create(&format!("{}|{stream_id}|pct", self.seed));
        let counts = hamilton::counts_per_value(slot_count, percents, &mut prng);
        let quota = Quota {
            stream_id: stream_id.to_string(),
            cum_hi: cumulative(&counts),
            values,
            percents: percents.to_vec(),
            counts,
            key: permute::key(&self.seed, stream_id),
            slot_count,
            domain,
            repeat,
            plan,
            repeat_key,
            modifier,
        };
        Built {
            column: Column::Quota(Box::new(quota.clone())),
            // A finite set of values with known quotas is exactly what a child
            // can filter on — unless the cell holds a LIST, in which case
            // parent="Name.value" has nothing coherent to match.
            parent: Some(quota.clone()),
            flag_name: flag_name.clone(),
            flag: flag_name.map(|_| Column::QuotaFlag(Box::new(quota))),
        }
    }

    fn modifier_for(
        &self,
        stream_id: &str,
        attrs: &BTreeMap<String, String>,
        element_draws: i32,
    ) -> EngineResult<Option<Modifier>> {
        let anomaly = imperfections::parse_anomaly(attrs)?.filter(|a| a.probability > 0.0);
        let missing = imperfections::parse_missing(attrs)?.filter(|m| m.probability > 0.0);
        let mask = attrs.get("mask").cloned();
        let case = attrs
            .get("case")
            .filter(|c| transforms::is_case_transform(c))
            .cloned();

        if anomaly.is_none() && missing.is_none() && mask.is_none() && case.is_none() {
            return Ok(None);
        }
        Ok(Some(Modifier {
            stream: stream_id.to_string(),
            element_draws: element_draws.max(1) as usize,
            anomaly,
            missing,
            mask,
            case,
        }))
    }

    fn plan_repeat(&self, spec: &repeat::Spec, row_count: i32, stream_id: &str) -> RepeatPlan {
        let groups = (spec.max - spec.min + 1).max(1) as usize;
        // The DECLARED shares when `lengths=` gave any, an even split otherwise — the
        // same call the in-memory engine makes, so the two agree on how many rows get
        // one value and how many get five.
        let percents = repeat::length_percents(spec);
        let mut prng = prng::create(&format!("{}|{stream_id}|replen", self.seed));
        let counts = hamilton::counts_per_value(row_count, &percents, &mut prng);

        let mut row_cum_lo = vec![0; groups];
        let mut slot_offset = vec![0; groups];
        let (mut row_acc, mut slot_acc) = (0, 0);
        for j in 0..groups {
            row_cum_lo[j] = row_acc;
            slot_offset[j] = slot_acc;
            let c = counts.get(j).copied().unwrap_or(0);
            row_acc += c;
            slot_acc += c * (spec.min + j as i32);
        }
        RepeatPlan {
            min: spec.min,
            total_slots: slot_acc,
            row_cum_lo,
            slot_offset,
        }
    }

    /// A `<gen type="template">` pointing at a pack that carries its own shares.
    fn weighted_template_pack(&self, gen: &Gen) -> EngineResult<Option<(Vec<String>, Vec<f64>)>> {
        if gen.gen_type != "template" {
            return Ok(None);
        }
        let address = gen.attr_or("value", "");
        // A synthetic address (person.b_day and its kind) is resolved inside the
        // generator and has no pack file behind it, so asking the registry for it
        // would fail rather than answer.
        if address.is_empty() || !self.env.packs.exists(address, self.locale_of(&gen.attrs)) {
            return Ok(None);
        }
        let entry = self.env.packs.load(address, self.locale_of(&gen.attrs))?;
        Ok(entry
            .percents
            .clone()
            .map(|percents| (entry.values.clone(), percents)))
    }

    fn locale_of<'b>(&'b self, attrs: &'b BTreeMap<String, String>) -> &'b str {
        match trim_to_none(attrs.get("local").map(String::as_str)) {
            Some(local) => local,
            None => self.env.config.locale_or_default(),
        }
    }
}

// ── evaluating one cell ──────────────────────────────────────────────────────

impl StreamEngine<'_> {
    /// The three questions an output format asks of a run, without the run
    /// having to exist first. See `output::parquet_output::Cells`.
    pub fn row_count(&self) -> usize {
        self.count.max(0) as usize
    }

    /// The declared sequence names, in declaration order.
    pub fn names(&self) -> &[String] {
        &self.sequence_names
    }

    /// One cell, addressed the way a materialised run would be addressed.
    pub fn cell(&self, name: &str, row: usize) -> EngineResult<Option<String>> {
        self.value_at(name, row as i32)
    }

    /// A share-declaring pack body, built here over the column rather than refused.
    ///
    /// A nested engine over the body's own sequences, at this column's count and
    /// under a seed salted with this column's name — the same seed the in-memory
    /// engine gives the body, so the two assemble the same rows. The nested
    /// engine is dropped as soon as its columns are taken from it: a `Column` is
    /// owned data, so the parent can evaluate them without keeping a borrow of a
    /// config that only lived for this call.
    ///
    /// `None` for the shapes still left to the in-memory engine: a body carrying
    /// its own `<valid>`, where rejecting a row and redrawing it is a
    /// whole-column decision with no lazy form yet.
    fn whole_column_pack_body(&self, gen: &Gen, stream_id: &str) -> EngineResult<Option<Built>> {
        let address = gen.attr_or("value", "");
        let Ok(entry) = self.env.packs.load(address, self.locale_of(&gen.attrs)) else {
            return Ok(None);
        };
        let Some(source) = entry.generator.as_deref() else {
            return Ok(None);
        };
        if !source.contains("<sequence") && !source.contains("<data") {
            return Ok(None);
        }
        let Ok(body) = crate::parser::config_builder::parse_pack_body(source) else {
            return Ok(None);
        };
        if body.validate.is_some() {
            return Ok(None);
        }

        let mut inner_config = self.env.config.clone();
        inner_config.seed = format!("{}|{stream_id}", self.seed);
        inner_config.sequences = body.sequences.clone();
        let inner = StreamEngine::build_with(
            &inner_config,
            self.env.packs,
            self.env.now_millis,
            self.env.base_dir,
            false,
            None,
        )?;
        let columns = inner.columns.clone();
        Ok(Some(Built::plain(Column::PackBody {
            columns,
            output: body.output.clone(),
            inject: self.env.config.inject.clone(),
            seed: std::rc::Rc::from(inner_config.seed.as_str()),
        })))
    }

    fn value_at(&self, name: &str, row: i32) -> EngineResult<Option<String>> {
        match self.columns.get(name) {
            Some(column) => self.value_of(column, row),
            None => Ok(None),
        }
    }

    /// Which member of the table this row draws, honouring `filter=`.
    fn pool_member(
        &self,
        table: &PoolTable,
        reference: &str,
        filter: &str,
        equality: &Option<(String, String)>,
        buckets: &Option<std::rc::Rc<BTreeMap<String, Vec<usize>>>>,
        row: i32,
    ) -> EngineResult<usize> {
        // Inside a config-level `<distinct>` the answer is not this reference's
        // alone: the ones declared before it have already taken members out of
        // this row, and none of them may be taken twice.
        if let Some(group) = self.pool_groups.get(reference).cloned() {
            return self.pool_member_in_group(&group, reference, row);
        }
        self.pool_member_alone(table, reference, filter, equality, buckets, row)
    }

    /// This reference's own pick, with no group having a say.
    fn pool_member_alone(
        &self,
        table: &PoolTable,
        reference: &str,
        filter: &str,
        equality: &Option<(String, String)>,
        buckets: &Option<std::rc::Rc<BTreeMap<String, Vec<usize>>>>,
        row: i32,
    ) -> EngineResult<usize> {
        let candidates = self.pool_candidates(table, filter, equality, buckets, row)?;
        Ok(draw_pool_member(
            &self.drawing_seed(),
            reference,
            &candidates,
            row,
            0,
        ))
    }

    /// Walk the group in declaration order; a member already taken this row is
    /// drawn again from what the row has left.
    fn pool_member_in_group(
        &self,
        group: &[PoolRefParams],
        wanted: &str,
        row: i32,
    ) -> EngineResult<usize> {
        let mut taken: Vec<usize> = Vec::new();
        for r in group {
            let candidates =
                self.pool_candidates(&r.table, &r.filter, &r.equality, &r.buckets, row)?;
            let mut pick = draw_pool_member(&self.drawing_seed(), &r.name, &candidates, row, 0);
            if taken.contains(&pick) {
                let free: Vec<usize> = candidates
                    .iter()
                    .copied()
                    .filter(|m| !taken.contains(m))
                    .collect();
                if free.is_empty() {
                    return invalid(&format!(
                        "<distinct> across sequences: row {row} has no member left for \
                         \"{}\" — the sequences in this group have taken every candidate the \
                         pool offers. A group of {} references needs {} members to choose from.",
                        r.name,
                        group.len(),
                        group.len()
                    ));
                }
                pick = draw_pool_member(&self.drawing_seed(), &r.name, &free, row, 1);
            }
            if r.name == wanted {
                return Ok(pick);
            }
            taken.push(pick);
        }
        Ok(0)
    }

    /// The members row `row` may draw from: all of them, or what a `filter=`
    /// leaves standing.
    fn pool_candidates(
        &self,
        table: &PoolTable,
        filter: &str,
        equality: &Option<(String, String)>,
        buckets: &Option<std::rc::Rc<BTreeMap<String, Vec<usize>>>>,
        row: i32,
    ) -> EngineResult<Vec<usize>> {
        if filter.is_empty() {
            return Ok((0..table.count).collect());
        }
        let (eligible, detail) = match (equality, buckets) {
            (Some((_, column)), Some(buckets)) => {
                let wanted = self.value_at(column, row)?.unwrap_or_default();
                (
                    buckets
                        .get(&match_key(&wanted))
                        .cloned()
                        .unwrap_or_default(),
                    format!(" ({column}=\"{wanted}\")"),
                )
            }
            _ => {
                let read = std::cell::RefCell::new(std::collections::BTreeMap::new());
                let mut found = Vec::new();
                for m in 0..table.count {
                    let scope = StreamMemberScope {
                        engine: self,
                        table,
                        member: m,
                        row,
                        read: &read,
                    };
                    if evaluate::as_condition(filter, &scope)? {
                        found.push(m);
                    }
                }
                let detail = pool::row_values_detail(&read.borrow());
                (found, detail)
            }
        };
        if eligible.is_empty() {
            return invalid(&pool::no_candidate_message(
                &table.name,
                filter,
                row as usize,
                &detail,
            ));
        }
        Ok(eligible)
    }

    fn build_pool_reference(
        &mut self,
        spec: &SequenceSpec,
        gen: &Gen,
        config: &Config,
    ) -> EngineResult<()> {
        let pool_name = gen.attr_or("value", "").trim().to_string();
        let Some(table) = self.pool_tables.get(&pool_name).cloned() else {
            return Ok(()); // unknown pool — the validator reports it
        };
        if table.count == 0 {
            return Ok(());
        }
        let filter = gen.attr_or("filter", "").trim().to_string();
        let known: Vec<String> = self.columns.keys().cloned().collect();
        let equality = if filter.is_empty() {
            None
        } else {
            pool::parse_equality_filter(&filter, &table, &|name| known.iter().any(|k| k == name))
        };
        let buckets = equality
            .as_ref()
            .map(|(field, _)| std::rc::Rc::new(pool::bucket_by_field(&table, field)));

        // If a config-level `<distinct>` holds this reference, remember the whole
        // group against every one of its names. Built from the config rather
        // than from columns, because a sibling's pick is not a column.
        let params = PoolRefParams {
            name: spec.name.clone(),
            table: table.clone(),
            filter: filter.clone(),
            equality: equality.clone(),
            buckets: buckets.clone(),
        };
        self.remember_pool_group(spec, &params, &known, config);

        for field in table.fields.clone() {
            let key = format!("{}.{}", spec.name, field);
            self.put(
                &key,
                Column::PoolField {
                    table: table.clone(),
                    reference: spec.name.clone(),
                    field,
                    filter: filter.clone(),
                    equality: equality.clone(),
                    buckets: buckets.clone(),
                },
            );
        }
        Ok(())
    }

    /// Record the `<distinct>` group this reference belongs to, if any.
    ///
    /// Every member's parameters are read off the config, so the group is whole
    /// the first time any of its references is built — a later sibling has not
    /// been reached yet, and the group needs it all the same.
    fn remember_pool_group(
        &mut self,
        spec: &SequenceSpec,
        params: &PoolRefParams,
        known: &[String],
        config: &Config,
    ) {
        let Some(group) = config
            .env_distinct_groups
            .iter()
            .find(|g| g.contains(&spec.name))
            .cloned()
        else {
            return;
        };
        let mut members: Vec<PoolRefParams> = Vec::new();
        for name in &group {
            if name == &spec.name {
                members.push(params.clone());
                continue;
            }
            let Some(other) = config.sequences.iter().find(|s| &s.name == name) else {
                continue;
            };
            let Source::Gen(gen) = &other.source else {
                continue;
            };
            if gen.gen_type != "pool" {
                continue;
            }
            let pool_name = gen.attr_or("value", "").trim().to_string();
            let Some(table) = self.pool_tables.get(&pool_name).cloned() else {
                continue;
            };
            if table.count == 0 {
                continue;
            }
            let filter = gen.attr_or("filter", "").trim().to_string();
            let equality = if filter.is_empty() {
                None
            } else {
                pool::parse_equality_filter(&filter, &table, &|n| known.iter().any(|k| k == n))
            };
            let buckets = equality
                .as_ref()
                .map(|(field, _)| std::rc::Rc::new(pool::bucket_by_field(&table, field)));
            members.push(PoolRefParams {
                name: name.clone(),
                table,
                filter,
                equality,
                buckets,
            });
        }
        if members.len() < 2 {
            return;
        }
        let shared = std::rc::Rc::new(members);
        for m in shared.iter() {
            self.pool_groups.insert(m.name.clone(), shared.clone());
        }
    }

    /// The seed to draw THIS value with: a pack body's own while one is being evaluated, the
    /// run's otherwise.
    ///
    /// An `Rc` rather than a `String` because this is read once per seeded draw per row, and a
    /// clone of the text would be an allocation on the hot path of a billion-row run.
    fn drawing_seed(&self) -> std::rc::Rc<str> {
        match self.body_seeds.borrow().last() {
            Some(seed) => seed.clone(),
            None => self.seed.clone(),
        }
    }

    fn value_of(&self, column: &Column, row: i32) -> EngineResult<Option<String>> {
        match column {
            Column::PoolField {
                table,
                reference,
                field,
                filter,
                equality,
                buckets,
            } => {
                let m = self.pool_member(table, reference, filter, equality, buckets, row)?;
                Ok(Some(
                    table
                        .columns
                        .get(field)
                        .and_then(|c| c.get(m).cloned())
                        .unwrap_or_default(),
                ))
            }
            Column::Count => Ok(Some((row + 1).to_string())),
            Column::First => Ok(Some(bool_text(row == 0))),
            Column::Last => Ok(Some(bool_text(row == self.count - 1))),
            Column::Total => Ok(Some(self.count.to_string())),
            Column::Absent => Ok(None),

            Column::QuantileSweep {
                domain,
                source,
                decimals,
                key,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                // Over the rows this column HAS, which for a filtered one is its domain
                // rather than the run — the same count the in-memory engine sweeps.
                let value = quantile::exact_at(
                    source,
                    *decimals,
                    i32::try_from(domain.size).unwrap_or(i32::MAX),
                    *key,
                    i32::try_from(r).unwrap_or(0),
                );
                self.modify(modifier, row, Some(value), 0)
            }

            Column::Sequential {
                domain,
                list,
                cycle,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                let value = memory::pick_sequential(list, r as usize, *cycle)?;
                self.modify(modifier, row, Some(value), 0)
            }

            Column::WalkedDate {
                domain,
                axis,
                cycle,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                // An OPEN axis has no size and never wraps: row r is simply the
                // r-th step.
                let value = match axis.size {
                    None => axis.at(i64::from(r)),
                    Some(size) => {
                        axis.at(memory::sequential_index(size as usize, r as usize, *cycle)? as i64)
                    }
                };
                self.modify(modifier, row, Some(value), 0)
            }

            Column::Counter {
                domain,
                attrs,
                up,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                let value = crate::generators::counter::value_at(attrs, i64::from(r), *up)?;
                self.modify(modifier, row, Some(value), 0)
            }

            Column::Timeseries {
                domain,
                spec,
                stream,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                let z = if spec.has_noise() {
                    let u =
                        seekable::uniforms(&self.drawing_seed(), &format!("{stream}:ts"), row, 2);
                    timeseries::standard_normal(u[0], u[1])
                } else {
                    0.0
                };
                let value =
                    numbers::to_fixed(timeseries::value_at(spec, i64::from(r), z), spec.decimals);
                self.modify(modifier, row, Some(value), 0)
            }

            Column::Pattern {
                domain,
                drawing,
                stream,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                let denom = if domain.size > 1 {
                    f64::from(domain.size - 1)
                } else {
                    1.0
                };
                let u = if drawing.draws() {
                    seekable::uniforms(&self.drawing_seed(), &format!("{stream}:pat"), row, 1)[0]
                } else {
                    0.0
                };
                let value = drawing.value_at(f64::from(r) / denom, u);
                self.modify(modifier, row, Some(value), 0)
            }

            Column::LinkedFile {
                domain,
                source,
                stream,
                modifier,
            } => {
                let Some(_) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                let index =
                    seekable::next_int(&self.drawing_seed(), stream, row, source.rows.len() as i32);
                let value = file::cell_at(source, index.max(0) as usize);
                self.modify(modifier, row, Some(value), 0)
            }

            Column::Quota(quota) => self.quota_value(quota, row),
            Column::QuotaFlag(quota) => self.quota_flag(quota, row),

            Column::LengthGroups {
                domain,
                gen,
                choices,
                cum_hi,
                key,
                stream,
                modifier,
            } => {
                let Some(r) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                let group = choices[run_for(cum_hi, permute::apply(r, domain.size, *key))];
                let pinned = Gen::new(gen.gen_type.clone(), number::pin_length(&gen.attrs, group));
                let value = self.one_value(&pinned, stream, row, None)?;
                self.modify(modifier, row, Some(value), 0)
            }

            Column::Repeated {
                domain,
                gen,
                separator,
                accumulate,
                plan,
                repeat_key,
                stream,
                distinct,
                flags,
            } => {
                let Some(p) = self.repeat_pos_at(domain, *repeat_key, row)? else {
                    return Ok(None);
                };
                let mut parts = Vec::new();
                // Under `distinct` the surviving value may have come off `#e{k}r3` rather
                // than the first attempt, so the FLAG has to be resolved on the same
                // sub-stream. Replaying the draw is what finds out which one won; asking
                // the first attempt would flag a value that was thrown away.
                let mut seen: Vec<String> = Vec::new();
                for k in 0..plan.length_at(p) {
                    // A drawn generator has no pool to draw down, so `distinct` is
                    // rejection sampling on fresh sub-streams — the same ids the reference
                    // uses, so the two agree value for value.
                    let draw_at = |suffix: &str| -> EngineResult<String> {
                        self.one_value(gen, &format!("{stream}#e{k}{suffix}"), row, None)
                    };
                    let suffix = if *distinct {
                        let (value, suffix) =
                            repeat::redraw_until_fresh_at(&seen, &gen.gen_type, draw_at)?;
                        seen.push(value);
                        suffix
                    } else {
                        String::new()
                    };
                    if *flags {
                        let mut spiked = [false];
                        self.one_value(
                            gen,
                            &format!("{stream}#e{k}{suffix}"),
                            row,
                            Some(&mut spiked),
                        )?;
                        parts.push(bool_text(spiked[0]));
                    } else if *distinct {
                        parts.push(seen[seen.len() - 1].clone());
                    } else {
                        parts.push(draw_at("")?);
                    }
                }
                let running = match accumulate {
                    Some(op) => match crate::generators::accumulate::apply(&parts, op) {
                        Ok(values) => values,
                        Err(message) => return invalid(&message),
                    },
                    None => parts,
                };
                Ok(Some(running.join(separator)))
            }

            Column::Plain {
                domain,
                gen,
                stream,
            } => {
                let Some(_) = self.pop_index_at(domain, row)? else {
                    return Ok(None);
                };
                Ok(Some(self.one_value(gen, stream, row, None)?))
            }

            Column::AnomalyFlag {
                domain,
                gen,
                stream,
                inline,
                probability,
                raw,
                missing,
            } => {
                if self.pop_index_at(domain, row)?.is_none() {
                    return Ok(None);
                }
                if *inline {
                    if *missing > 0.0
                        && seekable::uniforms(
                            &self.drawing_seed(),
                            &format!("{stream}#miss"),
                            row,
                            1,
                        )[0] < *missing
                    {
                        return Ok(Some(bool_text(false)));
                    }
                    let u =
                        seekable::uniforms(&self.drawing_seed(), &format!("{stream}#anom"), row, 1)
                            [0];
                    let numeric = match raw {
                        None => false,
                        Some(column) => self
                            .value_of(column, row)?
                            .is_some_and(|v| v.trim().parse::<f64>().is_ok_and(f64::is_finite)),
                    };
                    return Ok(Some(bool_text(u < *probability && numeric)));
                }
                let mut spiked = [false];
                self.one_value(gen, stream, row, Some(&mut spiked))?;
                Ok(Some(bool_text(spiked[0])))
            }

            Column::Text(text) => Ok(Some(text.clone())),

            Column::Constant { domain, text } => {
                Ok(self.pop_index_at(domain, row)?.map(|_| text.clone()))
            }

            Column::Mix {
                domain,
                cum_hi,
                key,
                cases,
                anomaly,
            } => {
                let Some(slot) = self.mix_slot_at(domain, *key, row)? else {
                    return Ok(None);
                };
                let at = run_for(cum_hi, slot);
                match anomaly {
                    Some(flags) => Ok(Some(bool_text(flags[at]))),
                    None => self.join_parts(&cases[at], row).map(Some),
                }
            }

            Column::Conditional(branches) => {
                for (condition, column) in branches {
                    let take = match condition {
                        None => true,
                        Some(expr) => self.condition(expr, row)?,
                    };
                    if take {
                        return self.value_of(column, row);
                    }
                }
                Ok(None)
            }

            Column::Switch {
                on,
                entries,
                fallback,
            } => {
                let key = self.value_at(on, row)?.unwrap_or_default();
                for (keys, parts) in entries {
                    if keys.contains(&key) {
                        return self.join_parts(parts, row).map(Some);
                    }
                }
                match fallback {
                    Some(parts) => self.join_parts(parts, row).map(Some),
                    None => Ok(None),
                }
            }

            Column::Distinct {
                members,
                groups,
                at,
                complaint,
            } => self
                .repair_distinct(members, groups, complaint, row)
                .map(|v| v[*at].clone()),

            Column::Composed { parts, witness } => {
                let mut text = String::new();
                let mut active = false;
                for part in parts {
                    match part {
                        Part::Text(literal) => text.push_str(literal),
                        Part::Column(column) => {
                            // A row outside the parent's filter has no value in
                            // any part, and the composed cell is absent rather
                            // than a string of bare literals.
                            if let Some(value) = self.value_of(column, row)? {
                                active = true;
                                text.push_str(&value);
                            }
                        }
                    }
                }
                match witness {
                    // Nothing unnamed draws here, so the value is the literals
                    // alone — constant, but still absent on a row this sequence
                    // does not apply to. A named field draws for exactly those
                    // rows and is asked instead.
                    Some(field) => Ok(self.value_of(field, row)?.map(|_| text)),
                    None => Ok(active.then_some(text)),
                }
            }

            Column::ExactUniq(resolver) => Ok(Some(resolver.value_at(row))),

            Column::EnvUniq { base, overrides } => match overrides.get(&row) {
                Some(replaced) => Ok(Some(replaced.clone())),
                None => self.value_of(base, row),
            },

            Column::Compute(tree) => {
                let fields = StreamFields { engine: self, row };
                compute::evaluate(tree, &fields)
                    .map(Some)
                    .map_err(|e| EngineError::Invalid(e.message))
            }

            Column::PackBody {
                columns,
                output,
                inject,
                seed,
            } => {
                // The body's own seed for as long as its columns are being read, then off again:
                // everything inside was keyed by it when the nested engine planned it, and the
                // draws it left until value time have to agree with that.
                self.body_seeds.borrow_mut().push(seed.clone());
                let lookup = BodyLookup {
                    engine: self,
                    columns,
                    row,
                };
                let result = interpolate::apply(output, inject.as_deref(), &lookup).map(Some);
                self.body_seeds.borrow_mut().pop();
                result
            }

            Column::Formula { expr, decimals } => formula::value_at_row(
                expr,
                *decimals,
                row.max(0) as usize,
                &|name| self.columns.contains_key(name),
                &|name| match self.value_at(name, row) {
                    Ok(value) => value,
                    Err(e) => {
                        self.remember(e);
                        None
                    }
                },
                // No previous row here, ever: this engine resolves ANY row without
                // touching the one before it — that is its whole design — so `prev()`
                // is refused rather than answered from a row it never computed.
                None,
            ),
        }
    }

    /// The whole group's values for one row, with collisions redrawn.
    ///
    /// Computed once per member asked rather than memoised: the repair is a pure
    /// function of the row, so recomputing gives the same answer, and a memo
    /// would need interior mutability for no change in the data.
    fn repair_distinct(
        &self,
        members: &[DistinctMember],
        groups: &[Vec<usize>],
        complaint: &str,
        row: i32,
    ) -> EngineResult<Vec<Option<String>>> {
        let mut values: Vec<Option<String>> = Vec::with_capacity(members.len());
        for member in members {
            values.push(self.value_of(&member.base, row)?);
        }

        for group in groups {
            let mut seen: Vec<String> = Vec::new();
            for at in group {
                let member = &members[*at];
                // An inactive row, filtered out by its parent.
                let Some(mut value) = values[*at].clone() else {
                    continue;
                };
                let mut attempt = 0usize;
                while seen.contains(&value) {
                    attempt += 1;
                    if attempt > DISTINCT_FUSE {
                        return invalid(&format!(
                            "{complaint} \"{}\" different from the others after {DISTINCT_FUSE} \
                             attempts — its source likely has too few distinct values.",
                            member.name
                        ));
                    }
                    let stream = format!("{}{attempt}", member.stream);
                    value = self.one_value(&member.gen, &stream, row, None)?;
                }
                seen.push(value.clone());
                values[*at] = Some(value);
            }
        }
        Ok(values)
    }

    /// A case body: its pieces, concatenated. A piece that does not apply on
    /// this row contributes nothing rather than the whole case being absent.
    fn join_parts(&self, parts: &[Column], row: i32) -> EngineResult<String> {
        let mut text = String::new();
        for part in parts {
            text.push_str(&self.value_of(part, row)?.unwrap_or_default());
        }
        Ok(text)
    }

    /// The flag beside a quota column: what HAPPENED on this row, not what was
    /// selected. `anomaly` multiplies a number and leaves anything else alone, so
    /// a selected word is not an outlier and must not be marked.
    fn quota_flag(&self, quota: &Quota, row: i32) -> EngineResult<Option<String>> {
        let Some(modifier) = &quota.modifier else {
            return Ok(None);
        };
        let Some(anomaly) = &modifier.anomaly else {
            return Ok(None);
        };
        let spiked_at = |row: i32, k: i32| -> EngineResult<bool> {
            let Some(slot) = self.slot_at(quota, row, k)? else {
                return Ok(false);
            };
            let raw = &quota.values[run_for(&quota.cum_hi, slot)];
            let draws = seekable::uniforms(
                &self.drawing_seed(),
                &format!("{}#anom", modifier.stream),
                row,
                modifier.element_draws,
            );
            let drawn = draws.get(k as usize).copied().unwrap_or(1.0);
            Ok(drawn < anomaly.probability && imperfections::is_spikeable(raw))
        };
        let Some(spec) = &quota.repeat else {
            if self.slot_at(quota, row, 0)?.is_none() {
                return Ok(None);
            }
            return Ok(Some(spiked_at(row, 0)?.to_string()));
        };
        let plan = quota.plan.as_ref().expect("built beside the spec");
        let Some(p) = self.repeat_pos_at(&quota.domain, quota.repeat_key, row)? else {
            return Ok(None);
        };
        // With `repeat` the flag is a LIST parallel to the values: one boolean
        // could not say which element of the batch was the one that spiked.
        let mut parts = Vec::new();
        for k in 0..plan.length_at(p) {
            parts.push(spiked_at(row, k)?.to_string());
        }
        Ok(Some(repeat::join(&parts, spec)?))
    }

    fn quota_value(&self, quota: &Quota, row: i32) -> EngineResult<Option<String>> {
        let Some(spec) = &quota.repeat else {
            let Some(slot) = self.slot_at(quota, row, 0)? else {
                return Ok(None);
            };
            let raw = quota.values[run_for(&quota.cum_hi, slot)].clone();
            return self.modify(&quota.modifier, row, Some(raw), 0);
        };

        let plan = quota.plan.as_ref().expect("built beside the spec");
        let Some(p) = self.repeat_pos_at(&quota.domain, quota.repeat_key, row)? else {
            return Ok(None);
        };
        let keep = plan.length_at(p);
        let mut parts = Vec::new();
        // `distinct` cannot read a pre-laid-out slot — a row that must not repeat itself has
        // to CHOOSE. One uniform per pick off the row's own `#dist` stream, budgeted at the
        // maximum length, so the row still resolves alone and the in-memory engine lands on
        // the same values.
        if spec.distinct {
            let draws = seekable::uniforms(
                &self.drawing_seed(),
                &format!("{}#dist", quota.stream_id),
                row,
                spec.max as usize,
            );
            let mut at = 0usize;
            let picked = repeat::draw_distinct(
                &quota.values,
                &quota.percents,
                keep as usize,
                || {
                    let u = draws.get(at).copied().unwrap_or(1.0);
                    at += 1;
                    u
                },
                "the value list",
            )?;
            for (k, raw) in picked.into_iter().enumerate() {
                let dressed = self.modify(&quota.modifier, row, Some(raw), k)?;
                parts.push(dressed.unwrap_or_default());
            }
            return Ok(Some(repeat::join(&parts, spec)?));
        }
        for k in 0..keep {
            let raw = match self.slot_at(quota, row, k)? {
                Some(slot) => quota.values[run_for(&quota.cum_hi, slot)].clone(),
                None => String::new(),
            };
            let dressed = self.modify(&quota.modifier, row, Some(raw), k as usize)?;
            parts.push(dressed.unwrap_or_default());
        }
        Ok(Some(repeat::join(&parts, spec)?))
    }

    /// One row's worth of an independently-drawn generator.
    ///
    /// The values and the modifiers come off the same generator, in that order,
    /// because that is the order the in-memory engine takes them in. Splitting
    /// them across two streams would give a different column for the same seed,
    /// which is the one thing neither engine may do.
    fn one_value(
        &self,
        gen: &Gen,
        stream_id: &str,
        row: i32,
        flags: Option<&mut [bool]>,
    ) -> EngineResult<String> {
        let mut prng = seekable::generator(&self.drawing_seed(), stream_id, row);
        // The row this value belongs to, and this engine's own registry to read siblings
        // from — what a distribution parameter written as an expression needs. Nothing
        // else looks at it, and a generator without one costs no lookup.
        let here = [row.max(0) as usize];
        let scope = memory::SiblingScope {
            rows: &here,
            siblings: self,
        };
        // The COLUMN's name and row travel with the one-row build, because the
        // in-memory engine's own one-row path carries them and anything derived
        // from them has to come out the same on both engines. A pack generator is
        // the case that showed it: its body is seeded from the column's identity.
        let drawn = memory::generate_in_column(
            gen,
            1,
            &mut prng,
            &self.env,
            None,
            Some(&scope),
            Some((self.env.config.seed.as_str(), stream_id, Some(here[0]))),
        )?;
        let mut own = [false];
        let finished = memory::finish(
            drawn,
            &gen.attrs,
            &mut prng,
            Some(flags.unwrap_or(&mut own)),
        )?;
        Ok(finished.into_iter().next().unwrap_or_default())
    }

    /// The per-row passes an inline-built value still needs.
    ///
    /// Each draws on a stream of its own, so adding one never disturbs the
    /// values. With `repeat` a row needs one draw per element, so the row's
    /// draws are pulled at once and indexed — asking for one draw and asking for
    /// the first of many give the same number.
    fn modify(
        &self,
        modifier: &Option<Modifier>,
        row: i32,
        value: Option<String>,
        element: usize,
    ) -> EngineResult<Option<String>> {
        let (Some(modifier), Some(mut result)) = (modifier, value.clone()) else {
            return Ok(value);
        };
        if let Some(anomaly) = &modifier.anomaly {
            let u = seekable::uniforms(
                &self.drawing_seed(),
                &format!("{}#anom", modifier.stream),
                row,
                modifier.element_draws,
            );
            if u[element] < anomaly.probability {
                result = imperfections::spike(&result, anomaly.factor);
            }
        }
        if let Some(missing) = &modifier.missing {
            let u = seekable::uniforms(
                &self.drawing_seed(),
                &format!("{}#miss", modifier.stream),
                row,
                modifier.element_draws,
            );
            if u[element] < missing.probability {
                result = missing.token.clone();
            }
        }
        if let Some(pattern) = &modifier.mask {
            result = mask::apply(pattern, &result)?;
        }
        if let Some(case) = &modifier.case {
            result = transforms::apply_case(case, &result);
        }
        Ok(Some(result))
    }
}

// ── writing ──────────────────────────────────────────────────────────────────

impl StreamEngine<'_> {
    fn text_result(&self) -> EngineResult<String> {
        let mut out = String::new();
        self.write_result(&mut out)?;
        Ok(out)
    }

    /// The run, written a piece at a time into any sink that accepts text.
    ///
    /// The same code path `text_result` uses, so the bytes cannot differ between
    /// a run bound for a String and one bound for a file — the difference is only
    /// where each piece goes once it exists. That is what lets `-o` hold one row
    /// instead of the whole output, which is what "streaming" was supposed to
    /// mean here and did not.
    fn write_result<W: std::fmt::Write>(&self, out: &mut W) -> EngineResult<()> {
        let fx = &self.env.config.fixtures;
        let each = memory::each_info(self.env.config)?;

        self.emit(out, &fx.before, 0)?;
        // About one report per half-percent: cheap enough to leave on always.
        let total = self.count.max(0) as usize;
        let report_every = (total / 200).max(1);
        for row in 0..self.count {
            if let Some(report) = self.on_progress {
                let done = row.max(0) as usize;
                if done % report_every == 0 {
                    report("render", done, total);
                }
            }
            self.emit(out, &fx.before_block, row)?;

            let mut active = Vec::new();
            for line in &self.env.config.block {
                let keep = match &line.if_expr {
                    None => true,
                    Some(expr) => self.condition(expr, row)?,
                };
                if keep {
                    active.push(line);
                }
            }

            // The OUTPUT lines, not the <line> ELEMENTS — see the note in the
            // in-memory engine. The two must agree byte for byte, so they count
            // the same thing.
            let mut emitted: Vec<String> = Vec::new();
            for line in &active {
                emitted.extend(self.render_line(line, row, &each)?);
            }
            for (i, text) in emitted.iter().enumerate() {
                self.emit(out, &fx.before_line, row)?;
                write_all(out, text)?;
                self.emit(out, &fx.after_line, row)?;
                if i + 1 < emitted.len() {
                    self.emit(out, &fx.delimiter_line, row)?;
                }
            }

            self.emit(out, &fx.after_block, row)?;
            if row + 1 < self.count {
                self.emit(out, &fx.delimiter_block, row)?;
            }
        }
        self.emit(out, &fx.after, (self.count - 1).max(0))?;
        // Said at the end as well as along the way: a phase a watcher sees CLOSE
        // is a phase it can tell from a stall. The sweep above reports every
        // half-percent and so stops short.
        if let Some(report) = self.on_progress {
            report("render", total, total);
        }
        Ok(())
    }

    fn emit<W: std::fmt::Write>(&self, to: &mut W, lines: &[Line], row: i32) -> EngineResult<()> {
        let none: Vec<(String, repeat::Spec)> = Vec::new();
        for line in lines {
            // A fixture line is one output line, and `render_line` hands back the LINES.
            for text in self.render_line(line, row, &none)? {
                write_all(to, &text)?;
            }
        }
        Ok(())
    }

    fn render_line(
        &self,
        line: &Line,
        row: i32,
        each_info: &[(String, repeat::Spec)],
    ) -> EngineResult<Vec<String>> {
        let mut template = String::new();
        for part in &line.parts {
            let keep = match &part.if_expr {
                None => true,
                Some(expr) => self.condition(expr, row)?,
            };
            if keep {
                template.push_str(&part.text);
            }
        }

        let inject = self.env.config.inject.as_deref();
        let Some(list_name) = trim_to_none(line.each.as_deref()) else {
            let lookup = StreamLookup { engine: self, row };
            let mut text = interpolate::apply(&template, inject, &lookup)?;
            self.raise_pending()?;
            text.push('\n');
            return Ok(vec![text]);
        };

        let spec = each_info
            .iter()
            .find(|(n, _)| n == list_name)
            .map(|(_, s)| s);
        let cell = self.value_at(list_name, row)?;
        let elements = repeat::split(
            cell.as_deref(),
            spec.map_or(repeat::DEFAULT_SEPARATOR, |s| s.separator.as_str()),
        );

        let (mut lane, mut stride) = (0i64, 0i64);
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
                base: StreamLookup { engine: self, row },
                list_name,
                element,
                item: (k + 1) as i64,
                item_id: repeat::item_key(i64::from(row) + 1, (k + 1) as i64, lane, stride),
            };
            let mut text = interpolate::apply(&template, inject, &lookup)?;
            self.raise_pending()?;
            text.push('\n');
            result.push(text);
        }
        Ok(result)
    }

    fn condition(&self, expression: &str, row: i32) -> EngineResult<bool> {
        let scope = StreamLookup { engine: self, row };
        let answer = evaluate::as_condition(expression, &scope)?;
        self.raise_pending()?;
        Ok(answer)
    }

    fn remember(&self, error: EngineError) {
        let mut slot = self.failure.borrow_mut();
        if slot.is_none() {
            *slot = Some(error);
        }
    }

    /// Re-raise whatever a lookup swallowed, if anything did.
    fn raise_pending(&self) -> EngineResult<()> {
        match self.failure.borrow_mut().take() {
            Some(e) => Err(e),
            None => Ok(()),
        }
    }
}

/// What a name resolves to on one row.
///
/// A cell that fails reads as empty HERE and is recorded on the engine, because
/// this layer answers a name with a string and has nowhere to put a `Result`.
/// [`StreamEngine::raise_pending`] is what turns it back into one.
struct StreamLookup<'a, 'b> {
    engine: &'a StreamEngine<'b>,
    row: i32,
}

impl Lookup for StreamLookup<'_, '_> {
    fn has(&self, name: &str) -> bool {
        self.engine.columns.contains_key(name)
    }

    fn value(&self, name: &str) -> String {
        match self.engine.value_at(name, self.row) {
            Ok(value) => value.unwrap_or_default(),
            Err(e) => {
                self.engine.remember(e);
                String::new()
            }
        }
    }
}

/// The streaming half of the sibling seam: a column is asked for a value at a row, and
/// the lazy registry computes exactly that row of exactly that column.
///
/// A forward reference cannot arrive here — TDC240 refuses a parameter naming a column
/// declared below it — so this never asks the registry to build a column that is asking
/// for this one.
impl memory::Siblings for StreamEngine<'_> {
    fn has(&self, name: &str) -> bool {
        self.columns.contains_key(name)
    }

    fn at(&self, name: &str, row: usize) -> Option<String> {
        match self.value_at(name, row as i32) {
            Ok(value) => value,
            Err(e) => {
                self.remember(e);
                None
            }
        }
    }
}

impl evaluate::Scope for StreamLookup<'_, '_> {
    fn has(&self, name: &str) -> bool {
        Lookup::has(self, name)
    }

    fn value(&self, name: &str) -> String {
        Lookup::value(self, name)
    }
}

/// The same row, seen by the compute layer.
struct StreamFields<'a, 'b> {
    engine: &'a StreamEngine<'b>,
    row: i32,
}

/// One row of a pack body's own columns, for the text they assemble into and for
/// a `<compute>` inside the body that reads its siblings.
///
/// A body's names are private to it, so they are resolved against the body's map
/// rather than the run's. Everything else about a column is self-contained, so
/// the parent engine evaluates it unchanged — only a `<compute>` asks for a
/// sibling by name, and that is what this exists for.
struct BodyLookup<'a, 'b> {
    engine: &'a StreamEngine<'b>,
    columns: &'a BTreeMap<String, Column>,
    row: i32,
}

impl BodyLookup<'_, '_> {
    fn value(&self, name: &str) -> Option<String> {
        let column = self.columns.get(name)?;
        match column {
            Column::Compute(tree) => {
                let fields = BodyFields { body: self };
                compute::evaluate(tree, &fields).ok()
            }
            other => self.engine.value_of(other, self.row).ok().flatten(),
        }
    }
}

impl interpolate::Lookup for BodyLookup<'_, '_> {
    fn has(&self, name: &str) -> bool {
        self.columns.contains_key(name)
    }

    fn value(&self, name: &str) -> String {
        BodyLookup::value(self, name).unwrap_or_default()
    }
}

struct BodyFields<'a, 'b, 'c> {
    body: &'a BodyLookup<'b, 'c>,
}

impl compute::Fields for BodyFields<'_, '_, '_> {
    fn get(&self, name: &str) -> Option<String> {
        self.body.value(name)
    }
}

impl compute::Fields for StreamFields<'_, '_> {
    fn get(&self, name: &str) -> Option<String> {
        self.engine.value_at(name, self.row).ok().flatten()
    }
}

struct ElementLookup<'a, 'b, 'c> {
    base: StreamLookup<'a, 'b>,
    list_name: &'c str,
    element: &'c str,
    item: i64,
    item_id: i64,
}

impl Lookup for ElementLookup<'_, '_, '_> {
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

// ── small helpers ────────────────────────────────────────────────────────────

/// Which run of the cumulative bounds holds this slot — binary search, for wide
/// columns.
fn run_for(cum_hi: &[i32], slot: i32) -> usize {
    let (mut lo, mut hi) = (0usize, cum_hi.len() - 1);
    while lo < hi {
        let mid = (lo + hi) / 2;
        if slot < cum_hi[mid] {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}

fn cumulative(counts: &[i32]) -> Vec<i32> {
    let mut acc = 0;
    counts
        .iter()
        .map(|c| {
            acc += c;
            acc
        })
        .collect()
}

fn evenly(n: usize) -> Vec<f64> {
    vec![100.0 / n as f64; n]
}

fn bool_text(value: bool) -> String {
    if value { "true" } else { "false" }.to_string()
}

fn long_attr(raw: Option<&String>, fallback: i64) -> EngineResult<i64> {
    match trim_to_none(raw.map(String::as_str)) {
        None => Ok(fallback),
        Some(text) => text
            .parse()
            .map_err(|_| EngineError::Invalid(format!("expected a whole number, got \"{text}\""))),
    }
}

fn trim_to_none(value: Option<&str>) -> Option<&str> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// A candidate member's fields first, then the row's columns — for a filter the
/// streaming engine evaluates per candidate.
///
/// A qualified `Pool.field` always means the member's field. A name that is both
/// a field and a column is refused by the validator, so this never has to guess.
struct StreamMemberScope<'a> {
    engine: &'a StreamEngine<'a>,
    table: &'a PoolTable,
    member: usize,
    row: i32,
    /// The ROW columns the filter actually read, and what they held — see
    /// [`pool::row_values_detail`]. Handed in from the caller so the values
    /// survive the per-candidate scope.
    read: &'a std::cell::RefCell<std::collections::BTreeMap<String, String>>,
}

impl StreamMemberScope<'_> {
    fn field(&self, name: &str) -> Option<String> {
        let prefix = format!("{}.", self.table.name);
        let key = name.strip_prefix(&prefix).unwrap_or(name);
        self.table
            .columns
            .get(key)
            .map(|c| c.get(self.member).cloned().unwrap_or_default())
    }
}

impl evaluate::Scope for StreamMemberScope<'_> {
    fn has(&self, name: &str) -> bool {
        self.field(name).is_some() || self.engine.columns.contains_key(name)
    }

    fn value(&self, name: &str) -> String {
        if let Some(found) = self.field(name) {
            return found;
        }
        let value = self
            .engine
            .value_at(name, self.row)
            .ok()
            .flatten()
            .unwrap_or_default();
        if self.engine.columns.contains_key(name) {
            self.read
                .borrow_mut()
                .insert(name.to_string(), value.clone());
        }
        value
    }
}
