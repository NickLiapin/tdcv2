//! The quick API: one value, one call, no config file.
//!
//! ```no_run
//! use tdcv2::quick::Quick;
//!
//! let mut tdc = Quick::new();
//!
//! tdc.get("person.male.firstName")?;   // John
//! tdc.get("usa.docs.ssn")?;            // 690070001, check digits and all
//! tdc.many("person.lastName", 10)?;    // ten of them
//! Quick::seeded("demo").locale("ru").get("person.lastName")?;
//! tdc.gen("number", &[("value", "20..30")])?;
//! # Ok::<(), tdcv2::quick::QuickError>(())
//! ```
//!
//! ONE RULE, the same as in the other four implementations: the address is
//! spelled the way the pack spells it. `person.male.firstName` here is
//! `person.male.firstName` in a config, in the reference, and in TypeScript,
//! Python, Java and C#.
//!
//! WHY A STRING AND NOT `tdc.person().male().first_name()`. That shape needs a
//! generated function per address, and a generated surface can only ever cover
//! the packs compiled into the binary. Most packs are downloaded at runtime —
//! ten languages and ninety-odd countries — so `tdc.lang().ru()` would simply
//! not exist for the pack a user had just installed, while
//! `get("ru.person.lastName")` works the moment the download finishes.
//! TypeScript, Python and C# reach the same place through a proxy their
//! languages provide and Rust does not; the address itself is identical in all
//! five.
//!
//! A leading segment may be left out, exactly as in a config: then the address
//! is read against the active locale. `get("person.lastName")` gives Williams
//! under `en` and Иванов under `ru`.
//!
//! WHAT THIS IS NOT. Every call is independent. Nothing here ties one value to
//! another — no `<switch>` on a drawn column, no `parent=`, no `uniq`. A
//! coherent record is a config; this is the drawer of loose values that a faker
//! occupies, answered from the same data packs.

use std::collections::BTreeMap;
use std::fmt;

use crate::packs::DataPacks;
use crate::tdc::Tdc;

/// Rows per underlying run.
///
/// Part of the cross-language contract: change it and every seeded value
/// changes, because the draw depends on the declared count. The batch size, the
/// `#` in the derived seed and the sequence name `V` all match
/// `typescript/src/quick/draw.ts` exactly, which is what makes the same seed
/// give the same value in every implementation.
pub const BATCH_ROWS: usize = 512;

/// Words the API answers to at the ROOT of an address, so no data CATEGORY may
/// be called one of them. `location.country` is fine — `country` there is a leaf.
pub const RESERVED_ROOT_NAMES: [&str; 5] = ["gen", "seed", "locale", "lang", "country"];

/// Raised for anything the quick API can explain better than the engine can.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuickError(pub String);

impl fmt::Display for QuickError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for QuickError {}

/// One open stream: the run it reads from, and how far into it we are.
///
/// Held by index rather than by iterator because a `Row` borrows its `Tdc`, and
/// an iterator stored beside the value it borrows from is the one shape Rust
/// will not allow. Reading by index costs nothing here — the run is already
/// built — and keeps the struct plain.
struct Cursor {
    run: Tdc,
    batch: usize,
    position: usize,
}

/// The quick API's state: one seed, one locale, and the streams opened so far.
///
/// [`Quick::seed`] and [`Quick::locale`] each return a NEW value rather than
/// changing this one, so two tests can hold different seeds at once and neither
/// leaks into the other.
pub struct Quick {
    seed: String,
    locale: Option<String>,
    cursors: BTreeMap<String, Cursor>,
}

impl Quick {
    /// The default entry point: random per process, locale from the project config.
    ///
    /// Without [`Quick::seeded`] the quick API is random per process, the way a
    /// faker is — a test that wants the same values twice asks for them by name.
    pub fn new() -> Quick {
        Quick {
            seed: random_seed(),
            locale: None,
            cursors: BTreeMap::new(),
        }
    }

    /// The same API under a chosen seed.
    pub fn seeded(seed: impl Into<String>) -> Quick {
        Quick {
            seed: seed.into(),
            locale: None,
            cursors: BTreeMap::new(),
        }
    }

    /// The same API under a chosen seed, from an existing one.
    pub fn seed(&self, value: impl Into<String>) -> Quick {
        Quick {
            seed: value.into(),
            locale: self.locale.clone(),
            cursors: BTreeMap::new(),
        }
    }

    /// The same API under a chosen locale, which is what a bare address is read against.
    pub fn locale(&self, value: impl Into<String>) -> Quick {
        Quick {
            seed: self.seed.clone(),
            locale: Some(value.into()),
            cursors: BTreeMap::new(),
        }
    }

    /// One value from a pack address.
    pub fn get(&mut self, address: &str) -> Result<String, QuickError> {
        Ok(self.many_with(address, 1, &[])?.remove(0))
    }

