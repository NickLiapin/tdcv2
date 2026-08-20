//! TDC — The Data Constructor.
//!
//! Deterministic test data from a declarative config. The same `.tdc` file, run
//! with the same seed, produces the same bytes here as in the TypeScript
//! reference and in the Java, Python and C# ports. That guarantee is checked,
//! not asserted: `fixtures/cross-language/` holds the cases all five answer to.
//!
//! [`Tdc`] is the entry point: a config file or a config string in, text or
//! addressable rows out. Everything below it is public too, because a port is
//! also a reference — a caller comparing this implementation with another needs
//! to reach the same pieces.

pub mod archive;
pub mod cli;
pub mod compute;
pub mod date;
pub mod distribution;
pub mod engine;
pub mod errors;
pub mod expr;
pub mod format;
pub mod generators;
pub mod json;
pub mod math;
pub mod model;
pub mod numbers;
pub mod output;
pub mod packs;
pub mod parser;
pub mod pattern;
pub mod pretty;
pub mod prng;
pub mod quick;
pub mod sequence;
pub mod stats;
pub mod tdc;
pub mod unicode;
pub mod validator;

pub use errors::{Diagnostic, Severity};
pub use tdc::{Column, Nested, Options, Plan, Row, Seed, Tdc, TdcError};
