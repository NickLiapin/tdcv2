//! Generate data from a `.tdc` config.
//!
//! The entry point. Point it at a file or hand it the config as a string, then
//! take the result as text or as rows:
//!
//! ```no_run
//! use tdcv2::Tdc;
//!
//! let data = Tdc::from_file("users.tdc")?;
//! println!("{data}");
//!
//! for row in data.rows() {
//!     println!("{:?}", row.get("Gender"));
//! }
//! # Ok::<(), tdcv2::TdcError>(())
//! ```
//!
//! Rows are the reason to use the library rather than the command line. A test
//! that asserts on `row.get("Gender")` says what it means; the same test parsing
//! CSV back out of a string spends most of its lines on the parsing.
//!
//! Text output and row output read the same generated values, so the two never
//! disagree. Row output ignores `<block>` and the wrappers entirely — those
//! describe a file format, and a row has no format.

use std::collections::BTreeMap;
use std::path::Path;

use crate::engine::{self, EngineError, RowSource};
use crate::errors::{has_errors, Diagnostic, Severity};
use crate::model::Config;
use crate::output::parquet_output;
use crate::packs::{project, DataPacks};
use crate::parser::lexer::Pos;
use crate::parser::{self, config_builder};
use crate::validator;

/// Why a run could not be built.
#[derive(Clone, Debug)]
pub enum TdcError {
    /// The config was refused.
    ///
    /// Carried as diagnostics rather than as prose, together with the source
    /// they were found in, so a caller can render the offending line instead of
    /// only quoting the message.
    Refused {
        diagnostics: Vec<Diagnostic>,
        source: String,
    },
    /// Something outside the config: a file that will not open, a pack folder
    /// that is not there.
    Io(String),
    /// The run itself could not be produced.
    Engine(EngineError),
}

impl TdcError {
    /// Every complaint, when the config was refused; empty otherwise.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        match self {
            TdcError::Refused { diagnostics, .. } => diagnostics,
            _ => &[],
        }
    }

    /// The config text a refusal's diagnostics point into.
    pub fn source(&self) -> Option<&str> {
        match self {
            TdcError::Refused { source, .. } => Some(source),
            _ => None,
        }
    }
}

impl std::fmt::Display for TdcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TdcError::Io(message) => f.write_str(message),
            TdcError::Engine(e) => write!(f, "{e}"),
            TdcError::Refused { diagnostics, .. } => {
                // The errors, if there are any: a warning standing next to a
                // refusal is not what stopped the run, and leading with it would
                // send the reader to the wrong line.
                let shown: Vec<&Diagnostic> = diagnostics
                    .iter()
                    .filter(|d| d.severity == Severity::Error)
                    .collect();
                match shown.len() {
                    0 => f.write_str("the config was refused"),
                    1 => write!(f, "{}", shown[0]),
                    n => write!(f, "{} (and {} more)", shown[0], n - 1),
                }
            }
        }
    }
}

impl std::error::Error for TdcError {}

impl From<EngineError> for TdcError {
    fn from(e: EngineError) -> Self {
        TdcError::Engine(e)
    }
}

/// Everything a run can be told, for the cases the constructors do not cover.
#[derive(Clone, Debug, Default)]
pub struct Options {
    pub config_file: Option<String>,
    pub config_string: Option<String>,
    pub count: Option<i32>,
    pub seed: Option<String>,
    pub locale: Option<String>,
    /// One named engine — 1 in memory, 2 streaming, 3 exact on disk — overriding
    /// what the config's `<env>` implies.
    ///
    /// The three draw in different orders, so this changes the data and not only
    /// the memory profile. It exists for the command line's `--engine` and for
    /// the tests that compare one engine against another; a config should say
    /// what it needs and let the router decide.
    pub engine: Option<u8>,
    /// The clock, for `value="today"` and for a birth date's age window.
    ///
    /// A parameter so a test can pin it; without that a test asserting on a
    /// generated date would pass today and fail tomorrow.
    pub now_millis: Option<i64>,
    /// Where the data packs live. Defaults to the ones this build can find.
    pub packs_dir: Option<String>,
    /// Extra folders an `@data/…` source may name, highest priority last.
    ///
    /// Layered ON TOP of the discovered packs rather than replacing them: a
    /// config that adds one folder for its own CSVs must not lose every bundled
    /// locale by doing so.
    pub data_paths: Vec<String>,
    /// What a relative `src=` is relative to.
    ///
    /// With a config file it defaults to that file's folder. With a config
    /// string there is no file to be relative to, so the caller says where — and
    /// if they do not, the working directory is the only honest answer left.
    pub base_dir: Option<String>,
}

