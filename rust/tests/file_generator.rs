//! `<gen type="file">` — the user's own file as a vocabulary.
//!
//! The files in `tests/data/` are deliberately awkward in the ways real exports
//! are: a blank line, leading and trailing spaces, a quoted field holding the
//! delimiter, a tab-separated variant. Each of those has a right answer, and
//! each is somewhere an implementation can quietly differ from the reference —
//! a CSV reader that split on every comma would produce "York" and lose "North"
//! while still looking like a list of cities.

use std::path::PathBuf;

use tdcv2::engine;
use tdcv2::parser::{self, config_builder};

/// Where the awkward files live. Not a relative path: a test binary's working
/// directory is not something to rely on.
fn data_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/data")
}

fn render(body: &str, count: i32, engine: &str) -> Result<Vec<String>, String> {
    let text = format!(
        "<tdc><env count=\"{count}\" seed=\"files\" local=\"en\">{body}</env>\
         <block><line><data>${{{{X}}}}|${{{{Y}}}}</data></line></block></tdc>"
    );
    let parsed = parser::parse(&text);
    assert!(parsed.ok(), "did not parse: {text}");
    let config = config_builder::build(&parsed.tree, None)
        .expect("builds")
        .with_engine(engine);
    engine::render_in(&config, 0, data_dir().to_str())
        .map(|out| out.lines().map(str::to_string).collect())
        .map_err(|e| e.message().to_string())
}

/// `Y` exists so every config has two columns and the line template is one shape.
const FILLER: &str = r#"<sequence name="Y"><gen type="text" value="-"/></sequence>"#;

fn column(rows: &[String], at: usize) -> Vec<String> {
    rows.iter()
        .map(|r| r.split('|').nth(at).unwrap_or("").to_string())
        .collect()
}

#[test]
fn a_plain_list_skips_blanks_and_trims_what_is_left() {
    // A file people maintain by hand has a trailing newline and a stray space.
    // Neither is a value, and a run that produced an empty string for one would
    // be reporting the file's formatting as data.
    for engine in ["1", "2"] {
        let rows = render(
            &format!(r#"<sequence name="X"><gen type="file" src="parts.txt"/></sequence>{FILLER}"#),
            40,
            engine,
        )
        .expect("renders");
        let drawn: Vec<String> = column(&rows, 0);
        for value in &drawn {
            assert!(
                ["Widget", "Sprocket", "Gasket", "Flange"].contains(&value.as_str()),
                "engine {engine}: {value:?} is not one of the four values"
            );
        }
    }
}

#[test]
fn order_sequential_walks_the_file_and_wraps() {
    let rows = render(
        &format!(
            r#"<sequence name="X"><gen type="file" src="parts.txt" order="sequential"/></sequence>{FILLER}"#
        ),
        6,
        "1",
    )
    .expect("renders");
    assert_eq!(
        column(&rows, 0),
        ["Widget", "Sprocket", "Gasket", "Flange", "Widget", "Sprocket"]
    );
}

#[test]
fn running_off_the_end_without_cycling_is_an_error_not_a_blank() {
    // Four values, six rows. Silently emitting empty cells for the tail is the
    // failure this project exists to prevent: the file looks the right length
    // and its last rows say nothing.
    for engine in ["1", "2"] {
        let message = render(
            &format!(
                r#"<sequence name="X"><gen type="file" src="parts.txt" order="sequential" cycle="false"/></sequence>{FILLER}"#
            ),
            6,
            engine,
        )
        .expect_err("six rows cannot come from four values");
        assert!(
            message.contains("only 4 values for 5 rows"),
            "engine {engine}: {message}"
        );
    }
}

#[test]
fn a_quoted_field_keeps_the_delimiter_inside_it() {
    // "York, North" is one city. A reader that split on every comma would give
    // "York" and lose the rest while still producing a plausible list.
    let rows = render(
        &format!(
            r#"<sequence name="X"><gen type="file" src="cities.csv" column="city"/></sequence>{FILLER}"#
        ),
        60,
        "1",
    )
    .expect("renders");
    let drawn = column(&rows, 0);
    assert!(drawn.iter().any(|v| v == "York, North"), "{drawn:?}");
    for value in &drawn {
        assert!(
            ["Bristol", "Leeds", "York, North", "Bath"].contains(&value.as_str()),
            "{value:?}"
        );
    }
}

#[test]
fn a_numbered_column_needs_telling_that_there_is_a_header() {
    // A named column implies a header row; a numbered one does not, because a
    // file of pure data has no header to skip.
    let rows = render(
        &format!(
            r#"<sequence name="X"><gen type="file" src="cities.csv" column="2" header="true"/></sequence>{FILLER}"#
        ),
        30,
        "1",
    )
    .expect("renders");
    for value in column(&rows, 0) {
        assert!(
            ["BS1", "LS1", "YO1", "BA1"].contains(&value.as_str()),
            "{value}"
        );
    }
}

#[test]
fn a_weight_column_is_an_exact_quota_not_a_bias() {
    // 1250 rows over the four populations: the shares are honoured exactly,
    // through the same apportionment percent= uses. A weight is a raw count, not
    // a percentage, because registry files publish counts.
    let rows = render(
        &format!(
            r#"<sequence name="X"><gen type="file" src="cities.csv" column="city" weight="population"/></sequence>{FILLER}"#
        ),
        1250,
        "1",
    )
    .expect("renders");
    let drawn = column(&rows, 0);
    let count = |city: &str| drawn.iter().filter(|v| *v == city).count();
    // 467000 / 1250000 × 1250 = 467, and so on down the file.
    assert_eq!(count("Bristol"), 467);
    assert_eq!(count("Leeds"), 536);
    assert_eq!(count("York, North"), 153);
    assert_eq!(count("Bath"), 94);
}

#[test]
fn two_columns_on_one_row_key_read_the_same_record() {
    // The whole reason row= exists: a city and its postcode drawn independently
    // produce pairs no validator and no human would accept.
    for engine in ["1", "2"] {
        let rows = render(
            concat!(
                r#"<sequence name="X"><gen type="file" src="cities.csv" column="city" row="loc"/></sequence>"#,
                r#"<sequence name="Y"><gen type="file" src="cities.csv" column="postcode" row="loc"/></sequence>"#
            ),
            30,
            engine,
        )
        .expect("renders");
        for row in &rows {
            let (city, postcode) = row.split_once('|').expect("both columns");
            let expected = match city {
                "Bristol" => "BS1",
                "Leeds" => "LS1",
                "York, North" => "YO1",
                "Bath" => "BA1",
                other => panic!("engine {engine}: unexpected city {other:?}"),
            };
            assert_eq!(postcode, expected, "engine {engine}: {row}");
        }
    }
}

#[test]
fn a_delimiter_can_be_named_rather_than_written() {
    let rows = render(
        &format!(
            r#"<sequence name="X"><gen type="file" src="tabbed.tsv" column="name" delimiter="tab"/></sequence>{FILLER}"#
        ),
        20,
        "1",
    )
    .expect("renders");
    for value in column(&rows, 0) {
        assert!(["first", "second"].contains(&value.as_str()), "{value}");
    }
}

#[test]
fn a_source_nobody_can_read_says_so_by_name() {
    let message = render(
        &format!(r#"<sequence name="X"><gen type="file" src="nope.txt"/></sequence>{FILLER}"#),
        3,
        "1",
    )
    .expect_err("there is no such file");
    assert!(message.contains("cannot read"), "{message}");
    assert!(message.contains("nope.txt"), "{message}");
}
