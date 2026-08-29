//! Reads data packs off disk.
//!
//! A pack is a text file: an optional `---` header, then one value per line.
//! With `weighted: true` each line is `value,count` instead, and the counts
//! become exact proportions rather than probabilities — the same machinery
//! `percent=` uses. That is why a run of 30,000 rows from the SSA name file
//! contains precisely as many Jameses as the census says, not approximately.

pub mod bundled_files;
pub mod param_width;
pub mod project;
pub mod registry;
pub mod source;
pub mod store;

use std::cell::RefCell;
use std::collections::BTreeMap;
use std::path::Path;

use source::{discover_root, DirectorySource, EmbeddedSource, LayeredSource, PackSource};

use crate::engine::{invalid, EngineError, EngineResult};
use crate::errors::Diagnostic;
use crate::model::config::{Case, CasePart, Gen, Item, Mix, SequenceSpec, Source, Switch};
use crate::parser::config_builder;
use crate::parser::lexer::Pos;

/// The extensions a dotted address is tried against, in order.
///
/// Nearly every pack is a `.txt` list; a COMPOSED pack — one whose value a
/// generator body builds rather than a line of the file — is a `.tdc`. The
/// reference ignores the extension altogether, and so does the address index
/// below; this list is only the fast path that spares an ordinary run the scan.
const PACK_EXTENSIONS: [&str; 2] = [".txt", ".tdc"];

/// A relative path without its final extension, the way the reference derives an
/// address from one. Only the last segment is considered, so `nl-be/person/name`
/// keeps the dot in its folder.
fn strip_extension(path: &str) -> &str {
    let start = path.rfind('/').map_or(0, |slash| slash + 1);
    match path[start..].rfind('.') {
        Some(dot) if dot > 0 => &path[..start + dot],
        _ => path,
    }
}

/// A share declared by one sequence of a pack generator's body.
///
/// Read from the parsed body rather than by searching the text for `percent=`,
/// because a `<data>` template may hold those eight characters as output.
fn declares_share(spec: &SequenceSpec) -> bool {
    let declared = |gen: &Gen| !gen.attr_or("percent", "").trim().is_empty();
    match &spec.source {
        Source::Mix(mix) => mix.percent.as_deref().is_some_and(|p| !p.trim().is_empty()),
        Source::Gen(gen) => declared(gen),
        Source::Fields(fields) => fields.iter().any(|field| declared(&field.gen)),
        _ => false,
    }
}

/// Every `<gen>` one sequence of a pack generator's body can reach.
///
/// Its own, a compound's fields, the items of a composed body, a conditional's
/// branches, and the ones nested inside `<mix>` and `<switch>` cases. The
/// nesting is the part worth spelling out: a `<gen type="template">` written
/// inside a `<case>` draws from the very same list as one written at the top of
/// the sequence, so a walk that stopped at the top level would call a pack
/// row-at-a-time on the strength of where its reference happens to sit.
fn gens_of(spec: &SequenceSpec) -> Vec<&Gen> {
    let mut found = Vec::new();
    match &spec.source {
        Source::Gen(gen) => found.push(gen),
        Source::Fields(fields) => found.extend(fields.iter().map(|field| &field.gen)),
        Source::Items(items) => {
            for item in items {
                match item {
                    Item::Field(field) => found.push(&field.gen),
                    Item::Gen(gen) => found.push(gen),
                    Item::Text(_) | Item::Constant { .. } => {}
                }
            }
        }
        Source::Branches(branches) => found.extend(branches.iter().map(|branch| &branch.gen)),
        Source::Mix(mix) => gens_of_mix(mix, &mut found),
        Source::Switch(switch) => gens_of_switch(switch, &mut found),
        // A `<compute>` derives its value from columns already drawn; it reaches
        // no pack of its own.
        Source::Compute(_) => {}
    }
    found
}

