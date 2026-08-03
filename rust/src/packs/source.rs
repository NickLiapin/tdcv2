//! Where pack files come from.
//!
//! A folder on disk, or several searched in order. That is how this
//! repository's tests read the same packs the other implementations read, and
//! how a project adds its own — a pack downloaded into a project belongs to the
//! project, not to whichever runtime happens to read it.

use std::path::{Path, PathBuf};

/// Whether a directory entry is repository noise rather than a pack.
///
/// The reference ignores a file's extension entirely when it turns a path into
/// an address, so a name is the only thing that can keep a locale manifest, a
/// README or a `.DS_Store` out of the registry — and this is the same short list
/// `load.ts` keeps. Everything else is data, whatever it is called.
pub fn is_ignored_entry(name: &str) -> bool {
    if name == "_locale.json" || name.starts_with('.') {
        return true;
    }
    let stem = match name.rfind('.') {
        Some(dot) if dot > 0 => &name[..dot],
        _ => name,
    };
    matches!(
        stem.to_lowercase().as_str(),
        "readme" | "license" | "changelog"
    )
}

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

    /// Where a file physically is, for a complaint that has to name it.
    ///
    /// A relative path is ambiguous the moment two roots are layered, and "which
    /// file did you mean" is the one thing such a message must not leave open.
    /// Packs compiled into the binary have no path at all, which is why this can
    /// answer nothing.
    fn locate(&self, _relative_path: &str) -> Option<String> {
        None
    }

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
                if is_ignored_entry(&name) {
                    continue;
                }
                let relative = if prefix.is_empty() {
                    name.clone()
                } else {
                    format!("{prefix}/{name}")
                };
                if entry.path().is_dir() {
                    walk(&entry.path(), &relative, out);
                } else {
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

    fn locate(&self, relative_path: &str) -> Option<String> {
        let path = self.resolve(relative_path);
        path.is_file().then(|| path.display().to_string())
    }

    fn describe(&self) -> String {
        self.root.display().to_string()
    }
}

/// The starter packs compiled into the binary.
///
/// A published crate is a tarball with nothing above it, so walking up from
/// `CARGO_MANIFEST_DIR` — which is how [`discover_root`] finds the repository's
/// `data/packs` — cannot work in `~/.cargo/registry`. Embedding is the only
/// shape that survives `cargo install`: the files are read by `include_str!` at
/// compile time, so the program needs nothing beside it at run time.
///
/// Empty in a checkout, where the real `data/packs` is on disk and reading it
/// from there is what keeps all five implementations looking at the same bytes.
/// [`is_empty`](Self::is_empty) is how a caller tells the two apart.
#[derive(Debug)]
pub struct EmbeddedSource;

impl EmbeddedSource {
    pub fn new() -> Self {
        Self
    }

    /// Whether anything was embedded — false in a checkout.
    ///
    /// Clippy sees a `const` empty slice and calls this always true, which it is
    /// — in a CHECKOUT. `bundle-packs.mjs add` rewrites the table before the
    /// crate is packaged, and in the published crate the same expression is
    /// always false. That is the one fact about this file worth keeping.
    #[allow(clippy::const_is_empty)]
    pub fn is_empty() -> bool {
        super::bundled_files::FILES.is_empty()
    }

    fn find(relative_path: &str) -> Option<&'static str> {
        super::bundled_files::FILES
            .iter()
            .find(|(path, _)| *path == relative_path)
            .map(|(_, text)| *text)
    }
}

impl Default for EmbeddedSource {
    fn default() -> Self {
        Self::new()
    }
}

impl PackSource for EmbeddedSource {
    fn has(&self, relative_path: &str) -> bool {
        Self::find(relative_path).is_some()
    }

    fn read_lines(&self, relative_path: &str) -> Option<Vec<String>> {
        // Split the same way DirectorySource does, so an embedded pack and a
        // pack on disk give the identical list of values — including the
        // trailing-newline and \r\n rules the other four implementations follow.
        Some(Self::find(relative_path)?.lines().map(str::to_string).collect())
    }

    fn list_files(&self) -> Vec<String> {
        let mut out: Vec<String> = super::bundled_files::FILES
            .iter()
            .map(|(path, _)| (*path).to_string())
            .collect();
        out.sort();
        out
    }

    fn has_top_level(&self, name: &str) -> bool {
        let prefix = format!("{name}/");
        super::bundled_files::FILES
            .iter()
            .any(|(path, _)| path.starts_with(&prefix))
    }

    fn has_country(&self, name: &str) -> bool {
        let prefix = format!("countries/{name}/");
        super::bundled_files::FILES
            .iter()
            .any(|(path, _)| path.starts_with(&prefix))
    }

    fn describe(&self) -> String {
        format!("the {} packs built into this binary", super::bundled_files::FILES.len())
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

    fn locate(&self, relative_path: &str) -> Option<String> {
        self.owning(relative_path)?.locate(relative_path)
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
