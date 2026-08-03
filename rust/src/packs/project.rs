//! The `tdcv2.config.json` cascade: where a project keeps its packs and what
//! locale it writes in.
//!
//! Two files, low to high: a global one in the platform's own config folder, and
//! the nearest project one at or above a starting directory. The project
//! overrides the global; `dataPaths` accumulate rather than replace, because a
//! project adding a folder should not lose the machine's.
//!
//! The search starts from the CONFIG FILE's folder, not the shell's working
//! directory. A `.tdc` file belongs to the project it sits in, and running it
//! from one directory up must not quietly lose that project's packs.
//!
//! A config file that exists but cannot be read is an error, never silently
//! ignored: a typo in the one file that says where the data lives would
//! otherwise look exactly like having no packs installed.

use std::path::{Path, PathBuf};

use crate::engine::{invalid, EngineResult};
use crate::json::{self, Value};

pub const PROJECT_CONFIG_NAME: &str = "tdcv2.config.json";

/// What the cascade resolved to, plus the files that contributed, low to high.
#[derive(Clone, Debug, Default)]
pub struct Resolved {
    pub data_paths: Vec<String>,
    pub locale: Option<String>,
    pub pack_store: Option<String>,
    pub sources: Vec<String>,
}

/// The cascade, starting from a directory — usually the config file's own.
pub fn load(from: Option<&str>) -> EngineResult<Resolved> {
    let global = global_config_path().filter(|path| path.is_file());
    load_with(global.as_deref(), from)
}

/// The same, with the global level named outright.
///
/// The seam the tests use. [`global_config_path`] reads the environment, and a
/// test that set `XDG_CONFIG_HOME` to pin the cascade would be changing what
/// every other test in the same binary reads at the same moment — a race that
/// passes until the day it does not.
pub fn load_with(global: Option<&Path>, from: Option<&str>) -> EngineResult<Resolved> {
    let mut resolved = Resolved::default();

    if let Some(global) = global {
        if global.is_file() {
            merge(&mut resolved, global)?;
        }
    }
    if let Some(project) = find_project_config(from) {
        merge(&mut resolved, &project)?;
    }
    Ok(resolved)
}

/// The global config's location, following each platform's own convention.
///
/// The same places the CLI writes to, because a config only one of them can find
/// is worse than no config at all.
pub fn global_config_path() -> Option<PathBuf> {
    let home = std::env::var("HOME")
        .ok()
        .or_else(|| std::env::var("USERPROFILE").ok())
        .filter(|h| !h.trim().is_empty())?;

    if cfg!(windows) {
        let base = std::env::var("APPDATA")
            .ok()
            .filter(|a| !a.trim().is_empty())
            .map_or_else(
                || Path::new(&home).join("AppData").join("Roaming"),
                PathBuf::from,
            );
        return Some(base.join("tdcv2").join("config.json"));
    }

    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|x| !x.trim().is_empty())
        .map_or_else(|| Path::new(&home).join(".config"), PathBuf::from);
    Some(base.join("tdcv2").join("config.json"))
}

/// The nearest `tdcv2.config.json` at or above this directory.
pub fn find_project_config(from: Option<&str>) -> Option<PathBuf> {
    let start = match from {
        Some(dir) => PathBuf::from(dir),
        None => std::env::current_dir().ok()?,
    };
    let mut dir: Option<&Path> = Some(&start);
    while let Some(current) = dir {
        let candidate = current.join(PROJECT_CONFIG_NAME);
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = current.parent();
    }
    None
}

/// One file's contribution, folded onto whatever came before it.
fn merge(into: &mut Resolved, path: &Path) -> EngineResult<()> {
    let shown = path.display().to_string();
    let Ok(text) = std::fs::read_to_string(path) else {
        return invalid(&format!("config \"{shown}\": cannot be read"));
    };
    let Ok(root) = json::parse(&text) else {
        return invalid(&format!("config \"{shown}\": is not valid JSON"));
    };
    let Value::Object(_) = root else {
        return invalid(&format!("config \"{shown}\": must be a JSON object"));
    };
    // Relative paths in a config file are relative to that FILE, not to whoever
    // read it — the same config has to mean the same folder from any directory.
    let base = path.parent().unwrap_or(Path::new("."));

    match root.get("dataPaths") {
        None => {}
        Some(Value::Array(entries)) => {
            for entry in entries {
                match entry.as_str() {
                    Some(text) if !text.trim().is_empty() => {
                        into.data_paths.push(absolute(base, text));
                    }
                    _ => {
                        return invalid(&format!(
                            "config \"{shown}\": \"dataPaths\" entries must be non-empty strings"
                        ))
                    }
                }
            }
        }
        Some(_) => {
            return invalid(&format!(
                "config \"{shown}\": \"dataPaths\" must be an array of strings"
            ))
        }
    }

    // The later file wins on the scalars; a project saying `ru` overrides a
    // machine-wide `en`.
    if let Some(locale) = string_field(&root, "locale", &shown)? {
        into.locale = Some(locale);
    }
    if let Some(store) = string_field(&root, "packStore", &shown)? {
        into.pack_store = Some(absolute(base, &store));
    }
    into.sources.push(shown);
    Ok(())
}

