//! `_pack.json` — who wrote a folder of packs, under what licence, at what version.
//!
//! The pack format is otherwise all content and no provenance: a folder of `.txt`
//! lists and `.tdc` generators says what it produces and nothing about where it
//! came from. That is fine while the only packs are the bundled ones, and stops
//! being fine the moment somebody downloads a folder from a colleague, a registry
//! or a company share and has to answer "may we ship data built from this?".
//!
//! Everything here is OPTIONAL and nothing here reaches the generated data. A
//! manifest cannot change a single value: it describes the folder it sits in, and
//! `tdcv2 pack info` is what reads it back. A run never mentions it — the same
//! seed gives the same bytes whether it parses or not, so halting a generation
//! over it would punish the run for something it does not depend on.

use crate::json::{self, Value};

pub const FILENAME: &str = "_pack.json";

/// The fields read back, in the order `pack info` prints them.
pub const FIELDS: [&str; 6] = [
    "name",
    "version",
    "license",
    "author",
    "homepage",
    "description",
];

/// One folder's manifest, and where it was found. Fields keep `FIELDS` order.
pub struct Found {
    pub folder: String,
    pub manifest: Vec<(String, String)>,
}

/// What a sweep of the configured folders turned up.
pub struct Sweep {
    pub found: Vec<Found>,
    /// One line per manifest that would not parse, in the order the folders were read.
    pub broken: Vec<String>,
}

/// Parse a `_pack.json`, or return the complaint to raise.
///
/// Unknown keys are kept quietly: a manifest is metadata, and a folder written
/// for a newer TDC — or for a company's own tooling beside it — must not stop
/// working here because it carries a field this version has no use for. What is
/// refused is a field that IS known and holds the wrong kind of thing, because
/// that one was meant for this reader and will not arrive.
pub fn parse(content: &str, folder: &str) -> Result<Vec<(String, String)>, String> {
    let root = match json::parse(content) {
        Ok(root) => root,
        Err(e) => {
            return Err(format!(
                "{FILENAME} in \"{folder}\" is not valid JSON ({e}); \
                 nothing in this folder is described until it is fixed"
            ))
        }
    };
    let Value::Object(pairs) = root else {
        return Err(format!(
            "{FILENAME} in \"{folder}\" must be a JSON object, e.g. {{\"license\": \"MIT\"}}"
        ));
    };

    let mut manifest = Vec::new();
    for field in FIELDS {
        let Some((_, value)) = pairs.iter().find(|(key, _)| key == field) else {
            continue;
        };
        match value {
            Value::String(text) => {
                if !text.trim().is_empty() {
                    manifest.push((field.to_string(), text.clone()));
                }
            }
            other => {
                let kind = match other {
                    Value::Array(_) => "a list",
                    Value::Object(_) => "an object",
                    Value::Number(_) => "a number",
                    Value::Bool(_) => "a boolean",
                    Value::Null => "null",
                    Value::String(_) => unreachable!(),
                };
                return Err(format!(
                    "{FILENAME} in \"{folder}\" has \"{field}\" as {kind}, and it must be text"
                ));
            }
        }
    }
    Ok(manifest)
}

/// Look for `_pack.json` in each root and in each of its top-level folders.
///
/// Two depths rather than a full walk, and deliberately: a manifest describes a
/// FOLDER OF PACKS, which is either a data path somebody configured or one locale
/// inside it. Walking deeper would invite a manifest per `.txt` file, and the
/// question this answers — who wrote this data, and under what licence — is not
/// one a single list of city names has its own answer to.
pub fn sweep(
    roots: &[String],
    read: &dyn Fn(&str) -> Option<String>,
    folders: &dyn Fn(&str) -> Vec<String>,
    join: &dyn Fn(&str, &str) -> String,
) -> Sweep {
    let mut found = Vec::new();
    let mut broken = Vec::new();
    let mut seen: Vec<String> = Vec::new();

    let mut visit = |folder: String| {
        if seen.contains(&folder) {
            return; // a root listed twice describes itself once
        }
        seen.push(folder.clone());
        let Some(content) = read(&join(&folder, FILENAME)) else {
            return;
        };
        match parse(&content, &folder) {
            Ok(manifest) => found.push(Found { folder, manifest }),
            Err(complaint) => broken.push(complaint),
        }
    };

    for root in roots {
        visit(root.clone());
        for name in folders(root) {
            visit(join(root, &name));
        }
    }
    Sweep { found, broken }
}

/// How a found folder is printed: relative to where the command was run when it
/// sits inside, absolute otherwise.
///
/// A project's own packs live under the project, so the reader sees `mypacks/en`
/// rather than sixty characters of temp path — and a store somewhere else in the
/// filesystem still says where it really is.
pub fn display_folder(folder: &str, cwd: &str) -> String {
    let Some(rest) = folder.strip_prefix(cwd) else {
        return folder.to_string();
    };
    let trimmed = rest.trim_start_matches('/');
    if trimmed.is_empty() {
        ".".to_string()
    } else {
        trimmed.to_string()
    }
}
