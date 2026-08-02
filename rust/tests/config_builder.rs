//! The builder against the shared corpus, and against the shapes it decides between.
//!
//! Building cannot prove the *values* are right — that waits for the engines and
//! the 104 expected outputs. What it can prove now is that every config the
//! reference accepts turns into a `Config` here, and that the handful of
//! order-dependent decisions inside go the same way they do in the other four.

mod common;

use tdcv2::json::Value;
use tdcv2::model::Source;
use tdcv2::parser::{self, config_builder};

fn build(config: &str) -> tdcv2::model::Config {
    let parsed = parser::parse(config);
    assert!(parsed.ok(), "the config did not parse: {config}");
    config_builder::build(&parsed.tree, None)
        .unwrap_or_else(|e| panic!("did not build: {e}\n  in: {config}"))
}

fn fixture_files(subdir: &str) -> Vec<String> {
    let dir = common::fixtures_dir().join(subdir);
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()))
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().to_string_lossy().to_string();
            name.ends_with(".json").then(|| format!("{subdir}/{name}"))
        })
        .collect();
    names.sort();
    names
}

#[test]
fn every_shared_case_config_builds() {
    let mut built = 0;
    for file in fixture_files("cases") {
        let fixture = common::read_fixture(&file);
        for case in fixture
            .get("cases")
            .and_then(Value::as_array)
            .unwrap_or_default()
        {
            let name = case.get("name").and_then(Value::as_str).unwrap_or("?");
            let Some(config) = case.get("config").and_then(Value::as_str) else {
                continue;
            };
            let parsed = parser::parse(config);
            let result = config_builder::build(&parsed.tree, None);
            assert!(
                result.is_ok(),
                "{file} / {name}: the reference builds this and we do not: {}",
                result.err().map(|e| e.message).unwrap_or_default()
            );
            built += 1;
        }
    }
    assert!(
        built >= 100,
        "only {built} configs built — the corpus moved"
    );
}

#[test]
fn env_attributes_land_where_the_engines_look_for_them() {
    let config = concat!(
        r#"<tdc regex_max_length="8"><env count="7" seed="s" local="ru" mode="disk" engine="2">"#,
        r#"<sequence name="V"><gen type="text" value="a"/></sequence>"#,
        r#"</env><block><line><data>${{V}}</data></line></block></tdc>"#
    );
    let built = build(config);
    assert_eq!(built.count, 7);
    assert_eq!(built.seed, "s");
    assert_eq!(built.locale.as_deref(), Some("ru"));
    assert_eq!(built.mode.as_deref(), Some("disk"));
    assert_eq!(built.engine.as_deref(), Some("2"));
    assert_eq!(built.regex_max_length, 8);
    assert_eq!(built.block.len(), 1);
    assert_eq!(built.block[0].parts.len(), 1);
    assert_eq!(built.block[0].parts[0].text, "${{V}}");
}

