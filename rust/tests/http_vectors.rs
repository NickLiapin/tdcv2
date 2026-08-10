//! The two numbers a service recomputes, against the shared vector file.
//!
//! A service checks ONE signature and reads ONE seed, and cannot tell which of
//! the five runtimes sent the request — so both are the wire contract rather
//! than an implementation detail. This crate held the only pinned value for the
//! derived seed and one of two for the signature; the file it now reads is the
//! same one the other four answer to, so a drift anywhere fails everywhere.

mod common;

use tdcv2::generators::http;

#[test]
fn signatures_match_every_implementation() {
    let fixture = common::read_fixture("http-vectors.json");
    let vectors = fixture
        .get("signature")
        .and_then(|v| v.get("vectors"))
        .and_then(|v| v.as_array())
        .expect("signature.vectors");
    assert!(!vectors.is_empty(), "an empty fixture would pass anything");

    for vector in vectors {
        let name = vector.get("name").and_then(|v| v.as_str()).expect("name");
        let secret = vector.get("secret").and_then(|v| v.as_str()).expect("secret");
        let timestamp = vector
            .get("timestamp")
            .and_then(|v| v.as_str())
            .expect("timestamp");
        let seed = vector.get("seed").and_then(|v| v.as_str()).expect("seed");
        let count = vector
            .get("count")
            .and_then(|v| v.as_i64())
            .expect("count") as usize;
        let body = vector.get("body").and_then(|v| v.as_str()).expect("body");
        let want = vector
            .get("signature")
            .and_then(|v| v.as_str())
            .expect("signature");

        assert_eq!(
            http::sign_request(secret, timestamp, seed, count, body),
            want,
            "{name}"
        );
    }
}

/// Pinning one request pins nothing: the vectors differ from the canonical one
/// in a single field each, so an implementation that dropped a field from the
/// message would match the first and fail one of the others.
#[test]
fn every_part_of_the_message_reaches_the_hash() {
    let fixture = common::read_fixture("http-vectors.json");
    let vectors = fixture
        .get("signature")
        .and_then(|v| v.get("vectors"))
        .and_then(|v| v.as_array())
        .expect("signature.vectors");
    let mut seen: Vec<&str> = vectors
        .iter()
        .filter_map(|v| v.get("signature").and_then(|s| s.as_str()))
        .collect();
    let total = seen.len();
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), total, "two vectors share a signature");
}

#[test]
fn derived_seeds_match_every_implementation() {
    let fixture = common::read_fixture("http-vectors.json");
    let vectors = fixture
        .get("derivedSeed")
        .and_then(|v| v.get("vectors"))
        .and_then(|v| v.as_array())
        .expect("derivedSeed.vectors");
    assert!(!vectors.is_empty(), "an empty fixture would pass anything");

    for vector in vectors {
        let env_seed = vector
            .get("envSeed")
            .and_then(|v| v.as_str())
            .expect("envSeed");
        let sequence = vector
            .get("sequence")
            .and_then(|v| v.as_str())
            .expect("sequence");
        let want = vector
            .get("derived")
            .and_then(|v| v.as_str())
            .expect("derived");
        assert_eq!(http::seed_for(env_seed, sequence), want, "{env_seed}|{sequence}");
    }
}
