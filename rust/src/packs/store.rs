//! The pack store: one flat tree, and the books that say who owns what in it.
//!
//! Bundles are axis-pure — one language (`ru`), or one country (`russia`), or
//! `common` — because language and country are independent dimensions that
//! compose (Russian in Russia = common + ru + russia). They all unpack into ONE
//! tree, at the address path and nothing above it:
//!
//! ```text
//! <store>/.tdcv2-installed.json
//! <store>/common/…
//! <store>/ru/…
//! <store>/countries/russia/…
//! ```
//!
//! The address path is the only level that has to exist, so it is the only level
//! there is. The store is a single scan root, registered in `dataPaths` once,
//! however many bundles go into it — the layout it replaced gave ten languages
//! and a hundred countries three near-duplicate levels and a hundred data roots.
//!
//! What it costs is that a bundle is no longer identifiable by a folder named
//! after it, and that is what this module's bookkeeping file is for: it records
//! the paths each bundle owns, so `pack remove` deletes exactly those and
//! `pack list` knows what is installed. Everything here is decided without
//! touching the wire — the network lives in `registry.rs` — which is what lets
//! the whole layout be tested from a temporary folder.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::archive::zip;
use crate::json::{self, Value};
use crate::packs::project;
use crate::packs::registry::{PackError, BUNDLE_PACKS_DIR};

/// The store's bookkeeping file.
///
/// A DOTFILE because it sits at the root of a scan root, and the pack loader
/// skips ignored NAMES rather than unknown extensions — a plain `installed.json`
/// here would be read as a pack at address `installed`.
pub const INSTALLED_FILE: &str = ".tdcv2-installed.json";

/// Bumped only if the record's shape changes in a way older tools misread.
pub const INSTALLED_SCHEMA_VERSION: i64 = 1;

fn fail<T>(what: impl Into<String>) -> Result<T, PackError> {
    Err(PackError(what.into()))
}

/// One bundle as the store has it.
#[derive(Clone, Debug, Default)]
pub struct InstalledBundle {
    pub id: String,
    /// The paths this bundle owns, relative to the store and always
    /// `/`-separated. `pack remove` deletes exactly these; a bundle sharing a
    /// tree with others cannot be found by looking for a folder with its name.
    pub paths: Vec<String>,
    /// What the registry called this revision, or `""` when it called it nothing.
    pub version: String,
    /// Digest of the archive it came from; `""` for an install migrated from the
    /// old layout, where the archive is long gone.
    pub sha256: String,
    /// How many files it wrote.
    pub files: usize,
}

/// The bookkeeping file's contents.
#[derive(Clone, Debug)]
pub struct InstalledRecord {
    pub schema_version: i64,
    /// Sorted by id, so the file is stable to diff.
    pub bundles: Vec<InstalledBundle>,
}

impl Default for InstalledRecord {
    fn default() -> Self {
        InstalledRecord {
            schema_version: INSTALLED_SCHEMA_VERSION,
            bundles: Vec::new(),
        }
    }
}

/// Where the bookkeeping file lives.
pub fn installed_file_path(store: &Path) -> PathBuf {
    store.join(INSTALLED_FILE)
}

