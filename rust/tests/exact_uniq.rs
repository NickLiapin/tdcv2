//! Engine 3: exact shares and uniqueness at the same time.
//!
//! Engine 2 gives unique combinations, but uniform ones. Engine 1 gives both and
//! holds the whole table to do it. Engine 3 is the interesting case — exact
//! shares, verified distinct, in bounded memory — and the properties worth
//! pinning are the two it promises rather than any particular bytes, which
//! `engines.json` already covers.

mod common;

use std::collections::BTreeMap;

use tdcv2::engine::{self, EngineError};
use tdcv2::parser::{self, config_builder};

/// A dense uniq: 60 combinations available, and the run asks for most of them,
/// so the construction collides and the repair has to place the strays.
fn dense(count: i32) -> String {
    format!(
        concat!(
            "<tdc><env count=\"{}\" seed=\"e3\" local=\"en\">",
            "<sequence name=\"K\" uniq=\"true\">",
            "<gen name=\"a\" type=\"text\" value=\"alpha,beta,gamma,delta,eps,zeta\" ",
            "percent=\"30,25,20,15,7,3\"/>",
            "<gen name=\"b\" type=\"text\" value=\"one,two,three,four,five,six,seven,eight,nine,ten\" ",
            "percent=\"20,15,12,11,10,9,8,7,5,3\"/>",
            "</sequence></env>",
            "<block><line><data>${{{{K.a}}}},${{{{K.b}}}}</data></line></block></tdc>"
        ),
        count
    )
}

fn render(source: &str, engine: &str) -> Result<String, EngineError> {
    let parsed = parser::parse(source);
    assert!(parsed.ok(), "the config should parse");
    let config = config_builder::build(&parsed.tree, None)
        .map_err(|e| EngineError::Invalid(e.message))?
        .with_engine(engine.to_string());
    engine::render(&config, 0)
}

fn rows(text: &str) -> Vec<&str> {
    text.trim_end_matches('\n').split('\n').collect()
}

#[test]
fn every_row_is_distinct_across_the_whole_run() {
    // Swept rather than spot-checked: whether the construction collides at all
    // depends on the count, so one size would test one path and call it two.
    let mut ran = 0usize;
    for count in 2..=34 {
        let Ok(text) = render(&dense(count), "3") else {
            continue;
        };
        let produced = rows(&text);
        assert_eq!(produced.len(), count as usize, "count {count}");

        let distinct: std::collections::BTreeSet<&str> = produced.iter().copied().collect();
        assert_eq!(
            distinct.len(),
            produced.len(),
            "count {count}: the run is not unique"
        );
        ran += 1;
    }
    assert!(
        ran > 20,
        "only {ran} counts ran — the sweep is not sweeping"
    );
}

#[test]
fn the_declared_shares_survive_the_repair() {
    // This is what engine 3 exists for. The repair moves rows between each
    // other and never brings a value in or takes one out, so the totals it
    // started with are the totals it ends with.
    for count in [12, 20, 30] {
        let text = render(&dense(count), "3").expect("a feasible run");

        let mut first: BTreeMap<&str, usize> = BTreeMap::new();
        for row in rows(&text) {
            *first
                .entry(row.split(',').next().unwrap_or(""))
                .or_default() += 1;
        }

        // 30% of the run, to the row, by Hamilton's largest remainder.
        let expected_alpha = ((f64::from(count) * 0.30).round()) as usize;
        assert_eq!(
            first.get("alpha").copied().unwrap_or(0),
            expected_alpha,
            "count {count}: alpha's share moved\n{text}"
        );
        assert_eq!(first.values().sum::<usize>(), count as usize);
    }
}

#[test]
fn a_run_too_tight_for_its_data_is_refused_rather_than_nearly_unique() {
    // 6 x 10 values, but the shares allow far fewer distinct pairs than the
    // product suggests. Shipping 40 rows of which two matched would be worse
    // than saying no.
    let error = render(&dense(40), "3").expect_err("40 rows should not fit");
    assert!(error.message().contains("infeasible"), "{error}");
    assert!(error.message().contains("40 were requested"), "{error}");
}

#[test]
fn engine_2_refuses_what_engine_3_answers() {
    // The two are the same code but for one setting, and this is the setting:
    // streaming uniq cannot honour percent, and says so instead of quietly
    // dropping the shares.
    let error = render(&dense(12), "2").expect_err("engine 2 cannot do this");
    assert!(matches!(error, EngineError::Unsupported(_)), "{error}");
    assert!(error.message().contains("percent"), "{error}");

    // And engine 3 does it.
    assert!(render(&dense(12), "3").is_ok());
}
