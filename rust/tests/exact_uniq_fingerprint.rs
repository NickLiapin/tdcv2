//! The fingerprint repair against the text repair — same table, or no deal.
//!
//! Engine 3 changes the CARRIER when a run is large: 13-byte hashes routed into
//! piles, each pile sorted as raw bytes, groups sharing a hash treated as
//! candidates. Which rows collide and where they move must not change with the
//! carrier. These cases run the same columns through both paths and compare
//! every row.
//!
//! None of this had a test in this port, and it could not have had one: the
//! carrier switches at a MILLION rows, and no suite renders a million rows. So
//! `repair_with_buckets` takes the pile count instead of working it out — the
//! same knob the reference has always had — and these run at a few thousand.
//!
//! The one place the two may legitimately differ is a real 64-bit hash
//! collision, whose odds at these sizes are nil; equality is asserted outright.

use std::collections::BTreeSet;

use tdcv2::engine::exact_uniq::{self, Overrides, Source};

/// A column that cycles through `values`, holding each for `stride` rows.
fn column(values: Vec<String>, stride: i32) -> Source<'static> {
    Box::new(move |row: i32| values[((row / stride) as usize) % values.len()].clone())
}

fn many(n: usize, prefix: &str) -> Vec<String> {
    (0..n).map(|i| format!("{prefix}{i}")).collect()
}

/// Every row's tuple, as text, with the repair's moves applied.
fn rows_of(overrides: &Overrides, sources: &[Source<'_>], count: i32) -> Vec<String> {
    (0..count)
        .map(|row| {
            let moved = overrides.get(&row);
            (0..sources.len())
                .map(|k| match moved {
                    Some(values) => values[k].clone(),
                    None => sources[k](row),
                })
                .collect::<Vec<String>>()
                .join("|")
        })
        .collect()
}

fn duplicate_count(sources: &[Source<'_>], count: i32) -> usize {
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut duplicates = 0;
    for row in 0..count {
        let key = sources
            .iter()
            .map(|source| source(row))
            .collect::<Vec<String>>()
            .join(&exact_uniq::JOIN.to_string());
        if !seen.insert(key) {
            duplicates += 1;
        }
    }
    duplicates
}

fn cases() -> Vec<(&'static str, i32, Vec<Source<'static>>)> {
    vec![
        (
            "a wide column and a narrow one, hundreds of collisions",
            3000,
            vec![column(many(200, "a"), 1), column(many(25, "b"), 11)],
        ),
        (
            "three columns, collisions in quantity",
            2000,
            vec![
                column(many(50, "a"), 1),
                column(many(20, "b"), 13),
                column(many(6, "c"), 29),
            ],
        ),
        (
            "two columns drawing from one list",
            1500,
            vec![column(many(60, "v"), 1), column(many(60, "v"), 11)],
        ),
    ]
}

#[test]
fn the_carrier_does_not_change_the_answer() {
    let tmp = std::env::temp_dir();
    for (name, count, sources) in cases() {
        assert!(
            duplicate_count(&sources, count) > 0,
            "{name}: nothing to repair, so the case proves nothing"
        );

        let text_moves = exact_uniq::repair(&sources, count, "\"A × B\"", &tmp, None, None)
            .expect("the text repair should succeed");
        let text = rows_of(&text_moves, &sources, count);
        let distinct: BTreeSet<&String> = text.iter().collect();
        assert_eq!(
            distinct.len(),
            count as usize,
            "{name}: the text repair left a duplicate"
        );

        for buckets in [2usize, 8, 32] {
            let moves = exact_uniq::repair_with_buckets(
                &sources,
                count,
                "\"A × B\"",
                &tmp,
                None,
                None,
                buckets,
            )
            .expect("the fingerprint repair should succeed");
            assert_eq!(
                rows_of(&moves, &sources, count),
                text,
                "{name}: {buckets} piles produced a different table"
            );
        }
    }
}

#[test]
fn a_hash_collision_between_different_tuples_never_becomes_a_duplicate() {
    // Pinned directly, because at these sizes a real 64-bit collision does not
    // happen — turn verification off entirely and every comparison above still
    // passes. Only a FORGED candidate group can fail this: rows whose tuples
    // differ, handed over as if their hashes had matched.
    let sources: Vec<Source<'static>> = vec![
        Box::new(|row: i32| format!("a{row}")), // all distinct
        Box::new(|row: i32| {
            if row == 1 || row == 2 {
                "same".to_string()
            } else {
                format!("b{row}")
            }
        }),
    ];
    assert_eq!(
        exact_uniq::verify_candidates(&sources, &[vec![5, 6]]),
        vec![]
    );
    // Rows 1 and 2 share ONLY the second column; the tuples still differ through the first.
    assert_eq!(
        exact_uniq::verify_candidates(&sources, &[vec![1, 2, 9]]),
        vec![]
    );

    // And a genuine repeat inside a mixed group survives, lowest row spared.
    let twin: Vec<Source<'static>> = vec![
        Box::new(|row: i32| {
            if row == 3 || row == 7 {
                "x".to_string()
            } else {
                format!("a{row}")
            }
        }),
        Box::new(|row: i32| {
            if row == 3 || row == 7 {
                "y".to_string()
            } else {
                format!("b{row}")
            }
        }),
    ];
    assert_eq!(
        exact_uniq::verify_candidates(&twin, &[vec![3, 7, 12]]),
        vec![7]
    );
}

#[test]
fn a_run_with_nothing_to_repair_passes_through_untouched() {
    let tmp = std::env::temp_dir();
    let sources: Vec<Source<'static>> = vec![column(many(400, "a"), 1), column(many(400, "b"), 1)];
    let moves =
        exact_uniq::repair_with_buckets(&sources, 400, "\"A × B\"", &tmp, None, None, 8).unwrap();
    assert!(
        moves.is_empty(),
        "nothing needed repairing, so nothing may move"
    );
    let rows = rows_of(&moves, &sources, 400);
    let distinct: BTreeSet<&String> = rows.iter().collect();
    assert_eq!(distinct.len(), 400);
    // Untouched means untouched: every row still holds what it drew.
    for row in 0..400 {
        assert_eq!(
            rows[row as usize],
            format!("{}|{}", sources[0](row), sources[1](row))
        );
    }
}
