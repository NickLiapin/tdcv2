//! What the carets cover.
//!
//! The position a diagnostic carries is pinned by the shared fixtures; how much
//! of the line it underlines is not, and it is the difference between being
//! shown the mistake and being shown where to start looking. These are the two
//! shapes a position ever has, and the two that would be easy to get wrong.

use tdcv2::errors::{render, Diagnostic, Severity};

fn carets(source: &str, line: i32, column: i32) -> String {
    let d = Diagnostic {
        severity: Severity::Error,
        code: "TDC000".to_string(),
        message: "x".to_string(),
        hint: String::new(),
        line,
        column,
    };
    render::one(&d, Some(source), "t.tdc", false)
        .lines()
        .find(|l| l.contains('^'))
        .unwrap_or_default()
        .trim()
        .trim_start_matches('|')
        .trim()
        .to_string()
}

#[test]
fn a_value_is_underlined_to_its_closing_quote() {
    let source = r#"<gen type="number" value="notanumber"/>"#;
    assert_eq!(carets(source, 1, 26), "^".repeat("notanumber".len()));
}

#[test]
fn an_element_is_underlined_whole_children_and_all() {
    // Not to the first ">": that would stop at the opening tag and leave the
    // body — the part being complained about — unmarked.
    let source = "<block><line><data>${{Nope}}</data></line></block>";
    assert_eq!(
        carets(source, 1, 13),
        "^".repeat("<data>${{Nope}}</data>".len())
    );
}

#[test]
fn a_self_closing_element_stops_at_its_own_slash() {
    let source = r#"<sequence name="B"><gen type="file" row="k"/></sequence>"#;
    assert_eq!(
        carets(source, 1, 19),
        "^".repeat(r#"<gen type="file" row="k"/>"#.len())
    );
}

#[test]
fn a_greater_than_inside_a_value_does_not_end_the_tag() {
    let source = r#"<data value="a>b"/>"#;
    assert_eq!(carets(source, 1, 0), "^".repeat(source.len()));
}

#[test]
fn a_comment_is_not_a_tag() {
    // `<!--` starts with `<` and is not an element; underlining it whole would
    // point at the comment rather than at the empty document being complained
    // about.
    assert_eq!(carets("<!-- nothing here -->", 1, 0), "^");
}

#[test]
fn a_position_past_the_end_of_the_line_still_renders() {
    assert_eq!(carets("<tdc/>", 1, 99), "^");
}
