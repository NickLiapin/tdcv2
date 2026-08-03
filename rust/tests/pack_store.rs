//! The pack store's books, and moving a store an older tdcv2 wrote.
//!
//! Everything here runs off a temporary folder: the decisions the store makes —
//! what a bundle owns, what the record may claim, what a migration would move —
//! are the half of `tdcv2 pack` that has nothing to do with the wire, and they
//! are the half that can quietly delete somebody's data if they are wrong.
//!
//! The cases are the reference's, ported one for one, so a disagreement between
//! two implementations shows up as the same test failing in both.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};

use tdcv2::packs::project;
use tdcv2::packs::store::{
    self, InstalledBundle, InstalledRecord, INSTALLED_FILE, INSTALLED_SCHEMA_VERSION,
};

/// A throwaway directory. A counter rather than a random name: the tests run in
/// parallel threads of one process, and a random name is not what makes them
/// distinct.
fn tmp() -> PathBuf {
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "tdcv2-store-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("the temp dir is writable");
    dir
}

/// Write a file, creating its folders.
fn put(path: &Path, body: &str) {
    std::fs::create_dir_all(path.parent().expect("a file has a parent"))
        .expect("the temp dir is writable");
    std::fs::write(path, body).expect("the temp dir is writable");
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{} : {e}", path.display()))
}

fn owned(files: &[&str]) -> Vec<String> {
    store::bundle_owned_paths(&files.iter().map(|f| (*f).to_string()).collect::<Vec<_>>())
}

fn entry(id: &str, paths: &[&str]) -> InstalledBundle {
    InstalledBundle {
        id: id.to_string(),
        paths: paths.iter().map(|p| (*p).to_string()).collect(),
        version: String::new(),
        sha256: "aa".to_string(),
        files: 2,
    }
}

// ── what a bundle owns ───────────────────────────────────────────────────────

#[test]
fn a_bundle_claims_the_one_subtree_it_fills() {
    assert_eq!(
        owned(&["ru/person/lastName.txt", "ru/city/name.txt"]),
        ["ru"]
    );
}

#[test]
fn a_country_bundle_claims_the_country_never_the_shared_folder_above_it() {
    assert_eq!(
        owned(&[
            "countries/russia/docs/inn.txt",
            "countries/russia/tax/x.txt"
        ]),
        ["countries/russia"]
    );
}

#[test]
fn files_that_share_no_parent_claim_each_top_level_entry() {
    assert_eq!(
        owned(&["en/a.txt", "countries/usa/b.txt"]),
        ["countries", "en"]
    );
}

#[test]
fn a_lone_file_at_the_root_is_claimed_as_itself() {
    assert_eq!(owned(&["loose.txt"]), ["loose.txt"]);
}

#[test]
fn a_bundle_claims_no_more_than_it_actually_fills() {
    // A one-file country stub owns the folder holding that file, not the whole
    // country — the answer follows the files, so removal can never take more
    // than the bundle brought.
    assert_eq!(
        owned(&["countries/andorra/docs/nid.txt"]),
        ["countries/andorra/docs"]
    );
}

#[test]
fn no_files_claim_nothing() {
    assert!(owned(&[]).is_empty());
}

// ── the record ───────────────────────────────────────────────────────────────

#[test]
fn a_missing_store_has_nothing_installed() {
    assert!(store::installed_bundle_ids(&tmp().join("nope"))
        .expect("a missing store is not an error")
        .is_empty());
}

#[test]
fn the_record_round_trips_through_the_dotfile_with_ids_sorted() {
    let dir = tmp();
    store::write_installed(
        &dir,
        &InstalledRecord {
            schema_version: 1,
            bundles: vec![entry("usa", &["countries/usa"]), entry("en", &["en"])],
        },
    )
    .expect("the temp dir is writable");

    assert_eq!(
        store::installed_bundle_ids(&dir).expect("readable"),
        ["en", "usa"]
    );
    assert_eq!(
        store::read_installed(&dir).expect("readable").bundles[0].paths,
        ["en"]
    );
    // The name matters: the store is a scan root, and the loader skips ignored
    // NAMES, so anything without a leading dot here would load as a pack.
    assert!(INSTALLED_FILE.starts_with('.'));
    assert!(read(&dir.join(INSTALLED_FILE)).ends_with('\n'));
}

