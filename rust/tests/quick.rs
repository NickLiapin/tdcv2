//! The quick API: one value, one call, no config.
//!
//! The values are pinned to the TypeScript implementation's, not merely to
//! themselves. That is the point of the feature existing here at all — a name in
//! a Rust unit test and a name in a TypeScript fixture should come from the same
//! list, in the same order, under the same seed. The constants below were read
//! out of the published npm package.

use tdcv2::packs::DataPacks;
use tdcv2::quick::{Quick, BATCH_ROWS, RESERVED_ROOT_NAMES};

fn demo() -> Quick {
    Quick::seeded("demo").locale("en")
}

#[test]
fn agrees_with_the_typescript_implementation() {
    let mut tdc = demo();
    assert_eq!(tdc.get("person.lastName").unwrap(), "Jones");
    assert_eq!(tdc.get("person.male.firstName").unwrap(), "Robert");
    assert_eq!(tdc.get("company.industry").unwrap(), "Pharmaceuticals");
    assert_eq!(
        tdc.get("common.id.uuid").unwrap(),
        "3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9"
    );
    assert_eq!(
        tdc.get("common.finance.iban").unwrap(),
        "DE62299399441396459682"
    );
    assert_eq!(tdc.get("usa.docs.ssn").unwrap(), "699209702");
}

#[test]
fn a_call_takes_the_next_value_rather_than_rerendering_row_one() {
    // The bug this prevents: a call that means "render one row" returns the same
    // value forever, so a loop of calls produces one name repeated.
    let mut tdc = demo();
    let drawn: Vec<String> = (0..5).map(|_| tdc.get("person.lastName").unwrap()).collect();
    assert_eq!(
        drawn,
        vec!["Jones", "Bush", "Armstrong", "Andrews", "Jimenez"]
    );
}

#[test]
fn many_is_the_same_stream_as_repeated_calls() {
    let mut tdc = demo();
    assert_eq!(
        tdc.many("person.lastName", 5).unwrap(),
        vec!["Jones", "Bush", "Armstrong", "Andrews", "Jimenez"]
    );
}

#[test]
fn two_addresses_are_two_streams() {
    let mut tdc = demo();
    tdc.get("company.industry").unwrap();
    tdc.get("company.industry").unwrap();
    assert_eq!(tdc.get("person.lastName").unwrap(), "Jones");
}

#[test]
fn the_stream_continues_past_one_batch() {
    // BATCH_ROWS values come from one underlying run; the next batch reopens
    // under a derived seed. That boundary is where two implementations drift, so
    // these four straddle it and are pinned to the TypeScript output.
    let mut tdc = Quick::seeded("batch").locale("en");
    let many = tdc.many("person.lastName", BATCH_ROWS + 88).unwrap();
    assert_eq!(many.len(), BATCH_ROWS + 88);
    assert_eq!(&many[510..514], ["Nguyen", "Miller", "Gilbert", "Reyes"]);
}

#[test]
fn seed_and_locale_return_a_new_value() {
    // Two tests must be able to hold two seeds at once without either leaking
    // into the other.
    let mut one = Quick::seeded("a").locale("en");
    let mut two = Quick::seeded("b").locale("en");
    let first_of_one = one.get("person.lastName").unwrap();
    assert_ne!(first_of_one, two.get("person.lastName").unwrap());

    // The stream belongs to the VALUE, not to the seed.
    assert_ne!(first_of_one, one.get("person.lastName").unwrap());
    assert_eq!(
        first_of_one,
        Quick::seeded("a").locale("en").get("person.lastName").unwrap()
    );
}

#[test]
fn the_locale_decides_what_a_bare_address_means() {
    let english = Quick::seeded("l")
        .locale("en")
        .get("person.lastName")
        .unwrap();
    assert!(english.is_ascii(), "{english}");
}

#[test]
fn an_engine_generator_is_reached_by_name() {
    assert_eq!(
        Quick::seeded("demo")
            .gen("number", &[("value", "18..80")])
            .unwrap(),
        "66"
    );
    assert_eq!(
        Quick::seeded("x")
            .gen_many("number", &[("value", "1..1000")], 4)
            .unwrap(),
        vec!["332", "591", "349", "665"]
    );
}

#[test]
fn a_misspelled_address_names_the_nearest_one() {
    let error = Quick::seeded("e")
        .locale("en")
        .get("usa.docs.sn")
        .unwrap_err();
    assert!(
        error.0.contains("Did you mean \"usa.docs.ssn\""),
        "{}",
        error.0
    );
}

#[test]
fn a_missing_pack_says_so_instead_of_proposing_another_language() {
    // The binary carries a starter set; the rest are downloaded. Answering
    // `af.person.lastName` with "did you mean en.person.lastName?" offers
    // English to someone who asked for Afrikaans.
    let error = Quick::seeded("m")
        .locale("en")
        .get("af.person.lastName")
        .unwrap_err();
    assert!(error.0.contains("\"af\" pack is not installed"), "{}", error.0);
    assert!(error.0.contains("tdcv2 pack add af"), "{}", error.0);
    assert!(!error.0.contains("Did you mean"), "{}", error.0);
}

