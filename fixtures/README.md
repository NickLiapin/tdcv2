# Regression Fixtures

This directory contains TDC DSL files and their expected outputs. All language
implementations must produce **bit-identical** output for each fixture when given
the same seed (specified inside each DSL file).

## Why bit-identical

Users of TDC should be able to develop locally in one language (e.g., TypeScript)
and run in production in another (e.g., Python) and get the same data. This
requires absolute behavioral equivalence across implementations.

See [../docs/bindings/](../docs/bindings/) — how one config runs in three languages for
the full rationale.

## Current fixtures (from the 2022-2024 prototype)

| File               | Output format                         | What it tests                                                         |
| ------------------ | ------------------------------------- | --------------------------------------------------------------------- |
| `tdc_csv.xml`      | CSV with header row                   | Basic block, file+template generators, date formatting                |
| `tdc_json.xml`     | JSON array of objects                 | `<before>` / `<after>` / `<before_block>` / `<after_block>` wrappers  |
| `tdc_sql.xml`      | `CREATE TABLE` + `INSERT` statements  | Multi-line `<before>`, generator interpolation inside string literals |
| `tdc_markdown.xml` | Pipe-separated markdown table         | Header formatting, inline multiple generators per line                |
| `tdc_txt.xml`      | Plain text with decorative delimiters | `<delimiter_block>` between cards                                     |

All five use the same seed (`674teyer74yTRGY7`), generating the same 10 patients
in different output formats. This **demonstrates the "one input, many formats"**
property of TDC — the main feature of the product.

## Expected outputs

Expected outputs are committed as `expected-<fixture-name>.out` alongside each
fixture. They are the **gold standard** that all language implementations must
reproduce exactly.

Additional focused fixtures cover newer runtime features such as parent-child
sequences, conditional rendering, and valid JSON comma handling.

## Cross-language fixture suite

`cross-language/` contains portable fixtures that future Python and Java ports
can consume directly:

- `cross-language/prng-vectors.json` — shared cyrb128+sfc32 PRNG golden values.
- `cross-language/hamilton-vectors.json` — exact percentage-distribution vectors.
- `cross-language/manifest.json` — runtime DSL fixtures plus expected outputs,
  rendered with a fixed clock.
- `cross-language/runtime/*.tdc` and `cross-language/expected/*.out` — focused
  end-to-end fixtures for newer deterministic generator features.

The TypeScript implementation has a dedicated test that reads these files from
disk instead of duplicating the expected values in test code. New language
implementations should copy that contract, not the TypeScript internals.

## Fixture evolution policy

- **Never modify a fixture's DSL** once it's checked in with expected output,
  unless the DSL syntax itself is intentionally changing.
- **If a generator's behavior changes** (bug fix or feature), the affected
  expected outputs are regenerated in a dedicated commit: `fix(engine): ...
(regenerates fixtures X, Y, Z)`. The diff of expected outputs is reviewed
  as part of the PR.
- **New DSL features** add **new** fixtures, don't modify old ones.

## References

- [../docs/guides/output-formats.md](../docs/guides/output-formats.md) — building any output format
