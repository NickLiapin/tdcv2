//! Reads data packs off disk.
//!
//! A pack is a text file: an optional `---` header, then one value per line.
//! With `weighted: true` each line is `value,count` instead, and the counts
//! become exact proportions rather than probabilities — the same machinery
//! `percent=` uses. That is why a run of 30,000 rows from the SSA name file
//! contains precisely as many Jameses as the census says, not approximately.

pub mod project;
pub mod registry;
pub mod source;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use source::{discover_root, DirectorySource, LayeredSource, PackSource};

use crate::engine::{invalid, EngineResult};

/// A loaded pack.
///
/// `percents` is `None` unless the pack is weighted. `generator` is `None`
/// unless the pack is a generator rather than a list — some packs describe how
/// to build a value instead of listing values, because listing every UUID is not
/// a thing anyone can do.
#[derive(Clone, Debug)]
pub struct Entry {
    pub values: Vec<String>,
    pub percents: Option<Vec<f64>>,
    pub generator: Option<String>,
}

impl Entry {
    pub fn weighted(&self) -> bool {
        self.percents.is_some()
    }

    pub fn is_generator(&self) -> bool {
        self.generator.is_some()
    }
}

pub struct DataPacks {
    source: Box<dyn PackSource + Send + Sync>,
    /// Folders searched by `src="@data/…"`, and by a relative `src=` the
    /// config's own folder does not hold. Highest priority last, as the layers
    /// are.
    data_roots: Vec<String>,
    /// Parsing a pack is pure, so the cache is an optimisation and never a
    /// behaviour. `RefCell` rather than `Mutex` because a run is
    /// single-threaded by construction — a shared PRNG could not be otherwise.
    cache: RefCell<BTreeMap<String, Entry>>,
    /// address -> relative file path, built on first miss. Empty until then:
    /// most runs resolve every address straight from the path and never pay
    /// for the scan.
    index: RefCell<Option<BTreeMap<String, String>>>,
}

impl std::fmt::Debug for DataPacks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DataPacks({})", self.source.describe())
    }
}

impl DataPacks {
    pub fn new(source: Box<dyn PackSource + Send + Sync>, data_roots: Vec<String>) -> Self {
        Self {
            source,
            data_roots,
            cache: RefCell::new(BTreeMap::new()),
            index: RefCell::new(None),
        }
    }

    pub fn from_root(root: &str) -> Self {
        Self::new(Box::new(DirectorySource::new(root)), vec![root.to_string()])
    }

    /// The packs found without being told where they are.
    pub fn discover() -> EngineResult<DataPacks> {
        match discover_root() {
            Some(root) => Ok(Self::from_root(&root.display().to_string())),
            None => invalid("no data packs found; set TDCV2_PACKS to a pack folder"),
        }
    }

    /// The packs a project has, rather than the packs this build ships with.
    ///
    /// The bundled ones, then every folder `tdcv2.config.json` lists, then
    /// whatever the caller adds — layered, highest priority last. A pack the CLI
    /// downloaded lands in a folder that file names, so a config using it works
    /// here exactly as it does in the other four implementations. Without this
    /// the same config would run in one language and fail in another, which is
    /// the worst kind of portability bug: nothing is wrong with the config, only
    /// with which runtime was asked to run it.
    pub fn for_project(search_from: Option<&str>, extra_roots: &[String]) -> EngineResult<Self> {
        let discovered = Self::discover()?;
        let config = project::load(search_from)?;

        let mut layers: Vec<Box<dyn PackSource + Send + Sync>> = vec![discovered.source];
        let mut roots = discovered.data_roots;
        for dir in config.data_paths.iter().chain(extra_roots.iter()) {
            // A root that is not there is still recorded: `@data/` reports what
            // it looked for, and a folder the config named but nobody created is
            // the most useful thing that message can say.
            if Path::new(dir).is_dir() {
                layers.push(Box::new(DirectorySource::new(dir)));
            }
            roots.push(dir.clone());
        }

        Ok(if layers.len() == 1 {
            Self::new(layers.pop().expect("one layer"), roots)
        } else {
            Self::new(Box::new(LayeredSource::new(layers)), roots)
        })
    }

    pub fn data_roots(&self) -> &[String] {
        &self.data_roots
    }

    /// Whether an address resolves, without caring what is in it.
    pub fn exists(&self, dotted_path: &str, locale: &str) -> bool {
        self.load(dotted_path, locale).is_ok()
    }

