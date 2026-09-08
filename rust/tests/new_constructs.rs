//! The three constructs this engine learned last: a per-row assertion, a walked
//! list with a repeat, and a `<data>` inside a `<case>` that reads its row.
//!
//! The shared fixtures pin what each of them PRODUCES, because that is
//! expressible as output. What only lives here is the half a rendering fixture
//! cannot hold: which row a refusal names, and the equality between two configs
//! — a claim that is only checked when both are run and compared.

use tdcv2::engine::{self, EngineError};
use tdcv2::model::Config;
use tdcv2::parser::{self, config_builder};

/// Render one config, or hand back the refusal it earned.
fn render(env: &str, count: i32, line: &str, mode: &str) -> Result<String, EngineError> {
    let source = format!(
        "<tdc><env count=\"{count}\" seed=\"s\" local=\"en\" mode=\"{mode}\">{env}</env>\
         <block><line><data>{line}</data></line></block></tdc>"
    );
    let parsed = parser::parse(&source);
    assert!(parsed.ok(), "the config should parse");
    let config: Config =
        config_builder::build(&parsed.tree, None).map_err(|e| EngineError::Invalid(e.message))?;
    engine::render(&config, 0)
}

fn rows(env: &str, count: i32, line: &str, mode: &str) -> Vec<String> {
    render(env, count, line, mode)
        .unwrap_or_else(|e| panic!("{}", e.message()))
        .trim_end_matches('\n')
        .split('\n')
        .map(str::to_string)
        .collect()
}

fn refusal(env: &str, count: i32, line: &str, mode: &str) -> String {
    render(env, count, line, mode)
        .err()
        .expect("this config should be refused")
        .message()
        .to_string()
}

// ── <assert each> ────────────────────────────────────────────────────────────

const AMOUNT: &str = "<sequence name=\"Amount\"><gen type=\"number\" value=\"1..100\"/></sequence>";
const FEE: &str = "<sequence name=\"Fee\"><gen type=\"number\" value=\"-3..20\"/></sequence>";

#[test]
fn a_per_row_assertion_that_holds_says_nothing() {
    let env = format!("{AMOUNT}<assert each=\"Amount > 0\" says=\"every amount is positive\"/>");
    rows(&env, 200, "${{Amount}}", "memory");
}

#[test]
fn the_config_the_whole_run_form_refuses_is_the_one_each_accepts() {
    // The `that=` refusal names `each=` as the answer, so the two must not both
    // reject it: the signpost would point nowhere.
    let whole = format!("{AMOUNT}<assert that=\"Amount > 0\" says=\"positive\"/>");
    assert!(refusal(&whole, 20, "${{Amount}}", "memory").contains("is not the same on every row"));
    let per_row = format!("{AMOUNT}<assert each=\"Amount > 0\" says=\"positive\"/>");
    rows(&per_row, 20, "${{Amount}}", "memory");
}

#[test]
fn a_failure_names_the_first_failing_row_and_the_value() {
    let env = format!("{FEE}<assert each=\"Fee >= 0\" says=\"a fee is never negative\"/>");
    let message = refusal(&env, 20, "${{Fee}}", "memory");
    assert!(
        message.contains("assert failed on row 3: a fee is never negative"),
        "{message}"
    );
    assert!(message.contains("Fee >= 0   with Fee = -1"), "{message}");
}

#[test]
fn the_streaming_engine_stops_on_the_same_row() {
    // The row loop is shared, and this is the proof. An engine that checked
    // after writing would name a different row.
    let env = format!("{FEE}<assert each=\"Fee >= 0\" says=\"a fee is never negative\"/>");
    assert!(refusal(&env, 20, "${{Fee}}", "disk").contains("assert failed on row 3"));
}

#[test]
fn every_per_row_assertion_is_checked_not_only_the_first() {
    let env = format!(
        "{AMOUNT}<assert each=\"Amount > 0\" says=\"positive\"/>\
         <assert each=\"Amount > 1000\" says=\"over a thousand\"/>"
    );
    assert!(refusal(&env, 5, "${{Amount}}", "memory").contains("over a thousand"));
}

// ── a walked list with a fixed repeat ────────────────────────────────────────

fn walked(value: &str, extra: &str) -> String {
    format!(
        "<sequence name=\"V\"><gen type=\"text\" value=\"{value}\" order=\"sequential\"{extra}/>\
         </sequence>"
    )
}

#[test]
fn a_repeat_matching_the_list_gives_every_row_the_whole_list() {
    let env = walked("created,paid,shipped,delivered", " repeat=\"4\"");
    assert_eq!(
        rows(&env, 3, "${{V}}", "memory"),
        vec!["created,paid,shipped,delivered"; 3]
    );
}