#[test]
fn a_count_of_zero_is_refused() {
    assert!(demo().many("person.lastName", 0).is_err());
}

#[test]
fn no_bundled_address_collides_with_a_reserved_name() {
    // The API answers to these words, so a pack category called one of them
    // would be unreachable. This says so when the pack is added rather than when
    // a user cannot reach it.
    let packs = DataPacks::for_project(None, &[]).expect("packs");
    let addresses = packs.address_list();
    let roots: Vec<&str> = addresses
        .iter()
        .map(|a| a.split('.').next().unwrap_or(""))
        .collect();
    for reserved in RESERVED_ROOT_NAMES {
        if reserved == "lang" || reserved == "country" {
            continue;
        }
        assert!(!roots.contains(&reserved), "{reserved}");
    }
}

// ---------------------------------------------------------------------------
// The one file all five implementations answer to.
//
// The constants above say what the values are; this says that the OTHER FOUR
// agree, because every implementation reads this same file. It is generated
// from the reference, so a change to the batch size, the derived seed or the
// synthesised config shows up here in whichever implementation made it —
// rather than in a user's diff six months later.
// ---------------------------------------------------------------------------

mod common;

#[test]
fn matches_the_shared_quick_vectors() {
    let fixture = common::read_fixture("quick-vectors.json");

    assert_eq!(
        fixture.get("batchRows").and_then(|v| v.as_f64()),
        Some(BATCH_ROWS as f64),
        "the declared batch size is part of the contract"
    );

    for case in fixture
        .get("addresses")
        .and_then(|v| v.as_array())
        .expect("addresses")
    {
        let seed = case.get("seed").and_then(|v| v.as_str()).expect("seed");
        let locale = case.get("locale").and_then(|v| v.as_str()).expect("locale");
        let address = case.get("address").and_then(|v| v.as_str()).expect("address");
        let count = case.get("count").and_then(|v| v.as_f64()).expect("count") as usize;
        let expected: Vec<String> = case
            .get("expected")
            .and_then(|v| v.as_array())
            .expect("expected")
            .iter()
            .map(|v| v.as_str().unwrap_or_default().to_string())
            .collect();

        let drawn = Quick::seeded(seed)
            .locale(locale)
            .many(address, count)
            .unwrap_or_else(|e| panic!("{address}: {e}"));
        assert_eq!(drawn, expected, "{address} under seed {seed}");
    }

    for case in fixture
        .get("generators")
        .and_then(|v| v.as_array())
        .expect("generators")
    {
        let seed = case.get("seed").and_then(|v| v.as_str()).expect("seed");
        let gen_type = case.get("type").and_then(|v| v.as_str()).expect("type");
        let count = case.get("count").and_then(|v| v.as_f64()).expect("count") as usize;
        let attrs = case.get("attrs").expect("attrs").as_string_map();
        let borrowed: Vec<(&str, &str)> = attrs
            .iter()
            .map(|(k, v)| (k.as_str(), v.as_str()))
            .collect();
        let expected: Vec<String> = case
            .get("expected")
            .and_then(|v| v.as_array())
            .expect("expected")
            .iter()
            .map(|v| v.as_str().unwrap_or_default().to_string())
            .collect();

        let drawn = Quick::seeded(seed)
            .gen_many(gen_type, &borrowed, count)
            .unwrap_or_else(|e| panic!("{gen_type}: {e}"));
        assert_eq!(drawn, expected, "gen {gen_type} under seed {seed}");
    }

    for case in fixture
        .get("diagnostics")
        .and_then(|v| v.as_array())
        .expect("diagnostics")
    {
        let name = case.get("name").and_then(|v| v.as_str()).expect("name");
        let seed = case.get("seed").and_then(|v| v.as_str()).expect("seed");
        let locale = case.get("locale").and_then(|v| v.as_str()).expect("locale");
        let address = case
            .get("address")
            .and_then(|v| v.as_str())
            .expect("address");
        let verbatim = case
            .get("verbatim")
            .and_then(|v| v.as_bool())
            .expect("verbatim");

        let message = Quick::seeded(seed)
            .locale(locale)
            .get(address)
            .expect_err(name)
            .0;

        if verbatim {
            let expected = case
                .get("message")
                .and_then(|v| v.as_str())
                .expect("message");
            assert_eq!(message, expected, "{name}");
            continue;
        }
        // Where the wording is free the fragments are the contract, because one
        // implementation words this one differently on purpose.
        for fragment in case
            .get("contains")
            .and_then(|v| v.as_array())
            .unwrap_or_default()
        {
            let fragment = fragment.as_str().unwrap_or_default();
            assert!(message.contains(fragment), "{name}: {message}");
        }
        for fragment in case
            .get("absent")
            .and_then(|v| v.as_array())
            .unwrap_or_default()
        {
            let fragment = fragment.as_str().unwrap_or_default();
            assert!(!message.contains(fragment), "{name}: {message}");
        }
    }
}