/// Read the store's books.
///
/// A missing file means an empty store; a malformed one is an ERROR rather than
/// an empty store, because "nothing is installed" would make `pack remove` claim
/// there is nothing to delete while the files sit there.
pub fn read_installed(store: &Path) -> Result<InstalledRecord, PackError> {
    let path = installed_file_path(store);
    if !path.is_file() {
        return Ok(InstalledRecord::default());
    }
    let shown = path.display().to_string();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return fail(format!("pack store record \"{shown}\" cannot be read"));
    };
    let root = match json::parse(&text) {
        Ok(root) => root,
        Err(e) => {
            return fail(format!(
                "pack store record \"{shown}\" is not valid JSON: {e}. \
                 Delete it and re-add your bundles."
            ))
        }
    };
    if !matches!(root, Value::Object(_)) {
        return fail(format!(
            "pack store record \"{shown}\" must be a JSON object"
        ));
    }

    let Some(Value::Number(declared)) = root.get("schemaVersion") else {
        return fail(format!(
            "pack store record \"{shown}\": \"schemaVersion\" must be a number"
        ));
    };
    let declared = *declared;
    if declared > INSTALLED_SCHEMA_VERSION as f64 {
        return fail(format!(
            "pack store record \"{shown}\" was written by a newer tdcv2 \
             (schemaVersion {}) — update tdcv2",
            number_text(declared)
        ));
    }
    let Some(entries) = root.get("bundles").and_then(Value::as_array) else {
        return fail(format!(
            "pack store record \"{shown}\": \"bundles\" must be an array"
        ));
    };

    let mut bundles = Vec::with_capacity(entries.len());
    for (i, entry) in entries.iter().enumerate() {
        bundles.push(parse_installed_bundle(entry, i, &shown, store)?);
    }
    sort_by_id(&mut bundles);
    Ok(InstalledRecord {
        schema_version: declared as i64,
        bundles,
    })
}

fn parse_installed_bundle(
    raw: &Value,
    i: usize,
    shown: &str,
    store: &Path,
) -> Result<InstalledBundle, PackError> {
    if !matches!(raw, Value::Object(_)) {
        return fail(format!(
            "pack store record \"{shown}\": bundles[{i}] must be an object"
        ));
    }
    let Some(id) = raw
        .get("id")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return fail(format!(
            "pack store record \"{shown}\": bundles[{i}].id must be a non-empty string"
        ));
    };
    let Some(claimed) = raw.get("paths").and_then(Value::as_array) else {
        return fail(format!(
            "pack store record \"{shown}\": bundles[{i}].paths must be an array"
        ));
    };

    let mut paths = Vec::with_capacity(claimed.len());
    for (j, value) in claimed.iter().enumerate() {
        let Some(text) = value.as_str().filter(|s| !s.is_empty()) else {
            return fail(format!(
                "pack store record \"{shown}\": bundles[{i}].paths[{j}] must be a non-empty string"
            ));
        };
        // Everything in here is deleted verbatim by `pack remove`, so a
        // hand-edited or hostile record must not be able to point outside the
        // store.
        if Path::new(text).is_absolute() || !project::is_path_inside(&store.join(text), store) {
            return fail(format!(
                "pack store record \"{shown}\": bundle \"{id}\" claims a path outside the \
                 store: \"{text}\""
            ));
        }
        paths.push(text.to_string());
    }

    Ok(InstalledBundle {
        id: id.to_string(),
        paths,
        version: text_or_empty(raw, "version"),
        sha256: text_or_empty(raw, "sha256"),
        files: raw
            .get("files")
            .and_then(Value::as_f64)
            .map_or(0, |n| n.max(0.0) as usize),
    })
}

