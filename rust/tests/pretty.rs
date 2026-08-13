//! The pretty-printer, held to the two promises that make it safe to run.
//!
//! A formatter people trust is one they can run without reading the diff. That
//! rests on two properties, and both are checked here over every shared case —
//! 111 configs covering every construct the DSL has:
//!
//! * **It preserves the data.** The formatted config renders byte-identical
//!   output to the original. A formatter that moved a value would be worse than
//!   no formatter, because the damage would look like a whitespace change.
//! * **It is idempotent.** Formatting twice changes nothing the second time.
//!   Without that, two people running it in turn produce a diff apiece.
//!
//! Byte-identity with the other four implementations is the third promise and
//! `fixtures/cross-language/cli.json` is where it is pinned — a team using two
//! of them must not get a formatting diff on every commit.

mod common;

use tdcv2::parser;
use tdcv2::pretty;

#[test]
fn formatting_a_config_does_not_change_what_it_renders() {
    let cases = common::all_cases();
    assert!(cases.len() > 100, "the fixture looks truncated");

    let mut checked = 0usize;
    for case in &cases {
        let Ok(before) = common::render(case) else {
            // A case this build refuses is not a formatting question.
            continue;
        };
        let formatted = pretty::format(&case.config);
        let after = common::render(&common::Case {
            config: formatted.clone(),
            ..clone_case(case)
        })
        .unwrap_or_else(|e| panic!("{}: the formatted config no longer runs: {e}", case.name));

        assert_eq!(
            after, before,
            "{}: formatting changed the data\n--- formatted ---\n{formatted}",
            case.name
        );
        checked += 1;
    }
    println!("pretty: {checked} configs render identically after formatting");
    assert!(checked > 100, "too few cases actually ran");
}

#[test]
fn formatting_twice_is_the_same_as_formatting_once() {
    let cases = common::all_cases();
    let mut checked = 0usize;
    for case in &cases {
        let once = pretty::format(&case.config);
        // A config that does not parse comes back unchanged, so this holds for
        // those too — and that is worth checking rather than skipping.
        let twice = pretty::format(&once);
        assert_eq!(twice, once, "{}: formatting is not idempotent", case.name);
        checked += 1;
    }
    println!("pretty: {checked} configs are unchanged by a second pass");
}

#[test]
fn a_file_that_does_not_parse_comes_back_untouched() {
    // Reformatting something half-parsed would rewrite it into something the
    // author never wrote.
    for broken in ["<tdc><env>", "<tdc", "<tdc><env count=></env></tdc>"] {
        assert_eq!(pretty::format(broken), broken);
    }
}

#[test]
fn comments_survive_and_keep_their_place() {
    let source = concat!(
        "<!-- about the file -->\n",
        "<tdc>\n",
        "<env count=\"1\" seed=\"s\">\n",
        "<!-- about the sequence -->\n",
        "<sequence name=\"A\"><gen type=\"text\" value=\"x\"/></sequence>\n",
        "</env>\n",
        "<block><line><data>${{A}}</data></line></block>\n",
        "</tdc>\n",
    );
    let formatted = pretty::format(source);

    assert!(formatted.contains("<!-- about the file -->"));
    assert!(formatted.contains("<!-- about the sequence -->"));

    let lines: Vec<&str> = formatted.lines().collect();
    assert_eq!(lines[0], "<!-- about the file -->", "before the root");
    let at = lines
        .iter()
        .position(|l| l.contains("about the sequence"))
        .expect("the second comment");
    assert!(
        lines[at + 1].contains("<sequence name=\"A\">"),
        "a comment stays directly above what it was written above"
    );
    // And it is indented with the thing it introduces, not left at column 0.
    assert!(lines[at].starts_with("        <!--"), "{:?}", lines[at]);
}

#[test]
fn a_comment_inside_an_element_stops_it_being_put_on_one_line() {
    // `<line>` is short enough to inline, and would be — but there is nowhere on
    // a single line to put a comment, and dropping it is not an option.
    let source = concat!(
        "<tdc><env count=\"1\" seed=\"s\"><sequence name=\"A\">",
        "<gen type=\"text\" value=\"x\"/></sequence></env>",
        "<block><line><!-- why --><data>${{A}}</data></line></block></tdc>",
    );
    let formatted = pretty::format(source);

    assert!(formatted.contains("<!-- why -->"));
    let line = formatted
        .lines()
        .find(|l| l.trim() == "<line>")
        .unwrap_or_default();
    assert_eq!(
        line.trim(),
        "<line>",
        "the element had to open on its own line"
    );
}

#[test]
fn the_tree_carries_the_comments_the_parser_hides() {
    // The parser drops comments, as the grammar does. They travel beside the
    // tree instead, which is what lets the pretty-printer put them back without
    // the generator ever seeing one.
    let parsed = parser::parse("<!-- one --><tdc><!-- two --></tdc>");
    assert!(parsed.ok());
    assert_eq!(
        parsed
            .tree
            .comments
            .iter()
            .map(|c| c.text.as_str())
            .collect::<Vec<_>>(),
        vec!["<!-- one -->", "<!-- two -->"]
    );
    assert_eq!(parsed.tree.comments[0].pos.line, 1);
    assert!(parsed.tree.comments[0].pos.column < parsed.tree.comments[1].pos.column);
}

/// `Case` is a plain record; this is the copy the render helper needs.
fn clone_case(case: &common::Case) -> common::Case {
    common::Case {
        name: case.name.clone(),
        config: case.config.clone(),
        expected: case.expected.clone(),
        count: case.count,
        seed: case.seed.clone(),
        locale: case.locale.clone(),
        now: case.now.clone(),
        data_path: case.data_path.clone(),
    }
}
