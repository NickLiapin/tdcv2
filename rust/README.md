# TDC — Rust Implementation

## Quick start

**You need:** **Rust 1.74 or newer** (install from https://rustup.rs). Nothing
else — this crate has **no dependencies at all**.

```bash
cd rust
cargo build --release
```

Then write a config and run it:

```xml title="demo.tdc"
<tdc>
  <env count="3" seed="demo" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Name"><gen type="template" value="person.lastName"/></sequence>
  </env>
  <block><line><data>${{Id}},${{Name}}</data></line></block>
</tdc>
```

```bash
cargo run --release --bin tdcv2 -- demo.tdc
```

Or, once built, straight from `target/release/tdcv2`.

```
1,Williams
2,Johnson
3,Smith
```

The same three names, every time, in every implementation — that is the whole
point of the `seed`.

### Data packs

A pack is the _data_ — the name lists, cities, streets and locale rules that
`type="template"` draws from. A starter set ships with the code: `common`, `en`
and the USA country pack, which is what the example above uses. Everything else
is downloaded on demand:

```bash
tdcv2 init                 # write a tdcv2.config.json, once per project
tdcv2 pack list            # what the registry has
tdcv2 pack add ru france   # download and wire up
```

One registry, one `tdcv2.config.json`, one store, shared by all five
implementations: a pack installed from here is a pack the others find. The full
story is in [the data-packs guide](../docs/data-packs/installing-packs.md).

## Using it as a library

```rust
use tdcv2::Tdc;

let data = Tdc::from_file("users.tdc")?;
print!("{data}");

for row in data.rows() {
    println!("{}", row.get("Gender").unwrap_or_default());
}

data.write_file("users.csv")?;
```

A sequence that does not apply to a row returns `None`, never `Some("")` — a
column declared `parent="Gender.Male"` has no value on a female row, and an
empty string would claim it had one that happened to be blank.

## The command line

```bash
tdcv2 <file.tdc>                          # generate
tdcv2 <file.tdc> -o users.csv             # the extension picks the format
tdcv2 check <file.tdc>                    # validate, silent when fine
tdcv2 format [-w] <file.tdc>              # pretty-print, -w rewrites in place
tdcv2 init                                # write a tdcv2.config.json
tdcv2 pack list | add <id> | remove <id>  # data packs
```

Flags: `--seed`, `--count`, `--locale`, `--data-path`, `--engine`.

## Why Rust

Two reasons, and neither is speed for its own sake.

**It is the honest test of the contract.** Rust shares nothing with the other
four — no ANTLR, no garbage collector, no floating-point defaults in common.
A parser written by hand from the same grammar, producing the same bytes, is
evidence the specification is real rather than an accident of one runtime.

**No dependencies.** Not one crate. The parser is hand-written, the HTTPS the
pack registry needs goes through `curl`, and the Parquet writer is ours. A build
that pulls nothing from the network is a build that still works in five years.

## What is here

```
src/
├── parser/      hand-written lexer and parser for the shared grammar
├── model/       Config and the config builder
├── sequence/    generators, pools, compounds, uniq and distinct
├── engine/      the three engines and the router that picks one
├── compute/     the checksum sub-language
├── validator/   every diagnostic, by code and position
├── packs/       the pack store, the registry client, addressing
├── output/      CSV, JSON, SQL, Parquet
└── bin/tdcv2.rs the command line
```

## Checks

```bash
cargo test        # the shared fixtures plus the crate's own tests
cargo clippy      # lints
cargo fmt --check # formatting
```

From the repository root, `npm run parity` runs this suite together with the
other four implementations and reports which of the five disagree.

## References

- [The documentation](../docs/README.md) — the language itself, in three
  languages
- [`fixtures/cross-language/`](../fixtures/cross-language/README.md) — the
  contract all five implementations are held to
- [`../CONTRIBUTING.md`](../CONTRIBUTING.md) — how a change lands in all five