fn text_or_empty(raw: &Value, key: &str) -> String {
    raw.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// A number as the message should read it: `2`, not `2.0`.
///
/// Only a hand-written record produces a fractional `schemaVersion`, and the
/// complaint about one has to quote what was actually written.
fn number_text(n: f64) -> String {
    if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

fn sort_by_id(bundles: &mut [InstalledBundle]) {
    // Plain byte order, not the machine's collation: five implementations write
    // this file and a locale-aware sort would put them in different orders on
    // different machines.
    bundles.sort_by(|a, b| a.id.cmp(&b.id));
}

/// Write the store's books, ids sorted so re-installing the same set is a no-diff.
pub fn write_installed(store: &Path, record: &InstalledRecord) -> Result<(), PackError> {
    std::fs::create_dir_all(store)
        .map_err(|e| PackError(format!("cannot create \"{}\": {e}", store.display())))?;
    let mut bundles = record.bundles.clone();
    sort_by_id(&mut bundles);

    // Built as an ordered document rather than from a map: the key order is part
    // of the file, and five implementations have to write the same bytes.
    let document = Value::Object(vec![
        (
            "schemaVersion".to_string(),
            Value::Number(INSTALLED_SCHEMA_VERSION as f64),
        ),
        (
            "bundles".to_string(),
            Value::Array(bundles.iter().map(bundle_value).collect()),
        ),
    ]);
    let path = installed_file_path(store);
    std::fs::write(&path, json::to_pretty(&document))
        .map_err(|e| PackError(format!("cannot write \"{}\": {e}", path.display())))
}

fn bundle_value(bundle: &InstalledBundle) -> Value {
    Value::Object(vec![
        ("id".to_string(), Value::String(bundle.id.clone())),
        (
            "paths".to_string(),
            Value::Array(
                bundle
                    .paths
                    .iter()
                    .cloned()
                    .map(Value::String)
                    .collect::<Vec<_>>(),
            ),
        ),
        ("version".to_string(), Value::String(bundle.version.clone())),
        ("sha256".to_string(), Value::String(bundle.sha256.clone())),
        ("files".to_string(), Value::Number(bundle.files as f64)),
    ])
}

/// The record with `entry` put in place of any earlier install of the same id.
pub fn with_bundle(record: InstalledRecord, entry: InstalledBundle) -> InstalledRecord {
    let mut bundles: Vec<InstalledBundle> = record
        .bundles
        .into_iter()
        .filter(|b| b.id != entry.id)
        .collect();
    bundles.push(entry);
    sort_by_id(&mut bundles);
    InstalledRecord {
        schema_version: INSTALLED_SCHEMA_VERSION,
        bundles,
    }
}

/// The record without `id`.
pub fn without_bundle(record: InstalledRecord, id: &str) -> InstalledRecord {
    InstalledRecord {
        schema_version: INSTALLED_SCHEMA_VERSION,
        bundles: record.bundles.into_iter().filter(|b| b.id != id).collect(),
    }
}

/// Bundle ids the store has, from its books.
///
/// A missing store is nothing installed, not an error. A tree somebody unpacked
/// by hand is not "installed" either: nothing records what it owns, so nothing
/// could remove it cleanly.
pub fn installed_bundle_ids(store: &Path) -> Result<Vec<String>, PackError> {
    let mut ids: Vec<String> = read_installed(store)?
        .bundles
        .into_iter()
        .map(|b| b.id)
        .collect();
    ids.sort();
    Ok(ids)
}

/// The paths a bundle owns, given every file it carries (store-relative,
/// `/`-separated).
///
/// Usually one path: every file of `ru` sits under `ru/`, every file of `russia`
/// under `countries/russia/`, so the longest shared directory IS the subtree the
/// bundle owns — and `countries/`, which several bundles share, is correctly not
/// claimed by any of them. A bundle whose files diverge at the top level owns
/// each of those top-level entries instead, which keeps the answer an antichain:
/// no owned path contains another.
pub fn bundle_owned_paths(files: &[String]) -> Vec<String> {
    if files.is_empty() {
        return Vec::new();
    }
    let directories: Vec<Vec<&str>> = files
        .iter()
        .map(|f| {
            let mut parts: Vec<&str> = f.split('/').collect();
            parts.pop();
            parts
        })
        .collect();

    let mut common: Vec<&str> = directories[0].clone();
    for other in &directories[1..] {
        let shared = common
            .iter()
            .zip(other.iter())
            .take_while(|(a, b)| a == b)
            .count();
        common.truncate(shared);
        if common.is_empty() {
            break;
        }
    }
    if !common.is_empty() {
        return vec![common.join("/")];
    }

    // No shared parent: the bundle owns each top-level entry its files start at,
    // and no more.
    let mut tops: Vec<String> = files
        .iter()
        .filter_map(|f| f.split('/').next())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    tops.sort();
    tops.dedup();
    tops
}

/// Refuse a bundle that would write into a path another one owns.
///
/// The registry's bundles are axis-pure and no two of them name the same path,
/// so this never fires on the real catalogue — it fires on a hand-built or
/// renamed archive, where the alternative is two bundles interleaved in one tree
/// and a `pack remove` that takes half of the other with it.
pub fn assert_no_overlap(
    id: &str,
    paths: &[String],
    record: &InstalledRecord,
) -> Result<(), PackError> {
    for other in &record.bundles {
        if other.id == id {
            continue;
        }
        for mine in paths {
            for theirs in &other.paths {
                if mine == theirs
                    || mine.starts_with(&format!("{theirs}/"))
                    || theirs.starts_with(&format!("{mine}/"))
                {
                    return fail(format!(
                        "bundle \"{id}\" would write into \"{mine}\", which \"{}\" already \
                         owns — remove \"{}\" first",
                        other.id, other.id
                    ));
                }
            }
        }
    }
    Ok(())
}

// ── unpacking one bundle ─────────────────────────────────────────────────────

/// Read a bundle's archive and decide, before a single byte is written, what it
/// would put where.
///
/// The archive nests everything under `<id>/packs/`, which is the bundler's
/// business and not the user's: those two levels are stripped here so the address
/// path lands directly in the store and `ru/person/lastName.txt` is what appears
/// under it, not `ru/packs/ru/person/lastName.txt`. Every entry must carry that
/// prefix — an archive that is not the bundle it claims to be, or that carries
/// something beside its packs, is refused whole rather than scattered into a
/// shared tree that nothing could then take apart again.
pub fn plan_extract(
    entries: Vec<zip::Entry>,
    id: &str,
    store: &Path,
) -> Result<Vec<(String, Vec<u8>)>, PackError> {
    let prefix = format!("{id}/{BUNDLE_PACKS_DIR}/");
    let mut planned: Vec<(String, Vec<u8>)> = Vec::new();
    for entry in entries {
        // A zip records folders as entries ending in `/` for tools that draw a
        // tree; unpacking creates them anyway.
        if entry.name.ends_with('/') {
            continue;
        }
        let Some(relative) = entry.name.strip_prefix(&prefix) else {
            return fail(format!(
                "bundle \"{id}\" carries \"{}\", which is not under \"{prefix}\" — refusing to \
                 unpack it",
                entry.name
            ));
        };
        if relative.is_empty() {
            continue;
        }
        // Zip-slip, checked here rather than at the write: an archive with one
        // escaping path must not first lay down the files that came before it.
        if !project::is_path_inside(&store.join(relative), store) {
            return fail(format!(
                "bundle \"{id}\" contains an unsafe path: {relative}"
            ));
        }
        planned.push((relative.to_string(), entry.data));
    }
    if planned.is_empty() {
        return fail(format!("bundle \"{id}\" has no files under \"{prefix}\""));
    }
    planned.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(planned)
}

/// Write a planned extract into the store. Every path was checked by the plan.
pub fn write_extract(files: &[(String, Vec<u8>)], store: &Path) -> Result<(), PackError> {
    for (relative, bytes) in files {
        let destination = store.join(relative);
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PackError(format!("cannot create \"{}\": {e}", parent.display())))?;
        }
        std::fs::write(&destination, bytes)
            .map_err(|e| PackError(format!("cannot write \"{}\": {e}", destination.display())))?;
    }
    Ok(())
}

