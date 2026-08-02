//! Writing Parquet, without a dependency.
//!
//! Every piece is written out — Snappy, Thrift's compact protocol, the RLE
//! hybrid, the plain encodings — for one reason: the five implementations
//! promise byte-identical files, and a library that changed its matcher, its
//! rounding or its page layout between versions would break that promise
//! silently. `fixtures/cross-language/parquet.json` pins six files by SHA256, so
//! it is byte-for-byte or nothing.

pub mod convert;
pub mod dictionary;
pub mod list_levels;
pub mod plain;
pub mod rle;
pub mod schema;
pub mod snappy;
pub mod statistics;
pub mod thrift;
pub mod writer;
