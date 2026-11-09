//! One `<gen type="http">` as a column of the run, fetched batch by batch.
//!
//! The rule `http` runs on: the column is cut into batches of `batch=` rows,
//! numbered by the ABSOLUTE row of the run — batch k is rows [k·N, (k+1)·N).
//! Wherever the generator sits — a sequence of its own, a `parent=` child, a
//! `<mix>` case, a field — row i reads answer i, and the service is asked only
//! for the batches somebody reads.
//!
//! The in-memory engine asks for a whole column of rows at once; a reader walking
//! row by row finds the batch already fetched or on the wire. Memory holds a few
//! batches, never the column.
//!
//! `parallel=` is how many batches may be on the wire together. The default, 1,
//! still overlaps the network with the engine's own work: the next batch is
//! requested the moment the current one arrives, while its rows are written.
//!
//! Mirrors `typescript/src/generators/http-column.ts`.

use std::cell::RefCell;
use std::collections::{BTreeMap, VecDeque};
use std::rc::Rc;
use std::thread::JoinHandle;

use crate::engine::{EngineError, EngineResult};
use crate::generators::http::{self, Batch, Failed, OnError};

/// Rows per request when `batch=` is absent — see the TypeScript twin for why.
pub const DEFAULT_BATCH: usize = 10_000;

/// Everything one http generator needs, resolved once per run.
#[derive(Clone, Debug)]
pub struct ColumnSpec {
    /// The column as the reader wrote it — `Hash`, or `Pay.ref` for a field.
    pub sequence: String,
    pub src: String,
    pub in_name: Option<String>,
    pub seed: String,
    pub secret: Option<String>,
    pub on_error: OnError,
    pub timeout_ms: i64,
    pub batch: usize,
    pub parallel: usize,
}

struct InFlight {
    handle: JoinHandle<Result<Vec<String>, Failed>>,
    offset: usize,
    count: usize,
}

pub struct HttpColumn {
    spec: ColumnSpec,
    total: usize,
    batches: usize,
    in_flight: BTreeMap<usize, InFlight>,
    /// Answered batches, oldest first; trimmed to `keep`.
    answered: VecDeque<(usize, Vec<String>)>,
    keep: usize,
}

/// Reads the `in=` column at an absolute row.
pub type InputAt<'a> = &'a dyn Fn(usize) -> String;

impl HttpColumn {
    pub fn new(spec: ColumnSpec, total: usize) -> Self {
        let batches = total.div_ceil(spec.batch.max(1));
        // The batch being read, the one before it (a reader may look one row back
        // across the seam) and everything already on the wire.
        let keep = spec.parallel + 2;
        Self {
            spec,
            total,
            batches,
            in_flight: BTreeMap::new(),
            answered: VecDeque::new(),
            keep,
        }
    }

    /// The answer for one absolute row.
    pub fn value_at(&mut self, row: usize, input_at: InputAt) -> EngineResult<String> {
        let size = self.spec.batch;
        let k = row / size;
        let ahead = self.sequential_ahead(k);
        let values = self.batch(k, Some(k + 1), &ahead, input_at)?;
        Ok(values.get(row - k * size).cloned().unwrap_or_default())
    }

    /// The answers for these absolute rows, in the order given. Only the batches
    /// holding them are requested, in ascending order, each exactly once.
    pub fn values_at(&mut self, rows: &[usize], input_at: InputAt) -> EngineResult<Vec<String>> {
        let size = self.spec.batch;
        let mut needed: Vec<usize> = rows.iter().map(|row| row / size).collect();
        needed.sort_unstable();
        needed.dedup();
        let mut by_batch: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for (i, &k) in needed.iter().enumerate() {
            let next = needed.get(i + 1).copied();
            let end = (i + self.spec.parallel).min(needed.len());
            let ahead: Vec<usize> = needed[(i + 1).min(end)..end].to_vec();
            let values = self.batch(k, next, &ahead, input_at)?;
            by_batch.insert(k, values);
        }
        Ok(rows
            .iter()
            .map(|&row| {
                let k = row / size;
                by_batch
                    .get(&k)
                    .and_then(|values| values.get(row - k * size))
                    .cloned()
                    .unwrap_or_default()
            })
            .collect())
    }

    fn batch(
        &mut self,
        k: usize,
        next: Option<usize>,
        ahead: &[usize],
        input_at: InputAt,
    ) -> EngineResult<Vec<String>> {
        if let Some((_, values)) = self.answered.iter().find(|(at, _)| *at == k) {
            return Ok(values.clone());
        }
        // The batch being read always goes out — the limit governs what is sent
        // AHEAD, not what the reader is waiting for.
        self.send(k, true, input_at);
        for &j in ahead {
            self.send(j, false, input_at);
        }
        let Some(flight) = self.in_flight.remove(&k) else {
            return Ok(Vec::new());
        };
        let values = self.answer(flight)?;
        self.remember(k, values.clone());
        if let Some(next) = next.filter(|&n| n < self.batches) {
            self.send(next, false, input_at);
        }
        Ok(values)
    }

