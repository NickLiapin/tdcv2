//! The engines: turning a [`Config`] into rows, and rows into text.
//!
//! There are three, as there are in the other four implementations — one
//! in-memory, one streaming, one exact-on-disk — and they agree byte for byte
//! on one seed, which `fixtures/cross-language/engines.json` checks. They differ
//! in what they can answer and what it costs in memory, so which engine a config
//! gets is still part of the contract: the router reads it off what the config
//! declares.
//!
//! [`memory`] streams nothing and answers instantly, [`stream`] holds one row,
//! and [`disk`] is [`stream`] with `uniq` built exactly — falling back to
//! [`memory`] for the configs that cannot be both exact and bounded.

pub mod disk;
pub mod exact_uniq;
pub mod external_sort;
pub mod memory;
pub mod per_row;
pub mod repeat_keyed;
pub mod router;
pub mod stream;
pub mod uniq_simple;

use crate::model::Config;
use crate::packs::DataPacks;

/// Why a run could not be produced.
///
/// The two are kept apart on purpose. **Unsupported** is a feature this
/// implementation has not reached yet and says so by name; **Invalid** is a
/// config that no implementation would accept. Only the second is a defect in
/// the config, and only the absence of the first is progress — the shared-case
/// harness counts them separately, because a port that quietly produced a
/// plausible-but-wrong column would otherwise look further along than one that
/// refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EngineError {
    Unsupported(String),
    Invalid(String),
}

impl EngineError {
    pub fn message(&self) -> &str {
        match self {
            EngineError::Unsupported(m) | EngineError::Invalid(m) => m,
        }
    }
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Unsupported(m) => write!(f, "not ported yet: {m}"),
            EngineError::Invalid(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for EngineError {}

pub type EngineResult<T> = Result<T, EngineError>;

/// Refuse by name, rather than approximate.
///
/// Every unported feature goes through here with the thing it is missing spelled
/// out, so the harness can group what is left and say which piece of work is the
/// biggest — rather than reporting a number and an impression.
pub fn unsupported<T>(what: &str) -> EngineResult<T> {
    Err(EngineError::Unsupported(what.to_string()))
}

pub fn invalid<T>(what: &str) -> EngineResult<T> {
    Err(EngineError::Invalid(what.to_string()))
}

/// A finished run, seen from the outside: how many records, what they are
/// called, what a given record holds.
///
/// The only thing the engines have to agree on. One holds every column in memory
/// and answers instantly; another computes the value when asked and forgets it
/// again. A caller iterating rows cannot tell which it has, which is the point —
/// the engine is a performance decision, not a difference in the data.
pub trait RowSource {
    /// The number of records.
    fn count(&self) -> usize;

    /// The declared sequences, in declaration order; the built-in `_`-names are
    /// left out.
    fn sequence_names(&self) -> &[String];

    /// One value, or `None` when the sequence does not apply to that record.
    fn value(&self, column: &str, row: usize) -> Option<&str>;

    /// The whole run as text — what the config's `<block>` produces.
    fn text(&self) -> String;
}

/// Run a config and return its text.
///
/// The router decides which engine, and that decision is part of the contract
/// rather than an optimisation: an engine that cannot hold a whole column still
/// answers a config that needs one, by answering a smaller question a row at a
/// time — which comes out wrong in every row while looking perfectly plausible.
pub fn render(config: &Config, now_millis: i64) -> EngineResult<String> {
    render_in(config, now_millis, None)
}

/// The same, resolving a relative `src=` against the config file's own folder.
///
/// Not the working directory: the same config would then work from one shell and
/// fail from another, which is the difference between a config a team can share
/// and one that only runs where it was written.
pub fn render_in(config: &Config, now_millis: i64, base_dir: Option<&str>) -> EngineResult<String> {
    // Discovered rather than required: a config that draws from no pack at all
    // still runs on a machine that has none, and only engine 3 cannot proceed
    // without one.
    let packs = DataPacks::discover().ok();
    match router::resolve(config, packs.as_ref())? {
        1 => memory::render_in(config, now_millis, base_dir),
        2 => stream::render_in(config, now_millis, base_dir),
        3 => {
            let packs = match packs {
                Some(found) => found,
                None => DataPacks::discover()?,
            };
            disk::render_in(config, &packs, now_millis, base_dir)
        }
        other => invalid(&format!("engine {other} does not exist")),
    }
}

/// Run a config and hand back the rows, whichever engine produced them.
///
/// What the facade calls. The result is owned rather than borrowed from the
/// engine so that a caller can hold it: engine 2 computes a value when asked and
/// forgets it again, which is exactly what [`RowSource`] cannot do, so the rows
/// it hands out are materialised at this boundary. Streaming callers use
/// [`render_in`], which is the path that keeps memory flat.
pub fn run_in(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
) -> EngineResult<Box<dyn RowSource>> {
    match router::resolve(config, Some(packs))? {
        1 => Ok(Box::new(memory::run_in(
            config, packs, now_millis, base_dir,
        )?)),
        2 => Ok(Box::new(stream::rows_in(
            config, packs, now_millis, base_dir,
        )?)),
        3 => disk::rows_in(config, packs, now_millis, base_dir),
        other => invalid(&format!("engine {other} does not exist")),
    }
}
