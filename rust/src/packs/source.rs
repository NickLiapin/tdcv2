//! Where pack files come from.
//!
//! A folder on disk, or several searched in order. That is how this
//! repository's tests read the same packs the other implementations read, and
//! how a project adds its own — a pack downloaded into a project belongs to the
//! project, not to whichever runtime happens to read it.

use std::path::{Path, PathBuf};

pub trait PackSource: std::fmt::Debug {
    /// Whether a pack exists at this path, e.g. `en/person/lastName.txt`.
    fn has(&self, relative_path: &str) -> bool;

    fn read_lines(&self, relative_path: &str) -> Option<Vec<String>>;

    /// Whether a top-level folder by this name exists — `en`, `usa`, `common`.
    ///
    /// This is how a dotted address is judged absolute or relative: `usa.ssn`
    /// names a country pack directly, while `person.lastName` is relative to the
    /// active locale.
    /// Every pack file this source can serve, as relative paths.
    ///
    /// The address index is built from this: a file's header may place it at an
    /// address that has nothing to do with its path, and the only way to know is
    /// to look inside every file.
    fn list_files(&self) -> Vec<String>;

    fn has_top_level(&self, name: &str) -> bool;

    /// Whether `countries/<name>` exists.
    ///
    /// The `countries/` folder is a physical grouping, not part of an address: a
    /// pack at `countries/usa/finance/aba_routing.txt` is addressed as
    /// `usa.finance.aba_routing`. Without this, every country pack would look
    /// like a relative address and be searched for under the active locale,
    /// where it is not.
    fn has_country(&self, name: &str) -> bool;

    fn describe(&self) -> String;
}

/// One folder of packs.
#[derive(Debug)]
pub struct DirectorySource {
    root: PathBuf,
}

impl DirectorySource {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn resolve(&self, relative_path: &str) -> PathBuf {
        let mut path = self.root.clone();
        for segment in relative_path.split('/') {
            path.push(segment);
        }
        path
    }
}

impl PackSource for DirectorySource {
    fn has(&self, relative_path: &str) -> bool {
        self.resolve(relative_path).is_file()
    }

    fn read_lines(&self, relative_path: &str) -> Option<Vec<String>> {
        let text = std::fs::read_to_string(self.resolve(relative_path)).ok()?;
        // `lines()` drops a trailing newline and splits on \n, treating \r\n as
        // a line too — the same shape `File.ReadAllLines` gives the other four.
        Some(text.lines().map(str::to_string).collect())
    }

    fn list_files(&self) -> Vec<String> {
        fn walk(dir: &std::path::Path, prefix: &str, out: &mut Vec<String>) {
            let Ok(entries) = std::fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let relative = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if entry.path().is_dir() {
                    walk(&entry.path(), &relative, out);
                } else if relative.ends_with(".txt") {
                    out.push(relative);
                }
            }
        }
        let mut out = Vec::new();
        walk(&self.root, "", &mut out);
        out.sort();
        out
    }

    fn has_top_level(&self, name: &str) -> bool {
        self.root.join(name).is_dir()
    }

    fn has_country(&self, name: &str) -> bool {
        self.root.join("countries").join(name).is_dir()
    }

    fn describe(&self) -> String {
        self.root.display().to_string()
    }
}

/// Several sources searched in order, the last one winning.
///
/// This is what lets a project's own packs shadow the bundled ones without
/// replacing them: a downloaded or hand-written pack at the same address is
/// found first, and everything else still resolves. The order is low priority to
/// high, so the search runs backwards.
#[derive(Debug)]
pub struct LayeredSource {
    sources: Vec<Box<dyn PackSource + Send + Sync>>,
}

impl LayeredSource {
    pub fn new(sources: Vec<Box<dyn PackSource + Send + Sync>>) -> Self {
        Self { sources }
    }

    fn owning(&self, relative_path: &str) -> Option<&(dyn PackSource + Send + Sync)> {
        self.sources
            .iter()
            .rev()
            .find(|s| s.has(relative_path))
            .map(AsRef::as_ref)
    }
}

impl PackSource for LayeredSource {
    fn has(&self, relative_path: &str) -> bool {
        self.owning(relative_path).is_some()
    }

    fn read_lines(&self, relative_path: &str) -> Option<Vec<String>> {
        self.owning(relative_path)?.read_lines(relative_path)
    }

    fn list_files(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for source in &self.sources {
            for path in source.list_files() {
                if !out.contains(&path) {
                    out.push(path);
                }
            }
        }
        out
    }

    fn has_top_level(&self, name: &str) -> bool {
        self.sources.iter().any(|s| s.has_top_level(name))
    }

    fn has_country(&self, name: &str) -> bool {
        self.sources.iter().any(|s| s.has_country(name))
    }

    fn describe(&self) -> String {
        self.sources
            .iter()
            .map(|s| s.describe())
            .collect::<Vec<_>>()
            .join(", ")
    }
}

/// The repository's own `data/packs`, found by walking upward.
///
/// The walk is what lets the tests here read the very same files the other four
/// implementations read, rather than a copy that could drift from them.
pub fn discover_root() -> Option<PathBuf> {
    if let Ok(from_env) = std::env::var("TDCV2_PACKS") {
        let path = PathBuf::from(&from_env);
        if path.is_dir() {
            return Some(path);
        }
    }

    let mut dir: Option<&Path> = Some(Path::new(env!("CARGO_MANIFEST_DIR")));
    while let Some(current) = dir {
        let candidate = current.join("data").join("packs");
        if candidate.is_dir() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}
