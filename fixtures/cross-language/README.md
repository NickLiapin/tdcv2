# Cross-Language Determinism Fixtures

This directory contains implementation-neutral fixtures for all future TDC
ports. TypeScript is the reference implementation; Python and Java must read the
same files and reproduce the same values byte-for-byte.

## Files

- `manifest.json` lists runtime DSL fixtures and their expected output files.
- `prng-vectors.json` stores the first PRNG values for stable seed strings.
- `hamilton-vectors.json` stores exact percentage-distribution outputs.
- `quick-vectors.json` stores the quick API's values — the one-call, no-config
  surface — including a 600-value draw that crosses the 512-row batch boundary,
  draws under five locales, and the messages the API raises when it cannot draw
  at all.
- `runtime/*.tdc` contains focused DSL fixtures for newer runtime features.
- `expected/*.out` contains byte-exact output for `runtime/*.tdc`.

## Rules For Future Ports

1. Run every PRNG vector exactly as written.
2. Run every Hamilton vector with the listed seed, count, values, and percents.
3. Render every runtime fixture from `manifest.json` with the listed
   `fixedNow` timestamp.
4. Reproduce every quick vector. The batch size, the `#<batch>` derived seed and
   the shape of the synthesised config are part of the contract, not an
   implementation detail: a value below 512 can agree while everything after it
   disagrees, which is why one vector deliberately runs past that line.
5. Run every `addresses` vector under the `locale` it names. An implementation
   that ignored the locale outright once passed this whole file, because all
   nine vectors said `en`. An address that names its own pack — `ru.person.…`,
   `usa.docs.…` — outranks the locale rather than being read beneath it.
6. Raise every `diagnostics` vector's message for the address it names. Where
   `verbatim` is true the wording is the contract, character for character;
   where it is false the message may be worded to suit the platform but must
   still carry every fragment in `contains` and none of those in `absent`. These
   sentences were written five times independently and converged by hand, which
   is exactly the kind of agreement that does not survive on its own.
7. Treat expected output files as binary text fixtures. Do not trim trailing
   whitespace or normalize newlines.

If a language cannot pass these fixtures, it is not compatible with the
TypeScript reference implementation yet.