#[test]
fn the_walk_carries_on_across_rows_rather_than_restarting() {
    // The part a single row cannot show: restarting would print `a,b` three
    // times and pass any test that only looked at row 0.
    let env = walked("a,b,c", " repeat=\"2\"");
    assert_eq!(rows(&env, 3, "${{V}}", "memory"), vec!["a,b", "c,a", "b,c"]);
}

#[test]
fn repeat_one_is_exactly_the_plain_walk() {
    // The property that makes carrying on a generalisation rather than a second
    // meaning — checked by running both, not by stating it.
    let one = rows(&walked("a,b,c", " repeat=\"1\""), 6, "${{V}}", "memory");
    let plain = rows(&walked("a,b,c", ""), 6, "${{V}}", "memory");
    assert_eq!(one, plain);
    assert_eq!(one, vec!["a", "b", "c", "a", "b", "c"]);
}

#[test]
fn both_engines_walk_the_same_way() {
    let env = walked("a,b,c", " repeat=\"2\"");
    assert_eq!(
        rows(&env, 8, "${{V}}", "disk"),
        rows(&env, 8, "${{V}}", "memory")
    );
}

#[test]
fn running_out_under_cycle_false_names_the_element_as_well_as_the_row() {
    // The message has to name a position in the WALK, not a row number that is
    // really an element index — that sends a reader to the wrong attribute.
    let env = walked("a,b,c,d,e", " repeat=\"2\" cycle=\"false\"");
    let message = refusal(&env, 5, "${{V}}", "memory");
    assert!(message.contains("row 3 runs out at element 2"), "{message}");
}

// ── ${{Name}} inside a <case> ────────────────────────────────────────────────

const CITY: &str =
    "<sequence name=\"City\"><gen type=\"text\" value=\"Alpha,Beta,Gamma\"/></sequence>";

#[test]
fn a_case_body_pairs_each_row_with_its_own_value() {
    // A case is built for the SUBSET of rows that chose it, so an implementation
    // reading a position rather than an absolute row pairs the wrong values and
    // still produces a plausible-looking file.
    let env = format!(
        "{CITY}<mix name=\"S\" percent=\"50\">\
         <case><data>${{{{City}}}}/north</data></case>\
         <case><data>${{{{City}}}}/south</data></case></mix>"
    );
    for row in rows(&env, 12, "${{City}}|${{S}}", "memory") {
        let (city, composed) = row.split_once('|').expect("a bar");
        assert!(composed.starts_with(&format!("{city}/")), "{row}");
    }
}

#[test]
fn the_filters_a_line_may_use_work_here_too() {
    let env = format!(
        "{CITY}<mix name=\"S\" percent=\"0\">\
         <case><data>${{{{City}}}} plain</data></case>\
         <case><data>${{{{City|upper}}}} loud</data></case></mix>"
    );
    for row in rows(&env, 4, "${{S}}", "memory") {
        assert!(row.ends_with(" loud"), "{row}");
        let head = row.split(' ').next().unwrap_or("");
        assert_eq!(head, head.to_uppercase(), "{row}");
    }
}

#[test]
fn a_column_empty_on_this_row_renders_empty_not_marked() {
    // A declared column with no value here is not the same thing as a name
    // nobody declared: printing the marker would read as a broken config.
    let env =
        "<sequence name=\"K\"><gen type=\"text\" value=\"a,b\" percent=\"50,50\"/></sequence>\
               <sequence name=\"Only\" parent=\"K.a\"><gen type=\"text\" value=\"X\"/></sequence>\
               <mix name=\"S\" percent=\"100\"><case><data>[${{Only}}]</data></case>\
               <case><data>never</data></case></mix>";
    let out = rows(env, 6, "${{S}}", "memory");
    assert!(out.iter().all(|r| r == "[X]" || r == "[]"), "{out:?}");
    assert!(out.iter().any(|r| r == "[]"), "{out:?}");
}

#[test]
fn both_engines_read_a_case_body_the_same_way() {
    let env = format!(
        "{CITY}<mix name=\"S\" percent=\"60\">\
         <case><data>${{{{City}}}} North</data></case>\
         <case><data>${{{{City|upper}}}} South</data></case></mix>"
    );
    assert_eq!(
        rows(&env, 12, "${{S}}", "disk"),
        rows(&env, 12, "${{S}}", "memory")
    );
}

#[test]
fn plain_text_in_a_case_is_left_alone() {
    let env = "<mix name=\"S\" percent=\"100\"><case><data>just text</data></case>\
               <case><data>never</data></case></mix>";
    assert_eq!(
        rows(env, 2, "${{S}}", "memory"),
        vec!["just text", "just text"]
    );
}
