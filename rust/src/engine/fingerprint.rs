//! Tuple fingerprints — how a large uniq run finds its duplicates.
//!
//! Sorting the tuples THEMSELVES means sorting text: records of eighty-odd
//! characters, millions of strings, each one an allocation. That text is what
//! makes the middle of a big run heavy — in scratch disk, in sort time, and in
//! memory.
//!
//! None of it is needed to DETECT a duplicate. Detection only asks "are these
//! two the same?", and a hash answers that in thirteen bytes:
//!
//! ```text
//! [hi 4B][lo 4B][row index 5B]   big-endian, fixed width
//! ```
//!
//! Fixed width and big-endian together buy the whole design. Comparing the raw
//! thirteen bytes IS comparing `(hi, lo, index)`, so sorting needs no
//! comparator and every implementation agrees by construction. And a record's
//! place in a file is `13 * ordinal`, so a sorted pile can be binary-searched
//! on disk: "is this tuple taken?" costs about twenty-five tiny reads and no
//! resident memory at all.
//!
//! A 64-bit hash is not proof — two different tuples can collide — so a group
//! of records sharing a hash is a CANDIDATE, not a verdict. Candidates are
//! verified by recomputing the actual tuples by row number. That is what makes
//! the duplicates found exactly the ones the text sort would name.
//!
//! Every number here is part of the cross-language contract, pinned by
//! `fixtures/cross-language/fingerprint-vectors.json`.

use std::collections::HashSet;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::prng::cyrb128;

/// Bytes per record: 4 (hash hi) + 4 (hash lo) + 5 (row index).
pub const RECORD_BYTES: usize = 13;

/// Rows a 5-byte index can name. Checked at the door rather than wrapped silently.
pub const MAX_INDEX: u64 = 1 << 40;

/// Records held in memory per sort batch.
const SORT_BATCH: usize = 2_000_000;

/// The 64-bit fingerprint of a tuple key, as two 32-bit halves.
pub fn hash64(key: &str) -> (u32, u32) {
    let state = cyrb128(key);
    (state[0] as u32, state[1] as u32)
}

/// Which pile a fingerprint belongs to.
pub fn bucket_of(hi: u32, buckets: usize) -> usize {
    (hi as usize) % buckets
}

/// How many piles for a run of `count` rows.
///
/// A short run gets one pile — the signal to stay on the exact text path, where
/// hashing has nothing to pay for itself with. Above that, four piles per core:
/// measured sizes come out even enough that no core waits on a straggler.
pub fn bucket_count_for(count: u64, cores: usize) -> usize {
    if count < 1_000_000 {
        return 1;
    }
    256.min(2.max(cores.max(1) * 4))
}

/// One record's bytes. Refuses an index the five bytes cannot carry.
pub fn encode(hi: u32, lo: u32, index: u64) -> Result<[u8; RECORD_BYTES], String> {
    if index >= MAX_INDEX {
        return Err(format!(
            "fingerprint index {index} exceeds the 5-byte record limit ({MAX_INDEX} rows)"
        ));
    }
    let mut record = [0u8; RECORD_BYTES];
    record[0..4].copy_from_slice(&hi.to_be_bytes());
    record[4..8].copy_from_slice(&lo.to_be_bytes());
    for b in 0..5 {
        record[8 + b] = ((index >> ((4 - b) * 8)) & 0xFF) as u8;
    }
    Ok(record)
}

/// The row index carried by one record.
pub fn index_of(record: &[u8]) -> u64 {
    let mut index: u64 = 0;
    for b in 0..5 {
        index = (index << 8) | u64::from(record[8 + b]);
    }
    index
}

/// Writes fingerprint records to a file, buffered.
pub struct Writer {
    out: BufWriter<File>,
}

impl Writer {
    pub fn create(path: &Path) -> Result<Self, String> {
        let file = File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(Self {
            out: BufWriter::with_capacity(1 << 20, file),
        })
    }

    pub fn write(&mut self, hi: u32, lo: u32, index: u64) -> Result<(), String> {
        let record = encode(hi, lo, index)?;
        self.out.write_all(&record).map_err(|e| e.to_string())
    }

    pub fn finish(mut self) -> Result<(), String> {
        self.out.flush().map_err(|e| e.to_string())
    }
}

