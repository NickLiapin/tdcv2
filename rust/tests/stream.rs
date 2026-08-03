//! The streaming engine's own properties, beyond matching the reference.
//!
//! `engines.json` already pins every byte against the reference. What is checked
//! here is what the engine is FOR: a row that depends only on its own index, an
//! exact share that survives being answered one row at a time, and a uniqueness
//! that comes from arithmetic rather than from remembering.

mod common;

use tdcv2::engine;
use tdcv2::model::Config;
use tdcv2::parser::{self, config_builder};

fn config(body: &str, count: i32, seed: &str) -> Config {
    let text = format!(
        "<tdc><env count=\"{count}\" seed=\"{seed}\" local=\"en\">{body}</env>\
         <block><line><data>{}</data></line></block></tdc>",
        "${{V}}"
    );
    let parsed = parser::parse(&text);
    assert!(parsed.ok(), "did not parse: {text}");
    config_builder::build(&parsed.tree, None).expect("builds")
}

fn lines(config: &Config) -> Vec<String> {
    engine::render(config, 0)
        .unwrap_or_else(|e| panic!("{e}"))
        .lines()
        .map(str::to_string)
        .collect()
}

#[test]
fn a_config_with_no_mode_streams_rather_than_going_to_memory() {
    // Which engine a config gets is part of the contract. It is no longer visible in the
    // output — every engine derives a cell from (seed, column, row), so all three agree — and
    // that agreement is asserted here alongside the routing, because a router that quietly
    // sent this to memory would scale differently while looking identical.
    let body = r#"<sequence name="V"><gen type="number" value="10..99"/></sequence>"#;
    let streamed = lines(&config(body, 6, "route"));
    let in_memory = lines(&config(body, 6, "route").with_engine("1"));
    assert_eq!(streamed, in_memory, "the engines must agree from one seed");
    assert_eq!(
        engine::router::resolve(&config(body, 6, "route"), None),
        Ok(2)
    );
}

#[test]
fn a_row_is_a_function_of_its_own_index() {
    // The property the whole engine rests on. Rendering ten rows and rendering
    // four must agree on the four they share — with a per-row draw taken in
    // order, they would not.
    let body = r#"<sequence name="V"><gen type="number" value="1000..9999"/></sequence>"#;
    let ten = lines(&config(body, 10, "seek"));
    let four = lines(&config(body, 4, "seek"));
    assert_eq!(
        &ten[..4],
        &four[..],
        "row 3 changed when the run got longer"
    );
}

#[test]
fn an_exact_share_survives_being_answered_one_row_at_a_time() {
    // 1000 rows at 70/20/10, and the counts are exact — not "about". This is the
    // reason percent= goes through a permuted quota rather than a per-row draw,
    // which would give roughly the right proportions and never the right ones.
    let values = lines(&config(
        r#"<sequence name="V"><gen type="text" value="RU,US,DE" percent="70,20,10"/></sequence>"#,
        1000,
        "quota",
    ));
    let count = |wanted: &str| values.iter().filter(|v| *v == wanted).count();
    assert_eq!(count("RU"), 700);
    assert_eq!(count("US"), 200);
    assert_eq!(count("DE"), 100);
}

#[test]
fn a_child_sequence_covers_exactly_the_rows_its_parent_gave_it() {
    // A child's own draws are numbered within the parent's subset, so the values
    // it produces cannot depend on how many rows the parent happened to give it.
    let text = "<tdc><env count=\"200\" seed=\"kids\" local=\"en\">\
        <sequence name=\"G\"><gen type=\"text\" value=\"Male,Female\" percent=\"75,25\"/></sequence>\
        <sequence name=\"T\" parent=\"G.Female\"><gen type=\"text\" value=\"Ms\"/></sequence>\
        </env><block><line><data>${{G}}|${{T}}</data></line></block></tdc>";
    let parsed = parser::parse(text);
    assert!(parsed.ok());
    let config = config_builder::build(&parsed.tree, None).expect("builds");
    let out = engine::render(&config, 0).expect("renders");

    let mut titled = 0;
    for line in out.lines() {
        let (gender, title) = line.split_once('|').expect("both columns");
        if gender == "Female" {
            assert_eq!(title, "Ms", "{line}");
            titled += 1;
        } else {
            assert_eq!(title, "", "{line}");
        }
    }
    assert_eq!(titled, 50, "25% of 200");
}

#[test]
fn uniqueness_comes_from_arithmetic_rather_than_from_remembering() {
    // The fields are the digits of one mixed-radix number and the permutation is
    // a bijection, so two rows would have to share an index to collide. Nothing
    // is remembered, which is what lets the millionth row cost what the first
    // one did.
    let text = "<tdc><env count=\"12\" seed=\"radix\" local=\"en\">\
        <sequence name=\"P\" uniq=\"true\">\
          <gen name=\"a\" type=\"text\" value=\"1,2,3,4\"/>\
          <gen name=\"b\" type=\"text\" value=\"x,y,z\"/>\
        </sequence></env>\
        <block><line><data>${{P.a}}${{P.b}}</data></line></block></tdc>";
    let parsed = parser::parse(text);
    assert!(parsed.ok(), "{:?}", parsed.problems);
    let config = config_builder::build(&parsed.tree, None).expect("builds");
    let out = engine::render(&config, 0).expect("renders");

    let mut seen: Vec<&str> = out.lines().collect();
    assert_eq!(seen.len(), 12);
    seen.sort_unstable();
    seen.dedup();
    assert_eq!(seen.len(), 12, "every one of the 4×3 combinations, once");
}

#[test]
fn a_uniq_asking_for_more_rows_than_combinations_says_so() {
    // Twelve combinations, thirteen rows. Refusing beats emitting a duplicate
    // under a uniq= that promised there would not be one. The router sends every uniq to the
    // exact engine, so this is that engine's refusal.
    let text = "<tdc><env count=\"13\" seed=\"radix\" local=\"en\">\
        <sequence name=\"P\" uniq=\"true\">\
          <gen name=\"a\" type=\"text\" value=\"1,2,3,4\"/>\
          <gen name=\"b\" type=\"text\" value=\"x,y,z\"/>\
        </sequence></env>\
        <block><line><data>${{P.a}}${{P.b}}</data></line></block></tdc>";
    let parsed = parser::parse(text);
    let config = config_builder::build(&parsed.tree, None).expect("builds");
    let message = engine::render(&config, 0)
        .expect_err("13 rows cannot be unique over 12 combinations")
        .message()
        .to_string();
    assert!(message.contains("at most 12 distinct rows"), "{message}");
}
