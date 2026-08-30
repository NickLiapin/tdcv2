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
`type="template"` draws from.

**Installed from crates.io, the crate already has data.** The starter set —
`common`, `en` and the USA country pack, 489 files — is compiled into the binary,
so `cargo install tdcv2` gives you something that works with no further steps.

86 languages and 161 country packs, each with the right check-digit
rule for its national ID formats, are a download away:

```bash
tdcv2 init                 # write a tdcv2.config.json, once per project
tdcv2 pack list            # what the registry has
tdcv2 pack add ru france   # download and wire up
```

One registry, one `tdcv2.config.json`, one store, shared by all five
implementations: a pack installed from here is a pack the others find. A folder
on disk always wins over the compiled-in copy, so a downloaded or hand-written
pack shadows the starter set without replacing it. The full story is in
[the data-packs guide](https://nickliapin.github.io/tdcv2/docs/data-packs/installing-packs).

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

## One value, without a config

Sometimes a test wants a name, not a dataset. The quick API answers from the same
data packs a config draws on, so the name in a unit test and the name in a
million-row fixture come from one list.

```rust
use tdcv2::quick::Quick;

let mut tdc = Quick::new();

tdc.get("person.lastName")?;            // Jones
tdc.get("person.male.firstName")?;      // Robert
tdc.get("usa.docs.ssn")?;               // 699209702 — with its real check digits
tdc.many("person.lastName", 5)?;        // five of them
tdc.gen("number", &[("value", "18..80")])?;
```

Values are random per process. Pin a seed when the value should be part of the
test rather than a variable in it — and `Quick::seeded` builds a NEW value, so two
tests can hold two seeds at once:

```rust
let mut demo = Quick::seeded("demo").locale("en");
demo.get("person.lastName")?;           // Jones, today and next year
```

The address is spelled the way the pack spells it: `person.male.firstName` here is
`person.male.firstName` in a config and in the reference. A bare address is read
against the active locale; write `ru.person.lastName` to name a pack outright.

**Why a string and not `tdc.person().last_name()`.** That shape needs a generated
function per address, and a generated surface can only ever cover the packs
compiled into the binary. Most packs are downloaded at runtime — 86 languages,
161 countries — so `tdc.lang().ru()` would not exist for the pack a user
had just installed, while `get("ru.person.lastName")` works the moment the
download finishes.

Every call is independent: nothing here ties one value to another. The moment two
values have to agree, you want a config.

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
