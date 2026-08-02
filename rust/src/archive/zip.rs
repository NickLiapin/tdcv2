//! Reading a zip: enough of it to unpack a pack bundle, and no more.
//!
//! The central directory at the end of the file is the index, and it is what is
//! read — not the local headers, because a local header may say the sizes are
//! "in a descriptor after the data", which cannot be found without already
//! knowing where the data ends. The central directory always has them.
//!
//! Two compression methods, which is what any zip writer produces for text:
//! stored and deflate.
//!
//! Entries are refused rather than sanitised when they would land outside the
//! target — an absolute path, or one that walks up with `..`. A malicious
//! archive writing over `~/.ssh/authorized_keys` is the oldest trick there is,
//! and a bundle is downloaded from the network.

use std::path::{Component, Path, PathBuf};

use super::inflate;

/// Why an archive could not be read.
#[derive(Clone, Debug)]
pub struct ZipError(pub String);

impl std::fmt::Display for ZipError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn fail<T>(what: impl Into<String>) -> Result<T, ZipError> {
    Err(ZipError(what.into()))
}

/// One file from the archive.
#[derive(Clone, Debug)]
pub struct Entry {
    /// The path as the archive wrote it, forward slashes and all.
    pub name: String,
    pub data: Vec<u8>,
}

const END_OF_DIRECTORY: u32 = 0x0605_4b50;
const DIRECTORY_ENTRY: u32 = 0x0201_4b50;
const LOCAL_HEADER: u32 = 0x0403_4b50;

/// Every file in the archive, in the order the directory lists them.
///
/// Directory entries — names ending in `/` — are left out: a zip records them
/// for tools that show a tree, and unpacking creates the folders anyway.
pub fn read(data: &[u8]) -> Result<Vec<Entry>, ZipError> {
    let end = find_end_of_directory(data)?;
    let count = u16::from_le_bytes([data[end + 10], data[end + 11]]) as usize;
    let mut at = u32::from_le_bytes([
        data[end + 16],
        data[end + 17],
        data[end + 18],
        data[end + 19],
    ]) as usize;

    let mut entries = Vec::with_capacity(count);
    for _ in 0..count {
        if at + 46 > data.len() || word(data, at)? != DIRECTORY_ENTRY {
            return fail("zip: the central directory is malformed");
        }
        let method = half(data, at + 10)?;
        let compressed = word(data, at + 20)? as usize;
        let uncompressed = word(data, at + 24)? as usize;
        let name_len = half(data, at + 28)? as usize;
        let extra_len = half(data, at + 30)? as usize;
        let comment_len = half(data, at + 32)? as usize;
        let local = word(data, at + 42)? as usize;

        let name_at = at + 46;
        let Some(raw) = data.get(name_at..name_at + name_len) else {
            return fail("zip: an entry name runs past the end of the file");
        };
        let name = String::from_utf8_lossy(raw).into_owned();
        at = name_at + name_len + extra_len + comment_len;

        if name.ends_with('/') {
            continue;
        }
        entries.push(Entry {
            data: body(data, local, method, compressed, uncompressed, &name)?,
            name,
        });
    }
    Ok(entries)
}

/// The entry's bytes, found through its LOCAL header and decompressed.
///
/// The local header is read only for the two lengths that say where the data
/// begins — the name and the extra field, which may differ from the central
/// directory's copies.
fn body(
    data: &[u8],
    local: usize,
    method: u16,
    compressed: usize,
    uncompressed: usize,
    name: &str,
) -> Result<Vec<u8>, ZipError> {
    if local + 30 > data.len() || word(data, local)? != LOCAL_HEADER {
        return fail(format!("zip: \"{name}\" has no local header"));
    }
    let name_len = half(data, local + 26)? as usize;
    let extra_len = half(data, local + 28)? as usize;
    let from = local + 30 + name_len + extra_len;
    let Some(raw) = data.get(from..from + compressed) else {
        return fail(format!("zip: \"{name}\" runs past the end of the file"));
    };

    match method {
        0 => Ok(raw.to_vec()),
        8 => inflate::inflate(raw, uncompressed)
            .map_err(|e| ZipError(format!("zip: \"{name}\": {e}"))),
        other => fail(format!(
            "zip: \"{name}\" uses compression method {other}, and only stored and deflate are read"
        )),
    }
}

/// The end-of-central-directory record, searched for from the back.
///
/// Backwards because it is the LAST such signature that counts, and a stored
/// entry may contain the same four bytes as its own data.
fn find_end_of_directory(data: &[u8]) -> Result<usize, ZipError> {
    if data.len() < 22 {
        return fail("zip: too short to be an archive");
    }
    // The record is 22 bytes plus a comment of up to 65535.
    let earliest = data.len().saturating_sub(22 + 0xffff);
    for at in (earliest..=data.len() - 22).rev() {
        if word(data, at)? == END_OF_DIRECTORY {
            return Ok(at);
        }
    }
    fail("zip: no end-of-central-directory record — not a zip, or truncated")
}

fn word(data: &[u8], at: usize) -> Result<u32, ZipError> {
    match data.get(at..at + 4) {
        Some(b) => Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]])),
        None => fail("zip: the file ends where a header was expected"),
    }
}

fn half(data: &[u8], at: usize) -> Result<u16, ZipError> {
    match data.get(at..at + 2) {
        Some(b) => Ok(u16::from_le_bytes([b[0], b[1]])),
        None => fail("zip: the file ends where a header was expected"),
    }
}

/// Unpack into `target`, refusing anything that would land outside it.
pub fn extract(data: &[u8], target: &Path) -> Result<usize, ZipError> {
    let entries = read(data)?;
    for entry in &entries {
        let path = safe_join(target, &entry.name)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| ZipError(format!("zip: cannot create {}: {e}", parent.display())))?;
        }
        std::fs::write(&path, &entry.data)
            .map_err(|e| ZipError(format!("zip: cannot write {}: {e}", path.display())))?;
    }
    Ok(entries.len())
}

/// `target` joined with an archive name, or a refusal.
///
/// An absolute name, a Windows drive letter, or a `..` that escapes is refused
/// by name rather than stripped: an archive that tried it is not one to unpack
/// a repaired version of.
fn safe_join(target: &Path, name: &str) -> Result<PathBuf, ZipError> {
    if name.starts_with('/') || name.starts_with('\\') || name.contains(':') {
        return fail(format!("zip: refusing an absolute entry name \"{name}\""));
    }

    let mut path = target.to_path_buf();
    let mut depth = 0i32;
    for part in name.split(['/', '\\']) {
        match part {
            "" | "." => continue,
            ".." => {
                depth -= 1;
                if depth < 0 {
                    return fail(format!(
                        "zip: refusing an entry that escapes the target: \"{name}\""
                    ));
                }
                path.pop();
            }
            _ => {
                // A component the OS reads specially is refused for the same
                // reason as `..`: what it means is not what the archive says.
                if Path::new(part).components().next() != Some(Component::Normal(part.as_ref())) {
                    return fail(format!("zip: refusing the entry name \"{name}\""));
                }
                depth += 1;
                path.push(part);
            }
        }
    }
    if depth <= 0 {
        return fail(format!("zip: refusing an entry with no name: \"{name}\""));
    }
    Ok(path)
}
