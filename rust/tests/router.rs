//! Which engine a config gets — the decision that is part of the contract.
//!
//! Worth its own file because getting it wrong is invisible. The three engines
//! draw in different orders, so a config sent to the wrong one renders every row
//! plausibly and every row differently from the reference. There is no crash to
//! notice and no column that looks odd.

use tdcv2::engine::router;
use tdcv2::parser::{self, config_builder};

fn engine_for(env_attrs: &str, body: &str) -> u8 {
    let config = format!(
        "<tdc><env count=\"3\" seed=\"s\" {env_attrs}>{body}</env>\
         <block><line><data>x</data></line></block></tdc>"
    );
    let parsed = parser::parse(&config);
    assert!(parsed.ok(), "did not parse: {config}");
    let built = config_builder::build(&parsed.tree, None).expect("builds");
    // The repository's own packs, because one of the rules is about what a pack
    // file declares and there is nowhere else to read that from.
    let packs = tdcv2::packs::DataPacks::discover().ok();
    router::resolve(&built, packs.as_ref()).unwrap_or_else(|e| panic!("{e}: {config}"))
}

const PLAIN: &str = r#"<sequence name="V"><gen type="text" value="a,b"/></sequence>"#;

#[test]
fn mode_says_what_may_be_held_and_the_router_picks_from_that() {
    assert_eq!(engine_for(r#"mode="memory""#, PLAIN), 1);
    assert_eq!(engine_for(r#"mode="disk""#, PLAIN), 2);
    // No mode at all is disk: a config says how big its run is, not how to hold
    // it. This is the default that a port forgets, and forgetting it sends every
    // ordinary config to the wrong engine.
    assert_eq!(engine_for("", PLAIN), 2);
}

#[test]
fn an_engine_named_outright_skips_every_other_rule() {
    // Including the rules that would otherwise force memory — which is what
    // makes engine= useful for a benchmark and a poor default for anything else.
    let dynamic = r#"<sequence name="V"><gen type="template" value="a.b.${{X}}"/></sequence>"#;
    assert_eq!(engine_for(r#"engine="2""#, dynamic), 2);
    assert_eq!(engine_for("", dynamic), 1, "without engine=, memory wins");
}

#[test]
fn stream_is_still_accepted_as_the_old_name_for_engine_two() {
    assert_eq!(engine_for(r#"mode="stream""#, PLAIN), 2);
}

#[test]
fn three_things_pull_a_disk_config_back_into_memory() {
    // Each is a question whose answer depends on the whole column. Answered a
    // row at a time they do not fail — they quietly produce data that is wrong
    // in a way nobody notices.
    assert_eq!(
        engine_for(
            "",
            r#"<sequence name="V"><gen type="template" value="vehicle.model.${{Brand}}"/></sequence>"#
        ),
        1,
        "an address not known until the row is"
    );
    assert_eq!(
        engine_for(
            "",
            r#"<sequence name="V"><gen type="file" src="a.csv" weight="w" row="r"/></sequence>"#
        ),
        1,
        "a weighted draw of a linked row needs the global total"
    );
    assert_eq!(
        engine_for(
            "",
            r#"<sequence name="V"><gen type="http" src="http://127.0.0.1:1/"/></sequence>"#
        ),
        1,
        "a network call never runs on the reproducible path"
    );
}

#[test]
fn a_pack_that_declares_its_own_shares_pulls_the_config_into_memory() {
    // The share is written inside the pack file, so nothing in the config says
    // this is a whole-column question — which is exactly why the router has to
    // open the pack. `zh-cn.geo.streetName` splits its street types 60/20/15/5;
    // resolved a row at a time the quota is computed over one row and every row
    // takes the largest share, producing a column of one value that looks like
    // data.
    let percent_pack =
        r#"<sequence name="V"><gen type="template" value="zh-cn.geo.streetName"/></sequence>"#;
    assert_eq!(engine_for(r#"local="zh-cn""#, percent_pack), 1);

    // A pack that declares no share has no such question and streams.
    let plain_pack =
        r#"<sequence name="V"><gen type="template" value="zh-cn.geo.streetNamed"/></sequence>"#;
    assert_eq!(engine_for(r#"local="zh-cn""#, plain_pack), 2);
}

#[test]
fn the_exact_engine_is_for_what_streaming_cannot_answer_per_row() {
    let weighted =
        r#"<sequence name="V"><gen type="advanced_regex" value="(?%{70:RU;30:US})"/></sequence>"#;
    assert_eq!(engine_for("", weighted), 3, "a weighted branch is a quota");

    // An ordinary advanced_regex has no quota in it and streams.
    let plain_pattern =
        r#"<sequence name="V"><gen type="advanced_regex" value="[0-9]{3}"/></sequence>"#;
    assert_eq!(engine_for("", plain_pattern), 2);

    // A child of a text parent streams; a child of anything else cannot, since
    // the set of parent values is not known in advance.
    let text_parent = concat!(
        r#"<sequence name="G"><gen type="text" value="M,W"/></sequence>"#,
        r#"<sequence name="N" parent="G.M"><gen type="text" value="a,b"/></sequence>"#
    );
    assert_eq!(engine_for("", text_parent), 2);

    let number_parent = concat!(
        r#"<sequence name="G"><gen type="number" value="1..9"/></sequence>"#,
        r#"<sequence name="N" parent="G"><gen type="text" value="a,b"/></sequence>"#
    );
    assert_eq!(engine_for("", number_parent), 3);
}

#[test]
fn a_mode_or_engine_nobody_ships_is_refused_rather_than_guessed() {
    for bad in [r#"mode="ram""#, r#"engine="4""#, r#"engine="fast""#] {
        let config = format!(
            "<tdc><env count=\"1\" seed=\"s\" {bad}>{PLAIN}</env>\
             <block><line><data>x</data></line></block></tdc>"
        );
        let parsed = parser::parse(&config);
        let built = config_builder::build(&parsed.tree, None).expect("builds");
        assert!(
            router::resolve(&built, None).is_err(),
            "{bad} should be refused"
        );
    }
}
