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
        let base_dir = case.get("dataPath").and_then(Value::as_str).map(|rel| {
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

/// The command line's Parquet route agrees with the library's, byte for byte.
///
/// They are two different walks over the same run and they have to end in the
/// same file. `Tdc::to_parquet` re-reads a run that is already in memory;
/// `Plan::write_parquet` encodes straight off the engine without ever building
/// one — which is the whole point of it, and also the whole risk: a lazy source
/// that answered even one cell differently would produce a valid Parquet file
/// full of the wrong data, and nothing else here would notice.
///
/// The pinned fixture above cannot catch that. It goes through the library route
/// only, so the route the command line actually takes was untested until this.
#[test]
fn the_streaming_route_writes_the_same_file_as_the_built_one() {
    // One of each shape that decides which engine runs: plain (engine 2), a uniq
    // group (engine 3), and a running total (refused by both, so the fallback to
    // memory has to produce the file rather than nothing).
    let configs = [
        (
            "plain",
            "<tdc><env count=\"120000\" seed=\"pqs\" local=\"en\">\
             <sequence name=\"A\"><gen type=\"text\" value=\"x,y,z\"/></sequence>\
             <sequence name=\"B\"><gen type=\"number\" value=\"1..900\"/></sequence></env>\
             <block><line><data name=\"a\">${{A}}</data>\
             <data name=\"b\" type=\"int64\">${{B}}</data></line></block></tdc>",
        ),
        (
            "uniq group",
            "<tdc><env count=\"300\" seed=\"pqu\" local=\"en\"><uniq>\
             <sequence name=\"A\"><gen type=\"text\" value=\"a,b,c,d,e,f,g,h,i,j,k,l,m,n,o,p,q,r,s,t\"/></sequence>\
             <sequence name=\"B\"><gen type=\"number\" value=\"1..30\"/></sequence></uniq></env>\
             <block><line><data name=\"a\">${{A}}</data>\
             <data name=\"b\" type=\"int64\">${{B}}</data></line></block></tdc>",
        ),
        (
            "running total",
            "<tdc><env count=\"500\" seed=\"pqr\" local=\"en\">\
             <sequence name=\"N\"><gen type=\"number\" value=\"1..9\"/></sequence>\
             <sequence name=\"T\"><gen type=\"running\" of=\"N\" accumulate=\"sum\"/></sequence></env>\
             <block><line><data name=\"n\" type=\"int64\">${{N}}</data>\
             <data name=\"t\" type=\"int64\">${{T}}</data></line></block></tdc>",
        ),
    ];

    let dir = std::env::temp_dir().join(format!("tdc-parquet-routes-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a temp directory");

    for (name, source) in configs {
        let target = dir.join(format!("{}.parquet", name.replace(' ', "-")));

        let plan = tdcv2::Tdc::plan(tdcv2::Options {
            config_string: Some(source.to_string()),
            now_millis: Some(NOW_MILLIS),
            ..tdcv2::Options::default()
        })
        .unwrap_or_else(|e| panic!("{name}: {e}"));
        let streamed = plan
            .write_parquet(&target)
            .unwrap_or_else(|e| panic!("{name}: {e}"));

        let built = tdcv2::Tdc::plan(tdcv2::Options {
            config_string: Some(source.to_string()),
            now_millis: Some(NOW_MILLIS),
            ..tdcv2::Options::default()
        })
        .and_then(tdcv2::Plan::build)
        .and_then(|tdc| tdc.to_parquet())
        .unwrap_or_else(|e| panic!("{name}: {e}"));

        if streamed {
            let written = std::fs::read(&target).expect("the written file");
            assert_eq!(
                written, built,
                "{name}: the two routes wrote different files"
            );
        } else {
            // Declined, which is an answer and not a failure — but only for the
            // config that BOTH engines refuse. A plain one taking the slow road
            // would mean the fast one had quietly stopped being used.
            assert_eq!(name, "running total", "{name} should have streamed");
        }
        assert!(!built.is_empty(), "{name}: the file is empty");
    }

    let _ = std::fs::remove_dir_all(&dir);
}
