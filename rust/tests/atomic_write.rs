//! A run's output reaches its destination whole, or not at all.
//!
//! The shared CLI fixture pins what matters most — a failed run leaves the previous file byte for
//! byte, for text, Parquet and a parallel run. These pin the edges a config cannot reach: a link
//! stays a link, a device is written in place, and a failure halfway takes its partial file with
//! it.

use std::io::Write;

use tdcv2::output::atomic::{partial_path, Pending};

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("tdc-atomic-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn replaces_the_destination_only_when_committed() {
    let dir = scratch("commit");
    let out = dir.join("out.csv");
    std::fs::write(&out, "old\n").unwrap();
    let (mut file, pending) = Pending::create(&out).unwrap();
    file.write_all(b"new\n").unwrap();
    drop(file);
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "old\n");
    assert!(partial_path(&out).exists());
    pending.commit().unwrap();
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "new\n");
    assert!(!partial_path(&out).exists());
}

#[test]
fn dropped_without_a_commit_leaves_the_destination_and_no_partial_file() {
    let dir = scratch("drop");
    let out = dir.join("out.csv");
    std::fs::write(&out, "old\n").unwrap();
    {
        let (mut file, _pending) = Pending::create(&out).unwrap();
        file.write_all(b"half of a ").unwrap();
    }
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "old\n");
    assert!(!partial_path(&out).exists());
}

#[cfg(unix)]
#[test]
fn writes_through_a_symbolic_link_which_stays_a_link() {
    let dir = scratch("link");
    let real = dir.join("real.csv");
    let link = dir.join("link.csv");
    std::fs::write(&real, "old\n").unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let (mut file, pending) = Pending::create(&link).unwrap();
    file.write_all(b"new\n").unwrap();
    drop(file);
    pending.commit().unwrap();
    assert!(std::fs::symlink_metadata(&link)
        .unwrap()
        .file_type()
        .is_symlink());
    assert_eq!(std::fs::read_to_string(&real).unwrap(), "new\n");
}

#[cfg(unix)]
#[test]
fn writes_a_device_in_place() {
    let (mut file, pending) = Pending::create(std::path::Path::new("/dev/null")).unwrap();
    file.write_all(b"x").unwrap();
    drop(file);
    pending.commit().unwrap();
}