#[test]
fn the_record_is_written_to_the_byte_five_implementations_agreed_on() {
    let dir = tmp();
    store::write_installed(
        &dir,
        &InstalledRecord {
            schema_version: INSTALLED_SCHEMA_VERSION,
            bundles: vec![InstalledBundle {
                id: "demo".to_string(),
                paths: vec!["demo/person".to_string()],
                version: String::new(),
                sha256: String::new(),
                files: 1,
            }],
        },
    )
    .expect("the temp dir is writable");

    // Two-space indent, a trailing newline, and the key order `id, paths,
    // version, sha256, files`. The shared CLI fixture compares this file, so a
    // reordered key here is a failing case in the other four.
    assert_eq!(
        read(&dir.join(INSTALLED_FILE)),
        "{\n  \"schemaVersion\": 1,\n  \"bundles\": [\n    {\n      \"id\": \"demo\",\n      \
         \"paths\": [\n        \"demo/person\"\n      ],\n      \"version\": \"\",\n      \
         \"sha256\": \"\",\n      \"files\": 1\n    }\n  ]\n}\n"
    );
}

#[test]
fn a_tree_nobody_recorded_is_not_installed() {
    let dir = tmp();
    std::fs::create_dir_all(dir.join("en/person")).expect("the temp dir is writable");
    assert!(store::installed_bundle_ids(&dir)
        .expect("readable")
        .is_empty());
}

#[test]
fn a_record_claiming_a_path_outside_the_store_is_refused() {
    let dir = tmp();
    put(
        &dir.join(INSTALLED_FILE),
        "{\"schemaVersion\":1,\"bundles\":[{\"id\":\"evil\",\"paths\":[\"../../etc\"]}]}",
    );
    let said = store::read_installed(&dir)
        .expect_err("a path outside the store")
        .0;
    assert!(said.contains("outside the store"), "{said}");
}

#[test]
fn a_malformed_record_is_an_error_rather_than_an_empty_store() {
    // An empty store would make `pack remove` say there is nothing to delete
    // while the files sit there.
    let dir = tmp();
    put(&dir.join(INSTALLED_FILE), "{ not json");
    let said = store::read_installed(&dir).expect_err("malformed JSON").0;
    assert!(said.contains("is not valid JSON"), "{said}");
    assert!(
        said.contains("Delete it and re-add your bundles."),
        "{said}"
    );
}

#[test]
fn a_record_from_a_newer_tdcv2_is_refused() {
    let dir = tmp();
    put(
        &dir.join(INSTALLED_FILE),
        "{\"schemaVersion\":2,\"bundles\":[]}",
    );
    let said = store::read_installed(&dir).expect_err("a newer schema").0;
    assert!(said.contains("was written by a newer tdcv2"), "{said}");
    assert!(said.contains("(schemaVersion 2)"), "{said}");
}

#[test]
fn with_bundle_replaces_the_same_id_and_without_bundle_drops_it() {
    let one = store::with_bundle(InstalledRecord::default(), entry("en", &["en"]));
    let again = store::with_bundle(
        one,
        InstalledBundle {
            files: 9,
            ..entry("en", &["en"])
        },
    );
    assert_eq!(again.bundles.len(), 1);
    assert_eq!(again.bundles[0].files, 9);
    assert!(store::without_bundle(again, "en").bundles.is_empty());
}

#[test]
fn a_bundle_may_not_write_into_a_path_another_one_owns() {
    let record = store::with_bundle(InstalledRecord::default(), entry("ru", &["ru"]));
    let said = store::assert_no_overlap("other", &["ru/person".to_string()], &record)
        .expect_err("an overlap")
        .0;
    assert!(said.contains("which \"ru\" already owns"), "{said}");
    assert!(said.contains("remove \"ru\" first"), "{said}");

    // Re-installing the SAME id is how a bundle is replaced, not an overlap.
    store::assert_no_overlap("ru", &["ru".to_string()], &record).expect("its own paths");
}

// ── paths ────────────────────────────────────────────────────────────────────

#[test]
fn a_nested_path_and_the_root_itself_are_inside_it() {
    assert!(project::is_path_inside(
        Path::new("/a/b/c"),
        Path::new("/a/b")
    ));
    assert!(project::is_path_inside(
        Path::new("/a/b"),
        Path::new("/a/b")
    ));
}

