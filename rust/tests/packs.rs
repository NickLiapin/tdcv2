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

/// The shipped generators whose body DRAWS from a weighted list and says so
/// nowhere: no `percent=` of their own, only a `value="…lastName"` pointing at a
/// file that happens to carry counts.
const WEIGHTED_DRAW: [(&str, &str); 6] = [
    ("hu", "hu.person.male.fullName"),
    ("cs", "cs.person.male.fullName"),
    ("nl", "nl.person.male.fullName"),
    ("sr", "sr.person.male.fullName"),
    ("fa", "fa.person.male.fullName"),
    ("he", "he.person.female.fullName"),
];

/// The same shape over lists that carry no counts. They must keep streaming: the
/// flag costs a column the streaming engines, and paying that for a pack with no
/// quota in it buys nothing.
const UNWEIGHTED_DRAW: [(&str, &str); 2] = [
    ("de", "de.person.male.fullName"),
    ("pl", "pl.person.male.fullName"),
];

#[test]
fn drawing_from_a_weighted_list_makes_a_generator_whole_column_and_drawing_from_a_plain_one_does_not(
) {
    // A weighted list is laid out to an exact quota over the run, so asked for a
    // single row it awards that row to the largest share — every row, every
    // seed. The pack that draws it cannot say so, because whether
    // `hu.person.lastName` carries counts is a fact about a different file.
    let packs = packs();

    let mut unflagged: Vec<&str> = Vec::new();
    for (locale, address) in WEIGHTED_DRAW {
        let body = packs
            .load(address, locale)
            .expect(address)
            .generator
            .unwrap_or_default();
        assert!(
            !body.contains("percent="),
            "{address} declares a share of its own, so it proves nothing here"
        );
        if !packs.needs_whole_column(address, locale) {
            unflagged.push(address);
        }
    }
    assert!(
        unflagged.is_empty(),
        "{} of {} generators drawing from a weighted list are not marked whole-column: {unflagged:?}",
        unflagged.len(),
        WEIGHTED_DRAW.len()
    );

    let mut overflagged: Vec<&str> = Vec::new();
    for (locale, address) in UNWEIGHTED_DRAW {
        if packs.needs_whole_column(address, locale) {
            overflagged.push(address);
        }
    }
    assert!(
        overflagged.is_empty(),
        "{} generator(s) over unweighted lists lost the streaming engines for nothing: {overflagged:?}",
        overflagged.len()
    );
}

#[test]
fn a_name_pack_over_a_weighted_list_does_not_hand_every_row_the_same_name() {
    // The failure this guards is silent: eight Hungarian names came out as
    // `Nagy László` eight times, on every engine and every seed, and the column
    // looked like data. `china.geo.streetName` is here as the neighbouring case
    // — it declares `percent=` in its own body — so one rule cannot be fixed by
    // breaking the other.
    let mut repeated: Vec<String> = Vec::new();
    for (locale, address) in WEIGHTED_DRAW
        .iter()
        .chain(UNWEIGHTED_DRAW.iter())
        .chain([("zh-cn", "china.geo.streetName")].iter())
    {
        let rows = render_pack(locale, address, 8);
        let distinct: std::collections::BTreeSet<&String> = rows.iter().collect();
        if distinct.len() < 2 {
            repeated.push(format!("{address} -> {:?}", distinct));
        }
    }
    assert!(
        repeated.is_empty(),
        "{} pack(s) returned one value for all 8 rows: {repeated:?}",
        repeated.len()
    );
}