/// Delete the paths a bundle owns, and any parent left empty behind them.
pub fn delete_owned_paths(store: &Path, paths: &[String]) -> Result<(), PackError> {
    for relative in paths {
        let target = store.join(relative);
        // The record is a file on disk and may have been edited; a path that
        // does not resolve inside the store is not deleted on its say-so.
        if !project::is_path_inside(&target, store) || project::is_same_path(&target, store) {
            return fail(format!(
                "refusing to delete \"{relative}\": it is not inside the pack store"
            ));
        }
        if target.is_dir() {
            let _ = std::fs::remove_dir_all(&target);
        } else {
            let _ = std::fs::remove_file(&target);
        }
        if let Some(parent) = target.parent() {
            prune_empty_dirs(parent, store);
        }
    }
    Ok(())
}

// ── the store's own files ────────────────────────────────────────────────────

/// Every file under `dir`, as `/`-separated paths relative to it, sorted.
///
/// Dotfiles included: `_locale.json` and anything else the packs carry has to
/// travel with them, and deciding what is "really" data is the loader's job.
pub fn walk_relative(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk_into(dir, "", &mut out);
    out.sort();
    out
}

fn walk_into(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let relative = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        if path.is_dir() {
            walk_into(&path, &relative, out);
        } else if path.is_file() {
            out.push(relative);
        }
    }
}

