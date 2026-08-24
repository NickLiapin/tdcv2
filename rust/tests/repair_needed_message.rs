//! The refusal a too-tight `<uniq>` gets, worded the same in all five
//! implementations.

use tdcv2::engine::exact_uniq::{repair_needed, repair_needed_at_least};
use tdcv2::engine::EngineError;

fn sentence(rows: &str) -> String {
    format!(
        "uniq \"A × B\" is too tight to repair without holding the whole table ({rows} \
         couldn't be placed) — run without mode=\"stream\" so the in-memory engine can arrange it."
    )
}

fn text(error: EngineError) -> String {
    match error {
        EngineError::Unsupported(message) => message,
        other => panic!("expected an Unsupported refusal, got {other:?}"),
    }
}

/// The scan stops as soon as it is past the cap, because nothing it could find
/// afterwards changes the answer — measured on a config that misses the cap by
/// two orders of magnitude (1,618,803 rows against 20,000), finishing the count
/// took 6.79 s against 0.08 s to stop. What it gives up is the exact figure, so
/// the sentence stops claiming one.
#[test]
fn a_floor_is_named_as_a_floor() {
    assert_eq!(
        text(repair_needed_at_least(20_000, "\"A × B\"", true)),
        sentence("more than 20000 rows")
    );
}

#[test]
fn an_exact_count_is_named_exactly() {
    assert_eq!(text(repair_needed(1, "\"A × B\"")), sentence("1 row(s)"));
}
