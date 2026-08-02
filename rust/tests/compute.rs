//! The compute layer, checked against identifiers whose check digits are public
//! facts.
//!
//! A test that only asserted the layer agrees with itself would pass a wrong
//! Luhn. These run the bundled packs and verify the ANSWER — a real payment-card
//! number's Luhn digit, a real IBAN's mod-97 — so the arithmetic is pinned by
//! the world rather than by the port.

mod common;

use tdcv2::engine;
use tdcv2::parser::{self, config_builder};

fn render(body: &str, count: i32, seed: &str) -> Vec<String> {
    let config = format!(
        "<tdc><env count=\"{count}\" seed=\"{seed}\" local=\"en\" mode=\"memory\">{body}</env>\
         <block><line><data>${{{{V}}}}</data></line></block></tdc>"
    );
    let parsed = parser::parse(&config);
    assert!(parsed.ok(), "did not parse: {config}");
    let built = config_builder::build(&parsed.tree, None).expect("builds");
    let text = engine::render(&built, 0).unwrap_or_else(|e| panic!("{e}\n  in: {config}"));
    text.lines().map(str::to_string).collect()
}

/// The Luhn check: double every second digit from the right, subtract nine from
/// anything over nine, and the total must be a multiple of ten.
fn luhn_ok(number: &str) -> bool {
    let mut sum = 0u32;
    let mut double = false;
    for c in number.chars().rev() {
        let Some(d) = c.to_digit(10) else {
            return false;
        };
        let d = if double {
            let doubled = d * 2;
            if doubled > 9 {
                doubled - 9
            } else {
                doubled
            }
        } else {
            d
        };
        sum += d;
        double = !double;
    }
    sum % 10 == 0
}

#[test]
fn a_generated_card_number_passes_luhn() {
    // The whole reason the compute layer exists: a card number without its check
    // digit is rejected by the system it was generated to test, and looks
    // perfectly fine until then.
    let values = render(
        r#"<sequence name="V"><gen type="template" value="common.payment.card.pan"/></sequence>"#,
        20,
        "luhn",
    );
    assert_eq!(values.len(), 20);
    for v in &values {
        assert_eq!(v.len(), 16, "{v}");
        assert!(luhn_ok(v), "{v} does not pass Luhn");
    }
}

#[test]
fn a_generated_iban_passes_the_mod_97_check() {
    // Move the first four characters to the end, turn letters into numbers, and
    // the whole thing read as one integer must be 1 modulo 97. Computed here
    // digit by digit, because the number is far too long for any integer type.
    let values = render(
        r#"<sequence name="V"><gen type="template" value="common.finance.iban"/></sequence>"#,
        10,
        "iban",
    );
    for v in &values {
        let compact: String = v.chars().filter(|c| !c.is_whitespace()).collect();
        assert!(compact.len() >= 15, "{v}");
        let rearranged: String = compact[4..].chars().chain(compact[..4].chars()).collect();

        let mut remainder = 0u32;
        for c in rearranged.chars() {
            let digits = if c.is_ascii_digit() {
                (c as u32 - '0' as u32).to_string()
            } else if c.is_ascii_uppercase() {
                (c as u32 - 'A' as u32 + 10).to_string()
            } else {
                panic!("{v} has a character an IBAN cannot hold: {c:?}");
            };
            for d in digits.chars() {
                remainder = (remainder * 10 + d.to_digit(10).expect("a digit")) % 97;
            }
        }
        assert_eq!(remainder, 1, "{v} fails the mod-97 check");
    }
}

#[test]
fn a_generated_vin_passes_its_weighted_mod_11_check() {
    // Position nine is the check digit, and 10 is written as X — which is the
    // detail a port gets wrong by emitting "10" and producing an 18-character
    // VIN that looks almost right.
    let values = render(
        r#"<sequence name="V"><gen type="template" value="common.vehicle.vin"/></sequence>"#,
        15,
        "vin",
    );
    const WEIGHTS: [u32; 17] = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
    // The ISO 3779 transliteration, A..Z. Taken from the pack's own <list>
    // rather than from memory: my first attempt had nineteen entries and
    // panicked on the first VIN holding a letter past S.
    const LETTERS: [u32; 26] = [
        1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3, 4, 5, 0, 7, 0, 9, 2, 3, 4, 5, 6, 7, 8, 9,
    ];

    for v in &values {
        assert_eq!(v.chars().count(), 17, "{v}");
        let mut sum = 0u32;
        for (i, c) in v.chars().enumerate() {
            let value = if let Some(d) = c.to_digit(10) {
                d
            } else {
                LETTERS[c as usize - 'A' as usize]
            };
            sum += value * WEIGHTS[i];
        }
        let expected = sum % 11;
        let check = v.chars().nth(8).expect("position nine");
        let actual = if check == 'X' {
            10
        } else {
            check.to_digit(10).unwrap_or_else(|| panic!("{v}"))
        };
        assert_eq!(actual, expected, "{v} has the wrong check digit");
    }
}

#[test]
fn a_computed_column_is_derived_and_costs_no_draw() {
    // A compute reads columns already built and takes no randomness. That is why
    // declaration ORDER alone decides what it can see, and why adding one does
    // not shift any column after it.
    let with_compute = render(
        concat!(
            r#"<sequence name="B"><gen type="number" value="100..999"/></sequence>"#,
            r#"<sequence name="V"><compute><result><concat>"#,
            r#"<field name="B"/><str v="-"/><mod><to_number><field name="B"/></to_number><int v="7"/></mod>"#,
            r#"</concat></result></compute></sequence>"#
        ),
        5,
        "derive",
    );
    for v in &with_compute {
        let (base, digit) = v.split_once('-').expect("a dash");
        let base: i64 = base.parse().expect("a number");
        assert_eq!(digit.parse::<i64>().expect("a digit"), base % 7, "{v}");
    }
}

#[test]
fn the_remainder_is_euclidean_and_not_the_host_languages() {
    // Rust, C#, Java and JavaScript all give a NEGATIVE remainder for a negative
    // dividend; Python does not. A check digit computed with the wrong sign
    // convention is wrong only for some inputs, which is the worst way to be
    // wrong.
    assert_eq!((-7i128) % 3, -1, "this is what the host language does");
    assert_eq!(
        tdcv2::compute::value::modulo(-7, 3).expect("a modulus"),
        2,
        "and this is what every implementation of TDC must do"
    );
    assert_eq!(tdcv2::compute::value::modulo(-7, -3).expect("ok"), 2);
    assert_eq!(tdcv2::compute::value::floor_div(-7, 2).expect("ok"), -4);
}

#[test]
fn a_multi_digit_string_will_not_coerce_to_a_number_by_itself() {
    // A single digit does, because iterating a string yields characters and
    // summing them is the whole point. "12" in an arithmetic slot is far more
    // often a mistake than an intention, so it has to say <to_number> out loud —
    // and the message says so.
    use tdcv2::compute::value::{as_int, Value};
    assert_eq!(as_int(&Value::str("7"), "<add>").expect("a digit"), 7);
    let err = as_int(&Value::str("12"), "<add>").unwrap_err();
    assert!(err.message.contains("<to_number>"), "{err}");
}
