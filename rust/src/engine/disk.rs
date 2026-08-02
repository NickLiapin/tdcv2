//! Engine 3: everything the in-memory engine does, for runs that do not fit in
//! memory.
//!
//! It is not a third implementation. It is the streaming engine with one setting
//! changed — a `uniq` sequence is built to its exact shares and then verified on
//! disk, instead of being given uniform combinations — and a fallback for the
//! configs that setting cannot satisfy.
//!
//! The fallback is the honest part. A config that turns out to need the whole
//! column, or a uniqueness constraint so tight the bounded repair cannot place
//! every row, goes to the in-memory engine and produces correct data at the cost
//! of the memory profile. Which is the right trade: an engine chosen for its
//! memory behaviour must not answer differently from the one that was not.

use super::{exact_uniq, memory, stream, EngineError, EngineResult, RowSource};
use crate::model::Config;
use crate::packs::DataPacks;

/// The run as addressable records, exact and bounded — or in memory when it
/// cannot be both.
pub fn rows_in(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
) -> EngineResult<Box<dyn RowSource>> {
    match stream::rows_exact(config, packs, now_millis, base_dir) {
        Ok(rows) => Ok(Box::new(rows)),
        Err(e) if falls_back(&e) => Ok(Box::new(memory::run_in(
            config, packs, now_millis, base_dir,
        )?)),
        Err(e) => Err(e),
    }
}

/// The same, rendered straight to text.
pub fn render_in(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
) -> EngineResult<String> {
    Ok(rows_in(config, packs, now_millis, base_dir)?.text())
}

/// Whether this is the streaming engine saying "not here", rather than the
/// config being wrong.
///
/// Only the first kind falls back. An invalid config is invalid on every engine,
/// and quietly running it somewhere else would turn a diagnostic into a
/// surprise.
fn falls_back(error: &EngineError) -> bool {
    exact_uniq::is_repair_needed(error) || matches!(error, EngineError::Unsupported(_))
}