/// Delete `dir` and every empty parent up to (but never including) `stop_at`.
pub fn prune_empty_dirs(dir: &Path, stop_at: &Path) {
    let mut current = dir.to_path_buf();
    while !project::is_same_path(&current, stop_at) && project::is_path_inside(&current, stop_at) {
        let Ok(mut entries) = std::fs::read_dir(&current) else {
            return;
        };
        if entries.next().is_some() {
            return;
        }
        if std::fs::remove_dir(&current).is_err() {
            return;
        }
        let Some(parent) = current.parent() else {
            return;
        };
        current = parent.to_path_buf();
    }
}

/// Delete every empty directory in `dir`'s subtree, and `dir` itself if that
/// leaves it empty. Returns whether `dir` is gone.
///
/// Moving files out leaves the whole shape of the old tree behind, and empty
/// folders in a scan root are noise a user then has to wonder about.
fn prune_empty_tree(dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut empty = true;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() || !prune_empty_tree(&path) {
            empty = false;
        }
    }
    empty && std::fs::remove_dir(dir).is_ok()
}

/// Move one file, falling back to copy+delete if the store spans two devices.
fn move_file(from: &Path, to: &Path) -> Result<(), PackError> {
    if std::fs::rename(from, to).is_ok() {
        return Ok(());
    }
    std::fs::copy(from, to)
        .map_err(|e| PackError(format!("cannot move \"{}\": {e}", from.display())))?;
    let _ = std::fs::remove_file(from);
    Ok(())
}

// ── migrating a store written by an older tdcv2 ──────────────────────────────

/// One bundle's tree, moved out of its old folder.
#[derive(Clone, Debug)]
pub struct StoreMove {
    pub id: String,
    /// Store-relative source, e.g. `ru/packs`.
    pub from: String,
    /// Store-relative destinations, e.g. `ru`.
    pub to: Vec<String>,
    pub files: usize,
}

/// What [`migrate_store`] did, for the caller to report.
#[derive(Clone, Debug)]
pub struct StoreMigration {
    pub store: String,
    pub moves: Vec<StoreMove>,
    /// Files that were in a bundle's old folder but OUTSIDE its `packs/` tree.
    /// They belong to no pack address, so they are left exactly where they are
    /// rather than being guessed at or deleted.
    pub leftovers: Vec<String>,
    pub dropped_data_paths: usize,
    /// The store, as written into `dataPaths`; `None` if it was already there.
    pub registered: Option<String>,
}

/// Bundle folders in the old layout: `<store>/<id>/packs/…`.
pub fn legacy_bundle_ids(store: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(store) else {
        return Vec::new();
    };
    let mut ids: Vec<String> = entries
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.is_dir() && path.join(BUNDLE_PACKS_DIR).is_dir())
                .then(|| entry.file_name().to_string_lossy().into_owned())
        })
        .collect();
    ids.sort();
    ids
}

