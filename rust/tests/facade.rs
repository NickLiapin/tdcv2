//! The public surface: what a caller actually touches.
//!
//! The contract worth testing here is not that the values are right — the shared
//! cases prove that. It is that the two views agree, that asking twice gives the
//! same answer, and that a sequence with no value on a row says so instead of
//! returning a blank that reads as a real one.

use std::collections::BTreeMap;

use tdcv2::{Nested, Options, Tdc, TdcError};

const PEOPLE: &str = concat!(
    r#"<tdc><env count="6" seed="facade" local="en" mode="memory">"#,
    r#"<sequence name="Gender"><gen type="text" value="Male, Female" percent="50,50"/></sequence>"#,
    r#"<sequence name="Beard" parent="Gender.Male">"#,
    r#"<gen type="text" value="yes, no"/></sequence>"#,
    r#"<sequence name="Address"><gen name="city" type="text" value="Berlin, Munich"/>"#,
    r#"<gen name="zip" type="number" value="10000..99999"/></sequence>"#,
    r#"</env><block><line><data>${{Gender}}</data></line></block></tdc>"#,
);

fn build(config: &str) -> Tdc {
    Tdc::from_string(config).expect("the config is valid")
}

#[test]
fn text_and_rows_read_the_same_generated_values() {
    let data = build(PEOPLE);

    let text = data.text();
    let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
    assert_eq!(lines.len(), 6);

    let from_rows: Vec<&str> = data.rows().map(|r| r.get("Gender").unwrap()).collect();
    assert_eq!(lines, from_rows);
}

#[test]
fn asking_twice_gives_the_same_run() {
    let data = build(PEOPLE);
    assert_eq!(data.text(), data.text());
    // And rows do not re-run the generator either — that would be both slow and,
    // with a generated seed, a different answer.
    assert_eq!(
        data.rows().next().unwrap().get("Gender"),
        data.row(0).unwrap().get("Gender")
    );
}

#[test]
fn a_sequence_that_does_not_apply_to_a_row_says_so_rather_than_returning_a_blank() {
    let data = build(PEOPLE);

    // parent="Gender.Male" has no value on a female row. An empty string would
    // claim it had one that happened to be blank, which a caller cannot tell
    // from a real empty value.
    let mut seen_female = false;
    let mut seen_male = false;
    for row in data.rows() {
        if row.get("Gender") == Some("Female") {
            seen_female = true;
            assert_eq!(row.get("Beard"), None);
            assert!(!row.to_map().contains_key("Beard"));
        } else {
            seen_male = true;
            assert!(row.get("Beard").is_some());
        }
    }
    // Otherwise the loop above could pass by never running.
    assert!(seen_female && seen_male);
}

#[test]
fn a_compound_reads_as_one_thing_with_parts() {
    let data = build(PEOPLE);
    let row = data.row(0).unwrap();

    let flat = row.to_map();
    // Flat, the caller has to notice the shared prefix.
    assert!(flat.contains_key("Address.zip"));
    assert!(!flat.contains_key("Address"));

    let Some(Nested::Group(address)) = row.nested().get("Address").cloned() else {
        panic!("Address should nest into a group");
    };
    assert_eq!(
        address.get("city").map(String::as_str),
        row.get("Address.city")
    );

    // A plain sequence stays a plain value.
    assert_eq!(
        row.nested().get("Gender"),
        Some(&Nested::Value(row.get("Gender").unwrap().to_string()))
    );
}

#[test]
fn the_seed_says_whether_the_run_is_reproducible() {
    let seeded = build(PEOPLE).seed();
    assert_eq!(seeded.value, "facade");
    assert!(!seeded.generated);

    const UNSEEDED: &str = concat!(
        r#"<tdc><env count="8" mode="memory"><sequence name="N">"#,
        r#"<gen type="number" value="1..999999"/></sequence></env>"#,
        r#"<block><line><data>${{N}}</data></line></block></tdc>"#,
    );
    let first = build(UNSEEDED);
    assert!(first.seed().generated);
    assert!(
        !first.seed().value.is_empty(),
        "a generated seed has to BE a seed: an empty one makes the advice to re-run with it \
         reproduce nothing"
    );

    // A seedless run is a fresh sample every time, as it is in the reference.
    let second = build(UNSEEDED);
    assert_ne!(first.seed().value, second.seed().value);
    assert_ne!(first.text(), second.text());

    // And the reported seed is the way back to it — the only reason to report it.
    let replayed = Tdc::new(Options {
        config_string: Some(UNSEEDED.to_string()),
        seed: Some(first.seed().value.clone()),
        ..Options::default()
    })
    .expect("the config is valid");
    assert_eq!(replayed.text(), first.text());
    assert!(!replayed.seed().generated);
}

#[test]
fn code_overrides_what_the_config_declared() {
    // A test that pins the count needs that value to hold even when the config
    // it borrowed carries one of its own — otherwise the override would be
    // advice rather than a setting.
    let data = Tdc::new(Options {
        config_string: Some(PEOPLE.to_string()),
        count: Some(2),
        seed: Some("other".to_string()),
        ..Options::default()
    })
    .expect("the config is valid");

    assert_eq!(data.count(), 2);
    assert_eq!(data.rows().count(), 2);
    assert_eq!(data.seed().value, "other");
}

