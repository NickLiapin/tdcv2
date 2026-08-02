//! The PRNG against the vectors every implementation is held to.
//!
//! A double is compared exactly, not approximately. These are not measurements:
//! the same seed has to produce the same bits, because the row a value lands on
//! is decided by comparing them. An "almost equal" test here would pass a port
//! that drifts.

mod common;

use tdcv2::prng::{self, permute, seekable};
use tdcv2::stats::hamilton;

#[test]
fn matches_the_shared_prng_vectors() {
    let fixture = common::read_fixture("prng-vectors.json");
    let per_seed = fixture
        .get("valuesPerSeed")
        .and_then(|v| v.as_i64())
        .expect("valuesPerSeed") as usize;
    let vectors = fixture
        .get("vectors")
        .and_then(|v| v.as_array())
        .expect("vectors");
    assert!(!vectors.is_empty(), "an empty fixture would pass anything");

    for vector in vectors {
        let seed = vector.get("seed").and_then(|v| v.as_str()).expect("seed");
        let expected: Vec<f64> = vector
            .get("values")
            .and_then(|v| v.as_array())
            .expect("values")
            .iter()
            .map(|v| v.as_f64().expect("a number"))
            .collect();
        assert_eq!(expected.len(), per_seed);

        let mut gen = prng::create(seed);
        for (i, want) in expected.iter().enumerate() {
            let got = gen.next();
            assert_eq!(
                got, *want,
                "seed {seed:?}, draw {i}: the sequence diverges from the reference"
            );
        }
    }
}

#[test]
fn matches_the_shared_hamilton_vectors() {
    let fixture = common::read_fixture("hamilton-vectors.json");
    let vectors = fixture
        .get("vectors")
        .and_then(|v| v.as_array())
        .expect("vectors");
    assert!(!vectors.is_empty());

    for vector in vectors {
        let name = vector.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let seed = vector.get("seed").and_then(|v| v.as_str()).expect("seed");
        let count = vector.get("count").and_then(|v| v.as_i64()).expect("count") as i32;
        let values: Vec<String> = vector
            .get("values")
            .and_then(|v| v.as_array())
            .expect("values")
            .iter()
            .map(|v| v.as_str().expect("a string").to_string())
            .collect();
        let percents: Vec<f64> = vector
            .get("percents")
            .and_then(|v| v.as_array())
            .expect("percents")
            .iter()
            .map(|v| v.as_f64().expect("a number"))
            .collect();

        let mut gen = prng::create(seed);
        let produced = hamilton::distribute(count, &values, &percents, &mut gen);
        assert_eq!(produced.len(), count as usize, "{name}: wrong length");

        // A vector pins the whole sequence, or its first rows, or only the
        // counts — whichever the reference recorded. Each is checked when
        // present rather than one being assumed.
        if let Some(expected) = vector.get("expected").and_then(|v| v.as_array()) {
            let want: Vec<&str> = expected
                .iter()
                .map(|v| v.as_str().expect("a string"))
                .collect();
            assert_eq!(produced, want, "{name}: the sequence differs");
        }
        if let Some(prefix) = vector.get("expectedPrefix").and_then(|v| v.as_array()) {
            let want: Vec<&str> = prefix
                .iter()
                .map(|v| v.as_str().expect("a string"))
                .collect();
            assert_eq!(
                &produced[..want.len()],
                &want[..],
                "{name}: the prefix differs"
            );
        }
        if let Some(counts) = vector.get("expectedCounts") {
            let entries = counts.as_object().expect("expectedCounts is an object");
            assert!(!entries.is_empty(), "{name}: an empty tally checks nothing");
            for (value, want) in entries {
                let want = want.as_i64().expect("a count") as usize;
                let got = produced.iter().filter(|v| *v == value).count();
                assert_eq!(got, want, "{name}: wrong count for {value:?}");
            }
        }
    }
}

#[test]
fn the_permutation_is_a_bijection_and_its_inverse_undoes_it() {
    // No shared vector pins this one — what it has to be is a property, and a
    // property is what is checked. If `apply` ever collided, an exact percent
    // quota would put two rows in one slot and leave another empty.
    let key = permute::key("hello", "Gender");
    for n in [1, 2, 3, 7, 16, 17, 100, 1000] {
        let mut seen = vec![false; n as usize];
        for i in 0..n {
            let slot = permute::apply(i, n, key);
            assert!(slot >= 0 && slot < n, "n={n}, row {i} landed outside");
            assert!(!seen[slot as usize], "n={n}, slot {slot} claimed twice");
            seen[slot as usize] = true;
            assert_eq!(
                permute::unapply(slot, n, key),
                i,
                "n={n}: the inverse missed"
            );
        }
    }
}

#[test]
fn a_seekable_draw_does_not_depend_on_the_draws_around_it() {
    // The whole reason the streaming engines exist: row 900_000's value has to
    // be reachable without producing the 899_999 before it.
    let direct = seekable::next("hello", "Age", 900_000);
    let again = seekable::next("hello", "Age", 900_000);
    assert_eq!(direct, again);
    assert_ne!(direct, seekable::next("hello", "Age", 900_001));
    assert_ne!(direct, seekable::next("hello", "Name", 900_000));
    assert_ne!(direct, seekable::next("other", "Age", 900_000));
}

#[test]
fn a_seed_outside_the_basic_plane_hashes_by_utf16_code_unit() {
    // Rust's `chars()` would walk code POINTS here and the other four walk UTF-16
    // code UNITS. For a seed holding an emoji that is a different hash, a
    // different stream, and a different dataset — with nothing to say so.
    let emoji = "seed-\u{1F600}";
    assert_eq!(emoji.chars().count(), 6);
    assert_eq!(
        emoji.encode_utf16().count(),
        7,
        "the surrogate pair is the point"
    );

    // What the reference produces for this seed, recorded from it directly.
    let mut gen = prng::create(emoji);
    let first = gen.next();
    assert_eq!(first, 0.06242345576174557);
}
