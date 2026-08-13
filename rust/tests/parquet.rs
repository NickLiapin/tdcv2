//! The Parquet writer, held to six files pinned by SHA256.
//!
//! Byte-for-byte or nothing. The format leaves a great deal to the writer — which
//! encoding, whether to build a dictionary, whether to compress, how the matcher
//! finds its matches — and a file that differs is not "a different but equally
//! valid Parquet": it is this project's central promise broken, because two
//! implementations of one config would hand a reader different bytes.

mod common;

use tdcv2::archive::sha256;
use tdcv2::engine;
use tdcv2::json::Value;
use tdcv2::output::parquet_output;
use tdcv2::parser::{self, config_builder};

/// The clock the fixture pins, so a `value="today"` column is the same today and
/// tomorrow.
const NOW_MILLIS: i64 = 1_776_945_600_000; // 2026-04-23T12:00:00Z

#[test]
fn every_pinned_file_is_written_byte_for_byte() {
    let fixture = common::read_fixture("parquet.json");
    let cases = fixture
        .get("cases")
        .and_then(Value::as_array)
        .expect("the cases");
    let total = cases.len();
    assert!(total >= 6, "the fixture moved");

    let mut matched = 0usize;
    let mut wrong: Vec<String> = Vec::new();

    for case in cases {
        let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
        // A case with `dataPath` reads sample files from a folder under `cases/`,
        // the same field and the same place the shared cases already use.
        let base_dir = case
            .get("dataPath")
            .and_then(Value::as_str)
            .map(|rel| {
                common::fixtures_dir()
                    .join("cases")
                    .join(rel)
                    .display()
                    .to_string()
            });
        let source = case
            .get("config")
            .and_then(Value::as_str)
            .expect("a config");
        let want_sha = case
            .get("sha256")
            .and_then(Value::as_str)
            .expect("a digest");
        let want_size = case.get("size").and_then(Value::as_i64).unwrap_or(-1);

        let parsed = parser::parse(source);
        assert!(parsed.ok(), "{name}: the config should parse");
        let config = config_builder::build(&parsed.tree, None)
            .unwrap_or_else(|e| panic!("{name}: {}", e.message));

        let packs = tdcv2::packs::DataPacks::discover().expect("the repository's packs");
        let rows = match engine::run_in(&config, &packs, NOW_MILLIS, base_dir.as_deref()) {
            Ok(rows) => rows,
            Err(e) => {
                wrong.push(format!("{name}: the run failed: {e}"));
                continue;
            }
        };

        let bytes = match parquet_output::to_bytes(&config, rows.as_ref()) {
            Ok(bytes) => bytes,
            Err(e) => {
                wrong.push(format!("{name}: {e}"));
                continue;
            }
        };

        let sha = sha256::hex(&bytes);
        if sha == want_sha {
            matched += 1;
            continue;
        }
        wrong.push(format!(
            "{name}: {} bytes (want {want_size}), sha {} (want {want_sha})",
            bytes.len(),
            &sha[..16]
        ));
    }

    println!("parquet: {matched} of {total} match the reference byte for byte");
    for w in &wrong {
        println!("  {w}");
    }
    assert!(wrong.is_empty(), "{} file(s) differ", wrong.len());
}