fn gens_of_mix<'a>(mix: &'a Mix, found: &mut Vec<&'a Gen>) {
    for case in &mix.cases {
        gens_of_case(case, found);
    }
}

fn gens_of_switch<'a>(switch: &'a Switch, found: &mut Vec<&'a Gen>) {
    for entry in &switch.entries {
        gens_of_case(&entry.value, found);
    }
    if let Some(fallback) = &switch.fallback {
        gens_of_case(fallback, found);
    }
}

fn gens_of_case<'a>(case: &'a Case, found: &mut Vec<&'a Gen>) {
    for part in &case.parts {
        match part {
            CasePart::Gen(gen) => found.push(gen),
            CasePart::Mix(mix) => gens_of_mix(mix, found),
            CasePart::Switch(switch) => gens_of_switch(switch, found),
            CasePart::Text(_) => {}
        }
    }
}

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
    /// The files the index build read and could not place — TDC171. Filled by
    /// the same pass, so saying so costs nothing over dropping them silently.
    unaddressable: RefCell<Vec<Diagnostic>>,
}

impl std::fmt::Debug for DataPacks {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "DataPacks({})", self.source.describe())
    }
}

impl DataPacks {
    pub fn new(source: Box<dyn PackSource + Send + Sync>, data_roots: Vec<String>) -> Self {
        register_date_locales(&*source);
        Self {
            source,
            data_roots,
            cache: RefCell::new(BTreeMap::new()),
            index: RefCell::new(None),
            unaddressable: RefCell::new(Vec::new()),
        }
    }

    pub fn from_root(root: &str) -> Self {
        // The pack folder is a pack SOURCE, not a `src=` data root. Registered as both, a
        // `src="x.txt"` that the config's own folder does not hold went looking inside
        // `data/packs` — so a mistyped path could quietly find a pack file, and the refusal
        // that names what it searched listed a folder the reference never looks in. Packs are
        // addressed by `template value=`; `src=` is a file path, and the two are separate.
        Self::new(Box::new(DirectorySource::new(root)), Vec::new())
    }

    /// The packs found without being told where they are.
    ///
    /// A folder on disk wins — `TDCV2_PACKS`, or the repository's own
    /// `data/packs` found by walking up — because that is the copy every
    /// implementation shares and the one a contributor edits. Failing that, the
    /// starter set compiled into this binary, which is what a crate installed
    /// from the registry has: there is nothing above `~/.cargo/registry` to walk
    /// up to, and without this every `type="template"` answered "no data packs
    /// found".
    pub fn discover() -> EngineResult<DataPacks> {
        if let Some(root) = discover_root() {
            return Ok(Self::from_root(&root.display().to_string()));
        }
        if !EmbeddedSource::is_empty() {
            return Ok(Self::new(Box::new(EmbeddedSource::new()), Vec::new()));
        }
        invalid("no data packs found; set TDCV2_PACKS to a pack folder")
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
        // A duplicate address RESOLVES — twice, which is the whole complaint, and
        // `load` is what reports it. Answering "no" here would report the
        // collision as a misspelled address and send the reader hunting for a
        // typo that is not there.
        if self.candidates(&self.base_path(dotted_path, locale)).len() > 1 {
            return true;
        }
        match self.load(dotted_path, locale) {
            Ok(_) => true,
            // It resolves — to nothing at all, which IS the complaint, and `load`
            // is what reports it.
            Err(EngineError::Invalid(message)) => {
                message.ends_with(NO_VALUES_MARK) || message.ends_with(EMPTY_BODY_MARK)
            }
            Err(_) => false,
        }
    }

    /// Where this address's files sit, extension aside.
    fn base_path(&self, dotted_path: &str, locale: &str) -> String {
        let first = dotted_path.split('.').next().unwrap_or("");
        if self.source.has_top_level(first) {
            // A locale or a reserved bucket: the address is already absolute.
            dotted_path.replace('.', "/")
        } else if self.source.has_country(first) {
            // A country: absolute too, but its files live under the countries/
            // grouping, which is not part of the address anyone writes.
            format!("countries/{}", dotted_path.replace('.', "/"))
        } else {
            // Relative to the active locale, so `person.lastName` under `ru` is
            // a Russian surname.
            format!("{locale}.{dotted_path}").replace('.', "/")
        }
    }

