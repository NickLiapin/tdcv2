<a name="top"></a>

**English** · [Русский](../ru/bindings/rust.md#top) · [Español](../es/bindings/rust.md#top)

← Previous: [C#](./csharp.md#top) · **[Contents](../README.md#top)**

---

# Rust

The crate reads the **same `.tdc` config** and, for the same seed, produces the **same
output** as the TypeScript, Python, Java and C# implementations — byte for byte, on all
three engines and in Parquet.

One crate, library and command line together.

## Getting it

> [!NOTE]
> **Pre-release**
>
> Not on crates.io yet — `cargo add tdcv2` will not find it. Build from a checkout:
>
> ```bash
> cd rust && cargo build --release
> ./target/release/tdcv2 demo.tdc
> ```
>
> The crate takes **no dependencies**, so this needs nothing but a Rust toolchain. After
> the release it becomes `cargo add tdcv2` / `cargo install tdcv2`; see
> [Installation](../getting-started/installation.md#top).

## Using it

```rust
use tdcv2::Tdc;

let data = Tdc::from_file("users.tdc")?;
println!("{data}");

for row in data.rows() {
    println!("{:?}", row.get("Gender"));
}

data.write_file("users.csv")?;
```

## Rows, not strings

A row is the reason to use the library rather than the command line. A test that asserts
on `row.get("Gender")` says what it means; the same test parsing CSV back out of a string
spends most of its lines on the parsing.

Text output and row output read the same generated values, so the two can never disagree.
The row view ignores `<block>` and the text wrappers entirely — those describe a file
format, and a row has no format.

```rust
use tdcv2::{Options, Tdc};

let data = Tdc::new(Options {
    config_file: Some("users.tdc".into()),
    count: Some(100),                 // overrides what <env> declared
    seed: Some("test".into()),        // pins the run
    ..Options::default()
})?;

let first = data.row(0).unwrap();
println!("{:?}", first.get("Address.city"));   // a compound's field
println!("{:?}", first.nested()["Address"]);   // or the whole address at once
```

A sequence that does not apply to a row returns `None`, never `Some("")`. A column
declared `parent="Gender.Male"` has no value on a female row, and a blank would claim it
had one that happened to be empty.

## Options

| | |
| --- | --- |
| `config_file` / `config_string` | Exactly one of the two |
| `count`, `seed`, `locale` | Override what `<env>` declared |
| `engine` | Force engine 1, 2 or 3 instead of letting the config route |
| `now_millis` | Pin the clock, so a test asserting on a date does not expire overnight |
| `packs_dir`, `data_paths` | Where packs and `@data/…` sources are found |
| `base_dir` | What a relative `src=` is relative to |

A refused config comes back as `TdcError::Refused`, which carries the diagnostics **and**
the source they point into — so a caller can render the offending line rather than only
quote the message. `diagnostics()` on a successful run carries what the config was warned
about but not refused for. `seed()` reports whether the seed was generated: an unseeded
run is not reproducible, which is almost never what was wanted.

## No dependencies

The crate depends on nothing. Its lexer and parser are written by hand against the shared
grammar; so are the PRNG, the DEFLATE decompressor, SHA-256, the Thrift and Snappy
encoders behind the Parquet writer, and the PNG decoder that reads a
[drawing](../generators/pattern.md#top) into a curve.

That is not minimalism for its own sake. Every one of those has to produce the same bytes
as the other four implementations, and a crate that fixed a rounding rule or a hash in a
minor release would break the guarantee this project is built on without changing a line
of TDC.

The one exception is HTTPS, which needs a TLS stack nobody should hand-write. `tdcv2 pack`
and [`<gen type="http">`](../generators/http.md#top) run **curl** as a child process; if it
is missing, the command says so and prints the install line for the platform it is on.
Everything else — generating data, reading local packs, every output format — works
without it.

## Requirements

Rust **1.74** or newer.

---

← Previous: [C#](./csharp.md#top) · **[Contents](../README.md#top)**
