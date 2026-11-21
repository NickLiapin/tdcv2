//! The two numbers a service recomputes, and the target it reads them against,
//! from the shared vector file.
//!
//! A service checks ONE signature and reads ONE seed, and cannot tell which of
//! the five runtimes sent the request — so both are the wire contract rather
//! than an implementation detail. The signature covers the request target, so
//! the target is part of that contract too. This crate held the only pinned
//! value for the derived seed and one of two for the signature; the file it now
//! reads is the same one the other four answer to, so a drift anywhere fails
//! everywhere.

mod common;

use tdcv2::generators::http;
use tdcv2::generators::http_target::{dot_segment_of, http_target};

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
        let secret = vector
            .get("secret")
            .and_then(|v| v.as_str())
            .expect("secret");
        let method = vector
            .get("method")
            .and_then(|v| v.as_str())
            .expect("method");
        let target = vector
            .get("target")
            .and_then(|v| v.as_str())
            .expect("target");
        let timestamp = vector
            .get("timestamp")
            .and_then(|v| v.as_str())
            .expect("timestamp");
        let seed = vector.get("seed").and_then(|v| v.as_str()).expect("seed");
        let count = vector.get("count").and_then(|v| v.as_i64()).expect("count") as usize;
        let offset = vector
            .get("offset")
            .and_then(|v| v.as_i64())
            .expect("offset") as usize;
        let total = vector.get("total").and_then(|v| v.as_i64()).expect("total") as usize;
        let body = vector.get("body").and_then(|v| v.as_str()).expect("body");
        let want = vector
            .get("signature")
            .and_then(|v| v.as_str())
            .expect("signature");

        assert_eq!(
            http::sign_request(secret, method, target, timestamp, seed, count, offset, total, body),
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

fn target_vectors() -> Vec<(String, String, String, String)> {
    let fixture = common::read_fixture("http-vectors.json");
    let vectors = fixture
        .get("target")
        .and_then(|v| v.get("vectors"))
        .and_then(|v| v.as_array())
        .expect("target.vectors");
    assert!(!vectors.is_empty(), "an empty fixture would pass anything");
    vectors
        .iter()
        .map(|vector| {
            let field = |key: &str| {
                vector
                    .get(key)
                    .and_then(|v| v.as_str())
                    .unwrap_or_else(|| panic!("{key}"))
                    .to_string()
            };
            (field("name"), field("src"), field("target"), field("url"))
        })
        .collect()
}

/// What is signed must be what curl puts on the request line, and the five
/// implementations must agree on it, or one service accepts four of them.
#[test]
fn targets_match_every_implementation() {
    for (name, src, target, url) in target_vectors() {
        let got = http_target(&src);
        assert_eq!(got.target, target, "{name}: target");
        assert_eq!(got.url, url, "{name}: url");
    }
}

/// The property the rebuilt URL relies on: what the rule produced, it produces
/// again — so a client handed it has nothing left to change.
#[test]
fn a_target_already_in_its_form_is_left_untouched() {
    for (name, _, target, url) in target_vectors() {
        let again = http_target(&url);
        assert_eq!(again.target, target, "{name}: target");
        assert_eq!(again.url, url, "{name}: url");
    }
}

#[test]
fn a_dot_segment_is_found_however_it_is_spelled() {
    assert_eq!(dot_segment_of("http://h/a/../b"), Some(".."));
    assert_eq!(dot_segment_of("http://h/./b"), Some("."));
    assert_eq!(dot_segment_of("http://h/a/%2e%2E"), Some(".."));
    assert_eq!(dot_segment_of("http://h/a/.%2e/b?x=.."), Some(".."));
    assert_eq!(dot_segment_of("http://h/a..b/.x/x.?q=/../"), None);
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
        assert_eq!(
            http::seed_for(env_seed, sequence),
            want,
            "{env_seed}|{sequence}"
        );
    }
}
