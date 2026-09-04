# TDC — The Data Constructor

> Declarative test-data generator — deterministic, exact proportions, any text format.

**Status:** v1.0 in development · pre-release · cross-language OSS project.

> **TDC and `tdcv2` — two names, two things.** **TDC** is the language: what a
> `.tdc` file contains and what the `TDC001`-style codes in error messages refer
> to. **`tdcv2`** is the package and the command that run it. The `v2` is there
> for a dull reason — `tdc` was already taken on npm and PyPI by unrelated
> packages — and it is not the version of the language: the package will still be
> called `tdcv2` at 1.0.

TDC builds realistic test and synthetic data from a short, declarative config.
Unlike random fakers or LLM-generated data, TDC is **deterministic** (same seed →
byte-identical output), produces **exact proportions**, and emits **any text
format you describe** — CSV, JSON, SQL, YAML, Markdown, or your own. A single
config runs identically in TypeScript, Python, Java, C# and Rust.

## Documentation

### 📖 **[nickliapin.github.io/tdcv2](https://nickliapin.github.io/tdcv2/docs/intro)**

Every implemented feature, with search, a sidebar and working anchors — in
**[English](https://nickliapin.github.io/tdcv2/docs/intro)** (canonical),
**[Русский](https://nickliapin.github.io/tdcv2/ru/docs/intro)** and
**[Español](https://nickliapin.github.io/tdcv2/es/docs/intro)**.

The same pages are also [in this repository](docs/) —
[ru](docs/ru/) · [es](docs/es/) — for reading without leaving GitHub, or offline.
They are generated from [`webdoc/`](webdoc/) and checked on every build, so the
copy and the site can never drift apart.

---

## What TDC does

TDC is a test/synthetic data generator with a custom DSL (XML-inspired but not XML).
Users describe **what** data they need via sequences with hierarchical dependencies,
and **how** it should be formatted via wrapper tags. The tool generates
deterministically (via seed) with exact percentage proportions, in any text format.

**Four unique moats:**

1. **Any text output format constructed in DSL.** No list of formats — users build
   CSV, JSON, SQL, YAML, Markdown, or any custom format via `<before>`, `<after>`,
   `<block>` wrappers.
2. **Hierarchical probabilistic dependencies.** `<sequence parent="Gender.Man">` —
   child distributions applied to parent subsets. Unavailable in faker-type tools.
   The numeric counterpart is `<gen type="formula" expr="…">`: a column computed from
   the others in its row — a weight that follows a height, a total that follows a price
   and a quantity — and a distribution parameter that can itself be an expression over
   another column (`lambda="Traffic * 0.1"`). Independent columns are what a model
   cannot learn anything from.
3. **Pattern-graph distributions** (shipped). Users draw an SVG/PNG curve, TDC uses
   its shape as a probability distribution — signal, corridor, and density modes.
   Nobody else does this.
4. **A real sample used as a distribution.** `read="quantile"` treats a file of
   measurements as a quantile function rather than a bag of values, so a thousand
   recorded amounts stretch to a million rows instead of collapsing into a comb of a
   thousand repeats; `sample="exact"` reproduces the sample with no sampling noise at
   all — measured, a worst deviation of 0.0000% across 99 quantiles.

Plus: deterministic via seed, exact proportions via the Hamilton method. It is
**cross-language** — one config, byte-identical output in TypeScript, Python, Java,
C# and Rust — and that is checked rather than claimed: `fixtures/cross-language/`
holds the cases all five answer to, including 6 Parquet files pinned by SHA-256.
TypeScript is the reference; the other four are complete ports of it.

---

## Getting started

Three ways in, and **you can stop at the first**. They are the same engine and the
same data; what changes is how much you have to say before it answers.

### 1. One value at a time — nothing to configure

The job a faker does. Import, call an address, get a string:

```typescript
import { tdc } from "tdcv2";

tdc.person.lastName(); // a different surname every run

// …or pin a seed, and the same values come back forever:
const demo = tdc.seed("demo");

demo.person.lastName(); // 'Jones'
demo.person.female.firstName(); // 'Linda'
demo.country.usa.geo.city(); // 'Los Angeles'
demo.commerce.department(); // 'Movies'
demo.gen.number("18..80"); // '66'
demo.person.lastName.many(3); // [ 'Bush', 'Armstrong', 'Andrews' ]
```

No config, no files, nothing to install beyond the package — those addresses come
from the data that ships with it. The seed is the one thing a faker does not give
you: a failing test that depends on generated data can be re-run and will fail the
same way. That is the whole API; [Quick
API](docs/getting-started/quick-api.md) is the rest of it.

### 2. A config in your code — when the values have to agree

The moment two fields must match — a name that follows a gender, a city that sits in
its country — independent calls stop being enough. Describe the row instead, and keep
working in your own language:

```typescript
import { TDC } from "tdcv2";

const users = new TDC({
  configString: `
<tdc>
  <env count="4" seed="demo">
    <sequence name="Gender"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
    <switch name="Name" on="Gender">
      <case is="Male"><gen type="template" value="person.male.firstName"/></case>
      <case is="Female"><gen type="template" value="person.female.firstName"/></case>
    </switch>
    <sequence name="Age"><gen type="number" value="18..65"/></sequence>
  </env>
  <block><line><data>\${{Gender}},\${{Name}},\${{Age}}</data></line></block>
</tdc>`,
});

users.toArray();
// [ { Gender: 'Female', Name: 'Mary',      Age: '59' },
//   { Gender: 'Male',   Name: 'James',     Age: '18' },
//   { Gender: 'Male',   Name: 'John',      Age: '53' },
//   { Gender: 'Female', Name: 'Elizabeth', Age: '24' } ]
```

Every name matches its gender, and the 50/50 split is exactly 50/50 — not
approximately. `toArray()` gives rows as objects, `toString()` the rendered text,
`toStream()` a stream for a large file.

### 3. A config file — when the dataset is the product

The same config in a `.tdc` file, run by the command line. No code at all, and the
file is the artefact: check it into the repository, and the fixture regenerates
byte-identically on any machine, in any of the five languages.

```xml title="users.tdc"
<tdc>
  <env count="4" seed="demo">
    <before><line><data>gender,name,age</data></line></before>

    <sequence name="Gender"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
    <switch name="Name" on="Gender">
      <case is="Male"><gen type="template" value="person.male.firstName"/></case>
      <case is="Female"><gen type="template" value="person.female.firstName"/></case>
    </switch>
    <sequence name="Age"><gen type="number" value="18..65"/></sequence>
  </env>
  <block><line><data>${{Gender}},${{Name}},${{Age}}</data></line></block>
</tdc>
```

```bash
npx tdcv2 users.tdc -o users.csv
```

```
gender,name,age
Female,Mary,59
Male,James,18
Male,John,53
Female,Elizabeth,24
```

The header came from `<before>`, the rows from `<block>` — which is why the output is
CSV here and could as easily be SQL, JSON or a format nobody has named: the layout is
something you spell out, not something you pick off a list.

### Installing, and where the examples come from

```bash
npm install -D tdcv2
npx tdcv2 init
npx tdcv2 tdcv2-examples/01-starter.tdc
```

The first line is all three ways above need. `init` writes a config and three worked examples into `tdcv2-examples/`, then
prints the command that runs the first one. **Those files exist only after
`init`** — nothing puts them there at install time, and once written they are
yours to edit. `npx` matters on npm: `npm install -D` leaves the command in
`node_modules/.bin` rather than on your PATH.

The same command line comes with all five packages — `pip install tdcv2`,
`cargo install tdcv2`, `dotnet tool install -g Tdcv2.Cli`, or the `cli` jar from
Maven Central. [Installation](docs/getting-started/installation.md) has the exact
line for each.

To run it from a checkout instead — while working on the engine itself:

```bash
npm --workspace typescript run build
node typescript/dist/cli/main.js tdcv2-examples/01-starter.tdc -o out.csv
```

---

## Project structure

```
tdcv2/
├── docs/                    The documentation, generated — read it here
│   ├── ru/, es/             The same pages in Russian and Spanish
│   └── img/                 Figures, shared by all three languages
├── webdoc/                  Its source: a Docusaurus site (en canonical, ru, es)
├── grammar/                 ANTLR4 grammar (TDCLexer.g4 + TDCParser.g4)
├── fixtures/                Regression test cases (+ cross-language/ vectors)
├── data/packs/              Locale-first data packs (word lists, locale data)
├── typescript/              TypeScript — the reference implementation
├── python/                  Python port  (library + CLI)
├── java/                    Java port    (library + CLI)
├── csharp/                  C# port      (library + CLI)
├── rust/                    Rust port    (library + CLI, no crate dependencies)
└── .github/                 CI workflows
```

**Starting from a fresh clone?** Each implementation's own README opens with a
quick start — what to install, how to build it, and one config to run so you see
output in under a minute:
[TypeScript](typescript/README.md) ·
[Python](python/README.md) ·
[Java](java/README.md) ·
[C#](csharp/README.md) ·
[Rust](rust/README.md). They all end at the same place: `tdcv2 pack add …` for
the data, from one shared registry.

**Principle:** one grammar (`grammar/TDCLexer.g4` + `grammar/TDCParser.g4`) is what
every implementation parses — through ANTLR where the runtime is available, and by
hand in Rust, which takes no dependencies. Each language directory is self-contained
with its own build, tests, and publishing pipeline (`npm`, `PyPI`, `Maven Central`,
`NuGet`, `crates.io`).

---

## Development

### Current phase

**Phase 1 / v1.0:** five implementations of one contract, all published at
**0.3.0** — npm, PyPI, Maven Central, NuGet and crates.io. Equal version numbers
are not a coincidence: they mean the same engine, so the same config and seed
produce the same bytes whichever registry the package came from. Maven Central
caps how many releases it accepts from a project each month, so the jar there can
fall a version behind; the documentation prints whichever version is actually on
Central rather than assuming the five agree.

- Parser from the shared grammar, with lexer modes for raw-text `<data>`
- Sequence engine with parent-child dependencies, on three engines: in memory,
  streaming, and exact-on-disk — the config picks, by what it asks for
- Multi-format text output via wrapper tags, plus a Parquet writer
- Library API and a CLI (`generate`, `check`, `format`, `init`, `pack`) in each
- Held together by `fixtures/cross-language/`: shared cases, diagnostics, engine
  comparisons, CLI behaviour, and Parquet files pinned by hash

The [documentation](docs/) describes every one of these as it actually behaves
today; the specification and risk analysis behind them are kept in the project's
internal notes.

### Principles (non-negotiable)

Key rules:

- **No source file exceeds 1000 lines** (enforced by linters).
- **Every feature has tests** — no tests, no merge.
- **Bit-identical determinism** — all language implementations produce identical
  output for same seed + same DSL file.
- **Conventional Commits** for commit messages.
- **Minimum external dependencies.** The TypeScript runtime deps are `antlr4ng`
  (parser runtime), `jsep` (expression parsing), `fflate` (zip, for data packs), and
  `@inquirer/prompts` (the `init` wizard). Everything else — PRNG, distributions, the
  Parquet writer, file I/O — uses the standard library. The Rust crate takes **no
  dependencies at all**: its lexer, parser, PNG decoder, DEFLATE, SHA-256, Thrift and
  Snappy are written out. New deps are added only with a documented justification
  (see [`DEPENDENCIES.md`](DEPENDENCIES.md)).

---

## License

[MIT](LICENSE) — Copyright (c) 2026 Nikolai Liapin.

TDC is and will remain open source without monetization plans. All features
equally accessible, all users equal, community-driven development.

---

## Background

This project began as an idea in 2022, with a working prototype developed
2022-2024 and then paused. This is a **full rewrite** begun in April 2026 based
on 4 years of refined vision. The original prototype's design decisions — both
wins and mistakes — were written up at the time and serve as the foundation for
this implementation.
