//! The fingerprint layer against the shared cross-language vectors.
//!
//! Every number in that fixture decides WHICH tuples a large uniq run avoids,
//! so an implementation that differs in any of them produces a different file
//! from the same seed. Hash, pile, record bytes and pile count are each pinned
//! here rather than trusted.

mod common;

use std::collections::HashSet;
use std::path::PathBuf;

use tdcv2::json::Value;
use tdcv2::engine::fingerprint as fp;

fn vectors() -> Value {
    common::read_fixture("fingerprint-vectors.json")
}

fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("tdc-fp-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn record_width_and_index_limit_match_the_contract() {
    let v = vectors();
    assert_eq!(
        v.get("recordBytes").expect("recordBytes").as_f64().expect("recordBytes") as u64,
        fp::RECORD_BYTES as u64
    );
    assert_eq!(v.get("maxIndex").expect("maxIndex").as_f64().expect("maxIndex") as u64, fp::MAX_INDEX);
}

#[test]
fn hash_and_pile_match_the_reference() {
    for vector in vectors().get("hashes").expect("hashes").as_array().expect("hashes") {
        let key = vector.get("key").expect("key").as_str().expect("key");
        let (hi, lo) = fp::hash64(key);
        assert_eq!(vector.get("hi").expect("hi").as_f64().expect("hi") as u64, u64::from(hi), "hi of {key:?}");
        assert_eq!(vector.get("lo").expect("lo").as_f64().expect("lo") as u64, u64::from(lo), "lo of {key:?}");

        for (buckets, expected) in vector.get("buckets").expect("buckets").as_object().expect("buckets") {
            let n: usize = buckets.parse().expect("pile count");
            assert_eq!(
                expected.as_f64().expect("pile") as usize,
                fp::bucket_of(hi, n),
                "pile of {key:?} over {n}"
            );
        }
    }
}

#[test]
fn record_bytes_match_the_reference_and_read_back_as_written() {
    for vector in vectors().get("records").expect("records").as_array().expect("records") {
        let hi = vector.get("hi").expect("hi").as_f64().expect("hi") as u32;
        let lo = vector.get("lo").expect("lo").as_f64().expect("lo") as u32;
        let index = vector.get("index").expect("index").as_f64().expect("index") as u64;

        let encoded = fp::encode(hi, lo, index).expect("encodes");
        let hex: String = encoded.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(vector.get("bytes").expect("bytes").as_str().expect("bytes"), hex, "index {index}");
        // A reader that disagrees with its own writer is worse than one that
        // disagrees with the reference, because nothing would catch it.
        assert_eq!(index, fp::index_of(&encoded));
    }
}

#[test]
fn an_index_past_the_limit_is_refused_not_wrapped() {
    let err = fp::encode(1, 1, fp::MAX_INDEX).expect_err("must refuse");
    assert!(err.contains("5-byte"), "{err}");
}

#[test]
fn pile_count_matches_the_reference() {
    for vector in vectors().get("pileCounts").expect("pileCounts").as_array().expect("pileCounts") {
        let count = vector.get("count").expect("count").as_f64().expect("count") as u64;
        let cores = vector.get("cores").expect("cores").as_f64().expect("cores") as usize;
        assert_eq!(
            vector.get("buckets").expect("buckets").as_f64().expect("buckets") as usize,
            fp::bucket_count_for(count, cores),
            "{count} rows / {cores} cores"
        );
    }
}

#[test]
fn sorting_is_byte_order_and_finds_every_repeated_fingerprint() {
    let dir = temp_dir("sort");
    let inputs: Vec<PathBuf> = (0..3).map(|k| dir.join(format!("in-{k}"))).collect();
    let mut writers: Vec<fp::Writer> = inputs
        .iter()
        .map(|path| fp::Writer::create(path).expect("writer"))
        .collect();

    for i in 0..300u64 {
        let (hi, lo) = fp::hash64(&format!("unique-{i}"));
        writers[(i % 3) as usize].write(hi, lo, i).expect("write");
    }
    let (a_hi, a_lo) = fp::hash64("dupA");
    for row in [7u64, 105, 203] {
        writers[0].write(a_hi, a_lo, row).expect("write");
    }
    let (b_hi, b_lo) = fp::hash64("dupB");
    for row in [50u64, 151] {
        writers[1].write(b_hi, b_lo, row).expect("write");
    }
    // Same high word, differing low words, written descending: an order that
    // only comes out right if the low word decides. 305 random hashes never
    // collide in 32 bits, so without these the sort could ignore the low word
    // and still pass.
    for lo in (0..10u32).rev() {
        writers[0].write(777, lo, 400 + u64::from(lo)).expect("write");
    }
    for writer in writers {
        writer.finish().expect("finish");
    }

    let sorted = dir.join("sorted");
    assert_eq!(fp::sort_files(&inputs, &sorted, &dir).expect("sort"), 315);

    let records = fp::read_records(&sorted).expect("read");
    assert_eq!(records.len(), 315);
    for pair in records.windows(2) {
        assert!(pair[0] <= pair[1], "not in byte order");
    }

    let mut groups = fp::candidate_groups(&sorted).expect("groups");
    for group in &mut groups {
        group.sort_unstable();
    }
    assert_eq!(groups.len(), 2);
    assert!(groups.contains(&vec![7usize, 105, 203]), "{groups:?}");
    assert!(groups.contains(&vec![50usize, 151]), "{groups:?}");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_ledger_never_calls_a_taken_tuple_free() {
    let dir = temp_dir("ledger");
    let buckets = 4usize;
    let keys: Vec<String> = (0..500).map(|i| format!("taken-{i}")).collect();

    let mut raw: Vec<fp::Writer> = (0..buckets)
        .map(|b| fp::Writer::create(&dir.join(format!("raw-{b}"))).expect("writer"))
        .collect();
    for (row, key) in keys.iter().enumerate() {
        let (hi, lo) = fp::hash64(key);
        raw[fp::bucket_of(hi, buckets)]
            .write(hi, lo, row as u64)
            .expect("write");
    }
    for writer in raw {
        writer.finish().expect("finish");
    }

    let mut sorted_paths = Vec::new();
    for b in 0..buckets {
        let out = dir.join(format!("sorted-{b}"));
        fp::sort_files(&[dir.join(format!("raw-{b}"))], &out, &dir).expect("sort");
        sorted_paths.push(out);
    }

    let moving: HashSet<usize> = [3usize, 4].into_iter().collect();
    let mut ledger = fp::Ledger::open(&sorted_paths, moving.clone()).expect("ledger");

    // The property uniqueness rests on: every taken tuple answers taken.
    for (row, key) in keys.iter().enumerate() {
        if !moving.contains(&row) {
            assert!(ledger.has(key), "{key}");
        }
    }
    // A tuple held ONLY by rows being moved is free — those values are being given away.
    assert!(!ledger.has("taken-3"));
    assert!(!ledger.has("taken-4"));
    // And tuples nobody holds are free.
    for i in 0..200 {
        assert!(!ledger.has(&format!("nobody-{i}")));
    }

    let _ = std::fs::remove_dir_all(&dir);
}