/// A finished run: its text, its rows, and what it was built from.
pub struct Tdc {
    config: Config,
    /// Whether the seed was invented here because nothing declared one.
    ///
    /// Stored rather than inferred from an empty seed: once one is generated the
    /// config carries it like any other, and "is it empty" would then answer no
    /// to a question it used to answer yes to.
    seed_generated: bool,
    source: String,
    diagnostics: Vec<Diagnostic>,
    engine: u8,
    run: Box<dyn RowSource>,
}

/// One record: its sequences, addressable by the names the config gave them.
pub struct Row<'a> {
    source: &'a dyn RowSource,
    index: usize,
}

impl<'a> Row<'a> {
    /// The 0-based position of this row in the run.
    pub fn index(&self) -> usize {
        self.index
    }

    /// The value of one sequence on this row.
    ///
    /// `None` when the sequence does not apply here — a column declared with
    /// `parent="Gender.Male"` has no value on a female row, and an empty string
    /// would claim it had one that happened to be blank.
    ///
    /// Borrowed from the run rather than from the row, so a caller may collect
    /// values across rows without copying every one of them.
    pub fn get(&self, sequence: &str) -> Option<&'a str> {
        self.source.value(sequence, self.index)
    }

    /// Every sequence with a value here.
    pub fn to_map(&self) -> BTreeMap<String, String> {
        self.source
            .sequence_names()
            .iter()
            .filter_map(|name| self.get(name).map(|v| (name.clone(), v.to_string())))
            .collect()
    }

    /// The same row with compound sequences grouped.
    ///
    /// A compound is one thing with parts, so it reads as one entry holding a
    /// map rather than as several siblings whose shared prefix the caller has to
    /// notice: `row.nested()["Address"]` gives the whole address, keyed by
    /// field.
    pub fn nested(&self) -> BTreeMap<String, Nested> {
        let mut result: BTreeMap<String, Nested> = BTreeMap::new();
        for (key, value) in self.to_map() {
            match key.split_once('.') {
                None => {
                    result.insert(key, Nested::Value(value));
                }
                Some((parent, field)) => match result
                    .entry(parent.to_string())
                    .or_insert_with(|| Nested::Group(BTreeMap::new()))
                {
                    Nested::Group(group) => {
                        group.insert(field.to_string(), value);
                    }
                    // A name used both alone and as a prefix. The engine does not
                    // produce one, and inventing a merge here would hide it if it
                    // ever did.
                    Nested::Value(_) => {}
                },
            }
        }
        result
    }
}

impl std::fmt::Debug for Row<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_map().entries(self.to_map()).finish()
    }
}

/// One entry of [`Row::nested`]: a plain sequence, or a compound's fields.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Nested {
    Value(String),
    Group(BTreeMap<String, String>),
}

/// What [`Tdc::seed`] reports: the seed used, and whether the config supplied it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Seed {
    pub value: String,
    /// True when the config named no seed, in which case the run is not
    /// reproducible — worth logging, since that is usually not what was wanted.
    pub generated: bool,
}

/// One column of a run: numbers when every cell is one, text otherwise.
#[derive(Debug, Clone, PartialEq)]
pub enum Column {
    /// Every cell was a finite number.
    Numbers(Vec<f64>),
    /// At least one cell was empty or not a number, so the column stays as it was.
    Text(Vec<Option<String>>),
}

/// Every cell as a finite f64, or `None` when even one of them is not.
fn as_finite_numbers(text: &[Option<String>]) -> Option<Vec<f64>> {
    let mut out = Vec::with_capacity(text.len());
    for cell in text {
        let cell = cell.as_deref()?;
        if cell.is_empty() {
            return None;
        }
        let value: f64 = cell.parse().ok()?;
        if !value.is_finite() {
            return None;
        }
        out.push(value);
    }
    Some(out)
}