    /// Resolve a dotted path against a locale and load it.
    ///
    /// The rule the reference uses: if the first segment names a locale, a
    /// country, or a reserved bucket, the path is already absolute; otherwise
    /// the active locale is prepended, so `person.lastName` under `en` is
    /// `en/person/lastName.txt`.
    pub fn load(&self, dotted_path: &str, locale: &str) -> EngineResult<Entry> {
        let key = format!("{dotted_path}|{locale}");
        if let Some(cached) = self.cache.borrow().get(&key) {
            return Ok(cached.clone());
        }

        let first = dotted_path.split('.').next().unwrap_or("");
        let file = if self.source.has_top_level(first) {
            // A locale or a reserved bucket: the address is already absolute.
            format!("{}.txt", dotted_path.replace('.', "/"))
        } else if self.source.has_country(first) {
            // A country: absolute too, but its files live under the countries/
            // grouping, which is not part of the address anyone writes.
            format!("countries/{}.txt", dotted_path.replace('.', "/"))
        } else {
            // Relative to the active locale, so `person.lastName` under `ru` is
            // a Russian surname.
            format!(
                "{}.txt",
                format!("{locale}.{dotted_path}").replace('.', "/")
            )
        };

        let lines = match self.source.read_lines(&file) {
            Some(lines) => lines,
            None => {
                // The path did not answer, so ask the headers: a file may declare
                // its own `address:` and then live anywhere at all — which is how
                // someone keeps a flat folder of their own lists. Scanned once, on
                // demand, so the ordinary run never pays for it.
                let absolute = self.absolute_address(dotted_path, locale);
                let placed = self.addresses().get(&absolute).cloned();
                match placed.and_then(|f| self.source.read_lines(&f).map(|l| (f, l))) {
                    Some((placed_file, lines)) => {
                        let entry = parse(&lines, &placed_file)?;
                        self.cache.borrow_mut().insert(key, entry.clone());
                        return Ok(entry);
                    }
                    None => {
                        return invalid(&format!(
                            "unknown template path \"{dotted_path}\" (looked for {file} in {})",
                            self.source.describe()
                        ));
                    }
                }
            }
        };

        let entry = parse(&lines, &file)?;
        self.cache.borrow_mut().insert(key, entry.clone());
        Ok(entry)
    }
    /// The address as the index holds it: locale-prefixed unless already absolute.
    fn absolute_address(&self, dotted_path: &str, locale: &str) -> String {
        let first = dotted_path.split('.').next().unwrap_or("");
        if self.source.has_top_level(first) || self.source.has_country(first) {
            dotted_path.to_string()
        } else {
            format!("{locale}.{dotted_path}")
        }
    }

    /// The parameters a generator pack accepts, or `None` when it is not one.
    ///
    /// A pack's parameters ARE its local `<sequence>` names: writing
    /// `domain="example.test"` on the calling `<gen>` replaces the sequence
    /// called `domain` with that constant. A single-`<gen>` pack declares none,
    /// and a plain list of values is not a generator at all — passing anything
    /// to either is always a no-op, so both return an empty set rather than
    /// `None`.
    ///
    /// Read by scanning for `<sequence name="…">` rather than by parsing the
    /// body: the validator asks before anything is built, and parsing here would
    /// report a pack author's syntax error at the caller's line.
    pub fn parameter_names(
        &self,
        dotted_path: &str,
        locale: &str,
    ) -> Option<std::collections::BTreeSet<String>> {
        let entry = self.load(dotted_path, locale).ok()?;
        let mut names = std::collections::BTreeSet::new();
        // A plain list of values has no parameters at all, which is not the same
        // as "unknown": an attribute aimed at one does nothing, and an attribute
        // that does nothing is indistinguishable from a typo.
        let Some(body) = entry.generator.as_ref() else {
            return Some(names);
        };
        let mut rest = body.as_str();
        while let Some(at) = rest.find("<sequence") {
            rest = &rest[at + "<sequence".len()..];
            let Some(end) = rest.find('>') else { break };
            let tag = &rest[..end];
            if let Some(name_at) = tag.find("name=\"") {
                let after = &tag[name_at + 6..];
                if let Some(close) = after.find('"') {
                    names.insert(after[..close].to_string());
                }
            }
            rest = &rest[end..];
        }
        Some(names)
    }

    /// Every address these packs can answer to, in no particular order.
    ///
    /// The quick API needs the whole list rather than a yes-or-no about one
    /// address: to say "did you mean" it has to compare what was typed against
    /// all of them. Building the index is the cost of the first call only.
    pub fn address_list(&self) -> Vec<String> {
        self.addresses().keys().cloned().collect()
    }

