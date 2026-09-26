//! Writing a run's output so a failed run leaves the destination as it found it.
//!
//! The output is written to `<path>.partial` beside the destination and renamed over it only once
//! the run has finished; a run that fails drops the pending file, which removes the partial one and
//! never touches the destination. The rename is within one directory, so within one filesystem, and
//! therefore atomic: a reader sees the old file or the new one, never half of either.
//!
//! Measured before this module, on all five implementations: a run that failed with `-o out.csv`
//! destroyed an existing `out.csv` — four truncated it to nothing, and this one deleted it.
//!
//! A symbolic link is resolved first and its TARGET written, so the link stays a link. A
//! destination that exists and is not a regular file (`-o /dev/stdout`, a named pipe) cannot be
//! replaced by a rename, so it is written directly — and so is one whose directory refuses a file
//! beside it (`/dev/stdout` redirected to a file resolves to `/dev/fd/1`).

use std::fs::File;
use std::path::{Path, PathBuf};

/// The partial file beside a destination.
pub fn partial_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".partial");
    path.with_file_name(name)
}

/// A destination being written. Commit it and it replaces the destination; drop it and the
/// destination is exactly as it was.
pub struct Pending {
    temp: Option<PathBuf>,
    target: PathBuf,
}

impl Pending {
    /// Open `path` for a run's output: the file to write to, and what to commit afterwards.
    pub fn create(path: &Path) -> std::io::Result<(File, Pending)> {
        let (target, replaceable) = match std::fs::canonicalize(path) {
            Ok(real) => {
                let regular = std::fs::metadata(&real).is_ok_and(|m| m.is_file());
                (real, regular)
            }
            // Nothing there yet: a new file, which a rename can always make.
            Err(_) => (path.to_path_buf(), true),
        };
        if replaceable {
            let temp = partial_path(&target);
            if let Ok(file) = File::create(&temp) {
                return Ok((
                    file,
                    Pending {
                        temp: Some(temp),
                        target,
                    },
                ));
            }
        }
        // Written in place, by the name it was given — exactly as before this module.
        let file = File::create(path)?;
        Ok((file, Pending { temp: None, target }))
    }

    /// The finished output takes the destination's place.
    pub fn commit(mut self) -> std::io::Result<()> {
        match self.temp.take() {
            Some(temp) => std::fs::rename(&temp, &self.target),
            None => Ok(()),
        }
    }
}

impl Drop for Pending {
    fn drop(&mut self) {
        if let Some(temp) = self.temp.take() {
            let _ = std::fs::remove_file(temp);
        }
    }
}