impl Tdc {
    /// A config file, everything else from `<env>`.
    pub fn from_file(path: impl AsRef<Path>) -> Result<Tdc, TdcError> {
        Tdc::new(Options {
            config_file: Some(path.as_ref().to_string_lossy().into_owned()),
            ..Options::default()
        })
    }

    /// A config held in memory, for a caller that built it rather than read it.
    pub fn from_string(config: impl Into<String>) -> Result<Tdc, TdcError> {
        Tdc::new(Options {
            config_string: Some(config.into()),
            ..Options::default()
        })
    }

    pub fn new(options: Options) -> Result<Tdc, TdcError> {
        Tdc::plan(options)?.build()
    }

    /// Everything a run needs, read and checked, with the rows not yet made.
    ///
    /// The other four implementations produce their rows on first use, so they
    /// can be asked what a run will cost after the object exists. Here a `Tdc`
    /// IS the finished run — which is what lets `text()` and `rows()` return
    /// values rather than results — so the question has to be asked one step
    /// earlier, and this is that step. [`Plan::preflight`] is the reason it is
    /// public: an estimate that arrives after the memory has been spent answers
    /// nothing.
    pub fn plan(options: Options) -> Result<Plan, TdcError> {
        let source = match (&options.config_file, &options.config_string) {
            (Some(_), Some(_)) | (None, None) => {
                return Err(TdcError::Io(
                    "Tdc needs exactly one of config_file and config_string".to_string(),
                ))
            }
            (Some(file), None) => std::fs::read_to_string(file)
                .map_err(|e| TdcError::Io(format!("cannot read \"{file}\": {e}")))?,
            (None, Some(text)) => text.clone(),
        };

        let parsed = parser::parse(&source);
        if !parsed.ok() {
            return Err(TdcError::Refused {
                diagnostics: parsed
                    .problems
                    .iter()
                    .map(|p| {
                        Diagnostic::error(
                            "TDC001",
                            p.message.clone(),
                            "",
                            Pos {
                                line: p.line,
                                column: p.column,
                            },
                        )
                    })
                    .collect(),
                source,
            });
        }

        let base_dir = options.base_dir.clone().or_else(|| {
            options
                .config_file
                .as_deref()
                .map(Path::new)
                .and_then(|file| std::fs::canonicalize(file).ok())
                .as_deref()
                .and_then(Path::parent)
                .map(|dir| dir.to_string_lossy().into_owned())
        });
        // The cascade is searched from the CONFIG FILE's folder, not from the
        // shell: a .tdc file belongs to the project it sits in, and running it
        // from one directory up must not quietly lose that project's packs.
        let search_from = base_dir.clone().or_else(working_directory);

        // A pack directory named outright wins; otherwise the project's own
        // tdcv2.config.json is consulted, so a pack downloaded by any
        // implementation is found by this one.
        let packs = match &options.packs_dir {
            Some(dir) => DataPacks::from_root(dir),
            None => DataPacks::for_project(search_from.as_deref(), &options.data_paths)?,
        };

        // Validate before building. A config the reference refuses must be
        // refused here too, or the two disagree about which configs are legal —
        // a portability bug even when every value either of them produces is
        // right.
        let diagnostics = validator::validate_in(
            &parsed.tree,
            Some(DataPacks::for_project(
                search_from.as_deref(),
                &options.data_paths,
            )?),
            base_dir.as_deref(),
        );
        if has_errors(&diagnostics) {
            return Err(TdcError::Refused {
                diagnostics,
                source,
            });
        }

        // The project config's `locale` is the fallback for a config that
        // declares none — the same file the packs came from, so a project that
        // installed `ru` and wrote it down gets Russian without repeating itself
        // in every .tdc.
        let default_locale = project::load(search_from.as_deref())?.locale;
        let mut config = config_builder::build(&parsed.tree, default_locale.as_deref())
            .map_err(|e| TdcError::Engine(EngineError::Invalid(e.message)))?
            .with_overrides(
                options.count,
                options.seed.as_deref(),
                options.locale.as_deref(),
            );
        if let Some(engine) = options.engine {
            config = config.with_engine(engine.to_string());
        }

        // Nothing named a seed, so one is invented — and USED, which is the
        // whole point. Leaving it empty would make every seedless run produce
        // the same bytes while the CLI reported a random seed of "", advice that
        // reproduces nothing. Randomness here is the reference's behaviour: a
        // seedless run is a different sample each time, and the seed printed
        // beside it is how you get that sample back.
        let seed_generated = config.seed.is_empty();
        if seed_generated {
            config.seed = fresh_seed();
        }

        // Read once, here, rather than per value: a run that straddled midnight
        // would otherwise put two different dates in one file from one "today".
        let now_millis = options.now_millis.unwrap_or_else(now);
        let engine = engine::router::resolve(&config, Some(&packs))?;

        Ok(Plan {
            config,
            seed_generated,
            source,
            diagnostics,
            engine,
            packs,
            now_millis,
            base_dir,
        })
    }

