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

**Three unique moats:**

1. **Any text output format constructed in DSL.** No list of formats — users build
   CSV, JSON, SQL, YAML, Markdown, or any custom format via `<before>`, `<after>`,
   `<block>` wrappers.
2. **Hierarchical probabilistic dependencies.** `<sequence parent="Gender.Man">` —
   child distributions applied to parent subsets. Unavailable in faker-type tools.
3. **Pattern-graph distributions** (shipped). Users draw an SVG/PNG curve, TDC uses
   its shape as a probability distribution — signal, corridor, and density modes.
   Nobody else does this.

Plus: deterministic via seed, exact proportions via the Hamilton method. It is
**cross-language** — one config, byte-identical output in TypeScript, Python, Java,
C# and Rust — and that is checked rather than claimed: `fixtures/cross-language/`
holds the cases all five answer to, including 6 Parquet files pinned by SHA-256.
TypeScript is the reference; the other four are complete ports of it.

---

## Getting started

### Library usage

```typescript
import { TDC, tdcv2 } from "tdcv2";

const config = `
<tdc version="0.1">
  <env count="3" seed="demo">
    <sequence name="Gender">
      <gen type="text" value="Male,Female" percent="50,50"/>
    </sequence>
    <sequence name="Code">
      <gen type="number" value="0000..9999"/>
    </sequence>
  </env>
  <block>
    <line><data>\${{_count}},\${{Gender}},\${{Code}}</data></line>
  </block>
</tdc>`;

const dataset = new TDC({ configString: config });

console.log(dataset.toString()); // text output from <block>/<line>/<data>
dataset.toStream().pipe(fs.createWriteStream("./out.csv"));
console.log(dataset.toArray()); // object rows from <sequence> declarations
```

### CLI usage

Install it and run it:

```bash
npm install -D tdcv2
npx tdcv2 init
npx tdcv2 tdcv2-examples/01-starter.tdc
```

`init` writes a config and three worked examples into `tdcv2-examples/`, then
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
**0.2.1** — npm, PyPI, Maven Central, NuGet and crates.io. Equal version numbers
are not a coincidence: they mean the same engine, so the same config and seed
produce the same bytes whichever registry the package came from.

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