#[test]
fn the_project_locale_fills_in_but_never_overrides() {
    // The same rule the other four follow, and the reason it exists: `init`
    // always writes a locale, so a project default that outranked the config
    // would make `local="ru"` produce English wherever one existed.
    let with_local = concat!(
        r#"<tdc><env count="1" seed="s" local="ru">"#,
        r#"<sequence name="V"><gen type="text" value="a"/></sequence>"#,
        r#"</env><block><line><data>x</data></line></block></tdc>"#
    );
    let without = with_local.replace(r#" local="ru""#, "");

    let parsed = parser::parse(with_local);
    let built = config_builder::build(&parsed.tree, Some("fr")).unwrap();
    assert_eq!(built.locale.as_deref(), Some("ru"), "the config wins");

    let parsed = parser::parse(&without);
    let built = config_builder::build(&parsed.tree, Some("fr")).unwrap();
    assert_eq!(built.locale.as_deref(), Some("fr"), "the project fills in");

    let parsed = parser::parse(&without);
    let built = config_builder::build(&parsed.tree, None).unwrap();
    assert_eq!(built.locale.as_deref(), Some("en"), "and en is the floor");

    // A blank project locale is not a locale. Treating "" as one would give the
    // pack loader an empty prefix to resolve addresses against.
    let parsed = parser::parse(&without);
    let built = config_builder::build(&parsed.tree, Some("   ")).unwrap();
    assert_eq!(built.locale.as_deref(), Some("en"));
}

#[test]
fn a_conditional_beats_a_compound_when_a_branch_is_also_named() {
    // The order these two are tested in is load bearing. A branch written as
    // `<gen if="…" name="…"/>` has both marks; the reference asks about `if`
    // first, so it is a conditional and the name is just an attribute the
    // generator may read. Testing compound first would silently turn every
    // named branch into a field.
    let built = build(concat!(
        r#"<tdc><env count="1" seed="s"><sequence name="V">"#,
        r#"<gen if="A.x" name="one" type="text" value="a"/>"#,
        r#"<gen name="two" type="text" value="b"/>"#,
        r#"</sequence></env><block><line><data>x</data></line></block></tdc>"#
    ));
    let Source::Branches(branches) = &built.sequences[0].source else {
        panic!(
            "expected a conditional, got {:?}",
            built.sequences[0].source
        );
    };
    assert_eq!(branches.len(), 2);
    assert_eq!(branches[0].if_expr.as_deref(), Some("A.x"));
    assert_eq!(branches[1].if_expr, None, "the bare gen is the fallback");
    assert_eq!(
        branches[0].gen.attr("if"),
        None,
        "`if` is the branch's condition, not something the generator reads"
    );
}

#[test]
fn one_named_gen_is_a_compound_and_one_unnamed_gen_is_not() {
    let compound = build(concat!(
        r#"<tdc><env count="1" seed="s"><sequence name="V">"#,
        r#"<gen name="only" type="text" value="a"/>"#,
        r#"</sequence></env><block><line><data>x</data></line></block></tdc>"#
    ));
    let Source::Fields(fields) = &compound.sequences[0].source else {
        panic!("a named lone gen is a deliberate one-field compound");
    };
    assert_eq!(fields.len(), 1);
    assert_eq!(fields[0].name, "only");

    let plain = build(concat!(
        r#"<tdc><env count="1" seed="s"><sequence name="V">"#,
        r#"<gen type="text" value="a"/>"#,
        r#"</sequence></env><block><line><data>x</data></line></block></tdc>"#
    ));
    assert!(matches!(plain.sequences[0].source, Source::Gen(_)));
}

#[test]
fn a_compute_child_wins_over_any_gen_beside_it() {
    // Note the shape of the compute body: every literal is an ATTRIBUTE, never
    // text between tags. The shared grammar gives `content` no text at all, so
    // `<str>x</str>` does not parse anywhere — it is `<str v="x"/>`. Writing a
    // compute tree by hand from memory gets this wrong the first time; the packs
    // in `data/packs/` are the reference for the shape.
    let built = build(concat!(
        r#"<tdc><env count="1" seed="s"><sequence name="V">"#,
        r#"<gen type="text" value="a"/>"#,
        r#"<compute><result><concat><str v="A-"/><field name="base"/></concat></result></compute>"#,
        r#"</sequence></env><block><line><data>x</data></line></block></tdc>"#
    ));
    assert!(
        built.sequences[0].is_computed(),
        "a <compute> child wins over any <gen> beside it"
    );
}

#[test]
fn a_map_splits_on_the_first_colon_only() {
    // So a value may contain colons — a time of day survives on the right.
    let built = build(concat!(
        r#"<tdc><env count="1" seed="s"><sequence name="G"><gen type="text" value="a"/></sequence>"#,
        r#"<switch name="T" on="G"><map>US|CA:09:30, MX:noon</map></switch>"#,
        r#"</env><block><line><data>x</data></line></block></tdc>"#
    ));
    let Source::Switch(sw) = &built.sequences[1].source else {
        panic!("expected a switch");
    };
    assert_eq!(sw.on, "G");
    assert_eq!(sw.entries.len(), 2);
    assert_eq!(sw.entries[0].keys, vec!["US", "CA"], "`|` is any-of");
    let tdcv2::model::CasePart::Text(value) = &sw.entries[0].value.parts[0] else {
        panic!("a map entry's value is literal text");
    };
    assert_eq!(value, "09:30");
}

#[test]
fn an_env_level_uniq_declares_its_sequences_and_keeps_only_their_names() {
    let built = build(concat!(
        r#"<tdc><env count="2" seed="s"><uniq>"#,
        r#"<sequence name="A"><gen type="text" value="a"/></sequence>"#,
        r#"<sequence name="B"><gen type="text" value="b"/></sequence>"#,
        r#"</uniq></env><block><line><data>x</data></line></block></tdc>"#
    ));
    assert_eq!(built.sequences.len(), 2, "the wrapper is not a sequence");
    assert_eq!(
        built.env_uniq_groups,
        vec![vec!["A".to_string(), "B".to_string()]]
    );

    // A group of one carries no constraint — there is nothing to be unique against.
    let lone = build(concat!(
        r#"<tdc><env count="2" seed="s"><uniq>"#,
        r#"<sequence name="A"><gen type="text" value="a"/></sequence>"#,
        r#"</uniq></env><block><line><data>x</data></line></block></tdc>"#
    ));
    assert_eq!(lone.sequences.len(), 1);
    assert!(lone.env_uniq_groups.is_empty());
}

#[test]
fn the_two_structural_faults_are_refused_before_validation() {
    // These are not diagnostics: without a <tdc> or a <block> there is no run to
    // validate. Both messages are the reference's, word for word, because the
    // facade turns them into TDC001 and TDC002.
    let no_tdc = parser::parse("<!-- nothing -->");
    let e = config_builder::build(&no_tdc.tree, None).unwrap_err();
    assert_eq!(e.message, "document has no <tdc> root element");

    let no_block = parser::parse(r#"<tdc><env count="1" seed="s"/></tdc>"#);
    let e = config_builder::build(&no_block.tree, None).unwrap_err();
    assert_eq!(e.message, "<tdc> has no <block> child — nothing to render");
}

#[test]
fn a_self_closed_block_is_not_a_block() {
    // The reference looks only for open/close elements, so `<block/>` does not
    // satisfy `<tdc>`'s requirement. Accepting it would be friendlier and would
    // take a config the other four refuse.
    let parsed = parser::parse(r#"<tdc><env count="1" seed="s"/><block/></tdc>"#);
    assert!(config_builder::build(&parsed.tree, None).is_err());
}

#[test]
fn regex_max_length_must_be_a_positive_integer() {
    for bad in ["0", "-1", "eight", ""] {
        let config = format!(
            r#"<tdc regex_max_length="{bad}"><env count="1" seed="s"/><block><line><data>x</data></line></block></tdc>"#
        );
        let parsed = parser::parse(&config);
        assert!(
            config_builder::build(&parsed.tree, None).is_err(),
            "regex_max_length={bad:?} should be refused"
        );
    }
    assert_eq!(config_builder::parse_max_length(None).unwrap(), 32);
    assert_eq!(config_builder::parse_max_length(Some(" 64 ")).unwrap(), 64);
}

#[test]
fn a_pack_generator_body_parses_as_the_same_language() {
    let gen = config_builder::parse_gen_tag(r#"<gen type="regex" value="[A-Z]{3}"/>"#).unwrap();
    assert_eq!(gen.gen_type, "regex");
    assert_eq!(gen.attr("value"), Some("[A-Z]{3}"));

    let composed = config_builder::parse_pack_body(concat!(
        r#"<sequence name="Body"><gen type="number" value="100..999"/></sequence>"#,
        r#"<data>${{Body}}</data>"#
    ))
    .unwrap();
    assert_eq!(composed.sequences.len(), 1);
    assert_eq!(composed.output, "${{Body}}");
    assert!(composed.validate.is_none());

    // Without an output template there is nothing to emit, and saying so beats
    // producing an empty column.
    assert!(config_builder::parse_pack_body(
        r#"<sequence name="B"><gen type="text" value="a"/></sequence>"#
    )
    .is_err());
}
