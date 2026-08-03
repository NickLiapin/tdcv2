//! Data packs, fetched on demand from the registry every implementation shares.
//!
//! The pack collection is a body of DATA with its own release rhythm, and it
//! grows without bound — every locale, every country, eventually every corpus.
//! It lives in one repository, and each library ships only a starter set.
//! Everything past that is downloaded.
//!
//! One registry for all of them is the point. A locale added there appears in
//! every implementation at once, and there is exactly one place to publish to.
//! This is the Rust client for it — the same `index.json`, the same bundle zips,
//! the same digests, and the same store layout, so a project can be set up by
//! whichever implementation happens to be at hand and used by any of the others.

use std::path::Path;

use crate::archive::{sha256, zip};
use crate::json::{self, Value};
use crate::packs::store::{self, InstalledBundle};

/// Where the bundles live. The same default every implementation uses.
pub const DEFAULT_BASE_URL: &str =
    "https://raw.githubusercontent.com/NickLiapin/tdcv2-data-packs/master";

/// The folder inside a bundle that is a pack scan root.
pub const BUNDLE_PACKS_DIR: &str = "packs";

/// Anything that stops a bundle being installed, said plainly.
#[derive(Clone, Debug)]
pub struct PackError(pub String);

impl std::fmt::Display for PackError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(what: impl Into<String>) -> Result<T, PackError> {
    Err(PackError(what.into()))
}

/// One downloadable bundle, as the registry's index describes it.
#[derive(Clone, Debug, Default)]
pub struct Bundle {
    pub id: String,
    pub name: String,
    pub description: String,
    pub file: String,
    pub bytes: i64,
    pub sha256: String,
    /// What the registry calls this revision of the bundle.
    ///
    /// Optional: today's index declares none, and the digest already tells two
    /// revisions apart — but the store writes down whatever the registry did
    /// say, so a registry that starts versioning its bundles is understood
    /// without a client change.
    pub version: Option<String>,
    /// The language a locale bundle carries, when it carries one.
    pub locale: Option<String>,
    /// The country a country bundle is for, when it is for one.
    pub country: Option<String>,
    /// Continents the country belongs to. A list because Russia is honestly in
    /// two of them.
    pub regions: Vec<String>,
    /// `[longitude, latitude]`, roughly the middle of the country.
    ///
    /// Read from the registry rather than from a table kept here: the picker
    /// exists in several languages, and several copies of world geography would
    /// be several copies that disagree.
    pub point: Option<[f64; 2]>,
}

/// The catalogue.
#[derive(Clone, Debug, Default)]
pub struct Index {
    pub bundles: Vec<Bundle>,
}

impl Index {
    /// A bundle by id, or a message naming what there is.
    pub fn find(&self, id: &str) -> Result<&Bundle, PackError> {
        if let Some(found) = self.bundles.iter().find(|b| b.id == id) {
            return Ok(found);
        }
        let known = if self.bundles.is_empty() {
            "(none)".to_string()
        } else {
            self.bundles
                .iter()
                .map(|b| b.id.clone())
                .collect::<Vec<_>>()
                .join(", ")
        };
        fail(format!("unknown bundle \"{id}\". Available: {known}"))
    }
}

pub struct Registry {
    base_url: String,
}

impl Default for Registry {
    fn default() -> Self {
        Registry::new(DEFAULT_BASE_URL)
    }
}

impl Registry {
    pub fn new(base_url: &str) -> Registry {
        Registry {
            base_url: base_url.trim_end_matches('/').to_string(),
        }
    }

    /// The catalogue of what can be installed.
    pub fn read_index(&self) -> Result<Index, PackError> {
        let raw = fetch(&format!("{}/index.json", self.base_url))?;
        let text = String::from_utf8(raw)
            .map_err(|_| PackError("the registry index is not UTF-8".to_string()))?;
        parse_index(&text)
    }