#[test]
fn a_row_outside_the_run_is_refused_rather_than_wrapped_or_empty() {
    let data = build(PEOPLE);
    assert!(data.row(6).is_none());
    assert!(data.row(usize::MAX).is_none());
}

#[test]
fn neither_both_nor_neither_source_is_accepted() {
    assert!(matches!(Tdc::new(Options::default()), Err(TdcError::Io(_))));
    assert!(matches!(
        Tdc::new(Options {
            config_string: Some(PEOPLE.to_string()),
            config_file: Some("x.tdc".to_string()),
            ..Options::default()
        }),
        Err(TdcError::Io(_))
    ));
}

#[test]
fn a_refused_config_carries_the_diagnostics_and_the_source_they_point_into() {
    // TDC004: a sequence with no generator. Refused rather than rendered as
    // blanks, and the caller gets the line to show.
    let broken = r#"<tdc><env count="1" seed="s"><sequence name="A"></sequence></env>
<block><line><data>${{A}}</data></line></block></tdc>"#;

    let Err(error) = Tdc::from_string(broken) else {
        panic!("a sequence with no generator should be refused");
    };
    assert!(!error.diagnostics().is_empty());
    assert_eq!(error.source(), Some(broken));
    // The message names the code, so a caller printing it says something useful
    // without reaching for the diagnostics list.
    assert!(error.to_string().contains("TDC"), "{error}");
}

#[test]
fn write_file_produces_exactly_what_text_does() {
    let data = build(PEOPLE);
    let target = std::env::temp_dir().join(format!("tdcv2-facade-{}.txt", std::process::id()));
    data.write_file(&target).expect("the temp dir is writable");
    let written = std::fs::read_to_string(&target).expect("just written");
    let _ = std::fs::remove_file(&target);

    assert_eq!(written, data.text());
}

#[test]
fn the_clock_is_a_parameter_so_a_date_test_does_not_expire_overnight() {
    let data = Tdc::new(Options {
        config_string: Some(
            concat!(
                r#"<tdc><env count="2" seed="s" local="en" mode="memory"><sequence name="D">"#,
                r#"<gen type="date" value="today" format="ISO"/></sequence></env>"#,
                r#"<block><line><data>${{D}}</data></line></block></tdc>"#,
            )
            .to_string(),
        ),
        // 2026-04-23T12:00:00Z
        now_millis: Some(1_776_945_600_000),
        ..Options::default()
    })
    .expect("the config is valid");

    assert_eq!(data.text(), "2026-04-23\n2026-04-23\n");
}

#[test]
fn a_config_file_resolves_a_relative_src_against_its_own_folder() {
    // The file lives beside the config, and the run is started from somewhere
    // else. Resolving against the working directory would make the same config
    // work from one shell and fail from another.
    let dir = std::env::temp_dir().join(format!("tdcv2-facade-src-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("the temp dir is writable");
    std::fs::write(dir.join("parts.txt"), "alpha\nbeta\n").expect("writable");
    let config = dir.join("run.tdc");
    std::fs::write(
        &config,
        concat!(
            r#"<tdc><env count="2" seed="s" mode="memory"><sequence name="P">"#,
            r#"<gen type="file" src="parts.txt"/></sequence></env>"#,
            r#"<block><line><data>${{P}}</data></line></block></tdc>"#,
        ),
    )
    .expect("writable");

    let data = Tdc::from_file(&config).expect("the config is valid");
    let values: Vec<String> = data
        .rows()
        .map(|r| r.get("P").unwrap_or_default().to_string())
        .collect();
    let _ = std::fs::remove_dir_all(&dir);

    assert_eq!(values.len(), 2);
    for value in values {
        assert!(value == "alpha" || value == "beta", "unexpected {value:?}");
    }
}

#[test]
fn the_two_views_agree_on_the_streaming_engine_too() {
    // Engine 2 computes a value when asked and forgets it again; the facade
    // materialises what it hands out. Text and rows still have to match, or the
    // engine would be a difference in the data rather than in the memory
    // profile.
    let config = concat!(
        r#"<tdc><env count="5" seed="s" local="en" mode="disk"><sequence name="N">"#,
        r#"<gen type="number" value="100..999"/></sequence></env>"#,
        r#"<block><line><data>${{N}}</data></line></block></tdc>"#,
    );
    let data = build(config);
    assert_eq!(data.engine(), 2);

    let text = data.text();
    let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
    let rows: Vec<&str> = data.rows().map(|r| r.get("N").unwrap()).collect();
    assert_eq!(lines, rows);
}

#[test]
fn a_run_of_no_records_is_a_run_not_a_failure() {
    let data = build(concat!(
        r#"<tdc><env count="0" seed="s" mode="memory"><sequence name="N">"#,
        r#"<gen type="number" value="1..9"/></sequence></env>"#,
        r#"<block><line><data>${{N}}</data></line></block></tdc>"#,
    ));

    assert!(data.is_empty());
    assert_eq!(data.rows().count(), 0);
    assert_eq!(data.row(0).map(|r| r.to_map()), None::<BTreeMap<_, _>>);
}