#[test]
fn an_escaping_path_is_not_inside_the_root() {
    assert!(!project::is_path_inside(
        Path::new("/a/b/../../etc/passwd"),
        Path::new("/a/b")
    ));
    assert!(!project::is_path_inside(
        Path::new("/other"),
        Path::new("/a/b")
    ));
}

// ── the config ───────────────────────────────────────────────────────────────

#[test]
fn the_per_bundle_entries_go_and_the_store_and_everything_outside_it_stay() {
    let dir = tmp();
    let config = dir.join("tdcv2.config.json");
    put(
        &config,
        "{\n  \"packStore\": \"./p\",\n  \"dataPaths\": [\"./p/en/packs\", \"./p/usa/packs\", \
         \"./p\", \"./my-own-lists\"]\n}\n",
    );

    assert_eq!(
        project::remove_data_paths_inside(&config, &dir.join("p")).expect("writable"),
        2
    );
    let after = read(&config);
    assert!(after.contains("\"./p\""), "{after}");
    assert!(after.contains("\"./my-own-lists\""), "{after}");
    assert!(!after.contains("/packs"), "{after}");
    // Nothing left to drop the second time.
    assert_eq!(
        project::remove_data_paths_inside(&config, &dir.join("p")).expect("writable"),
        0
    );
}

// ── migrating a store an older tdcv2 wrote ───────────────────────────────────

struct OldProject {
    dir: PathBuf,
    config: PathBuf,
    store: PathBuf,
}

/// A project as the old `pack add ru russia` left it: two bundle folders, each
/// with its own `packs/` root, and two `dataPaths` entries pointing inside them.
fn old_project(extra: &[(&str, &str)]) -> OldProject {
    let dir = tmp();
    let store = dir.join("tdcv2-packs");
    let config = dir.join("tdcv2.config.json");

    put(
        &store.join("ru/packs/ru/person/lastName.txt"),
        "---\nlocale: ru\n---\nИванов\n",
    );
    put(
        &store.join("ru/packs/ru/city/name.txt"),
        "---\nlocale: ru\n---\nОмск\n",
    );
    put(
        &store.join("ru/packs/ru/_locale.json"),
        "{\"code\":\"ru\"}\n",
    );
    put(
        &store.join("russia/packs/countries/russia/docs/inn.txt"),
        "---\naddress: russia.docs.inn\n---\n7707083893\n",
    );
    put(
        &store.join("russia/packs/countries/russia/bank/bic.txt"),
        "---\naddress: russia.bank.bic\n---\n044525225\n",
    );
    for (path, body) in extra {
        put(&store.join(path), body);
    }
    put(
        &config,
        "{\n  \"packStore\": \"./tdcv2-packs\",\n  \"locale\": \"ru\",\n  \"dataPaths\": [\n    \
         \"./tdcv2-packs/ru/packs\",\n    \"./tdcv2-packs/russia/packs\"\n  ],\n  \
         \"keepThis\": true\n}\n",
    );
    OldProject { dir, config, store }
}

#[test]
fn the_old_layout_is_recognised_and_a_flat_store_is_left_alone() {
    let old = old_project(&[]);
    assert_eq!(store::legacy_bundle_ids(&old.store), ["ru", "russia"]);

    let flat = tmp();
    std::fs::create_dir_all(flat.join("ru")).expect("the temp dir is writable");
    assert!(store::legacy_bundle_ids(&flat).is_empty());
}