    /// Every pack file's address, read from its header — built once, kept.
    ///
    /// A header may carry `address:` (authoritative) and `locale:` (used only
    /// when the path-derived address has no locale of its own). Files that
    /// resolve to neither a locale, a country nor a reserved bucket are not
    /// addressable and are left out, the same rule the reference applies.
    fn addresses(&self) -> BTreeMap<String, String> {
        if let Some(built) = self.index.borrow().as_ref() {
            return built.clone();
        }
        let mut index: BTreeMap<String, String> = BTreeMap::new();
        for file in self.source.list_files() {
            let Some(lines) = self.source.read_lines(&file) else {
                continue;
            };
            let header = header_of(&lines);
            let address = match header
                .get("address")
                .map(|a| a.trim())
                .filter(|a| !a.is_empty())
            {
                Some(declared) => declared.to_string(),
                None => {
                    let mut derived = file.trim_end_matches(".txt").replace('/', ".");
                    if let Some(rest) = derived.strip_prefix("countries.") {
                        derived = rest.to_string();
                    }
                    let head = derived.split('.').next().unwrap_or("").to_string();
                    if self.source.has_top_level(&head) || self.source.has_country(&head) {
                        derived
                    } else {
                        // Not under a locale folder: the header's own `locale:`
                        // is the only thing that can say where this belongs.
                        match header
                            .get("locale")
                            .map(|l| l.trim())
                            .filter(|l| !l.is_empty())
                        {
                            Some(declared) => format!("{declared}.{derived}"),
                            None => continue,
                        }
                    }
                }
            };
            index.insert(address, file);
        }
        *self.index.borrow_mut() = Some(index.clone());
        index
    }
}

/// Just the `---` fenced header, for the address scan: no body, no validation.
fn header_of(lines: &[String]) -> BTreeMap<String, String> {
    let mut header = BTreeMap::new();
    if lines.first().map(|l| l.trim()) != Some("---") {
        return header;
    }
    for line in lines.iter().skip(1) {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(colon) = trimmed.find(':') {
            if colon > 0 {
                header.insert(
                    trimmed[..colon].trim().to_lowercase(),
                    trimmed[colon + 1..].trim().to_string(),
                );
            }
        }
    }
    header
}

fn parse(lines: &[String], file: &str) -> EngineResult<Entry> {
    let mut header: BTreeMap<String, String> = BTreeMap::new();
    let mut start = 0usize;
    if lines.first().map(|l| l.trim()) == Some("---") {
        let mut end = 1usize;
        while end < lines.len() && lines[end].trim() != "---" {
            if let Some(colon) = lines[end].find(':') {
                if colon > 0 {
                    header.insert(
                        lines[end][..colon].trim().to_string(),
                        lines[end][colon + 1..].trim().to_string(),
                    );
                }
            }
            end += 1;
        }
        start = end + 1;
    }

    let body: Vec<String> = lines[start.min(lines.len())..]
        .iter()
        .filter(|l| !l.trim().is_empty())
        .cloned()
        .collect();

    // `generator: tdc` marks a pack whose body is a <gen> tag rather than a list
    // of values. Some things cannot be listed — a UUID, an account number — so
    // the pack ships the rule.
    if header.get("generator").map(String::as_str) == Some("tdc") {
        return Ok(Entry {
            values: Vec::new(),
            percents: None,
            generator: Some(body.join("\n")),
        });
    }

    if header.get("weighted").map(String::as_str) != Some("true") {
        return Ok(Entry {
            values: body,
            percents: None,
            generator: None,
        });
    }

    let delimiter = header.get("delimiter").map(String::as_str).unwrap_or(",");
    let mut values = Vec::with_capacity(body.len());
    let mut counts: Vec<f64> = Vec::with_capacity(body.len());
    let mut total = 0f64;
    for line in &body {
        // From the RIGHT: the count is the last field, and a value may contain
        // the delimiter.
        let Some(at) = line.rfind(delimiter) else {
            return invalid(&format!(
                "weighted pack {file}: line \"{line}\" has no count"
            ));
        };
        let Ok(weight) = line[at + delimiter.len()..].trim().parse::<f64>() else {
            return invalid(&format!(
                "weighted pack {file}: line \"{line}\" has no count"
            ));
        };

        // A zero weight means "never drawn". Dropping it rather than carrying it
        // at zero probability is what the reference does, and census files are
        // full of them.
        if weight == 0.0 {
            continue;
        }
        values.push(line[..at].to_string());
        counts.push(weight);
        total += weight;
    }

    if values.is_empty() {
        return invalid(&format!("weighted pack {file} has no positive counts"));
    }

    // Written exactly as the reference computes it. Reordering these operations
    // changes the last bits of the double, which changes a Hamilton remainder,
    // which changes which row gets a leftover — and the output stops matching.
    let percents: Vec<f64> = counts.iter().map(|c| c / total * 100.0).collect();

    Ok(Entry {
        values,
        percents: Some(percents),
        generator: None,
    })
}