    /// One value from a pack address, with parameters for the generator behind it.
    pub fn get_with(
        &mut self,
        address: &str,
        params: &[(&str, &str)],
    ) -> Result<String, QuickError> {
        Ok(self.many_with(address, 1, params)?.remove(0))
    }

    /// Several values from one address, continuing the same stream.
    pub fn many(&mut self, address: &str, count: usize) -> Result<Vec<String>, QuickError> {
        self.many_with(address, count, &[])
    }

    /// Several values from one address, with parameters.
    pub fn many_with(
        &mut self,
        address: &str,
        count: usize,
        params: &[(&str, &str)],
    ) -> Result<Vec<String>, QuickError> {
        let mut attrs: Vec<(String, String)> = vec![("value".to_string(), address.to_string())];
        attrs.extend(
            params
                .iter()
                .map(|(k, v)| ((*k).to_string(), (*v).to_string())),
        );
        self.draw("template", &attrs, count)
    }

    /// One value from an engine generator — the ones that take attributes rather
    /// than an address.
    ///
    /// They are reached by name rather than living at the top level because the
    /// pack categories are already called `date`, `text` and `word`.
    pub fn gen(&mut self, gen_type: &str, attrs: &[(&str, &str)]) -> Result<String, QuickError> {
        Ok(self.gen_many(gen_type, attrs, 1)?.remove(0))
    }

    /// Several values from one engine generator, continuing the same stream.
    pub fn gen_many(
        &mut self,
        gen_type: &str,
        attrs: &[(&str, &str)],
        count: usize,
    ) -> Result<Vec<String>, QuickError> {
        let owned: Vec<(String, String)> = attrs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        self.draw(gen_type, &owned, count)
    }

    /// Streams held open per generator, keyed by the generator and its attributes.
    ///
    /// Two different addresses draw independently, and the same address asked
    /// twice continues where it left off. That is forced by a measured fact —
    /// values depend on the row COUNT, not only on the seed, so a call cannot
    /// mean "render one row" or a loop of calls returns the same value forever.
    fn draw(
        &mut self,
        gen_type: &str,
        attrs: &[(String, String)],
        count: usize,
    ) -> Result<Vec<String>, QuickError> {
        if count == 0 {
            return Err(QuickError(
                "count must be a positive whole number, got 0".to_string(),
            ));
        }

        let key = key_of(gen_type, attrs);
        if !self.cursors.contains_key(&key) {
            let run = self.open(gen_type, attrs, 0)?;
            self.cursors.insert(
                key.clone(),
                Cursor {
                    run,
                    batch: 0,
                    position: 0,
                },
            );
        }

        let mut out = Vec::with_capacity(count);
        while out.len() < count {
            let (needs_next_batch, next_batch) = {
                let cursor = &self.cursors[&key];
                (cursor.position >= cursor.run.count(), cursor.batch + 1)
            };
            if needs_next_batch {
                let run = self.open(gen_type, attrs, next_batch)?;
                let cursor = self.cursors.get_mut(&key).expect("just inserted");
                cursor.run = run;
                cursor.batch = next_batch;
                cursor.position = 0;
                continue;
            }

            let cursor = self.cursors.get_mut(&key).expect("just inserted");
            // One sequence, one column: the row is { V: <the value> }. A compound
            // row cannot appear here — this layer never builds one.
            let value = cursor
                .run
                .row(cursor.position)
                .and_then(|row| row.get("V").map(str::to_string))
                .unwrap_or_default();
            cursor.position += 1;
            out.push(value);
        }
        Ok(out)
    }

    fn open(
        &self,
        gen_type: &str,
        attrs: &[(String, String)],
        batch: usize,
    ) -> Result<Tdc, QuickError> {
        let seed = if batch == 0 {
            self.seed.clone()
        } else {
            format!("{}#{batch}", self.seed)
        };
        let config = config_for(gen_type, attrs, self.locale.as_deref(), &seed)?;
        Tdc::from_string(config).map_err(|error| self.explain(gen_type, attrs, error))
    }

    /// Turn an engine diagnostic about a config the caller never wrote into a
    /// sentence about the call they did write — but only when the address really
    /// is what went wrong.
    ///
    /// Rewriting every failure hides the one line that says what is actually
    /// wrong: an attribute the validator refused came back as `unknown address
    /// "common.internet.email". Did you mean "common.internet.email"?`, which is
    /// nonsense.
    fn explain(
        &self,
        gen_type: &str,
        attrs: &[(String, String)],
        error: crate::tdc::TdcError,
    ) -> QuickError {
        if gen_type != "template" {
            return QuickError(error.to_string());
        }
        let address = attrs
            .iter()
            .find(|(k, _)| k == "value")
            .map(|(_, v)| v.as_str())
            .unwrap_or("");
        let locale = self.locale.as_deref().unwrap_or("en");
        let known = known_addresses();

        if let Some(missing) = uninstalled_pack(address, &known) {
            return QuickError(format!(
                "the \"{missing}\" pack is not installed, so \"{address}\" cannot be drawn. \
                 Install it with `tdcv2 pack add {missing}` \
                 (run `tdcv2 init` once first, to say where packs go)."
            ));
        }
        let qualified = format!("{locale}.{address}");
        if known.iter().any(|a| a == address || *a == qualified) {
            return QuickError(error.to_string());
        }
        let hint = match nearest(address, locale, &known) {
            Some(near) => format!(". Did you mean \"{near}\"?"),
            None => String::new(),
        };
        QuickError(format!(
            "unknown address \"{address}\" (locale \"{locale}\"){hint}"
        ))
    }
}