/// Every record in a file, read in bounded memory.
pub fn read_records(path: &Path) -> Result<Vec<[u8; RECORD_BYTES]>, String> {
    let mut file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = Vec::new();
    let mut buffer = vec![0u8; RECORD_BYTES * 4096];
    loop {
        let read = file.read(&mut buffer).map_err(|e| e.to_string())?;
        if read == 0 {
            return Ok(out);
        }
        let mut at = 0;
        while at + RECORD_BYTES <= read {
            let mut record = [0u8; RECORD_BYTES];
            record.copy_from_slice(&buffer[at..at + RECORD_BYTES]);
            out.push(record);
            at += RECORD_BYTES;
        }
    }
}

/// Hash rows `[from, to)` and route each fingerprint into its pile file.
///
/// Returns one path per pile, in pile order. Nothing is sorted here — a pile is
/// sorted by whoever picks it up.
#[allow(clippy::too_many_arguments)] // one pile writer, and every knob it needs
pub fn write_piles(
    resolvers: &[Box<dyn Fn(usize) -> String + '_>],
    from: usize,
    to: usize,
    dir: &Path,
    prefix: &str,
    buckets: usize,
    join: &str,
    on_progress: crate::engine::Watch<'_>,
) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::with_capacity(buckets);
    let mut writers = Vec::with_capacity(buckets);
    for b in 0..buckets {
        let path = dir.join(format!("{prefix}-{b}"));
        writers.push(Writer::create(&path)?);
        paths.push(path);
    }

    // About one report per half-percent of the range: cheap enough to leave on always.
    let report_every = ((to - from) / 200).max(1);
    for row in from..to {
        if let Some(report) = on_progress {
            if (row - from) % report_every == 0 {
                report("uniq-scan", row - from, to - from);
            }
        }
        let mut key = String::new();
        for (r, resolver) in resolvers.iter().enumerate() {
            if r > 0 {
                key.push_str(join);
            }
            key.push_str(&resolver(row));
        }
        let (hi, lo) = hash64(&key);
        writers[bucket_of(hi, buckets)].write(hi, lo, row as u64)?;
    }
    for writer in writers {
        writer.finish()?;
    }
    Ok(paths)
}

