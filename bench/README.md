# Cross-language benchmark

Three implementations, one config, the same stopwatch. The question is not "which language is
fastest" in the abstract — it is whether three ports held to producing **identical bytes** also
cost roughly the same to run, and where they do not, by how much.

```bash
python3 bench.py --tier short                   # 10 000 rows, all three engines
python3 bench.py --tier medium --repeats 2      # 1 000 000 rows
python3 bench.py --tier large --engines 2,3 --repeats 1   # ~1 GB of output
python3 report.py results/*.json > results/REPORT.md
```

## What is held equal

|               |                                                                                                                                                                                                                                                                                                                                         |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The config    | One file per scenario. Only `count` and `engine` are substituted, so all three read the same bytes.                                                                                                                                                                                                                                     |
| The clock     | `now` is pinned, so a date generator cannot drift between runs.                                                                                                                                                                                                                                                                         |
| The API       | The **library**, single-threaded, in all three. `writeFile` straight to disk.                                                                                                                                                                                                                                                           |
| The stopwatch | `/usr/bin/time -l` outside the process. No implementation times itself.                                                                                                                                                                                                                                                                 |
| The result    | Compared by SHA-256 across the three languages, within one engine. A speed figure for a run that produced different data would be worthless, so a mismatch fails the row. Engines are not compared to each other — they legitimately produce different rows from the same seed, so a difference there would be no evidence of anything. |

**Not the TypeScript CLI.** It spreads a run across worker processes, and neither of the other two
has anything like it. Timing that against them would measure a feature rather than a language. The
parallel numbers live in `temp_docs/performance-log.md` and are a separate question.

## Two things the numbers do not mean

**Peak RSS is not "memory needed" for the JVM.** Java's heap grows until a collection is worth
running, so its RSS reflects what it was _allowed_ to take, not what it had to have. Read the Java
memory column as an upper bound; `-Xmx` moves it.

**Startup is included, and at the short tier it is most of the figure.** That is on purpose — it is
what a user waiting for a small file actually experiences. At the medium and large tiers it
disappears into the noise.

## The configs

- `customers.tdc` — six fields of different costs: a counter, two data-pack lookups, an exact
  percent split, a number with decimals, an ISO date, and an address built from two other columns.
  A config made only of counters would measure the loop rather than the generators.
- `uniq.tdc` — where engine 3 differs from engine 2 at all. Without `uniq=` the exact engine does
  exactly what the streaming one does, so timing them on the same config would only prove they
  share code. Three columns of 150 values give 3 375 000 combinations, so a million rows fill about
  a third of the space — tight enough that the arrangement costs something, loose enough that it
  stays feasible.

## Tiers

| Tier   |       Rows |  Output | Why                                                     |
| ------ | ---------: | ------: | ------------------------------------------------------- |
| short  |     10 000 | ~0.7 MB | The size a test fixture actually is. Startup dominates. |
| medium |  1 000 000 |  ~70 MB | Steady state — the generators, not the process.         |
| large  | 14 900 000 |   ~1 GB | Where holding the run in memory stops being free.       |

Engine 1 holds every column in memory, so the large tier was expected to be out of reach for it. On
a 32 GB machine it was not — all three languages finished, at 3.6 to 8.2 GB of resident memory. The
figures are in the report; on a smaller machine that row is where the streaming engines stop being
an optimisation and become the only option.

## Results

[`results/FINDINGS.md`](results/FINDINGS.md) — what the numbers mean.
[`results/REPORT.md`](results/REPORT.md) — the tables, regenerated from the JSON.