    fn sequential_ahead(&self, k: usize) -> Vec<usize> {
        (k + 1..(k + self.spec.parallel).min(self.batches)).collect()
    }

    fn send(&mut self, k: usize, needed: bool, input_at: InputAt) {
        if k >= self.batches
            || self.in_flight.contains_key(&k)
            || self.answered.iter().any(|(at, _)| *at == k)
        {
            return;
        }
        // Never more than `parallel` out at once: a service that is not safe to
        // call concurrently gets exactly one request at a time under the default.
        if !needed && self.in_flight.len() >= self.spec.parallel {
            return;
        }
        let offset = k * self.spec.batch;
        let count = self.spec.batch.min(self.total - offset);
        let inputs: Option<Vec<String>> = self
            .spec
            .in_name
            .as_ref()
            .map(|_| (offset..offset + count).map(input_at).collect());
        let spec = self.spec.clone();
        let total = self.total;
        let handle = std::thread::spawn(move || {
            http::fetch(&Batch {
                src: &spec.src,
                count,
                offset,
                total,
                inputs: inputs.as_deref(),
                seed: Some(&spec.seed),
                on_error: spec.on_error,
                timeout_ms: spec.timeout_ms,
                secret: spec.secret.as_deref(),
            })
        });
        self.in_flight.insert(
            k,
            InFlight {
                handle,
                offset,
                count,
            },
        );
    }

    /// Wait for a batch, naming its rows in a failure when the column has several.
    fn answer(&self, flight: InFlight) -> EngineResult<Vec<String>> {
        let InFlight {
            handle,
            offset,
            count,
        } = flight;
        let result = handle.join().unwrap_or_else(|_| {
            Err(Failed {
                why: "could not be reached (the request thread stopped)".to_string(),
            })
        });
        result.map_err(|failed| {
            let place = if self.batches > 1 {
                format!(" (rows {offset}–{})", offset + count - 1)
            } else {
                String::new()
            };
            EngineError::Invalid(format!(
                "http service for sequence \"{}\" at {}{place} {}",
                self.spec.sequence, self.spec.src, failed.why
            ))
        })
    }

    fn remember(&mut self, k: usize, values: Vec<String>) {
        self.answered.push_back((k, values));
        while self.answered.len() > self.keep {
            self.answered.pop_front();
        }
    }
}

/// A positive whole number from `batch=`/`parallel=`, or the default.
fn parse_count(raw: Option<&String>, fallback: usize) -> usize {
    raw.map(|s| s.trim())
        .filter(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|&n| n > 0)
        .unwrap_or(fallback)
}

/// The http columns of one run, one per generator and column, made on first use
/// and kept — so a reader building one row at a time reads the batches the
/// previous row fetched instead of asking again.
#[derive(Default)]
pub struct HttpSession {
    columns: RefCell<BTreeMap<(usize, String), Rc<RefCell<HttpColumn>>>>,
}

impl HttpSession {
    /// The column for this generator as `sequence` reads it.
    pub fn column(
        &self,
        gen_key: usize,
        sequence: &str,
        attrs: &BTreeMap<String, String>,
        env_seed: &str,
        base_dir: &str,
        total: usize,
    ) -> EngineResult<Rc<RefCell<HttpColumn>>> {
        let key = (gen_key, sequence.to_string());
        if let Some(known) = self.columns.borrow().get(&key) {
            return Ok(Rc::clone(known));
        }
        // Resolved per column and never cached: two sequences may sign with two
        // different secrets, and a config naming an unset variable should say so
        // in terms of the sequence the reader wrote.
        let secret = match attrs
            .get("secret")
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            None => None,
            Some(spec) => Some(
                http::resolve_secret(spec, std::path::Path::new(base_dir)).map_err(|why| {
                    EngineError::Invalid(format!("http service for sequence \"{sequence}\": {why}"))
                })?,
            ),
        };
        let spec = ColumnSpec {
            sequence: sequence.to_string(),
            src: attrs.get("src").cloned().unwrap_or_default(),
            in_name: attrs
                .get("in")
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
            seed: http::seed_for(env_seed, sequence),
            secret,
            on_error: http::on_error(attrs),
            timeout_ms: http::timeout_ms(attrs.get("timeout").map(String::as_str)),
            batch: parse_count(attrs.get("batch"), DEFAULT_BATCH),
            parallel: parse_count(attrs.get("parallel"), 1),
        };
        let made = Rc::new(RefCell::new(HttpColumn::new(spec, total)));
        self.columns.borrow_mut().insert(key, Rc::clone(&made));
        Ok(made)
    }
}