    /// The config text this run was built from.
    ///
    /// Exposed because a diagnostic names a line, and showing that line is what
    /// makes the complaint act on rather than look up.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Anything the config was warned about but not refused for.
    ///
    /// Errors stop the constructor, so whatever is left here is worth saying and
    /// not worth stopping for.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// The number of records this run produces.
    pub fn count(&self) -> usize {
        self.run.count()
    }

    pub fn is_empty(&self) -> bool {
        self.count() == 0
    }

    /// The seed in effect, and whether the config named it.
    pub fn seed(&self) -> Seed {
        Seed {
            value: self.config.seed.clone(),
            generated: self.seed_generated,
        }
    }

    /// Which engine this config runs on: 1 in memory, 2 streaming, 3 exact on
    /// disk.
    ///
    /// Worth exposing because it explains the run's memory profile, and because
    /// a config that asked for disk mode and got engine 1 back is being told
    /// something useful — it uses a feature that has to see the whole column.
    pub fn engine(&self) -> u8 {
        self.engine
    }

    /// The declared sequences, in declaration order.
    pub fn sequence_names(&self) -> &[String] {
        self.run.sequence_names()
    }

    /// The whole output as one string.
    pub fn text(&self) -> String {
        self.run.text()
    }

    /// Write the output to a file, replacing whatever is there.
    ///
    /// A `.parquet` name switches the format. The extension rather than a flag
    /// because that is what the other four do, and because a file named
    /// `out.parquet` holding CSV is a trap someone falls into once and
    /// remembers forever.
    pub fn write_file(&self, target: impl AsRef<Path>) -> Result<(), TdcError> {
        let target = target.as_ref();
        let parquet = target
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("parquet"));

        let bytes = if parquet {
            parquet_output::to_bytes(&self.config, self.run.as_ref())?
        } else {
            self.text().into_bytes()
        };
        std::fs::write(target, bytes)
            .map_err(|e| TdcError::Io(format!("cannot write \"{}\": {e}", target.display())))
    }

    /// The run as a Parquet file, whatever the target is called.
    pub fn to_parquet(&self) -> Result<Vec<u8>, TdcError> {
        Ok(parquet_output::to_bytes(&self.config, self.run.as_ref())?)
    }

    /// One record by position, or `None` outside the run.
    pub fn row(&self, index: usize) -> Option<Row<'_>> {
        (index < self.count()).then(|| Row {
            source: self.run.as_ref(),
            index,
        })
    }

    /// The run as COLUMNS rather than rows, with numbers as numbers.
    ///
    /// A column comes back as `Column::Numbers` — a `Vec<f64>` — only when EVERY
    /// cell in it is a finite number, and as `Column::Text` otherwise. The variant
    /// therefore says which, and a caller reading a numeric column never has to
    /// check for a label hiding in it.
    ///
    /// All-or-nothing on purpose: a vector of doubles cannot hold "no value", and
    /// filling the gaps with NaN would put a number nobody generated where a
    /// `parent=` filter deliberately left nothing.
    ///
    /// Not a way to skip the number-to-string conversion: sequences hold their
    /// values as text, so this parses them. It is for the ergonomics, and for not
    /// building the whole file as one string first.
    pub fn to_columns(&self) -> Vec<(String, Column)> {
        let source = self.run.as_ref();
        let count = self.count();
        source
            .sequence_names()
            .iter()
            .map(|name| {
                let text: Vec<Option<String>> = (0..count)
                    .map(|i| source.value(name, i).map(str::to_owned))
                    .collect();
                let column = match as_finite_numbers(&text) {
                    Some(numbers) => Column::Numbers(numbers),
                    None => Column::Text(text),
                };
                (name.clone(), column)
            })
            .collect()
    }

    /// The records one at a time, without building a list of them.
    pub fn rows(&self) -> impl Iterator<Item = Row<'_>> + '_ {
        (0..self.count()).map(move |index| Row {
            source: self.run.as_ref(),
            index,
        })
    }

    /// What this run cost in memory, or nothing when the answer is "not much".
    ///
    /// The same question [`Plan::preflight`] answers, kept here because the other
    /// four implementations ask it of the finished object and a caller porting
    /// code between them should not have to find a different name. Asked here it
    /// is a report rather than a decision: the rows already exist. Ask the plan
    /// instead when the point is to not pay.
    pub fn preflight(&self, materialized: bool) -> Option<Diagnostic> {
        memory_estimate(&self.config, self.engine, materialized)
    }
}