    /// Download a bundle, verify it, unpack it into the store and write it into
    /// the store's books.
    ///
    /// The bytes are checked against the digest the registry published before
    /// anything is written. Data that arrived corrupted, or altered on the way,
    /// is refused rather than unpacked — a generator quietly fed the wrong names
    /// produces a dataset nobody can tell is wrong. Length first, because a
    /// download cut short in transit is the common case and saying how short says
    /// far more than "the hash did not match"; the digest then covers everything
    /// else, including an archive swapped for one of exactly the same size.
    ///
    /// A bundle's zip nests everything under `<id>/packs/`, and both levels are
    /// stripped while unpacking so what lands in the store is the address path:
    /// `<store>/en/person/lastName.txt`. That archive layout is the registry's,
    /// shared by every implementation, so getting it wrong here breaks packs
    /// published for the others rather than only ours.
    pub fn install(&self, bundle: &Bundle, store: &Path) -> Result<Installation, PackError> {
        std::fs::create_dir_all(store)
            .map_err(|e| PackError(format!("cannot create \"{}\": {e}", store.display())))?;

        let archive = fetch(&format!("{}/{}", self.base_url, bundle.file))?;
        if bundle.bytes > 0 && archive.len() as i64 != bundle.bytes {
            return fail(format!(
                "bundle \"{}\": expected {} bytes, got {}",
                bundle.id,
                bundle.bytes,
                archive.len()
            ));
        }
        if !sha256::hex(&archive).eq_ignore_ascii_case(bundle.sha256.trim()) {
            return fail(format!(
                "bundle \"{}\" failed its checksum — download corrupt or tampered; not installed",
                bundle.id
            ));
        }

        let entries = zip::read(&archive).map_err(|e| PackError(e.0))?;
        let planned = store::plan_extract(entries, &bundle.id, store)?;
        let files: Vec<String> = planned.iter().map(|(name, _)| name.clone()).collect();
        let paths = store::bundle_owned_paths(&files);

        let record = store::read_installed(store)?;
        store::assert_no_overlap(&bundle.id, &paths, &record)?;

        // Re-installing replaces rather than layers: without this, a bundle that
        // dropped a file would leave the old one behind for good, still
        // answering to its address.
        let previous = record
            .bundles
            .iter()
            .find(|b| b.id == bundle.id)
            .map(|b| b.paths.clone());
        if let Some(previous) = previous {
            store::delete_owned_paths(store, &previous)?;
        }

        store::write_extract(&planned, store)?;
        store::write_installed(
            store,
            &store::with_bundle(
                record,
                InstalledBundle {
                    id: bundle.id.clone(),
                    paths: paths.clone(),
                    version: bundle.version.clone().unwrap_or_default(),
                    sha256: bundle.sha256.clone(),
                    files: files.len(),
                },
            ),
        )?;

        Ok(Installation {
            files: files.len(),
            paths,
        })
    }
}

/// What one install put where.
#[derive(Clone, Debug)]
pub struct Installation {
    /// How many files the bundle wrote.
    pub files: usize,
    /// The store-relative paths it now owns — where its data actually is.
    pub paths: Vec<String>,
}

fn parse_index(text: &str) -> Result<Index, PackError> {
    let root = json::parse(text)
        .map_err(|e| PackError(format!("the registry index is not valid JSON: {e}")))?;
    let Some(bundles) = root.get("bundles").and_then(Value::as_array) else {
        return fail("the registry index has no \"bundles\" list");
    };

    Ok(Index {
        bundles: bundles
            .iter()
            .map(|node| Bundle {
                id: text_of(node, "id"),
                name: text_of(node, "name"),
                description: text_of(node, "description"),
                file: text_of(node, "file"),
                bytes: node.get("bytes").and_then(Value::as_i64).unwrap_or(0),
                sha256: text_of(node, "sha256"),
                version: opt_text(node, "version"),
                locale: opt_text(node, "locale"),
                country: opt_text(node, "country"),
                regions: node
                    .get("regions")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_string)
                            .collect()
                    })
                    .unwrap_or_default(),
                point: node.get("point").and_then(Value::as_array).and_then(|xs| {
                    match (
                        xs.first().and_then(Value::as_f64),
                        xs.get(1).and_then(Value::as_f64),
                    ) {
                        (Some(lon), Some(lat)) => Some([lon, lat]),
                        _ => None,
                    }
                }),
            })
            .collect(),
    })
}

/// A string that may simply not be there — the registry omits `locale` on a
/// country bundle and `country` on a locale one, and which of the two is missing
/// is how the picker tells them apart.
fn opt_text(node: &Value, key: &str) -> Option<String> {
    node.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn text_of(node: &Value, key: &str) -> String {
    node.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

// ── the wire ─────────────────────────────────────────────────────────────────

/// How long a download may take, matching the other four implementations.
const TIMEOUT_SECONDS: &str = "60";

/// The bytes at a registry address.
///
/// `file:` is read directly — a mounted share, an offline mirror, a test's
/// temporary folder.
///
/// `http:` and `https:` go through `curl`, run as a process. The crate takes no
/// dependencies, and a TLS stack is the last thing to hand-write beside a hash;
/// curl ships with macOS, with every Linux worth the name, and with Windows 10
/// and later. What comes back is not trusted either way: the bundle's bytes are
/// checked against the digest the registry published before anything is written,
/// so the transport is a courier and not an authority.
fn fetch(url: &str) -> Result<Vec<u8>, PackError> {
    if let Some(path) = file_url_path(url) {
        return match std::fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => fail(format!("not found: {url}")),
            Err(e) => fail(format!("cannot read {url} ({e})")),
        };
    }

    let scheme = url.split_once("://").map(|(s, _)| s).unwrap_or_default();
    if scheme == "http" || scheme == "https" {
        return curl(url);
    }
    fail(format!(
        "registry \"{url}\" must be an http, https or file address"
    ))
}

/// One `curl` run, with the URL as an ARGUMENT rather than a shell string.
///
/// No shell is involved, so a registry address carrying a quote or a semicolon
/// is a bad address and not a command.
fn curl(url: &str) -> Result<Vec<u8>, PackError> {
    let done = std::process::Command::new("curl")
        .arg("--fail") // an HTTP error is a failure, not a page to unpack
        .arg("--silent")
        .arg("--show-error")
        .arg("--location") // the registry's raw URLs redirect
        .arg("--max-time")
        .arg(TIMEOUT_SECONDS)
        .arg("--")
        .arg(url)
        .output();

    let done = match done {
        Ok(done) => done,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(PackError(curl_is_missing(url)))
        }
        Err(e) => return fail(format!("cannot run curl for {url} ({e})")),
    };

    if done.status.success() {
        return Ok(done.stdout);
    }

    // curl says what went wrong on stderr; the status alone is a number nobody
    // remembers. A 404 is common enough to name in the same words the file: path
    // uses, so the two read alike.
    let said = String::from_utf8_lossy(&done.stderr).trim().to_string();
    if said.contains("404") {
        return fail(format!("not found: {url}"));
    }
    fail(if said.is_empty() {
        format!("cannot reach {url} (curl {})", done.status)
    } else {
        format!("cannot reach {url} ({said})")
    })
}

