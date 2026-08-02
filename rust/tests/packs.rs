//! How a dotted address becomes a file, and what a pack file may say about itself.
//!
//! These run against the repository's real `data/packs` — the same files the
//! other four implementations read. A copy would drift; reading the originals is
//! what makes "the same pack" mean something.

// `common` is shared by every integration test; this one uses none of it, and
// Rust compiles the module per test binary rather than once.
mod common;

use tdcv2::packs::DataPacks;

fn packs() -> DataPacks {
    DataPacks::discover().expect("the repository's data/packs")
}

#[test]
fn a_relative_address_is_resolved_against_the_active_locale() {
    let packs = packs();
    let en = packs.load("person.lastName", "en").expect("en surnames");
    let ru = packs.load("person.lastName", "ru").expect("ru surnames");
    assert!(!en.values.is_empty() && !ru.values.is_empty());
    assert_ne!(
        en.values, ru.values,
        "the same address under two locales must not read one file"
    );
    // The Russian pack holds Cyrillic; the English one does not. A port that
    // ignored the locale would pass every other assertion here.
    assert!(ru.values.iter().any(|v| v.chars().any(|c| c >= 'А')));
    assert!(en.values.iter().all(|v| v.is_ascii()));
}

#[test]
fn an_address_whose_first_segment_names_a_locale_is_already_absolute() {
    // `en.person.lastName` must not become `ru/en/person/lastName.txt` when the
    // run's locale is Russian. This is what lets one config mix a Russian name
    // with an English street.
    let packs = packs();
    let absolute = packs.load("en.person.lastName", "ru").expect("absolute");
    let relative = packs.load("person.lastName", "en").expect("relative");
    assert_eq!(absolute.values, relative.values);
}

#[test]
fn a_country_pack_is_absolute_too_but_lives_under_a_folder_nobody_writes() {
    // `countries/` is a physical grouping, not part of the address. Without the
    // special case every country pack would look relative and be searched for
    // under the active locale, where it is not.
    let packs = packs();
    assert!(
        packs.exists("usa.finance.aba_routing", "ru"),
        "a country address resolves whatever the run's locale is"
    );
}

#[test]
fn an_address_that_resolves_to_nothing_says_where_it_looked() {
    let packs = packs();
    let err = packs.load("person.nosuchthing", "en").unwrap_err();
    let message = err.message();
    assert!(message.contains("person.nosuchthing"), "{message}");
    // The path it tried, not only the address it was given — which is the half
    // that tells you whether the locale or the name was wrong.
    assert!(message.contains("en/person/nosuchthing.txt"), "{message}");
}

#[test]
fn a_weighted_pack_becomes_exact_proportions_and_drops_its_zero_counts() {
    let packs = packs();
    let entry = packs
        .load("person.male.firstName", "en")
        .expect("US given names");
    assert!(
        entry.weighted(),
        "the SSA name file declares weighted: true"
    );
    let percents = entry.percents.as_ref().expect("weighted");
    assert_eq!(percents.len(), entry.values.len());

    // Shares, not probabilities: they add to a hundred, and a run apportions
    // them exactly rather than sampling towards them.
    let total: f64 = percents.iter().sum();
    assert!((total - 100.0).abs() < 1e-6, "shares sum to {total}");
    assert!(
        percents.iter().all(|p| *p > 0.0),
        "a zero count means never drawn, and is dropped rather than carried"
    );
}

#[test]
fn a_generator_pack_carries_its_rule_instead_of_a_list() {
    // Some things cannot be listed — every UUID, every account number — so the
    // pack ships the rule that makes one. Reading it is the compute layer's job;
    // what this checks is that the header is understood and the body survives.
    let packs = packs();
    let entry = packs
        .load("common.payment.card.pan", "en")
        .expect("the PAN pack");
    assert!(entry.is_generator());
    assert!(entry.values.is_empty(), "a generator lists nothing");
    let body = entry.generator.as_deref().unwrap_or("");
    assert!(body.contains("<sequence"), "{body}");
    assert!(body.contains("<compute>"), "{body}");
}

#[test]
fn the_header_is_optional_and_its_absence_is_not_a_shape_of_its_own() {
    // A pack with no `---` block is a plain list from its first line. A parser
    // that skipped a line looking for one would silently drop a value.
    let packs = packs();
    for address in ["person.lastName", "color.name"] {
        if let Ok(entry) = packs.load(address, "en") {
            assert!(!entry.values.is_empty(), "{address}");
            assert!(
                entry.values.iter().all(|v| !v.trim().is_empty()),
                "{address} kept a blank line"
            );
            assert!(
                !entry.values.iter().any(|v| v.trim() == "---"),
                "{address} kept a header delimiter as a value"
            );
        }
    }
}

/// The starter packs compiled into the binary.
///
/// A published crate is a tarball with nothing above it, so the walk that finds
/// `data/packs` in a checkout cannot work in `~/.cargo/registry`. The crate
/// published without this answered every `type="template"` with "no data packs
/// found" — while every test in this file was green, because every test in this
/// file runs inside the repository.
///
/// These assert the SHAPE of the embedded source. Whether the packaged crate
/// actually carries anything is a question no in-repo test can answer, so
/// `scripts/verify-crate.mjs` packages it, unpacks it outside the repository,
/// builds it there and runs one.
mod embedded {
    use tdcv2::packs::source::{EmbeddedSource, PackSource};

    #[test]
    fn a_checkout_embeds_nothing_and_reads_the_repository_instead() {
        // `bundle-packs.mjs add` fills the table in only for packaging, and
        // `remove` empties it again. A checkout that had it filled would be
        // reading a stale copy of packs that live once.
        assert!(
            EmbeddedSource::is_empty(),
            "a checkout must not carry a second copy of the packs; run \
             `node scripts/bundle-packs.mjs remove`"
        );
    }

    #[test]
    fn an_empty_embedded_source_answers_nothing_rather_than_wrongly() {
        // The dangerous failure is not "no data" — it is an empty source that
        // claims to have an address and hands back nothing.
        let source = EmbeddedSource::new();
        assert!(!source.has("en/person/lastName.txt"));
        assert_eq!(source.read_lines("en/person/lastName.txt"), None);
        assert!(source.list_files().is_empty());
        assert!(!source.has_top_level("en"));
        assert!(!source.has_country("usa"));
    }
}