/// A run that has been read, checked and understood, but not yet produced.
///
/// See [`Tdc::plan`] for why this exists as its own step.
pub struct Plan {
    config: Config,
    seed_generated: bool,
    source: String,
    diagnostics: Vec<Diagnostic>,
    engine: u8,
    packs: DataPacks,
    now_millis: i64,
    base_dir: Option<String>,
}

impl Plan {
    /// The config text, for rendering a diagnostic against the line it names.
    pub fn source(&self) -> &str {
        &self.source
    }

    /// Anything the config was warned about but not refused for.
    pub fn diagnostics(&self) -> &[Diagnostic] {
        &self.diagnostics
    }

    /// The seed this run will use, and whether the config named it.
    pub fn seed(&self) -> Seed {
        Seed {
            value: self.config.seed.clone(),
            generated: self.seed_generated,
        }
    }

    /// Which engine will run it: 1 in memory, 2 streaming, 3 exact on disk.
    pub fn engine(&self) -> u8 {
        self.engine
    }

    /// What this run is likely to cost in memory, or nothing when the answer is
    /// "not much".
    ///
    /// Worth asking before a large run rather than after: a config that will not
    /// fit says so in a millisecond here, and takes minutes to say so by
    /// thrashing. The estimate is deliberately crude — a cell is assumed to cost
    /// about forty bytes and a rendered record about two hundred — because the
    /// decision it informs is "is this the right order of magnitude", not "how
    /// many bytes exactly".
    ///
    /// `materialized` is whether the whole output will be held as one string, as
    /// [`Tdc::text`] does. A run written straight to a file does not pay that.
    pub fn preflight(&self, materialized: bool) -> Option<Diagnostic> {
        memory_estimate(&self.config, self.engine, materialized)
    }

    /// Write the run straight to a file, holding one row rather than the whole
    /// output.
    ///
    /// Separate from [`Tdc::write_file`] because of WHEN it runs: by the time a
    /// `Tdc` exists the run has already been materialised, so writing from one
    /// can only ever copy what is already in memory. Going from the plan skips
    /// that — the rows are produced and handed to the file as they appear.
    ///
    /// Returns `false` when this run cannot take the streaming path — Parquet
    /// needs the whole table to write its footer, and the in-memory and
    /// exact-on-disk engines hold the run by design. The caller then builds and
    /// writes the ordinary way; nothing here changes what the bytes are.
    pub fn write_streaming(&self, target: &Path) -> Result<bool, TdcError> {
        let parquet = target
            .extension()
            .is_some_and(|e| e.eq_ignore_ascii_case("parquet"));
        if parquet || self.engine != 2 {
            return Ok(false);
        }

        let file = std::fs::File::create(target)
            .map_err(|e| TdcError::Io(format!("cannot write \"{}\": {e}", target.display())))?;
        let mut sink = FileSink {
            out: std::io::BufWriter::new(file),
            error: None,
        };
        let rendered = crate::engine::stream::write_in(
            &self.config,
            self.now_millis,
            self.base_dir.as_deref(),
            &mut sink,
        );
        // The sink's own failure is the better message: the engine only knows
        // that a write refused, while the sink kept the reason the OS gave.
        if let Some(e) = sink.finish(target)? {
            return Err(e);
        }
        // The streaming engine can refuse a config the router sent it — a running
        // total is the plain case — and when nobody named an engine, the answer is
        // to build it in memory instead. Saying "no" here does exactly that: the
        // caller writes the ordinary way. The half-written file goes first, so a
        // failure between here and there cannot leave a truncated run looking
        // finished.
        if let Err(e) = &rendered {
            if matches!(e, crate::engine::EngineError::Unsupported(_))
                && !crate::engine::engine_was_named(&self.config)
            {
                std::fs::remove_file(target).map_err(|e| {
                    TdcError::Io(format!("cannot remove \"{}\": {e}", target.display()))
                })?;
                return Ok(false);
            }
        }
        rendered?;
        Ok(true)
    }

