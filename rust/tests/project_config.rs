//! `tdcv2.config.json`: where a project says its packs live.
//!
//! The cascade is what lets a pack downloaded by any one of the five
//! implementations be found by the other four. Getting it wrong is a
//! portability bug of the worst kind — nothing is wrong with the config, only
//! with which runtime was asked to run it — so the rules are pinned here rather
//! than left to the one caller that happens to exercise them.

use std::path::{Path, PathBuf};

use tdcv2::packs::project;

/// A throwaway directory tree, removed when the test ends.
struct Sandbox(PathBuf);

impl Sandbox {
    fn new(name: &str) -> Sandbox {
        let dir = std::env::temp_dir().join(format!("tdcv2-project-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("the temp dir is writable");
        Sandbox(dir)
    }

    fn write(&self, relative: &str, contents: &str) -> PathBuf {
        let path = self.0.join(relative);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("writable");
        }
        std::fs::write(&path, contents).expect("writable");
        path
    }

    fn dir(&self, relative: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(&path).expect("writable");
        path
    }

    fn at(&self, relative: &str) -> String {
        self.0.join(relative).to_string_lossy().into_owned()
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// The cascade with no global level, so a test says what it means whether or not
/// the machine running it has a config of its own.
fn load(sandbox: &Sandbox, from: &str) -> project::Resolved {
    project::load_with(None, Some(&sandbox.at(from))).expect("a valid config")
}

#[test]
fn the_nearest_config_at_or_above_a_directory_is_the_one_that_counts() {
    let sandbox = Sandbox::new("nearest");
    sandbox.write("tdcv2.config.json", "{}");
    let deep = sandbox.dir("a/b/c");

    let found =
        project::find_project_config(Some(&deep.to_string_lossy())).expect("the config above it");
    assert_eq!(found, sandbox.0.join("tdcv2.config.json"));

    // And the nearer one wins when there are two.
    let nearer = sandbox.write("a/tdcv2.config.json", "{}");
    assert_eq!(
        project::find_project_config(Some(&deep.to_string_lossy())),
        Some(nearer)
    );
}

#[test]
fn a_relative_path_is_relative_to_the_file_that_wrote_it() {
    // Not to whoever read it: the same config has to mean the same folder from
    // any directory, or a run would find its packs from one shell and not from
    // another.
    let sandbox = Sandbox::new("relative");
    sandbox.write(
        "project/tdcv2.config.json",
        r#"{"dataPaths": ["./packs", "../shared"]}"#,
    );

    let resolved = load(&sandbox, "project");
    assert_eq!(
        resolved.data_paths,
        vec![sandbox.at("project/packs"), sandbox.at("shared")],
        "`.` should be dropped and `..` cancelled, not carried into the path"
    );
}

#[test]
fn an_absolute_path_is_left_alone() {
    let sandbox = Sandbox::new("absolute");
    let elsewhere = sandbox.dir("elsewhere");
    sandbox.write(
        "tdcv2.config.json",
        &format!(
            r#"{{"dataPaths": [{}]}}"#,
            serde_like_string(&elsewhere.to_string_lossy())
        ),
    );

    let resolved = load(&sandbox, "");
    assert_eq!(resolved.data_paths, vec![elsewhere.to_string_lossy()]);
}

#[test]
fn a_config_that_cannot_be_used_is_refused_rather_than_ignored() {
    // A typo in the one file that says where the data lives would otherwise look
    // exactly like having no packs installed — the same symptom, a completely
    // different fix.
    for (name, contents, expected) in [
        ("not-json", "{ nope", "is not valid JSON"),
        ("not-object", "[1, 2]", "must be a JSON object"),
        (
            "paths-not-array",
            r#"{"dataPaths": "packs"}"#,
            "must be an array of strings",
        ),
        (
            "path-blank",
            r#"{"dataPaths": ["  "]}"#,
            "must be non-empty strings",
        ),
        (
            "locale-not-string",
            r#"{"locale": 5}"#,
            "must be a non-empty string",
        ),
        (
            "locale-blank",
            r#"{"locale": ""}"#,
            "must be a non-empty string",
        ),
    ] {
        let sandbox = Sandbox::new(name);
        sandbox.write("tdcv2.config.json", contents);

        let error = project::load_with(None, Some(&sandbox.at("")))
            .expect_err(&format!("{name} should be refused"));
        assert!(
            error.message().contains(expected),
            "{name}: {error} does not mention {expected:?}"
        );
        // And it names the file, because a message about "the config" is no help
        // when a cascade has two of them.
        assert!(error.message().contains("tdcv2.config.json"), "{name}");
    }
}

#[test]
fn a_scalar_is_taken_from_the_highest_level_that_set_one() {
    let sandbox = Sandbox::new("cascade");
    let global = sandbox.write(
        "machine/config.json",
        r#"{"locale": "en", "packStore": "./store", "dataPaths": ["./machine"]}"#,
    );
    sandbox.write(
        "project/tdcv2.config.json",
        r#"{"locale": "ru", "dataPaths": ["./project"]}"#,
    );

    let resolved =
        project::load_with(Some(&global), Some(&sandbox.at("project"))).expect("a valid cascade");

    assert_eq!(resolved.locale.as_deref(), Some("ru"), "the project wins");
    // A scalar the project did not set keeps the machine's value rather than
    // being cleared by the higher level.
    assert_eq!(
        resolved.pack_store.as_deref(),
        Some(&*sandbox.at("machine/store"))
    );
    // Paths accumulate rather than replace: a project adding a folder should not
    // lose the machine's.
    assert_eq!(
        resolved.data_paths,
        vec![sandbox.at("machine/machine"), sandbox.at("project/project")]
    );
    assert_eq!(
        resolved.sources,
        vec![
            global.to_string_lossy().into_owned(),
            sandbox.at("project/tdcv2.config.json")
        ],
        "low to high"
    );
}

#[test]
fn no_config_anywhere_is_an_empty_answer_not_a_failure() {
    // A run with no project file is the ordinary case, not an error.
    let sandbox = Sandbox::new("none");
    sandbox.dir("a/b");
    let resolved = load(&sandbox, "a/b");
    assert!(resolved.data_paths.is_empty());
    assert!(resolved.locale.is_none());
    assert!(resolved.pack_store.is_none());
    assert!(resolved.sources.is_empty());
}

#[test]
fn the_global_config_follows_the_platforms_own_convention() {
    // The same place the CLI writes to: a config only one of them can find is
    // worse than no config at all.
    let path = project::global_config_path().expect("a home directory");
    let shown = path.to_string_lossy();
    assert!(shown.ends_with("tdcv2/config.json") || shown.ends_with("tdcv2\\config.json"));
    if cfg!(not(windows)) {
        assert!(shown.contains(".config/") || std::env::var("XDG_CONFIG_HOME").is_ok());
    }
}

#[test]
fn a_path_is_normalised_so_the_same_folder_written_two_ways_compares_equal() {
    let base = Path::new("/tmp/project");
    assert_eq!(project::absolute(base, "./packs"), "/tmp/project/packs");
    assert_eq!(
        project::absolute(base, "packs/../packs"),
        "/tmp/project/packs"
    );
    assert_eq!(project::absolute(base, "../packs"), "/tmp/packs");
    assert_eq!(project::absolute(base, "  ./packs  "), "/tmp/project/packs");
    // Going up past the root stays at the root rather than growing `..`.
    assert_eq!(project::absolute(Path::new("/"), "../.."), "/");
}

/// The one string this test file has to embed in JSON, escaped.
fn serde_like_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}