/// Move a store written by an older tdcv2 into the flat layout, in place.
///
/// Returns `None` when there is nothing to move. Everything is PLANNED before
/// anything moves: a store half in one layout and half in the other is worse
/// than one that refused and said why, and the refusal costs the user only the
/// two minutes it takes to move the offending file themselves.
///
/// Anyone who ran `pack add` before the flat store has `<store>/<id>/packs/…` on
/// disk and one `dataPaths` entry per bundle in their config; both are fixed
/// here, so the first `tdcv2 pack` after an upgrade is all it takes.
pub fn migrate_store(
    store: &Path,
    config_path: &Path,
) -> Result<Option<StoreMigration>, PackError> {
    let ids = legacy_bundle_ids(store);
    if ids.is_empty() {
        return Ok(None);
    }
    let packs_root_of = |id: &str| store.join(id).join(BUNDLE_PACKS_DIR);

    let mut planned: BTreeMap<PathBuf, (String, PathBuf)> = BTreeMap::new();
    let mut per_bundle: Vec<(String, Vec<String>)> = Vec::new();
    let mut conflicts: Vec<String> = Vec::new();
    let mut leftovers: Vec<String> = Vec::new();

    for id in &ids {
        let relatives = walk_relative(&packs_root_of(id));
        // Read before anything moves: a bundle whose tree lands back under its
        // own name (`ru/packs/ru` → `ru`) would otherwise report its own data as
        // a leftover the moment it arrived.
        for relative in walk_relative(&store.join(id)) {
            if !relative.starts_with(&format!("{BUNDLE_PACKS_DIR}/")) {
                leftovers.push(format!("{id}/{relative}"));
            }
        }
        for relative in &relatives {
            let destination = store.join(relative);
            if !project::is_path_inside(&destination, store) {
                conflicts.push(format!("{id}: \"{relative}\" would land outside the store"));
                continue;
            }
            if let Some((claimed, _)) = planned.get(&destination) {
                conflicts.push(format!(
                    "{relative}: claimed by both \"{claimed}\" and \"{id}\""
                ));
                continue;
            }
            if destination.exists() {
                conflicts.push(format!("{relative}: something is already there"));
                continue;
            }
            // Landing inside another bundle's old folder would move a file out
            // from under a move still to come.
            if ids.iter().any(|other| {
                other != id && project::is_path_inside(&destination, &packs_root_of(other))
            }) {
                conflicts.push(format!(
                    "{relative}: it would land inside another bundle's old folder"
                ));
                continue;
            }
            planned.insert(destination, (id.clone(), packs_root_of(id).join(relative)));
        }
        per_bundle.push((id.clone(), relatives));
    }

    if !conflicts.is_empty() {
        let mut shown: Vec<String> = conflicts.iter().take(5).map(|c| format!("  {c}")).collect();
        if conflicts.len() > 5 {
            shown.push(format!("  … and {} more", conflicts.len() - 5));
        }
        return fail(format!(
            "cannot move the pack store \"{}\" to the flat layout — {} path(s) collide:\n{}\n\
             Nothing was moved. Clear those paths, or delete the store and run \
             `tdcv2 pack add` again.",
            store.display(),
            conflicts.len(),
            shown.join("\n")
        ));
    }

    for (destination, (_, from)) in &planned {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| PackError(format!("cannot create \"{}\": {e}", parent.display())))?;
        }
        move_file(from, destination)?;
    }

    let mut record = read_installed(store)?;
    let mut moves: Vec<StoreMove> = Vec::new();
    for (id, relatives) in &per_bundle {
        let paths = bundle_owned_paths(relatives);
        record = with_bundle(
            record,
            InstalledBundle {
                id: id.clone(),
                paths: paths.clone(),
                version: String::new(),
                sha256: String::new(),
                files: relatives.len(),
            },
        );
        moves.push(StoreMove {
            id: id.clone(),
            from: format!("{id}/{BUNDLE_PACKS_DIR}"),
            to: paths,
            files: relatives.len(),
        });
        prune_empty_tree(&packs_root_of(id));
        prune_empty_tree(&store.join(id));
    }
    write_installed(store, &record)?;

    let store_text = store.to_string_lossy().into_owned();
    let dropped = project::remove_data_paths_inside(config_path, store)
        .map_err(|e| PackError(e.message().to_string()))?;
    let stored = project::stored_path(config_path, &store_text);
    let added = project::register(config_path, std::slice::from_ref(&store_text))
        .map_err(|e| PackError(e.message().to_string()))?;

    Ok(Some(StoreMigration {
        store: store.display().to_string(),
        moves,
        leftovers,
        dropped_data_paths: dropped,
        registered: added.then_some(stored),
    }))
}
