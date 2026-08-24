# Heavy tests — local only, never in CI

These generate real files of gigabyte scale. They exist because the bugs they
catch cannot be caught any other way: a memory appetite that only shows past a
hundred million rows, a repair cap that only trips past a hundred thousand
collisions, a progress channel that only proves itself over a run long enough to
watch. Every one of them was written after a real failure, and the failure is
named in the test.

They do **not** run in `npm test`, and they must **never** run in CI. A single
one writes 10 GB and takes half an hour; a runner would be out of disk before it
was out of minutes, and the free Actions budget would go with it. The protection
is structural rather than a promise:

- `vitest.config.ts` includes only `test/**/*.test.ts`, and these are
  `*.heavy.ts` — the default run cannot see them.
- `npm run test:heavy` points vitest at this directory explicitly.
- Each file refuses to run when `CI` is set in the environment, so even a
  mistaken workflow line fails loudly instead of burning an hour.

## Running them

```bash
cd typescript
npm run test:heavy              # all of them, ~1 hour, ~25 GB of disk
npm run test:heavy -- progress  # one file
```

Check the disk first: the largest needs 25 GB free and cleans up after itself,
including when it fails.

## What each one is for

| File                      | Proves                                                                                                                                                                                               | Costs          |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `memory-ceiling.heavy.ts` | Memory does not grow with the file: ten million rows with the heap capped at 512 MB. The cap is the point — an appetite that came back would die here instead of quietly using more.                 | ~70 s, 150 MB  |
| `progress.heavy.ts`       | The status file moves through every phase on a real run and its mtime is a usable heartbeat, polled from outside the process — and a PARALLEL run is counted whole rather than one worker at a time. | ~35 s, 300 MB  |
| `uniqueness.heavy.ts`     | Every row of a two-million-row file is distinct, counted with an external sort — not sampled — and the thread count does not change a byte.                                                          | ~2 min, 100 MB |

They are cheaper than they were: the fingerprint work cut both the time and the
scratch space by roughly an order of magnitude, and the configs were narrowed to
the smallest that still exercise the machinery. The 10 GB and 20 GB runs in the
table below are not tests — they were done by hand, and the numbers are kept
here so a future run has something to compare against.

## What covers the progress channel, and where

Three layers, and only the third is here:

- The unit tests pin the SHAPE of a report — phases in order, `done` monotone, every
  phase closing at its total.
- `fixtures/cross-language/cli.json` pins the command line in all five: `--progress`
  writes a status file that ends in `done` at 100%, and refuses without `-o`. That is
  the part that has to be identical everywhere, so it lives with the other shared
  cases rather than in one implementation's tests.
- `progress.heavy.ts`, here, is the only place the channel is watched over a run long
  enough for the intermediate phases to appear at all. A three-row run finishes before
  the first throttled report is due; the fixture above can therefore only assert on
  the last write, and this fills that gap.

  Its second case is about the PARALLEL path, which is the ordinary one: above a
  hundred thousand rows the CLI splits the run by itself. That case was silent for a
  while — every worker rendered its range without telling anyone, so an eleven-second
  run reported one line — and no cheap test could have caught it, because the split
  only happens on runs too big for a fast suite.

The four ports have the first two layers. They have no heavy suite of their own — the
engine behaviour they would exercise is already pinned byte for byte by the shared
cases, and four more gigabyte-scale suites would cost hours to buy a second opinion on
the same numbers.

## Two traps these tests fell into first

Both are worth knowing, because a new heavy test can fall into either.

**Waiting for an event that already happened.** The progress test subscribed to
the child's `exit` after its polling loop, and the run finishes in half a
minute — so the event had fired before anyone was listening, and the test hung
until its own thirty-minute timeout. Subscribe first, poll second.

**Measuring the fallback instead of the engine.** The memory test first used a
narrow config: 400 x 500,000 for ten million rows collides about 250,000 times,
which trips the repair cap, and the run correctly falls back to the in-memory
engine — which cannot fit under a 512 MB cap. It failed, and it was right to,
but it was not measuring what its name said. A heavy test whose config decides
which engine runs has to say which engine it means.

## The numbers these came from

Recorded on Nick's machine (12 cores, 32 GB) so a future run has something to
compare against:

- 20 GB / 194,011,420 rows, one thread, heap capped at 1 GB: 84 min, peak
  0.87 GB, all rows distinct.
- 10 GB / 97,005,710 rows, one thread, heap capped at 640 MB: ~35 min.
- 10 GB, eleven threads: ~10 min, peak 13.5 GB.
- 1 GB, eleven threads: 55 s.

Before the fingerprint work the same 10 GB run died twice — out of heap at
4.2 GB, then at V8's hard limit of ~16.7 million set entries — after half an
hour, with nothing written.