/// Add pack roots to a config's `dataPaths`, creating the file if there is none.
///
/// Written relative when the path sits under the config's own folder, the way
/// every implementation writes them, so a checked-in config keeps working on
/// another machine. Existing settings are preserved and duplicates dropped.
///
/// Returns whether the file changed.
pub fn register(config_path: &Path, roots: &[String]) -> EngineResult<bool> {
    let dir = config_dir(config_path);
    let mut document = read_document(config_path)?;
    let mut entries = data_path_entries(&document);

    let mut added = false;
    for root in roots {
        // De-duped by RESOLVED path, so an entry written "./x" and the same
        // folder named absolutely do not both land in the file.
        let target = absolute(Path::new("."), root);
        if !entries.iter().any(|entry| absolute(&dir, entry) == target) {
            entries.push(storable(&dir, &target));
            added = true;
        }
    }

    put(&mut document, "dataPaths", array_of(&entries));
    write_document(config_path, &document)?;
    Ok(added)
}

/// The inverse: pack roots dropped from a config's `dataPaths`.
///
/// Matched by resolved path, so an entry written relative and one written
/// absolute both go. Removing a root does not remove data — a bundled pack
/// covering the same addresses simply resurfaces, being a lower-priority root.
pub fn unregister(config_path: &Path, roots: &[String]) -> EngineResult<bool> {
    if !config_path.is_file() {
        return Ok(false);
    }
    let dir = config_dir(config_path);
    let mut document = read_document(config_path)?;
    let entries = data_path_entries(&document);

    let targets: Vec<String> = roots
        .iter()
        .map(|root| absolute(Path::new("."), root))
        .collect();
    let kept: Vec<String> = entries
        .iter()
        .filter(|entry| !targets.contains(&absolute(&dir, entry)))
        .cloned()
        .collect();
    if kept.len() == entries.len() {
        return Ok(false);
    }

    put(&mut document, "dataPaths", array_of(&kept));
    write_document(config_path, &document)?;
    Ok(true)
}

/// Drop every `dataPaths` entry that points INSIDE `store`, keeping the store
/// itself and everything outside it. Returns how many went.
///
/// That is the per-bundle registration the old layout needed — a hundred of them
/// for a hundred bundles — and after the move to the flat store each one names a
/// folder that no longer exists.
pub fn remove_data_paths_inside(config_path: &Path, store: &Path) -> EngineResult<usize> {
    if !config_path.is_file() {
        return Ok(0);
    }
    let dir = config_dir(config_path);
    let mut document = read_document(config_path)?;
    let entries = data_path_entries(&document);

    let kept: Vec<String> = entries
        .iter()
        .filter(|entry| {
            let resolved = PathBuf::from(absolute(&dir, entry));
            is_same_path(&resolved, store) || !is_path_inside(&resolved, store)
        })
        .cloned()
        .collect();
    if kept.len() == entries.len() {
        return Ok(0);
    }

    put(&mut document, "dataPaths", array_of(&kept));
    write_document(config_path, &document)?;
    Ok(entries.len() - kept.len())
}

/// How `target` would be written down in this config — what `pack add` reports.
pub fn stored_path(config_path: &Path, target: &str) -> String {
    storable(&config_dir(config_path), &absolute(Path::new("."), target))
}

fn config_dir(config_path: &Path) -> PathBuf {
    PathBuf::from(normalize(config_path.parent().unwrap_or(Path::new("."))))
}

/// Relative when it sits under the config's folder; absolute when it does not.
///
/// The relative form keeps the leading `./`. It is the same path either way, but
/// a config is a file people read and diff across implementations, so "the same"
/// should also LOOK the same.
fn storable(dir: &Path, target: &str) -> String {
    let absolute = normalize(Path::new(target));
    let root = normalize(dir);
    if absolute == root {
        return ".".to_string();
    }
    let prefix = if root.ends_with(std::path::MAIN_SEPARATOR) {
        root
    } else {
        format!("{root}{}", std::path::MAIN_SEPARATOR)
    };
    match absolute.strip_prefix(&prefix) {
        Some(rest) => format!("./{}", rest.replace('\\', "/")),
        None => absolute,
    }
}

