# Cross-Language Determinism Fixtures

This directory contains implementation-neutral fixtures for all future TDC
ports. TypeScript is the reference implementation; Python and Java must read the
same files and reproduce the same values byte-for-byte.

## Files

- `manifest.json` lists runtime DSL fixtures and their expected output files.
- `prng-vectors.json` stores the first PRNG values for stable seed strings.
- `hamilton-vectors.json` stores exact percentage-distribution outputs.
- `runtime/*.tdc` contains focused DSL fixtures for newer runtime features.
- `expected/*.out` contains byte-exact output for `runtime/*.tdc`.

## Rules For Future Ports

1. Run every PRNG vector exactly as written.
2. Run every Hamilton vector with the listed seed, count, values, and percents.
3. Render every runtime fixture from `manifest.json` with the listed
   `fixedNow` timestamp.
4. Treat expected output files as binary text fixtures. Do not trim trailing
   whitespace or normalize newlines.

If a language cannot pass these fixtures, it is not compatible with the
TypeScript reference implementation yet.