    /// The files this address's path resolves to, one per extension that exists.
    /// More than one is a collision, because the extension is not part of an address.
    fn candidates(&self, base: &str) -> Vec<String> {
        PACK_EXTENSIONS
            .iter()
            .map(|extension| format!("{base}{extension}"))
            .filter(|candidate| self.source.has(candidate))
            .collect()
    }

    /// Whether a pack generator apportions a share over the whole column.
    ///
    /// Two ways to earn it.
    ///
    /// A `percent=` anywhere in a generator's body — on its `<mix>`, on a
    /// `<gen>`, on a compound field — makes its quota a property of the run
    /// rather than of a row. Asked before a config is handed to an engine that
    /// resolves one row at a time: such an engine computes the quota over a
    /// single row, so every row goes to the largest share and the column comes
    /// out uniform while looking like data.
    ///
    /// And a body that DRAWS from a weighted list, which the body does not say.
    /// A weighted list is laid out to the same exact quota, so each value takes
    /// its measured share of the rows; over a column of one row that plan awards
    /// the row to the largest share, every time, for every seed. Six shipped
    /// locales lost their full names to this: eight rows of
    /// `hu.person.male.fullName` came out `Nagy László` eight times, and Czech,
    /// Dutch, Serbian, Persian and Hebrew were in the same state, while German
    /// and Polish were not — the only difference being that their name lists
    /// carry no weights. The body says `value="hu.person.lastName"` and nothing
    /// in that line reveals that the list on the other end is weighted, so the
    /// question has to be followed through the reference.
    ///
    /// An address that does not resolve answers "no" — an unknown pack is the
    /// validator's complaint to make, and the router has no better answer than
    /// the one it would give for a pack with no shares.
    pub fn needs_whole_column(&self, dotted_path: &str, locale: &str) -> bool {
        self.whole_column(dotted_path, locale, &mut Vec::new())
    }

    /// [`needs_whole_column`](Self::needs_whole_column), carrying the addresses
    /// already open on the walk.
    ///
    /// Only a GENERATOR can answer yes here. A plain weighted list asked for
    /// directly by a config is laid out by the streaming engines themselves, and
    /// saying yes for one would move every config drawing a first name off the
    /// engine that handles it perfectly well.
    fn whole_column(&self, dotted_path: &str, locale: &str, seen: &mut Vec<String>) -> bool {
        let visiting = format!("{dotted_path}|{locale}");
        // A generator that comes back round to itself. The loader reports the
        // cycle as the error it is; this walk only has to stop, since recursing
        // would end the process rather than answer.
        if seen.iter().any(|open| open == &visiting) {
            return false;
        }
        let Ok(entry) = self.load(dotted_path, locale) else {
            return false;
        };
        let Some(body) = entry.generator.as_deref() else {
            return false;
        };
        let Ok(composed) = config_builder::parse_pack_body(body) else {
            // A single bare `<gen>` does not parse as a composed body: it
            // declares a share only through its own `percent=`, and it draws
            // from no list to inherit one from.
            return body.contains("percent=");
        };
        seen.push(visiting);
        let answer = composed.sequences.iter().any(|spec| {
            declares_share(spec)
                || gens_of(spec)
                    .into_iter()
                    .any(|gen| self.draws_whole_column(gen, locale, seen))
        });
        seen.pop();
        answer
    }