    /// Produce the rows.
    pub fn build(self) -> Result<Tdc, TdcError> {
        // Generated once and kept: asking for the text and then for the rows
        // must not run the generator twice, which would be both slow and — with
        // a generated seed — a different answer.
        let run = engine::run_in(
            &self.config,
            &self.packs,
            self.now_millis,
            self.base_dir.as_deref(),
        )?;

        Ok(Tdc {
            config: self.config,
            seed_generated: self.seed_generated,
            source: self.source,
            diagnostics: self.diagnostics,
            engine: self.engine,
            run,
        })
    }
}

/// Very coarse per-cell estimate in bytes: a typical generated value — a name, a
/// number, a short date — lands in that range once its own bookkeeping is paid
/// for.
const BYTES_PER_CELL: i64 = 40;

/// Estimated size of one rendered record: the literal text plus the values
/// substituted into it. Generous, and roughly what the example configs produce.
const BYTES_PER_RENDERED_CARD: i64 = 200;

/// Warn once the estimate reaches this share of total RAM: the run will take a
/// big part of the machine and may lean on swap, but it can still finish.
const WARN_RATIO: f64 = 0.5;

/// Refuse once it reaches this share: even with the operating system handing
/// back everything it can, it will not fit, and the run will thrash or die. The
/// headroom below 1.0 is for the OS, for everything else running, and for how
/// rough the estimate is.
const ERROR_RATIO: f64 = 0.9;

/// The memory estimate, and the complaint it justifies.
///
/// Measured against the machine's TOTAL memory rather than what the operating
/// system calls free. Modern systems keep RAM busy with caches they hand back
/// the moment a process asks, so the free figure reads far below what a run can
/// actually have and would refuse jobs that run perfectly well. What bounds a
/// run is what fits in physical memory before it thrashes.
fn memory_estimate(config: &Config, engine: u8, materialized: bool) -> Option<Diagnostic> {
    // A streaming engine holds one row, not the run, so its cost does not grow
    // with count.
    let streaming = engine != 1;
    let mut slots: i64 = 4; // _count, _first, _last, _total
    for spec in &config.sequences {
        slots += match &spec.source {
            crate::model::config::Source::Fields(fields) => fields.len() as i64,
            _ => 1,
        };
    }

    let count = i64::from(config.count);
    let cells = if streaming { slots } else { count * slots };
    let mut estimated = cells * BYTES_PER_CELL;
    if !streaming && materialized {
        estimated += count * BYTES_PER_RENDERED_CARD;
    }

    // No figure means no opinion. The other four inherit the reference's
    // `total > 0 ? … : Infinity`, which on Node can never happen; here the probe
    // really can come back empty on a platform neither branch below knows, and
    // refusing every run on a machine we failed to measure would be a worse
    // answer than the OOM it is trying to prevent.
    let total = i64::try_from(total_memory()?).unwrap_or(i64::MAX);
    if total <= 0 {
        return None;
    }
    let ratio = estimated as f64 / total as f64;
    if ratio < WARN_RATIO {
        return None;
    }

    let estimated_mb = (estimated + 1024 * 1024 - 1) / (1024 * 1024);
    let total_mb = total / (1024 * 1024);
    let at = Pos { line: 1, column: 0 };
    if ratio >= ERROR_RATIO {
        return Some(Diagnostic::error(
            "TDC201",
            format!(
                "estimated memory need (~{estimated_mb} MB) exceeds this machine's RAM \
                 ({total_mb} MB) — run will likely thrash or crash"
            ),
            "Reduce count, split the generation into smaller batches, or switch to disk mode \
             (mode=\"disk\") which is bounded-memory.",
            at,
        ));
    }
    Some(Diagnostic::warning(
        "TDC200",
        format!(
            "estimated memory need (~{estimated_mb} MB) is a large share of this machine's RAM \
             ({total_mb} MB) — may lean on swap and slow down"
        ),
        "This will still run; for very large datasets mode=\"disk\" keeps memory flat regardless \
         of count.",
        at,
    ))
}

