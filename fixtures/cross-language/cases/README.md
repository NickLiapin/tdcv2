# Shared behaviour cases

One case is a whole `.tdc` config plus the exact text it must render to. Every
implementation reads these files and compares bytes.

A case is a **config**, not a call to one function, and that is the point. It
means each language needs exactly one runner — parse, render, compare — instead
of a separate harness per generator, and it tests the wiring as well as the
arithmetic. A generator that computes correctly but is reached with the wrong
attributes fails here, where a unit test of the function alone would pass.

## Files

Each `*.json` groups cases by area. Every case has:

| field         | meaning                                                              |
| :------------ | :------------------------------------------------------------------- |
| `name`        | unique within the file; used in the test report                      |
| `description` | what the case pins down, in one line                                 |
| `config`      | the `.tdc` source                                                    |
| `expected`    | the exact output, as an array of lines                               |
| `seed`        | optional override of `<env seed>`                                    |
| `count`       | optional override of `<env count>`                                   |
| `locale`      | optional override of `<env local>`                                   |
| `now`         | optional clock, ISO-8601 — required by any case using dates          |
| `dataPath`    | optional folder, relative to THIS directory, where `src=` files live |

`dataPath` is how a `type="file"` case reaches its sample: the folder is resolved
against the cases directory, so `"dataPath": "data"` reads
`fixtures/cross-language/cases/data/`. Keep those samples SMALL and
hand-checkable — a shared fixture that nobody can verify by eye is a hash, not a
contract.

`expected` is an array of lines rather than one string only because a diff
between arrays reads far better in a failing test than a diff between two blobs.
The lines are joined with `\n` and a trailing newline; a config whose output does
not end in one cannot be expressed here, and none does.

## Regenerating

`expected` is produced by running the reference implementation, never written by
hand:

```
cd typescript && npm run cases:update
```

That command rewrites every `expected` from the current reference behaviour, so
it is also the review step: a diff in `expected` after an unrelated change is a
behaviour change that nobody asked for.

`npm run check` runs the same script in verify mode, which is what stops the
reference drifting away from the fixtures silently.

## Adding a case

Write the config, leave `expected` as `[]`, run `cases:update`, and read the
diff. If the output is not what the case is supposed to demonstrate, the config
is wrong — not the expectation.

Every case runs against the **in-memory engine**. The streaming engines compute
a row from its index and consume the generator in a different order, so they
produce different values from the same seed by design; mixing the two here would
compare two algorithms rather than two implementations.

## Beyond the cases: `npm run signature`

Six of the quantile cases pin ten lines each. The promises `read="quantile"`
exists for — a six-order-of-magnitude tail reproduced to 0.0000%, every
observation owning exactly its share, the comb gone — live on a hundred thousand
rows and cannot be written as bytes. `typescript/scripts/signature/quantile-signature.cjs`
asserts them directly against any implementation's CLI:

```
node scripts/signature/quantile-signature.cjs dist/cli/main.js
```

It builds its own samples, exits non-zero on failure, and is meant to be hung in
each port's CI. Fourteen checks; the reference passes all fourteen.

One thing to know before reading a failure as a defect: its reference quantile
uses the MIDPOINT convention, `sorted[i]` at `(i + 0.5)/n` — the same one the
engine uses. Computed against the ends, `i/(n-1)`, the same runs read about 1.3%
off, and that is two definitions of a quantile rather than an error.