#[test]
fn a_ring_of_generators_stops_the_walk_instead_of_ending_the_process() {
    // Two packs that name each other. The loader reports the cycle as the error
    // it is; this question has no reason to recurse into it, and a walk that did
    // would take the whole test binary down with a stack overflow rather than
    // fail one assertion.
    // Named for THIS process, like every other temp path in the suite. A fixed name is shared
    // with whatever else is running, and the directory this test wipes on the way in is one
    // another run may be writing into: `five-ways.mjs` runs the suites together and this test
    // failed there with "write pack: NotFound" while passing on its own.
    let root = std::env::temp_dir().join(format!("tdc-packs-ring-{}", std::process::id()));
    let ring = root.join("ring");
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&ring).expect("temp packs");
    for (file, target) in [("one.tdc", "ring.two"), ("two.tdc", "ring.one")] {
        std::fs::write(
            ring.join(file),
            format!(
                "---\ngenerator: tdc\n---\n\
                 <sequence name=\"s\"><gen type=\"template\" value=\"{target}\"/></sequence>\n\
                 <data>${{{{s}}}}</data>\n"
            ),
        )
        .expect("write pack");
    }

    let packs = DataPacks::from_root(&root.display().to_string());
    assert!(!packs.needs_whole_column("ring.one", "en"));

    let _ = std::fs::remove_dir_all(&root);
}

/// Eight rows of one pack address, through the engine the router picks.
///
/// No `mode=`, because the routing IS the thing under test: the default is disk,
/// and a pack whose quota spans the column has to pull the run back to the
/// in-memory engine on its own.
fn render_pack(locale: &str, address: &str, count: usize) -> Vec<String> {
    let config = format!(
        "<tdc><env count=\"{count}\" seed=\"probe\" local=\"{locale}\">\
         <sequence name=\"P\"><gen type=\"template\" value=\"{address}\"/></sequence></env>\
         <block><line><data>${{{{P}}}}</data></line></block></tdc>"
    );
    let parsed = tdcv2::parser::parse(&config);
    assert!(parsed.ok(), "did not parse: {config}");
    let built = tdcv2::parser::config_builder::build(&parsed.tree, None).expect("builds");
    let text = tdcv2::engine::render(&built, 0).unwrap_or_else(|e| panic!("{e}\n  in: {config}"));
    text.lines().map(str::to_string).collect()
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

/// Which folder the packs come out of, before any config or command line adds
/// to it.
///
/// One rule in all five implementations: `TDCV2_PACKS`, then the source checkout
/// this build came from, then the starter set inside the artefact. What is worth
/// testing here is the middle one — it is the step that used to differ, and the
/// step that can capture the wrong folder if the marker is dropped.
mod discovery {
    use std::fs;
    use tdcv2::packs::source::source_checkout_packs;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        // No `tempfile` dependency: this crate has zero, on purpose. The test's
        // own name keeps two of them apart.
        let dir = std::env::temp_dir().join(format!("tdc-discovery-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn finds_the_repository_this_build_came_from() {
        let found = source_checkout_packs(std::path::Path::new(env!("CARGO_MANIFEST_DIR")));
        assert_eq!(
            found,
            Some(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("repo root")
                    .join("data")
                    .join("packs")
            )
        );
    }

    #[test]
    fn refuses_a_data_packs_that_is_not_this_repository() {
        // The point of the marker. Without it an unrelated `data/packs` above an
        // installed crate would answer, and the same config would then read
        // different data depending on where the user happened to install it.
        let root = temp_dir("stranger");
        fs::create_dir_all(root.join("data").join("packs").join("en")).expect("packs");
        let deep = root.join("project").join("deep");
        fs::create_dir_all(&deep).expect("deep");

        assert_eq!(source_checkout_packs(&deep), None);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn accepts_a_checkout_from_any_depth_below_it() {
        let root = temp_dir("checkout");
        fs::create_dir_all(root.join("data").join("packs")).expect("packs");
        fs::create_dir_all(root.join("fixtures").join("cross-language")).expect("marker");
        let deep = root.join("a").join("b").join("c");
        fs::create_dir_all(&deep).expect("deep");

        assert_eq!(
            source_checkout_packs(&deep),
            Some(root.join("data").join("packs"))
        );

        let _ = fs::remove_dir_all(&root);
    }
}
