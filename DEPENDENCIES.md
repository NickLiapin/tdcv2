# Dependencies

TDC keeps its runtime dependency surface small on purpose: the PRNG, the statistical
distributions, the Parquet writer, and all file I/O are hand-written against each
language's standard library, so the same behaviour can be reproduced byte-for-byte in
the Python and Java ports. A new runtime dependency is added only with a justification
recorded here.

## TypeScript — runtime dependencies

| Package             | Why it is here                                                                                                                                               | Why not the standard library                                                                                                    |
| :------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| `antlr4ng`          | Runtime for the ANTLR-generated lexer/parser (`grammar/TDCLexer.g4` + `TDCParser.g4`). The grammar is the single cross-language source of truth for the DSL. | Hand-writing a parser for the raw-text `<data>` lexer modes would diverge from the other ports.                                 |
| `jsep`              | Parses the small expression language used in `if=` and compute predicates into an AST TDC then evaluates itself.                                             | A correct, precedence-aware expression parser is exactly the kind of thing worth not re-implementing three times.               |
| `fflate`            | Zip read/write for the bundled data packs (`build-data-packs`, `pack add`).                                                                                  | Node's `zlib` does raw deflate but not the zip container; `fflate` is dependency-free and works identically in a browser build. |
| `@inquirer/prompts` | The interactive `tdcv2 init` / `tdcv2 pack` wizards.                                                                                                         | Only reached by the interactive CLI, never by the library or generation path.                                                   |

## TypeScript — dev-only (not shipped)

`antlr-ng` (grammar codegen), `vitest` + `@vitest/coverage-v8` (tests), `eslint` +
`typescript-eslint` (lint), `prettier` (format), `typescript` (compiler), `hyparquet`
(reads the Parquet the writer produces, so the round-trip is asserted against an
independent reader), and the optional `vscode-languageserver*` peer deps for the LSP.
None of these are runtime dependencies.

## Not dependencies (deliberately hand-written)

- **PRNG** — `cyrb128` seeding plus a seekable Feistel/permutation substrate
  (`src/prng/`), so `value(i)` is reproducible and the streaming engines can seek.
- **Statistical distributions** — Lanczos gamma, regularized incomplete gamma/beta,
  bisection inverse-CDF (`src/generators/special.ts`), each consuming a fixed number
  of uniforms so the draw stays seekable and deterministic.
- **Parquet writer** — the Thrift/snappy/RLE/dictionary encoding is written from
  scratch (`src/output/parquet/`), no `parquetjs`.

These are the parts the Python and Java ports must reproduce exactly; a third-party
library in any one language would make byte-identical output across languages
impossible.
