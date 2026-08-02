//! Masks and filters, against values taken from the reference implementation.
//!
//! Every expected string below came out of `typescript/dist/format/transforms.js`
//! rather than out of my reading of the mask rules. Two of them contradicted
//! what I would have written down, which is the reason the table exists in this
//! form.

use tdcv2::format::{mask, transforms};

fn filter(kind: &str, arg: Option<&str>, value: &str) -> String {
    transforms::apply_filter(kind, arg, value).expect("applies")
}

#[test]
fn a_mask_indexes_the_original_and_consumes_separately() {
    // The rule that makes `w[1] w[0]` a swap and `w[0] *` a repeat: indexing and
    // consumption are two channels. What an index EMITS never depends on what
    // has been consumed; consumption only decides what is left for a bare `x`,
    // `w` or `*`.
    let cases: &[(&str, &str, &str)] = &[
        ("xxx-xxx", "1234567", "123-456"),
        ("w[1] w[0]", "John Smith", "Smith John"),
        // `w[0]` consumed the first word AND its delimiter, so `*` prints the
        // rest with no leading space — and the whole thing reads unchanged.
        ("w[0] *", "John Smith Jr", "John Smith Jr"),
        // The one that reads oddly and is right: `x[0]` emits "J" but only
        // consumes that one character, so `*` still has the "ohn" after it.
        ("x[0]. *", "John Smith", "J. ohn Smith"),
        ("x[0..2]", "abcdef", "abc"),
        ("x[-1]", "abcdef", "f"),
        ("x[-2..-1]", "abcdef", "ef"),
        // A descending range walks backwards.
        ("x[2..0]", "abcdef", "cba"),
        // A `[` that does not follow an x or a w is ordinary text, so a mask can
        // carry a bracketed label without escaping it.
        ("[tel.] xxx", "12345", "[tel.] 123"),
        // The same word twice: indexing is a copy when something else claims the
        // position too.
        ("w[0] w[0]", "John Smith", "John John"),
        // Out of range emits nothing rather than failing. The length of a value
        // is not known until it is generated, so there is nothing to check the
        // mask against beforehand — and stopping a million-row run over one
        // short value would be worse than a gap in it.
        ("x[9]", "ab", ""),
    ];

    for (pattern, input, want) in cases {
        assert_eq!(
            mask::apply(pattern, input).expect("applies"),
            *want,
            "mask {pattern:?} on {input:?}"
        );
    }
}

#[test]
fn a_broken_index_is_refused_with_the_reason_and_the_fix() {
    let err = mask::apply("x[1-3]", "abcdef").unwrap_err();
    // A hyphen would clash with a negative index, so ranges use `..` — and the
    // message says so rather than only that the mask is wrong.
    assert!(err.message().contains(".."), "{err}");
    assert!(err.message().contains("x[0..4]"), "{err}");

    // Checked without applying, which is what the validator needs to refuse one
    // before a single row exists.
    assert!(mask::check("xxx-xxx").is_ok());
    assert!(mask::check("x[1-3]").is_err());
}

#[test]
fn every_filter_matches_the_reference() {
    let cases: &[(&str, Option<&str>, &str, &str)] = &[
        ("slice", Some("0,3"), "abcdef", "abc"),
        // A negative index counts from the END, as `Array.slice` does. It has to
        // mean "the last three" everywhere, not "all of them" in whichever
        // implementation clamped it to zero.
        ("slice", Some("-3"), "abcdef", "def"),
        ("slice", Some(",4"), "abcdef", "abcd"),
        // Grouping runs from the RIGHT, so a number's last group stays whole.
        ("group", Some("3,-"), "123456789", "123-456-789"),
        ("group", Some(""), "1234567", "1 234 567"),
        ("compact", Some(""), "1000000", "lfls"),
        ("compact", Some(""), "-42", "-16"),
        // Not a whole number, so there is nothing to shorten: passed through.
        ("compact", Some(""), "abc", "abc"),
        ("csv", None, "Knife, 3 pcs", "\"Knife, 3 pcs\""),
        ("sql", None, "O'Brien", "O''Brien"),
        // Only the FIRST letter of each word moves, so an already-correct
        // "mcDonald" becomes "McDonald" and not "Mcdonald".
        ("title", None, "john mcDonald", "John McDonald"),
        ("capitalize", None, "john smith", "John smith"),
        ("replace", Some("a,X"), "banana", "bXnXnX"),
        ("trim", None, "  hi  ", "hi"),
        // An unknown filter passes the value through untouched. Filters are
        // lenient by design and the validator is where a typo gets named;
        // failing here would turn a misspelling into a dead run rather than a
        // visible oddity in the output.
        ("nosuch", None, "keep", "keep"),
    ];

    for (kind, arg, value, want) in cases {
        assert_eq!(filter(kind, *arg, value), *want, "|{kind} on {value:?}");
    }
}

#[test]
fn uppercasing_uses_the_full_unicode_mapping() {
    // The C# port needs a hundred-entry table here because .NET's
    // ToUpperInvariant is a 1:1 mapping and leaves ß alone. Rust does not — but
    // "Rust does not" is a claim, so these are the awkward ones, checked against
    // `node` before the claim was written into the module.
    assert_eq!(filter("upper", None, "straße"), "STRASSE");
    assert_eq!(filter("upper", None, "ﬄ"), "FFL");
    assert_eq!(filter("upper", None, "ʼn"), "ʼN");
    assert_eq!(filter("upper", None, "ǰ"), "J̌");
    assert_eq!(filter("lower", None, "STRASSE"), "strasse");
}

#[test]
fn a_mask_counts_code_points_and_not_bytes() {
    // `x` takes one CHARACTER. Counting bytes would cut a multi-byte character
    // in half and produce invalid UTF-8 — which in Rust is not a wrong string
    // but a panic, so this is a crash rather than a quiet divergence.
    assert_eq!(mask::apply("xxx", "日本語です").expect("applies"), "日本語");
    assert_eq!(mask::apply("x[-1]", "日本語").expect("applies"), "語");
    assert_eq!(filter("slice", Some("1,3"), "日本語です"), "本語");
}