#[test]
fn each_tree_moves_up_is_recorded_and_leaves_one_data_path() {
    let old = old_project(&[]);
    let migration = store::migrate_store(&old.store, &old.config)
        .expect("nothing collides")
        .expect("there was something to move");

    // On disk: the address path and nothing above it.
    assert!(read(&old.store.join("ru/person/lastName.txt")).contains("Иванов"));
    assert!(old.store.join("ru/_locale.json").is_file()); // travels with its locale
    assert!(old.store.join("countries/russia/docs/inn.txt").is_file());
    assert!(!old.store.join("ru/packs").exists());
    assert!(!old.store.join("russia").exists());

    // In the books: who owns what.
    let record = store::read_installed(&old.store).expect("readable");
    let owns: Vec<(String, Vec<String>)> = record
        .bundles
        .iter()
        .map(|b| (b.id.clone(), b.paths.clone()))
        .collect();
    assert_eq!(
        owns,
        vec![
            ("ru".to_string(), vec!["ru".to_string()]),
            ("russia".to_string(), vec!["countries/russia".to_string()]),
        ]
    );
    // Nothing to claim about an archive nobody kept.
    assert_eq!(record.bundles[0].sha256, "");
    assert_eq!(record.bundles[0].version, "");
    assert_eq!(record.bundles[0].files, 3);

    // In the config: two per-bundle entries out, the store in, everything else kept.
    let config = read(&old.config);
    assert!(
        config.contains("\"dataPaths\": [\n    \"./tdcv2-packs\"\n  ]"),
        "{config}"
    );
    assert!(config.contains("\"keepThis\": true"), "{config}");
    assert!(config.contains("\"locale\": \"ru\""), "{config}");
    assert_eq!(migration.dropped_data_paths, 2);
    assert_eq!(migration.registered.as_deref(), Some("./tdcv2-packs"));
}

#[test]
fn migrating_a_second_time_does_nothing_at_all() {
    let old = old_project(&[]);
    store::migrate_store(&old.store, &old.config).expect("nothing collides");
    assert!(store::migrate_store(&old.store, &old.config)
        .expect("nothing collides")
        .is_none());
}

#[test]
fn files_that_were_never_pack_data_stay_where_they_are_and_are_named() {
    let old = old_project(&[("ru/sources/lastName.csv", "Иванов,100\n")]);
    let migration = store::migrate_store(&old.store, &old.config)
        .expect("nothing collides")
        .expect("there was something to move");

    assert_eq!(migration.leftovers, ["ru/sources/lastName.csv"]);
    assert!(old.store.join("ru/sources/lastName.csv").is_file());
    assert!(old.store.join("ru/person/lastName.txt").is_file());
}

#[test]
fn a_taken_destination_refuses_the_whole_migration_having_moved_nothing() {
    let old = old_project(&[]);
    // Something already sits where `ru` has to land.
    put(&old.store.join("ru/person/lastName.txt"), "somebody else\n");

    let said = store::migrate_store(&old.store, &old.config)
        .expect_err("a collision")
        .0;
    assert!(said.contains("path(s) collide"), "{said}");
    assert!(said.contains("Nothing was moved."), "{said}");

    // The old tree is untouched, so the user can look and decide.
    assert!(old.store.join("ru/packs/ru/person/lastName.txt").is_file());
    assert_eq!(
        read(&old.store.join("ru/person/lastName.txt")),
        "somebody else\n"
    );
    let config = read(&old.config);
    assert!(config.contains("./tdcv2-packs/ru/packs"), "{config}");
    assert!(config.contains("./tdcv2-packs/russia/packs"), "{config}");
}

#[test]
fn the_first_pack_command_migrates_before_it_does_anything_else() {
    let old = old_project(&[]);
    let mut stdout: Vec<u8> = Vec::new();
    let mut stderr: Vec<u8> = Vec::new();

    let exit = tdcv2::cli::pack::run(
        &["remove".to_string(), "russia".to_string()],
        &old.dir.to_string_lossy(),
        &mut stdout,
        &mut stderr,
    )
    .expect("the CLI could write its output");
    assert_eq!(exit, 0);

    let said = String::from_utf8(stderr).expect("stderr is UTF-8");
    // On stderr: `pack list` prints a catalogue people pipe, and a one-off
    // notice about the store is not part of it.
    assert!(said.contains("used the old per-bundle layout"), "{said}");
    assert!(said.contains("ru: ru/packs → ru (3 files)"), "{said}");
    assert!(
        said.contains("dropped 2 per-bundle dataPaths entries"),
        "{said}"
    );
    assert!(said.contains("registered ./tdcv2-packs instead"), "{said}");

    // And the removal that followed acted on the migrated store.
    assert!(!old.store.join("countries").exists());
    assert!(old.store.join("ru/person/lastName.txt").is_file());
    assert_eq!(
        store::installed_bundle_ids(&old.store).expect("readable"),
        ["ru"]
    );
    let config = read(&old.config);
    assert!(
        config.contains("\"dataPaths\": [\n    \"./tdcv2-packs\"\n  ]"),
        "{config}"
    );
}