/// This machine's physical RAM, or `None` when the platform will not say.
///
/// There is no such thing in `std`, and the crate takes no dependencies, so the
/// two systems it runs on are asked in their own words — the same shape the pack
/// downloader and the terminal-size probe already use: ask the system, and take
/// no answer for an answer. `/proc/meminfo` is a plain file read; `sysctl` is one
/// short process, run once per run.
fn total_memory() -> Option<u64> {
    if let Ok(meminfo) = std::fs::read_to_string("/proc/meminfo") {
        // "MemTotal:       32791484 kB" — the unit is always kB, and has been
        // for the whole life of the file.
        let kb = meminfo
            .lines()
            .find_map(|line| line.strip_prefix("MemTotal:"))
            .and_then(|rest| rest.split_whitespace().next())
            .and_then(|number| number.parse::<u64>().ok());
        if let Some(kb) = kb {
            return Some(kb * 1024);
        }
    }

    // macOS and the BSDs. `hw.memsize` is bytes on macOS; `hw.physmem` is the
    // BSD spelling of the same thing.
    for key in ["hw.memsize", "hw.physmem"] {
        let output = std::process::Command::new("sysctl")
            .args(["-n", key])
            .stderr(std::process::Stdio::null())
            .output()
            .ok();
        let bytes = output
            .filter(|done| done.status.success())
            .and_then(|done| String::from_utf8(done.stdout).ok())
            .and_then(|text| text.trim().parse::<u64>().ok());
        if let Some(bytes) = bytes.filter(|b| *b > 0) {
            return Some(bytes);
        }
    }
    None
}

impl std::fmt::Display for Tdc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text())
    }
}

fn working_directory() -> Option<String> {
    std::env::current_dir()
        .ok()
        .map(|dir| dir.to_string_lossy().into_owned())
}

/// A seed for a run that declared none.
///
/// Shaped like the reference's `String(Math.random())` — a decimal in [0, 1) —
/// so the value the CLI prints looks the same whichever implementation printed
/// it, and can be pasted into `--seed` on any of them.
///
/// The crate has no random number generator and takes no dependency to get one,
/// so the clock is the entropy: nanoseconds since the epoch, mixed with the
/// process id so two runs started in the same nanosecond on one machine still
/// differ. This seeds a run; it is not a source anything security-shaped should
/// use, and nothing here does.
fn fresh_seed() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |since| since.as_nanos());
    let key = format!("{nanos}:{}", std::process::id());
    format!("{}", crate::prng::create(&key).next())
}

/// Milliseconds since the epoch.
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_millis() as i64)
        .unwrap_or(0)
}

/// A file seen as somewhere text can be written.
///
/// `std::fmt::Write` is what the renderer speaks, and it cannot carry an error:
/// its failure type is empty. So the real cause is kept here and asked for once
/// the run is over, which is also the only place it can be reported usefully.
struct FileSink {
    out: std::io::BufWriter<std::fs::File>,
    error: Option<std::io::Error>,
}

impl FileSink {
    /// Flush, and hand back whatever went wrong along the way.
    fn finish(&mut self, target: &Path) -> Result<Option<TdcError>, TdcError> {
        use std::io::Write as _;
        if let Err(e) = self.out.flush() {
            self.error.get_or_insert(e);
        }
        Ok(self
            .error
            .take()
            .map(|e| TdcError::Io(format!("cannot write \"{}\": {e}", target.display()))))
    }
}

impl std::fmt::Write for FileSink {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        use std::io::Write as _;
        match self.out.write_all(text.as_bytes()) {
            Ok(()) => Ok(()),
            Err(e) => {
                self.error.get_or_insert(e);
                Err(std::fmt::Error)
            }
        }
    }
}