    /// Whether one `<gen>` of a pack body reaches a weighted list, directly or
    /// through another pack generator.
    ///
    /// The locale travels with the reference: a body drawing `person.lastName`
    /// means the surname of the locale the caller is running under, and reading
    /// the English list to answer a Hungarian question would answer about the
    /// wrong file. An explicit `local=` on the `<gen>` wins, as it does at
    /// render time.
    fn draws_whole_column(&self, gen: &Gen, locale: &str, seen: &mut Vec<String>) -> bool {
        if gen.gen_type != "template" {
            return false;
        }
        let target = gen.attr_or("value", "");
        // `common.vehicle.model.${{Brand}}` — the pack this names is not known
        // until the row is, and a config holding one is on its way to the
        // in-memory engine by a rule of its own.
        if target.is_empty() || target.contains("${{") {
            return false;
        }
        let inner = gen
            .attr("local")
            .map(str::trim)
            .filter(|declared| !declared.is_empty())
            .unwrap_or(locale);
        let Ok(entry) = self.load(target, inner) else {
            return false;
        };
        entry.weighted() || (entry.is_generator() && self.whole_column(target, inner, seen))
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

        let base = self.base_path(dotted_path, locale);
        let candidates = self.candidates(&base);
        if candidates.len() > 1 {
            // The extension is not part of an address, so two files that differ
            // only by it claim the SAME one. Picking the first silently would
            // make the other dead weight its author cannot see — the run keeps
            // working and reads the same file forever.
            let first = &candidates[0];
            let second = &candidates[1];
            return invalid(&format!(
                "duplicate data-pack address \"{}\" declared by both \"{}\" and \"{}\" \
                 — rename or move one",
                self.absolute_address(dotted_path, locale),
                self.source.locate(second).unwrap_or_else(|| second.clone()),
                self.source.locate(first).unwrap_or_else(|| first.clone()),
            ));
        }

        let found = candidates.into_iter().next().and_then(|candidate| {
            self.source
                .read_lines(&candidate)
                .map(|lines| (candidate, lines))
        });

        let (file, lines) = match found {
            Some(hit) => hit,
            None => {
                // The path did not answer, so ask the headers: a file may declare
                // its own `address:` and then live anywhere at all — which is how
                // someone keeps a flat folder of their own lists. Scanned once, on
                // demand, so the ordinary run never pays for it.
                let absolute = self.absolute_address(dotted_path, locale);
                let placed = self.addresses().get(&absolute).cloned();
                match placed.and_then(|f| self.source.read_lines(&f).map(|l| (f, l))) {
                    Some((placed_file, lines)) => {
                        let entry = self.checked(
                            parse(&lines, &placed_file)?,
                            dotted_path,
                            locale,
                            &placed_file,
                        )?;
                        self.cache.borrow_mut().insert(key, entry.clone());
                        return Ok(entry);
                    }
                    None => {
                        return invalid(&format!(
                            "unknown template path \"{dotted_path}\" (looked for {base}.txt in {})",
                            self.source.describe()
                        ));
                    }
                }
            }
        };

        let entry = self.checked(parse(&lines, &file)?, dotted_path, locale, &file)?;
        self.cache.borrow_mut().insert(key, entry.clone());
        Ok(entry)
    }

