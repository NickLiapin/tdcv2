//! Reading what the pack registry publishes: a zip, and the digest that says it
//! arrived intact.
//!
//! Three small pieces written out rather than depended on — a hash, a
//! decompressor and a zip reader. The crate takes no dependencies, and each of
//! these is pinned to the standard that defines it, which is what makes a
//! hand-written one worth trusting.

pub mod inflate;
pub mod sha256;
pub mod zip;