impl Default for Quick {
    fn default() -> Self {
        Quick::new()
    }
}

impl fmt::Display for Quick {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.locale {
            Some(locale) => write!(f, "<tdcv2 quick seed={} locale={locale}>", self.seed),
            None => write!(f, "<tdcv2 quick seed={}>", self.seed),
        }
    }
}

/// A seed nobody chose, from the clock and the address of a heap allocation.
///
/// The crate has no dependencies by design, so there is no rand to reach for.
/// This value is never part of any output a test asserts on — a test that wants
/// the same values twice calls `Quick::seeded`.
fn random_seed() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let boxed = Box::new(0u8);
    let address = &*boxed as *const u8 as usize;
    format!("{nanos:x}{address:x}")
}

fn known_addresses() -> Vec<String> {
    // A broken project config must not hide the real error behind its own.
    DataPacks::for_project(None, &[])
        .map(|packs| packs.address_list())
        .unwrap_or_default()
}

/// The pack an address names, when that pack is real but not on this machine.
///
/// The binary carries a starter set and the registry carries the other
/// hundred-odd, so `ru.person.lastName` fails not because `ru` is a typo but
/// because `ru` has not been downloaded. The test is structural rather than a
/// table of locale codes, so it holds for packs that do not exist yet: nothing
/// at all under the first segment, but the REST of the address resolves
/// somewhere.
fn uninstalled_pack(address: &str, known: &[String]) -> Option<String> {
    let (head, tail) = address.split_once('.')?;
    if head.is_empty() || tail.is_empty() {
        return None;
    }
    let prefix = format!("{head}.");
    if known.iter().any(|a| a.starts_with(&prefix)) {
        return None;
    }
    let suffix = format!(".{tail}");
    known
        .iter()
        .any(|a| a == tail || a.ends_with(&suffix))
        .then(|| head.to_string())
}

/// The nearest reachable address to what was typed, compared against the address
/// as written AND against its locale-qualified form: `person.firstNam` and
/// `en.person.firstNam` are the same typo seen from two sides.
fn nearest(typed: &str, locale: &str, known: &[String]) -> Option<String> {
    let qualified = format!("{locale}.{typed}");
    let mut best: Option<&String> = None;
    let mut best_score = usize::MAX;
    for address in known {
        let score = distance(typed, address).min(distance(&qualified, address));
        if score < best_score {
            best_score = score;
            best = Some(address);
        }
    }
    // Three edits away is a different address, not a typo.
    (best_score <= 3).then(|| best.cloned()).flatten()
}

fn distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut carry = prev[0];
        prev[0] = i;
        for j in 1..=b.len() {
            let keep = prev[j];
            prev[j] = (prev[j] + 1)
                .min(prev[j - 1] + 1)
                .min(carry + usize::from(a[i - 1] != b[j - 1]));
            carry = keep;
        }
    }
    prev[b.len()]
}

fn config_for(
    gen_type: &str,
    attrs: &[(String, String)],
    locale: Option<&str>,
    seed: &str,
) -> Result<String, QuickError> {
    let mut rendered = String::new();
    for (name, value) in attrs {
        rendered.push_str(&format!(" {name}=\"{}\"", escape(value)?));
    }
    let local = match locale {
        Some(locale) => format!(" local=\"{}\"", escape(locale)?),
        None => String::new(),
    };
    Ok(format!(
        "<tdc><env count=\"{BATCH_ROWS}\" seed=\"{}\"{local}>\
         <sequence name=\"V\"><gen type=\"{gen_type}\"{rendered}/></sequence></env>\
         <block><line><data>${{{{V}}}}</data></line></block></tdc>",
        escape(seed)?
    ))
}

fn escape(value: &str) -> Result<&str, QuickError> {
    if value.contains('"') {
        return Err(QuickError(format!(
            "a double quote is not allowed in a generator value: {value}"
        )));
    }
    Ok(value)
}

fn key_of(gen_type: &str, attrs: &[(String, String)]) -> String {
    let mut sorted: Vec<&(String, String)> = attrs.iter().collect();
    sorted.sort_by(|a, b| a.0.cmp(&b.0));
    let pairs: Vec<String> = sorted.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{gen_type}|{}", pairs.join("&"))
}
