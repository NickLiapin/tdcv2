//! The hand-written parser against every config the shared fixtures contain.
//!
//! The other four implementations generate their parser from `grammar/*.g4`, so
//! their agreement with each other is largely ANTLR's doing. This one is written
//! by hand, which makes "accepts the same dialect" a claim that has to be
//! demonstrated. The demonstration is the corpus: every config in
//! `fixtures/cross-language/`, several hundred of them, parsed here — the
//! valid ones cleanly, and the deliberately-broken diagnostic ones without a
//! crash and without inventing syntax errors the other four do not report.

mod common;

use tdcv2::json::Value;
use tdcv2::parser::{self, ast::Kind};

/// Every `config` string in a fixture file, with the case name for the message
/// and whether the case EXPECTS the parser itself to refuse it (`error PARSE`
/// signatures) — those are exempt from "everything here parses".
fn configs_in(relative: &str) -> Vec<(String, String, bool)> {
    let fixture = common::read_fixture(relative);
    let cases = fixture
        .get("cases")
        .and_then(|v| v.as_array())
        .unwrap_or_else(|| panic!("{relative} has no cases"));
    cases
        .iter()
        .filter_map(|case| {
            let name = case.get("name").and_then(Value::as_str)?.to_string();
            let config = case.get("config").and_then(Value::as_str)?.to_string();
            let expects_parse_refusal =
                case.get("expected")
                    .and_then(Value::as_array)
                    .is_some_and(|expected| {
                        expected
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|signature| signature.starts_with("error PARSE"))
                    });
            Some((name, config, expects_parse_refusal))
        })
        .collect()
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
fn every_shared_case_config_parses_without_a_syntax_error() {
    let mut seen = 0;
    for file in fixture_files("cases") {
        for (name, config, _expects_parse_refusal) in configs_in(&file) {
            let result = parser::parse(&config);
            assert!(
                result.ok(),
                "{file} / {name}: the reference parses this and we do not:\n  {}\n  in: {config}",
                result
                    .problems
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n  ")
            );
            assert!(
                result.tree.child("tdc").is_some(),
                "{file} / {name}: parsed, but no <tdc> came out"
            );
            seen += 1;
        }
    }
    assert!(seen >= 100, "only {seen} configs — the corpus went missing");
}

#[test]
fn the_diagnostic_corpus_parses_too_since_its_faults_are_semantic() {
    // These configs are deliberately wrong, but wrong in ways the VALIDATOR
    // catches. Exactly one of the 108 is a syntax-level complaint, and even that
    // one — a document with no <tdc> at all — parses fine and is refused later.
    // A parser that rejected any of the rest would report the failure in the
    // wrong voice and at the wrong position.
    let mut checked = 0;
    for file in fixture_files("diagnostics") {
        for (name, config, expects_parse_refusal) in configs_in(&file) {
            if expects_parse_refusal {
                // The nesting-ceiling case is refused BY the parser, on
                // purpose — the first case in the corpus where the parser is
                // the right voice.
                continue;
            }
            let result = parser::parse(&config);
            assert!(
                result.ok(),
                "{file} / {name}: this is a semantic fault, not a syntax one:\n  {}\n  in: {config}",
                result
                    .problems
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join("\n  ")
            );
            checked += 1;
        }
    }
    assert!(checked >= 100, "only {checked} diagnostic configs");
}

#[test]
fn an_attribute_points_inside_its_quotes() {
    // The convention every position in the diagnostics fixture follows. Here it
    // is checked against a case from that fixture with its expected column, so
    // the arithmetic is pinned by the shared contract and not by my reading of
    // it.
    let config = concat!(
        r#"<tdc><env count="2" seed="s"><sequence name="G">"#,
        r#"<gen type="text" value="a,b" nosuchattr="1"/>"#,
        r#"</sequence></env><block><line><data>x</data></line></block></tdc>"#
    );
    let tree = parser::parse(config).tree;
    let gen = tree
        .child("tdc")
        .and_then(|t| t.child("env"))
        .and_then(|e| e.child("sequence"))
        .and_then(|s| s.child("gen"))
        .expect("the gen element");

    // `expected: ["error TDC015 1:89"]` in diagnostics/attributes.json.
    let at = gen.at("nosuchattr");
    assert_eq!((at.line, at.column), (1, 89));
    assert_eq!(gen.attr_value("nosuchattr"), Some("1"));
    assert_eq!(gen.attr_value("value"), Some("a,b"));
    assert_eq!(gen.kind, Kind::SelfClosing);
}

