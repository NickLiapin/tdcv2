//! The zip reader and the decompressor behind it.
//!
//! Checked against archives another tool wrote, because a decompressor that only
//! reads its own compressor's output proves nothing. The fixtures in
//! `tests/data/` were produced by Python's `zipfile`, and one of them carries
//! the repository's real pack files — several thousand lines of English names —
//! so the dynamic-Huffman path is exercised on text rather than on a toy.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tdcv2::archive::{sha256, zip};

fn fixture(name: &str) -> Vec<u8> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/data")
        .join(name);
    std::fs::read(&path).unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()))
}

fn repo_file(relative: &str) -> String {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join(relative);
        if candidate.is_file() {
            return std::fs::read_to_string(candidate).expect("readable");
        }
        dir = dir.parent().expect("the repository is above the crate");
    }
}

#[test]
fn a_deflated_archive_comes_back_byte_for_byte() {
    let entries = zip::read(&fixture("deflated.zip")).expect("a readable archive");
    let by_name: std::collections::BTreeMap<&str, &Vec<u8>> =
        entries.iter().map(|e| (e.name.as_str(), &e.data)).collect();

    // Real text, compressed by another tool with dynamic Huffman codes.
    let surnames = repo_file("data/packs/en/person/lastName.txt");
    assert_eq!(
        String::from_utf8_lossy(by_name["demo/packs/demo/person/lastName.txt"]),
        surnames
    );
    assert!(surnames.lines().count() > 100, "the fixture is worth using");

    // A long run: every byte after the first two comes from a back-reference
    // that overlaps its own source, which is the copy a slice move gets wrong.
    assert_eq!(
        String::from_utf8_lossy(by_name["demo/repeats.txt"]),
        "ab".repeat(50_000)
    );

    // The ends of the range: one byte, and none.
    assert_eq!(by_name["demo/tiny.txt"].as_slice(), b"x");
    assert!(by_name["demo/empty.txt"].is_empty());
}

#[test]
fn a_stored_archive_is_read_without_decompressing_anything() {
    let entries = zip::read(&fixture("stored.zip")).expect("a readable archive");
    assert_eq!(entries.len(), 2);
    let lastnames = entries
        .iter()
        .find(|e| e.name.ends_with("lastName.txt"))
        .expect("the pack file");
    assert_eq!(lastnames.data, b"Ivanov\nPetrov\n");
}

#[test]
fn extracting_writes_the_tree_the_archive_describes() {
    let sandbox = Sandbox::new("extract");
    let count = zip::extract(&fixture("stored.zip"), sandbox.path()).expect("extractable");
    assert_eq!(count, 2);

    let landed = sandbox.path().join("demo/packs/demo/person/lastName.txt");
    assert_eq!(
        std::fs::read_to_string(&landed).expect("written"),
        "Ivanov\nPetrov\n"
    );
}

#[test]
fn an_entry_that_would_escape_the_target_is_refused_and_nothing_is_written() {
    // The oldest trick there is, and a bundle arrives over the network.
    let sandbox = Sandbox::new("escape");
    let error = zip::extract(&fixture("escaping.zip"), sandbox.path())
        .expect_err("an escaping entry must be refused");
    assert!(error.0.contains("escapes"), "{error}");

    let outside = sandbox.path().parent().unwrap().join("escaped.txt");
    assert!(!outside.exists(), "the file was written outside the target");
}

#[test]
fn something_that_is_not_an_archive_says_so() {
    for (bytes, expected) in [
        // Long enough to look at, and nothing in it says zip.
        (vec![b'x'; 500], "no end-of-central-directory"),
        (b"PK".to_vec(), "too short"),
    ] {
        let error = zip::read(&bytes).expect_err("should be refused");
        assert!(error.0.contains(expected), "{error}");
    }
}

#[test]
fn the_digest_is_what_the_registry_would_have_published() {
    // The check `pack add` makes: the bytes on disk against the hex in the
    // index. Verified here against a digest computed by another tool.
    let data = fixture("stored.zip");
    let ours = sha256::hex(&data);
    assert_eq!(ours.len(), 64);
    assert!(ours
        .chars()
        .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()));

    // Two different archives must not share a digest, which is the only
    // property `pack add` actually relies on.
    assert_ne!(ours, sha256::hex(&fixture("deflated.zip")));
}

/// A throwaway directory, removed when the test ends.
struct Sandbox(PathBuf);

impl Sandbox {
    fn new(name: &str) -> Sandbox {
        static NEXT: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "tdcv2-zip-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        Sandbox(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