/// Sort any number of fingerprint files into ONE sorted file. Returns the count.
///
/// The records are sorted AS BYTES. Because the encoding is big-endian and
/// fixed width, that is exactly `(hi, lo, index)` ascending — no comparator to
/// reproduce, and no way for two implementations to disagree about the order.
pub fn sort_files(inputs: &[PathBuf], out_path: &Path, tmp_root: &Path) -> Result<usize, String> {
    let dir = tmp_root.join(format!("tdc-fp-sort-{}", std::process::id()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let mut runs: Vec<PathBuf> = Vec::new();
    let mut total = 0usize;
    let mut batch: Vec<[u8; RECORD_BYTES]> = Vec::new();

    let result = (|| -> Result<usize, String> {
        for input in inputs {
            for record in read_records(input)? {
                batch.push(record);
                total += 1;
                if batch.len() >= SORT_BATCH {
                    runs.push(write_run(&mut batch, &dir, runs.len())?);
                }
            }
        }
        if !batch.is_empty() {
            runs.push(write_run(&mut batch, &dir, runs.len())?);
        }
        merge_runs(&runs, out_path)?;
        Ok(total)
    })();

    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn write_run(
    batch: &mut Vec<[u8; RECORD_BYTES]>,
    dir: &Path,
    index: usize,
) -> Result<PathBuf, String> {
    batch.sort_unstable();
    let path = dir.join(format!("run-{index}"));
    let file = File::create(&path).map_err(|e| e.to_string())?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    for record in batch.iter() {
        out.write_all(record).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())?;
    batch.clear();
    Ok(path)
}

fn merge_runs(runs: &[PathBuf], out_path: &Path) -> Result<(), String> {
    // Each run is read whole rather than streamed: a run is at most SORT_BATCH
    // records, and the merge holds one run at a time plus one head per run.
    let mut sources: Vec<Vec<[u8; RECORD_BYTES]>> = Vec::with_capacity(runs.len());
    for run in runs {
        sources.push(read_records(run)?);
    }
    let mut at: Vec<usize> = vec![0; sources.len()];

    let file = File::create(out_path).map_err(|e| e.to_string())?;
    let mut out = BufWriter::with_capacity(1 << 20, file);
    loop {
        let mut best: Option<usize> = None;
        for (r, source) in sources.iter().enumerate() {
            if at[r] >= source.len() {
                continue;
            }
            match best {
                None => best = Some(r),
                Some(b) => {
                    if source[at[r]] < sources[b][at[b]] {
                        best = Some(r);
                    }
                }
            }
        }
        let Some(r) = best else { break };
        out.write_all(&sources[r][at[r]]).map_err(|e| e.to_string())?;
        at[r] += 1;
    }
    out.flush().map_err(|e| e.to_string())
}

/// Row groups that share a fingerprint, from a SORTED file.
///
/// Candidates, not verdicts: a 64-bit collision between different tuples lands
/// here too, so the caller recomputes the true tuples and keeps only the rows
/// that genuinely repeat.
pub fn candidate_groups(sorted_path: &Path) -> Result<Vec<Vec<usize>>, String> {
    let records = read_records(sorted_path)?;
    let mut groups: Vec<Vec<usize>> = Vec::new();
    let mut current: Option<[u8; 8]> = None;
    let mut group: Vec<usize> = Vec::new();

    for record in &records {
        let mut head = [0u8; 8];
        head.copy_from_slice(&record[0..8]);
        if current != Some(head) {
            if group.len() >= 2 {
                groups.push(std::mem::take(&mut group));
            }
            group.clear();
            current = Some(head);
        }
        group.push(index_of(record) as usize);
    }
    if group.len() >= 2 {
        groups.push(group);
    }
    Ok(groups)
}

/// "Is this tuple already taken?" — answered by binary search on the sorted piles.
///
/// The sorted fingerprints ARE the ledger; a lookup is about twenty-five
/// record-sized reads and no resident memory. Rows being reassigned have their
/// old tuples freed, so a match counts only if some matching record's row is
/// not among them. A 64-bit collision can only make the answer "taken" for a
/// free tuple — the repair then picks another combination; it can never hide a
/// taken one.
pub struct Ledger {
    files: Vec<File>,
    counts: Vec<u64>,
    moving: HashSet<usize>,
}

impl Ledger {
    pub fn open(sorted_paths: &[PathBuf], moving: HashSet<usize>) -> Result<Self, String> {
        let mut files = Vec::with_capacity(sorted_paths.len());
        let mut counts = Vec::with_capacity(sorted_paths.len());
        for path in sorted_paths {
            let file = File::open(path).map_err(|e| format!("{}: {e}", path.display()))?;
            let size = file.metadata().map_err(|e| e.to_string())?.len();
            counts.push(size / RECORD_BYTES as u64);
            files.push(file);
        }
        Ok(Self {
            files,
            counts,
            moving,
        })
    }

    pub fn has(&mut self, key: &str) -> bool {
        let (hi, lo) = hash64(key);
        let pile = bucket_of(hi, self.files.len());
        let count = self.counts[pile];
        if count == 0 {
            return false;
        }

        let mut wanted = [0u8; 8];
        wanted[0..4].copy_from_slice(&hi.to_be_bytes());
        wanted[4..8].copy_from_slice(&lo.to_be_bytes());

        let mut probe = [0u8; RECORD_BYTES];
        let file = &mut self.files[pile];

        let mut low = 0u64;
        let mut high = count;
        while low < high {
            let mid = (low + high) / 2;
            if read_at(file, mid, &mut probe).is_err() {
                return false;
            }
            if probe[0..8] < wanted[..] {
                low = mid + 1;
            } else {
                high = mid;
            }
        }

        let mut at = low;
        while at < count {
            if read_at(file, at, &mut probe).is_err() {
                return false;
            }
            if probe[0..8] != wanted[..] {
                break;
            }
            if !self.moving.contains(&(index_of(&probe) as usize)) {
                return true;
            }
            at += 1;
        }
        false
    }
}

fn read_at(file: &mut File, ordinal: u64, into: &mut [u8]) -> Result<(), String> {
    file.seek(SeekFrom::Start(ordinal * RECORD_BYTES as u64))
        .map_err(|e| e.to_string())?;
    file.read_exact(into).map_err(|e| e.to_string())
}
