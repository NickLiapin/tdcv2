//! `<gen type="http">` — the pieces that can be checked without a socket.
//!
//! The generator's real behaviour needs a service, and the differential run
//! against one is what proved it: seven scenarios — a plain call, a short reply,
//! both `on_error` branches, a 500, the 429 that cannot be softened, and a
//! timeout — all matching the reference word for word. What is worth a
//! standing test is the derived seed, because it is a value another program
//! depends on and a silent change to it would break services rather than tests.

use tdcv2::generators::http::{self, OnError};

#[test]
fn the_seed_a_service_receives_is_derived_per_sequence() {
    // Pinned against the reference's own output for this pair. A service written
    // to be reproducible from this header must get the same header whichever
    // runtime called it, or the same config produces different data depending on
    // the runtime.
    assert_eq!(http::seed_for("httpseed", "V"), "a49ff8ad");

    // Two sequences pointed at one service must not receive the same seed, or a
    // service that generates from it hands back two identical columns.
    assert_ne!(http::seed_for("s", "First"), http::seed_for("s", "Second"));
    // And two runs with different seeds must differ, which is the other half.
    assert_ne!(http::seed_for("a", "V"), http::seed_for("b", "V"));

    // Eight hex digits, always — a service parsing it has a fixed width to read.
    let value = http::seed_for("whatever", "Name");
    assert_eq!(value.len(), 8);
    assert!(value
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));
}

#[test]
fn timeout_reads_seconds_and_falls_back_to_thirty() {
    assert_eq!(http::timeout_ms(Some("0.4")), 400);
    assert_eq!(http::timeout_ms(Some("30")), 30_000);
    assert_eq!(http::timeout_ms(Some(" 2 ")), 2_000);

    // Anything unusable is the default rather than an error: a bad timeout is
    // not worth refusing a run over, and zero or negative would mean "give up
    // immediately", which nobody writes on purpose.
    for unusable in ["", "abc", "-1", "0"] {
        assert_eq!(http::timeout_ms(Some(unusable)), 30_000, "{unusable:?}");
    }
    assert_eq!(http::timeout_ms(None), 30_000);
}

#[test]
fn on_error_is_fail_unless_it_says_empty() {
    let mut attrs = std::collections::BTreeMap::new();
    assert_eq!(http::on_error(&attrs), OnError::Fail);

    attrs.insert("on_error".to_string(), "empty".to_string());
    assert_eq!(http::on_error(&attrs), OnError::Empty);

    // Not a spelling anyone should rely on being forgiven.
    attrs.insert("on_error".to_string(), "Empty".to_string());
    assert_eq!(http::on_error(&attrs), OnError::Fail);
}

#[test]
fn a_batch_of_nothing_asks_no_service_anything() {
    // count=0 must not open a socket. A config with a parent that filtered
    // everything out reaches here, and a service woken to be asked for nothing
    // is a service that will be woken a lot.
    let values = http::fetch("http://127.0.0.1:1/never", 0, None, None, OnError::Fail, 1, None)
        .expect("no call, no failure");
    assert!(values.is_empty());
}