    /// A pack that lists nothing is refused here rather than drawn from later.
    ///
    /// A file with a header and no lines under it parses perfectly well and
    /// yields an empty list. Nothing downstream expects one: the generator picks
    /// `values[floor(random * len)]` and every implementation but the reference
    /// crashed on the index — a subtract overflow here, an IndexError in Python,
    /// an out-of-bounds in Java and C# — none of them naming the file. Said the
    /// way the reference has always said it, so the sentence is one sentence in
    /// five implementations.
    fn checked(
        &self,
        entry: Entry,
        dotted_path: &str,
        locale: &str,
        file: &str,
    ) -> EngineResult<Entry> {
        if entry.generator.is_none() && entry.values.is_empty() {
            return invalid(&format!(
                "data-pack address \"{}\" ({}){NO_VALUES_MARK}",
                self.absolute_address(dotted_path, locale),
                self.source.locate(file).unwrap_or_else(|| file.to_string()),
            ));
        }
        // A `generator: tdc` pack ships a rule instead of a list, and a header
        // with nothing under it ships neither. This used to answer "pack
        // generator body has no <gen> tag:" without naming the file, which
        // leaves the author a folder to search by hand.
        if entry
            .generator
            .as_deref()
            .is_some_and(|b| b.trim().is_empty())
        {
            return invalid(&format!(
                "generator \"{}\" ({}){EMPTY_BODY_MARK}",
                self.absolute_address(dotted_path, locale),
                self.source.locate(file).unwrap_or_else(|| file.to_string()),
            ));
        }
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
    pub fn parameter_names(&self, dotted_path: &str, locale: &str) -> Option<Vec<String>> {
        let entry = self.load(dotted_path, locale).ok()?;
        // DECLARATION order, not sorted: the names go straight into a refusal that lists them, and a pack that declares `user` then `domain` was reported as "domain, user" -- the reader matching the note against the pack body reads down a different list than the one there.
        let mut names: Vec<String> = Vec::new();
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
                    let name = after[..close].to_string();
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
            rest = &rest[end..];
        }
        Some(names)
    }

    /// How many characters each parameter's own sequence produces, where that is a FACT.
    ///
    /// A pinned parameter replaces the pack's own sequence for the run. The packs
    /// that carry a CHECK DIGIT compute it over a fixed layout, so a value of the
    /// wrong width does not shift the layout — it breaks it. See
    /// [`param_width`](crate::packs::param_width) for what counts as provable.
    pub fn parameter_widths(
        &self,
        dotted_path: &str,
        locale: &str,
    ) -> std::collections::BTreeMap<String, usize> {
        let Ok(entry) = self.load(dotted_path, locale) else {
            return std::collections::BTreeMap::new();
        };
        entry
            .generator
            .as_ref()
            .map(|body| param_width::parameter_widths(body))
            .unwrap_or_default()
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
        let mut dropped: Vec<Diagnostic> = Vec::new();
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
                    let mut derived = strip_extension(&file).replace('/', ".");
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
                            None => {
                                if has_header(&lines) {
                                    dropped.push(unaddressable_warning(
                                        &self.source.locate(&file).unwrap_or(file),
                                        &derived,
                                    ));
                                }
                                continue;
                            }
                        }
                    }
                }
            };
            index.insert(address, file);
        }
        *self.index.borrow_mut() = Some(index.clone());
        *self.unaddressable.borrow_mut() = dropped;
        index
    }

    /// Every pack file the address scan read and could not place.
    ///
    /// Empty until something has looked an address up and missed, because that
    /// is when the scan runs. The reference walks every pack root before it
    /// starts and can therefore say this about a file no config mentions; here
    /// the walk is the fallback path, and a run that resolves everything by path
    /// never pays for it. The author who wrote the unplaceable file always takes
    /// the fallback — their own address is the one that misses — so the file
    /// gets named at the moment it matters. `fixtures/cross-language/cli.json`
    /// records the difference.
    pub fn header_warnings(&self) -> Vec<Diagnostic> {
        self.unaddressable.borrow().clone()
    }
}

/// A pack file the scan read and could not address.
///
/// A warning rather than an error: the run continues on everything else, and the
/// author hears about the file instead of meeting it later as "unknown template
/// path" with nothing to connect the two.
fn unaddressable_warning(file: &str, address: &str) -> Diagnostic {
    Diagnostic::warning(
        "TDC171",
        format!(
            "data-pack file \"{file}\" is not addressable: \"{address}\" does not match where \
             the file is, and its first segment is not a known locale. A folder opens a \
             namespace of its own — move the file into one, or give it an `address:` or a \
             `locale:` that says where it belongs."
        ),
        &format!("Data pack file: {file}"),
        Pos { line: 1, column: 0 },
    )
}