/// The config as it is written, or an empty one.
///
/// Kept WHOLE and rewritten in place: every key the file already had survives in
/// the order it was written, including keys this version knows nothing about.
/// Rebuilding the document from the three settings we happen to parse would
/// silently delete anything else a project put there.
fn read_document(path: &Path) -> EngineResult<Vec<(String, Value)>> {
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let shown = path.display().to_string();
    let Ok(text) = std::fs::read_to_string(path) else {
        return invalid(&format!("cannot read config \"{shown}\""));
    };
    match json::parse(&text) {
        Ok(Value::Object(entries)) => Ok(entries),
        Ok(_) => invalid(&format!("config \"{shown}\" must be a JSON object")),
        Err(e) => invalid(&format!("config \"{shown}\" is not valid JSON: {e}")),
    }
}

fn write_document(path: &Path, document: &[(String, Value)]) -> EngineResult<()> {
    let shown = path.display().to_string();
    if let Some(parent) = path.parent() {
        if std::fs::create_dir_all(parent).is_err() {
            return invalid(&format!("cannot create \"{}\"", parent.display()));
        }
    }
    let text = json::to_pretty(&Value::Object(document.to_vec()));
    match std::fs::write(path, text) {
        Ok(()) => Ok(()),
        Err(e) => invalid(&format!("cannot write config \"{shown}\": {e}")),
    }
}

/// The document's `dataPaths`, as strings — anything else in the array is dropped.
fn data_path_entries(document: &[(String, Value)]) -> Vec<String> {
    document
        .iter()
        .find(|(key, _)| key == "dataPaths")
        .and_then(|(_, value)| value.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn array_of(entries: &[String]) -> Value {
    Value::Array(entries.iter().cloned().map(Value::String).collect())
}

/// Replace a key in place, or append it — the order of everything else is the
/// file's.
fn put(document: &mut Vec<(String, Value)>, key: &str, value: Value) {
    match document.iter().position(|(k, _)| k == key) {
        Some(at) => document[at].1 = value,
        None => document.push((key.to_string(), value)),
    }
}

/// A scalar string setting: absent, or present and non-empty. Nothing in between.
fn string_field(root: &Value, key: &str, shown: &str) -> EngineResult<Option<String>> {
    match root.get(key) {
        None => Ok(None),
        Some(Value::String(text)) if !text.trim().is_empty() => Ok(Some(text.trim().to_string())),
        Some(_) => invalid(&format!(
            "config \"{shown}\": \"{key}\" must be a non-empty string"
        )),
    }
}

/// A path as written, resolved against the file it was written in.
///
/// Normalised lexically rather than by asking the filesystem: a root that does
/// not exist yet still has to compare equal to the same root written another
/// way, or `pack install` would add a duplicate entry every time it ran.
pub fn absolute(base: &Path, text: &str) -> String {
    let text = text.trim();
    let path = Path::new(text);
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        base.join(path)
    };
    normalize(&joined)
}

/// Whether `child` is `parent` itself, or sits somewhere under it.
///
/// This is the guard on every path that came from outside — an entry in a
/// downloaded archive, a path a hand-edited store record claims to own — so it
/// answers about what a path MEANS rather than about what is on disk: a store
/// nobody has created yet still has an inside, and a symlink is not consulted
/// about whether the archive that wrote it was honest.
pub fn is_path_inside(child: &Path, parent: &Path) -> bool {
    let child = resolved(child);
    let parent = resolved(parent);
    if child == parent {
        return true;
    }
    let separator = std::path::MAIN_SEPARATOR;
    let prefix = if parent.ends_with(separator) {
        parent
    } else {
        format!("{parent}{separator}")
    };
    child.starts_with(&prefix)
}

/// Whether two paths name the same place, `.` and `..` folded out of both.
pub fn is_same_path(one: &Path, other: &Path) -> bool {
    resolved(one) == resolved(other)
}

/// A path made absolute against the process's directory, then normalised.
fn resolved(path: &Path) -> String {
    if path.is_absolute() {
        return normalize(path);
    }
    match std::env::current_dir() {
        Ok(cwd) => normalize(&cwd.join(path)),
        Err(_) => normalize(path),
    }
}

/// `.` dropped and `..` cancelled against the segment before it.
pub fn normalize(path: &Path) -> String {
    use std::path::Component;

    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::CurDir => {}
            // Only when there is something to go up FROM: `/..` is `/`, and a
            // leading `..` on a relative path has to stay.
            Component::ParentDir => match out.components().next_back() {
                Some(Component::Normal(_)) => {
                    out.pop();
                }
                Some(Component::RootDir | Component::Prefix(_)) => {}
                _ => out.push(".."),
            },
            other => out.push(other.as_os_str()),
        }
    }
    out.to_string_lossy().to_string()
}
