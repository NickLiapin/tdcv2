//! Sorting more records than fit in memory.
//!
//! The exact engine asks one question of this — are any two records identical — and answers it by
//! putting equal records next to each other. Get the merge wrong and the answer is wrong:
//! duplicates that never meet are duplicates that ship.
//!
//! The disk half had never run here. An input that fits in one chunk is sorted in memory and never
//! touches a file, and everything this suite sorted was that size, so the run files, the k-way
//! merge and the cleanup were dead to the tests while being exactly what a large run uses.
//! TypeScript and Java each had a test for it; this crate, Python and C# had none.
//!
//! `chunk_size` is the seam: production leaves it at a million records, and these pass a handful.

mod common;

use std::path::Path;

use tdcv2::engine::external_sort::{sort, Sorted};

fn drain(mut sorted: Sorted) -> Vec<String> {
    let mut out = Vec::new();
    while let Some(record) = sorted.take().expect("the merge should not fail") {
        out.push(record);
    }
    out
}

fn sorted_with(records: &[&str], chunk: usize, dir: &Path) -> Vec<String> {
    drain(sort(records.iter().map(|r| (*r).to_string()), chunk, dir).expect("sort"))
}

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tdc-esort-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

#[test]
fn spans_many_runs_and_loses_nothing() {
    // 500 records, chunk of 7 → about 72 runs merged. Forces the disk path.
    let dir = temp("many");
    let records: Vec<String> = (0..500)
        .map(|i| ((i * 137 + 11) % 500).to_string())
        .collect();
    let got = drain(sort(records.iter().cloned(), 7, &dir).expect("sort"));
    let mut want = records.clone();
    want.sort();
    assert_eq!(got, want);
    assert_eq!(got.len(), records.len());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn keeps_duplicates_so_the_scan_can_find_them() {
    // The whole point: equal records end up adjacent, and none is dropped on the way. Two equal
    // lines coming from DIFFERENT runs is the case a tie-break can silently swallow.
    let dir = temp("dupes");
    assert_eq!(
        sorted_with(&["b", "a", "b", "c", "a", "a"], 2, &dir),
        vec!["a", "a", "a", "b", "b", "c"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_in_memory_path_when_it_all_fits() {
    let dir = temp("memory");
    assert_eq!(
        sorted_with(&["3", "1", "2"], 1000, &dir),
        vec!["1", "2", "3"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn empty_input() {
    let dir = temp("empty");
    assert!(sorted_with(&[], 4, &dir).is_empty());
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn chunk_size_cannot_change_the_answer() {
    let dir = temp("chunks");
    let records: Vec<String> = (0..200).map(|i| ((i * 977) % 251).to_string()).collect();
    let once = drain(sort(records.iter().cloned(), 5, &dir).expect("sort"));
    for chunk in [5usize, 50, 100_000] {
        assert_eq!(
            drain(sort(records.iter().cloned(), chunk, &dir).expect("sort")),
            once,
            "chunk {chunk}"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn byte_order_not_number_order() {
    // The keys are opaque and only equality of neighbours matters, so this sorts as text.
    // "100" before "2" is correct, and a locale-aware comparison would be slower and
    // machine-dependent.
    let dir = temp("bytes");
    assert_eq!(
        sorted_with(&["10", "9", "100", "2", "30"], 2, &dir),
        vec!["10", "100", "2", "30", "9"]
    );
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_temp_files_are_gone_when_the_scan_ends() {
    let dir = temp("cleanup");
    let records: Vec<String> = (0..60).map(|i| i.to_string()).collect();
    let got = drain(sort(records.iter().cloned(), 4, &dir).expect("sort"));
    let mut want = records.clone();
    want.sort();
    assert_eq!(got, want);
    // A long run sorts many times; a leaked run directory each time fills the disk.
    let left: Vec<_> = std::fs::read_dir(&dir)
        .expect("read temp dir")
        .filter_map(Result::ok)
        .map(|e| e.file_name())
        .collect();
    assert!(left.is_empty(), "left behind: {left:?}");
    let _ = std::fs::remove_dir_all(&dir);
}
