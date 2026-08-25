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
//!
//! Two things it must NOT do, and both used to happen here.
//!
//! It must not fall back for a caller that NAMED this engine. `engine="3"` and
//! `--engine 3` say WHICH engine to run, so quietly running another hides exactly
//! what the author asked to be told — the rule the streaming engine has followed
//! all along. Measured before the fix: a tight `<uniq>` under `--engine 3`
//! produced byte-identical output to `--engine 1`, so anyone benchmarking engine
//! 3 on a tight config was benchmarking engine 1.
//!
//! And it must not fall back past what the in-memory engine can hold. There the
//! fallback does not fail fast; it fails after half an hour of materialising, out
//! of memory, with nothing written.

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
    rows_in_watched(config, packs, now_millis, base_dir, None)
}

/// Raise instead of falling back, in the two cases where falling back is the
/// wrong answer.
///
/// `named` here means "named AND stopped by the repair cap". A shape the lazy
/// path cannot express at all — a weighted pack generator, say — means engine 3
/// never got to run the config, and covering that is what engine 3 IS. The cap
/// is the other case: engine 3 DID run this config, got most of the way, and
/// gave up on a memory budget — the very property the caller named this engine
/// to get.
fn refuse_if_it_must(error: &EngineError, count: i32, named: bool) -> Option<EngineError> {
    // The refusals share a first half — up to the em dash — and differ in the
    // advice after it.
    let full = match error {
        EngineError::Unsupported(message) | EngineError::Invalid(message) => message.as_str(),
        _ => return None,
    };
    let said = full.split(" — ").next().unwrap_or(full);
    if count > exact_uniq::IN_MEMORY_FALLBACK_MAX_ROWS {
        return Some(EngineError::Unsupported(format!(
            "{said} — and at {count} rows the in-memory engine cannot take over. Widen the \
             uniq columns' values (more distinct names, wider ranges…) or lower the count."
        )));
    }
    if named {
        return Some(EngineError::Unsupported(format!(
            "{said} — and engine 3 was asked for by name, so it refuses rather than quietly \
             running another engine. Remove the engine choice to let a uniq this tight go to \
             the in-memory engine, which is what has been happening here all along."
        )));
    }
    None
}

/// The same, reporting what it is doing as it goes.
pub fn rows_in_watched(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
    on_progress: crate::engine::Watch<'_>,
) -> EngineResult<Box<dyn RowSource>> {
    rows_in_named(config, packs, now_millis, base_dir, on_progress, false)
}

/// The same, told whether the caller asked for this engine BY NAME.
pub fn rows_in_named(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
    on_progress: crate::engine::Watch<'_>,
    named: bool,
) -> EngineResult<Box<dyn RowSource>> {
    match stream::rows_exact_watched(config, packs, now_millis, base_dir, on_progress) {
        Ok(rows) => Ok(Box::new(rows)),
        Err(e) if falls_back(&e) => {
            let stopped_by_the_cap = exact_uniq::is_repair_needed(&e);
            if let Some(refusal) = refuse_if_it_must(&e, config.count, named && stopped_by_the_cap)
            {
                return Err(refusal);
            }
            Ok(Box::new(memory::run_in_watched(
                config,
                packs,
                now_millis,
                base_dir,
                on_progress,
            )?))
        }
        Err(e) => Err(e),
    }
}

/// The same, rendered straight to text.
pub fn render_in(
    config: &Config,
    packs: &DataPacks,
    now_millis: i64,
    base_dir: Option<&str>,
    named: bool,
) -> EngineResult<String> {
    Ok(rows_in_named(config, packs, now_millis, base_dir, None, named)?.text())
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