/// Whether the file opens with the `---` fence.
///
/// A file with no header at all stays silent when it cannot be placed: it is
/// probably a raw `@data` source that happens to sit in a pack folder, not a
/// pack somebody meant to publish.
/// The date words each locale ships — `DATE_LOCALE.json` beside its name lists.
///
/// Months (with the in-a-date form every shipped file carries), weekdays, and
/// the `L`/`LL` layouts. `LLL`/`LLLL` are taken when the file writes them and
/// derived otherwise — `LL` plus the time, the weekday in front — because a
/// derived long form in the right language beats the fully English date these
/// locales rendered before this loader existed. A file that cannot be parsed
/// registers nothing: the built-in fallback to English then stands, and the
/// validator's warning says so.
fn register_date_locales(source: &(dyn PackSource + Send + Sync)) {
    // Once per SOURCE IDENTITY, not per construction: tests build thousands of
    // `DataPacks` over the same folder, and re-reading seventy files each time
    // is what turned a three-minute suite into twenty-five.
    static DONE: std::sync::OnceLock<std::sync::Mutex<std::collections::BTreeSet<String>>> =
        std::sync::OnceLock::new();
    let done = DONE.get_or_init(|| std::sync::Mutex::new(std::collections::BTreeSet::new()));
    {
        let mut seen = done.lock().expect("date-locale sources");
        if !seen.insert(source.describe()) {
            return;
        }
    }
    for name in source.list_top_level_names() {
        let Some(lines) = source.read_lines(&format!("{name}/DATE_LOCALE.json")) else {
            continue;
        };
        let content = lines.join("\n");
        let mut hash: u64 = 1469598103934665603;
        for byte in content.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(1099511628211);
        }
        let Ok(raw) = crate::json::parse(&content) else {
            continue;
        };
        let strings = |key: &str, len: usize| -> Option<Vec<String>> {
            let values = raw.get(key)?.as_array()?;
            if values.len() != len {
                return None;
            }
            values
                .iter()
                .map(|v| v.as_str().map(str::to_string))
                .collect()
        };
        let fmt = |key: &str| -> Option<String> {
            raw.get("formats")?.get(key)?.as_str().map(str::to_string)
        };
        let (Some(months), Some(months_short), Some(weekdays), Some(weekdays_short)) = (
            strings("months", 12),
            strings("monthsShort", 12),
            strings("weekdays", 7),
            strings("weekdaysShort", 7),
        ) else {
            continue;
        };
        let (Some(l), Some(ll)) = (fmt("L"), fmt("LL")) else {
            continue;
        };
        let lll = fmt("LLL").unwrap_or_else(|| format!("{ll} HH:mm"));
        let llll = fmt("LLLL").unwrap_or_else(|| format!("dddd, {ll} HH:mm"));
        let into12 = |v: Vec<String>| -> [String; 12] {
            v.try_into()
                .unwrap_or_else(|_| unreachable!("length checked"))
        };
        let into7 =
            |v: Vec<String>| -> [String; 7] { v.try_into().unwrap_or_else(|_| unreachable!()) };
        crate::date::locales::register_pack_locale(
            &name,
            hash,
            crate::date::locales::PackDateLocale {
                months: into12(months),
                months_in_date: strings("monthsInDate", 12).map(into12),
                months_short: into12(months_short),
                weekdays: into7(weekdays),
                weekdays_short: into7(weekdays_short),
                formats: [l, ll, lll, llll],
            },
        );
    }
}

fn has_header(lines: &[String]) -> bool {
    lines.first().map(|l| l.trim()) == Some("---")
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

/// The tail of the "lists nothing" refusal, so `exists` can recognise it.
///
/// The other four implementations give that refusal its own exception type;
/// here the error is a message, and the codebase already tells one refusal from
/// another this way (see `REPAIR_NEEDED_MARK`).
const NO_VALUES_MARK: &str = " has no values";

/// The same, for a `generator:` pack whose body is missing.
const EMPTY_BODY_MARK: &str = " has an empty body";

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
