//! Sort more records than fit in memory.
//!
//! The oldest trick there is, and still the right one: fill a buffer, sort it,
//! write it out, repeat; then merge the sorted runs by always taking the
//! smallest head. Memory is bounded by one chunk plus one line per run, whatever
//! the input's size.
//!
//! Engine 3 needs it for one question — are any two records identical — which
//! cannot be answered by a hash set once the answer stops fitting in RAM.
//! Sorting puts equal records next to each other, and the scan that follows
//! holds nothing but the group it is in.
//!
//! An input that fits in a single chunk never touches the disk. Most runs are
//! that, and paying for temp files to sort ten thousand rows would make the
//! exact engine slower than the one it exists to replace.

use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::{Path, PathBuf};

use crate::engine::{invalid, EngineResult};

/// Records held in memory per run. Roughly a hundred megabytes of short keys.
pub const DEFAULT_CHUNK: usize = 1_000_000;

/// The records in ascending order.
///
/// Byte order, not locale order — the keys are opaque and only equality of
/// neighbours matters, and a locale-aware comparison would also be slower and
/// machine-dependent.
///
/// The result is handed back as a `Sorted`, which either owns the whole thing
/// (it fit) or reads it back from disk one record at a time (it did not).
pub fn sort(
    records: impl Iterator<Item = String>,
    chunk_size: usize,
    tmp_dir: &Path,
) -> EngineResult<Sorted> {
    let limit = if chunk_size == 0 {
        DEFAULT_CHUNK
    } else {
        chunk_size.max(1)
    };

    let mut runs: Vec<PathBuf> = Vec::new();
    let mut chunk: Vec<String> = Vec::new();
    let mut dir: Option<PathBuf> = None;

    for record in records {
        chunk.push(record);
        if chunk.len() >= limit {
            let target = match &dir {
                Some(dir) => dir.clone(),
                None => {
                    let made = make_dir(tmp_dir, runs.len())?;
                    dir = Some(made.clone());
                    made
                }
            };
            runs.push(write_run(&mut chunk, &target, runs.len())?);
            chunk = Vec::new();
        }
    }

    // It all fit. Sort in memory and never create a file — the common case by
    // far.
    if runs.is_empty() {
        chunk.sort_unstable();
        return Ok(Sorted::InMemory {
            records: chunk,
            at: 0,
        });
    }

    let dir = dir.expect("a run was written, so the directory exists");
    if !chunk.is_empty() {
        runs.push(write_run(&mut chunk, &dir, runs.len())?);
    }
    Sorted::merging(runs, dir)
}

/// A sorted sequence, read once.
pub enum Sorted {
    InMemory {
        records: Vec<String>,
        at: usize,
    },
    /// A k-way merge: one line per run in memory, and the temp files gone when
    /// it ends.
    Merging {
        readers: Vec<Option<BufReader<std::fs::File>>>,
        /// The smallest unread line of each run, or `None` when that run is
        /// spent.
        heads: Vec<Option<String>>,
        dir: PathBuf,
    },
}

impl Sorted {
    fn merging(runs: Vec<PathBuf>, dir: PathBuf) -> EngineResult<Sorted> {
        let mut readers = Vec::with_capacity(runs.len());
        let mut heads = Vec::with_capacity(runs.len());
        for path in &runs {
            let file = std::fs::File::open(path)
                .map_err(|e| open_failed(path, &e.to_string()).unwrap_err())?;
            let mut reader = BufReader::new(file);
            let head = read_line(&mut reader)?;
            readers.push(Some(reader));
            heads.push(head);
        }
        Ok(Sorted::Merging {
            readers,
            heads,
            dir,
        })
    }

    /// The next record, or `None` at the end.
    ///
    /// Not `Iterator`: reading a merged run can fail, and an iterator that
    /// swallowed a read error would end the scan early and call the result
    /// sorted.
    pub fn take(&mut self) -> EngineResult<Option<String>> {
        match self {
            Sorted::InMemory { records, at } => {
                if *at >= records.len() {
                    return Ok(None);
                }
                *at += 1;
                Ok(Some(records[*at - 1].clone()))
            }
            Sorted::Merging { readers, heads, .. } => {
                // The run index breaks ties, so two identical lines from
                // different runs both survive rather than one displacing the
                // other.
                let mut smallest: Option<usize> = None;
                for (run, head) in heads.iter().enumerate() {
                    let Some(value) = head else { continue };
                    let better = match smallest {
                        None => true,
                        Some(best) => value < heads[best].as_ref().expect("a head"),
                    };
                    if better {
                        smallest = Some(run);
                    }
                }

                let Some(run) = smallest else { return Ok(None) };
                let taken = heads[run].take();
                if let Some(reader) = readers[run].as_mut() {
                    heads[run] = read_line(reader)?;
                }
                Ok(taken)
            }
        }
    }
}

impl Drop for Sorted {
    fn drop(&mut self) {
        // Dropped as soon as the scan ends rather than left for a caller to
        // remember. A run abandoned part-way still cleans up.
        if let Sorted::Merging { readers, dir, .. } = self {
            readers.clear();
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

fn read_line(reader: &mut BufReader<std::fs::File>) -> EngineResult<Option<String>> {
    let mut line = String::new();
    match reader.read_line(&mut line) {
        Ok(0) => Ok(None),
        Ok(_) => {
            if line.ends_with('\n') {
                line.pop();
            }
            Ok(Some(line))
        }
        Err(e) => invalid(&format!("external sort: cannot read a run ({e})")),
    }
}

fn make_dir(tmp_dir: &Path, salt: usize) -> EngineResult<PathBuf> {
    // Named from the process and a counter rather than at random: the crate has
    // no random source outside a seeded run, and two sorts in one process must
    // not share a folder.
    let dir = tmp_dir.join(format!(
        "tdc-esort-{}-{}-{salt}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_nanos())
    ));
    match std::fs::create_dir_all(&dir) {
        Ok(()) => Ok(dir),
        Err(e) => invalid(&format!(
            "external sort: cannot create \"{}\" ({e})",
            dir.display()
        )),
    }
}

fn write_run(chunk: &mut [String], dir: &Path, index: usize) -> EngineResult<PathBuf> {
    chunk.sort_unstable();
    let path = dir.join(format!("run-{index}.txt"));
    let file = std::fs::File::create(&path)
        .map_err(|e| open_failed(&path, &e.to_string()).unwrap_err())?;
    let mut writer = BufWriter::new(file);
    for record in chunk.iter() {
        if writeln!(writer, "{record}").is_err() {
            return invalid(&format!(
                "external sort: cannot write \"{}\"",
                path.display()
            ));
        }
    }
    if writer.flush().is_err() {
        return invalid(&format!(
            "external sort: cannot write \"{}\"",
            path.display()
        ));
    }
    Ok(path)
}

fn open_failed(path: &Path, why: &str) -> EngineResult<()> {
    invalid(&format!(
        "external sort: cannot open \"{}\" ({why})",
        path.display()
    ))
}