/// How to install curl, per platform.
///
/// Spelled out rather than left as "install curl": someone who has just met this
/// tool should not have to go and find out how, and the answer differs enough
/// between systems to be worth a table. Every platform is listed, not only the
/// one this build is running on, because the message gets pasted into issues and
/// read by people on other machines.
/// Written with `concat!` rather than as one literal: a `\` continuation eats
/// the leading whitespace of the next line, which silently unindents the first
/// row of the table.
const HOW_TO_INSTALL_CURL: &str = concat!(
    "  macOS           brew install curl   (or: xcode-select --install)\n",
    "  Debian, Ubuntu  sudo apt install curl\n",
    "  Fedora, RHEL    sudo dnf install curl\n",
    "  Arch            sudo pacman -S curl\n",
    "  Alpine          sudo apk add curl\n",
    "  openSUSE        sudo zypper install curl\n",
    "  FreeBSD         sudo pkg install curl\n",
    "  Windows         winget install curl.curl   (or: choco install curl)",
);

/// What to say when curl is not there.
///
/// Kept apart from the run so it can be checked without uninstalling curl from
/// the machine running the tests.
fn curl_is_missing(url: &str) -> String {
    format!(
        "cannot reach {url}\n\n\
         `tdcv2 pack` downloads with curl, and there is none on this PATH. curl ships with \
         macOS,\nwith Windows 10 and later, and with most Linux distributions — if yours does \
         not have it:\n\n\
         {HOW_TO_INSTALL_CURL}\n\n\
         Only `pack` reaches the network. Generating data, `check`, `format` and `init` all work \
         without\ncurl. You can also skip the download entirely: install the pack with another \
         implementation\n(`npx tdcv2 pack add …`) and point --registry at a folder you already \
         have, with file://"
    )
}

/// The local path behind a `file:` URL, or `None` for any other scheme.
///
/// Percent-escapes are undone because a temp directory can carry a space, and a
/// URL that spells it `%20` names a file that does not exist.
fn file_url_path(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("file://")
        .map(|rest| rest.strip_prefix("localhost").unwrap_or(rest))
        .or_else(|| url.strip_prefix("file:"))?;
    let path = if rest.starts_with('/') {
        rest.to_string()
    } else {
        format!("/{rest}")
    };
    Some(unescape(&path))
}

fn unescape(text: &str) -> String {
    let bytes: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '%' && i + 2 < bytes.len() {
            let hex: String = bytes[i + 1..i + 3].iter().collect();
            if let Ok(byte) = u8::from_str_radix(&hex, 16) {
                out.push(byte as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A user who has just met the tool should not have to go and find out how
    /// to install curl, so every platform is named — including the ones this
    /// build is not running on, because the message gets pasted into issues.
    #[test]
    fn the_message_for_a_missing_curl_says_how_to_get_one_everywhere() {
        let said = curl_is_missing("https://example.test/index.json");

        for platform in [
            "macOS", "Debian", "Ubuntu", "Fedora", "Arch", "Alpine", "openSUSE", "FreeBSD",
            "Windows",
        ] {
            assert!(said.contains(platform), "no advice for {platform}:\n{said}");
        }
        for command in ["brew install curl", "apt install curl", "winget install"] {
            assert!(said.contains(command), "no command {command:?}:\n{said}");
        }

        // And it does not overstate the damage: only `pack` needs the network,
        // and a user who reads "nothing works" gives up on a tool that mostly
        // does.
        assert!(said.contains("Only `pack` reaches the network"));
        assert!(
            said.contains("file://"),
            "the way round it is part of the advice"
        );

        // Every row of the table lines up. A stray backslash continuation once
        // ate the first row's indent, which is invisible in the source and
        // obvious in the terminal.
        for row in HOW_TO_INSTALL_CURL.lines() {
            assert!(row.starts_with("  "), "unindented row: {row:?}");
        }
    }
}