#[test]
fn a_data_body_is_raw_text_even_when_it_looks_like_tags() {
    // The whole point of <data>: what is inside is literal, including things
    // that would otherwise lex as markup.
    let tree =
        parser::parse(r#"<tdc><block><line><data>a<b>c ${{X}}</data></line></block></tdc>"#).tree;
    let data = tree
        .child("tdc")
        .and_then(|t| t.child("block"))
        .and_then(|b| b.child("line"))
        .and_then(|l| l.child("data"))
        .expect("the data element");
    assert_eq!(data.kind, Kind::Data);
    assert_eq!(data.text, "a<b>c ${{X}}");
    assert!(
        data.children.is_empty(),
        "a raw body holds text, not elements"
    );
}

#[test]
fn a_map_body_keeps_its_punctuation() {
    let tree = parser::parse(
        r#"<tdc><env count="1" seed="s"><switch name="T" on="G"><map>a:1, b:2</map></switch></env><block><line><data>x</data></line></block></tdc>"#,
    )
    .tree;
    let map = tree
        .child("tdc")
        .and_then(|t| t.child("env"))
        .and_then(|e| e.child("switch"))
        .and_then(|s| s.child("map"))
        .expect("the map element");
    assert_eq!(map.kind, Kind::Map);
    assert_eq!(map.text, "a:1, b:2");
}

#[test]
fn comments_and_the_xml_declaration_are_hidden() {
    let tree =
        parser::parse("<?xml version=\"1.0\"?><!-- a note --><tdc><!-- another --><block/></tdc>")
            .tree;
    assert_eq!(tree.elements.len(), 1);
    let tdc = tree.child("tdc").expect("the tdc element");
    assert_eq!(tdc.children.len(), 1);
    assert_eq!(tdc.children[0].name, "block");
}

#[test]
fn a_document_with_no_tdc_parses_and_leaves_the_complaint_to_the_validator() {
    // diagnostics/structure.json expects `error TDC001 1:0` for exactly this,
    // and TDC001 is raised by the facade, not here. The grammar is permissive at
    // the top level on purpose.
    let result = parser::parse("<!-- nothing here -->");
    assert!(result.ok(), "a comment-only file is not a syntax error");
    assert!(result.tree.elements.is_empty());
}

#[test]
fn a_broken_config_yields_a_located_problem_and_no_panic() {
    // The shared CLI fixture's "broken" config. It asks only for a located
    // diagnostic, not for particular wording — which is what lets this
    // implementation report syntax errors in its own voice.
    let result = parser::parse("<tdc><env>");
    assert!(!result.ok(), "an unclosed document is a syntax error");
    let first = &result.problems[0];
    assert!(first.line >= 1 && first.column >= 0);
    assert!(!first.message.is_empty());
}

#[test]
fn positions_survive_newlines() {
    // The bug this was written to catch: stamping a token's position where the
    // SCAN started rather than where the token did put every indented tag at the
    // end of the line above it. Nothing in the shared corpus notices, because
    // those configs are one long line — but every config a person actually
    // writes is indented, and every diagnostic in one would have pointed at the
    // wrong place.
    //
    //            0000000000111111111122222222
    //            0123456789012345678901234567
    // line 2 is: `  <env count="2" seed="s">`
    let config = "<tdc>\n  <env count=\"2\" seed=\"s\">\n  </env>\n</tdc>";
    let tree = parser::parse(config).tree;
    let env = tree.child("tdc").and_then(|t| t.child("env")).expect("env");
    assert_eq!((env.pos.line, env.pos.column), (2, 2), "the '<' of <env>");
    let at = env.at("seed");
    assert_eq!(
        (at.line, at.column),
        (2, 23),
        "the 's' inside seed's quotes"
    );
    let count = env.at("count");
    assert_eq!(
        (count.line, count.column),
        (2, 14),
        "the '2' inside count's"
    );
}
