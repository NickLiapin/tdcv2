# What the measurements say

The tables are in [REPORT.md](REPORT.md); this is what they add up to. Every figure below was
measured on one machine on 26 July 2026 and is reproducible with the commands in
[../README.md](../README.md).

|            |                                             |
| ---------- | ------------------------------------------- |
| Machine    | Apple M2 Max, 12 cores, 32 GB, macOS 26.5.1 |
| TypeScript | Node v20.19.0                               |
| Java       | OpenJDK 20                                  |
| Python     | CPython 3.10.12                             |

Single-threaded library calls in all three. Wall clock and peak RSS from `/usr/bin/time -l`,
outside the process, so nothing times itself.

The Python column was re-measured after the optimisation described below; the TypeScript and Java
columns are the first run's, untouched. Every digest matched across the change, so the two sets of
Python numbers describe the same output.

## The three ports agree about the data

Every cell was digested with SHA-256 and compared across the languages. All 45 matched — including
the gigabyte, where the three implementations wrote 1 112 473 175 identical bytes on the streaming
engine. This is the precondition for any of the speed numbers meaning anything: they are three
timings of the same work, not three timings of three different jobs.

**Across engines the bytes differ, and that is the documented behaviour, not a defect.** On
`customers.tdc` engine 1 and engine 2 disagree on every single row at every size — the engines draw
in a different order, so the same seed lands on different values. What they do preserve exactly is
what was declared: at 10 000 rows the `percent="70,20,10"` split came out 7 000 / 2 000 / 1 000
under all three engines, to the row. Reproducibility is per engine, and the determinism page says
so.

Engines 2 and 3 match each other byte for byte on `customers.tdc`, which is expected — that config
has no `uniq=`, so the exact engine has nothing extra to do and runs the streaming code. On
`uniq.tdc` at a million rows the pairing flips: **engine 3 matched engine 1** and engine 2 differed,
which is what "exact on disk" is supposed to mean — engine 3 reproduces the in-memory arrangement
without holding the rows, while engine 2 gives its own uniform spread of combinations. At 10 000
rows all three differed; the small-run arrangement has slack that each engine fills its own way.

## Java is fastest, TypeScript is close, Python is behind

At the gigabyte on the streaming engine: Java 64 s, TypeScript 87 s, Python 11 m 41 s.

The Java–TypeScript gap is steady at about 1.4× and does not grow with size. The Python gap does:
×10.2 at a million rows, ×11.0 at fifteen million. Startup costs amortise away and what remains is
the per-row cost of the interpreter.

Throughput on that run — Java 233 000 rows/s, TypeScript 172 000, Python 21 000.

## Python's gap depends on the config, not on Python

| Config          | Engine        | Python vs Java |
| --------------- | ------------- | -------------: |
| `customers.tdc` | 2 — streaming |          ×11.0 |
| `customers.tdc` | 1 — in memory |           ×5.8 |
| `uniq.tdc`      | 2 — streaming |           ×7.6 |
| `uniq.tdc`      | 1 — in memory |           ×3.5 |

The worst case is the streaming engine on a config with real per-value work. Engine 2 builds a
fresh seekable PRNG from `seed|stream|index` for every value it produces — that is what makes a row
addressable by index, and it is nearly free under a JIT and expensive in CPython. `uniq.tdc` does
most of its thinking once, up front, so Python closes to within 3.5×.

**Where Python is competitive:** small runs (0.21 s against Java's 0.15 s on `uniq.tdc`), and
anything where the arrangement dominates the per-row work.

## Most of Python's gap was the port, not the language

The first run put Python at ×24 against Java on the gigabyte. Profiling a million rows found the
time in four places, none of them the generators:

| What                                       | Why it cost                                                     | Fix                                                         |
| ------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------- |
| 70M calls to a one-line `_u32`             | A Python frame built and torn down to evaluate one `&`          | Masks written inline                                        |
| cyrb128 re-hashing the whole seed per draw | Only the index at the end of `seed\|stream\|index` changes      | The hash is resumable; the prefix is folded once per stream |
| 11.8M `startswith` calls                   | One date format string re-split per row, same answer every time | Formats compiled once and cached                            |
| A regex per row on `from`/`to`             | Two constants from the config, re-parsed for every row          | Cached, and `dataclasses.replace` dropped from the hot path |

A million rows on engine 2 went from 100.2 s to 45.8 s; the gigabyte from 25 m 53 s to 11 m 41 s.
Output byte-identical — the cross-language fixtures are what says so, not the timings.

**Then processes.** A row is a function of its own index, so shards need no coordination at all —
which is the whole reason the seekable generator exists. `write_file(workers="auto")` splits a run
across one process per core bar one:

| Gigabyte, engine 2              |         Time | vs the first run |
| ------------------------------- | -----------: | ---------------: |
| Python, first measurement       |    25 m 53 s |                — |
| Python, after the hot-path work |    11 m 41 s |             2.2× |
| Python, 11 processes            | **1 m 27 s** |        **17.9×** |

At 87 s Python on eleven cores lands within a second of TypeScript's single-threaded 87 s, and 36 %
behind Java's 64 s. The output is byte-identical to the single-process run, which is the only
reason the comparison is worth making.

**This is not in the tables above, deliberately.** Those measure one thread in every language,
because the TypeScript CLI has worker parallelism the Java and Python libraries do not, and timing
that against them would compare a feature rather than a language. The parallel figure belongs here,
labelled, rather than in a column that claims to be like-for-like.

## On plain configs the in-memory engine is the fast one, and it costs

Contrary to what "streaming" suggests, engine 1 beat engine 2 at every size on `customers.tdc`:

| Gigabyte, engine 1 vs engine 2 |       TypeScript |             Java |                Python |
| ------------------------------ | ---------------: | ---------------: | --------------------: |
| Time                           |     51 s vs 87 s |     41 s vs 64 s | 3 m 57 s vs 11 m 41 s |
| Peak RSS                       | 3.6 GB vs 290 MB | 8.2 GB vs 396 MB |       8.2 GB vs 31 MB |

Engine 1 is 1.6–1.7× faster in Java and TypeScript and 3× faster in Python — for 12× to 266× the
memory. The tradeoff is exactly the one the engine selector exists to make. All three did fit a
gigabyte in memory on a 32 GB machine, which is worth knowing, but on a smaller one the streaming
engines are not an optimisation, they are the only option.

**This reverses on `uniq.tdc`.** At a million rows engine 1 took 3.70 s against engine 2's 2.28 s in
TypeScript and 2.64 s against 1.32 s in Java — slower, and at four times the memory. Only Python
still preferred it (9.33 s against 10.07 s). Engine 1 has to materialise every column before it can
arrange anything, and on a config whose cost _is_ the arrangement it pays that twice over. The
earlier worst-case measurement in `temp_docs` — a five-column compound `uniq` where engine 1 needed
an estimated 14 GB and never finished — is the same effect taken to its limit.

So the rule is not "in memory is faster". It is: **in memory is faster when the work is per-row, and
loses when the work is choosing which rows exist at all.**

## Streaming memory really is flat

Peak RSS on the streaming engine, from 10 000 rows to 14 900 000 — a 1 490× increase in output:

|            | 10 000 | 1 000 000 | 14 900 000 |
| ---------- | -----: | --------: | ---------: |
| TypeScript | 128 MB |    282 MB |     290 MB |
| Java       | 112 MB |    399 MB |     396 MB |
| Python     |  31 MB |     31 MB |      31 MB |

Python's figure does not move at all. TypeScript and Java settle after the first size and stay
there. The bound is real, not asymptotic hand-waving.

Note that engine 3's bounded memory is conditional. Without `uniq=` it matches engine 2 exactly
(31 MB in Python at the gigabyte). With `uniq=` the arrangement lives in memory and only the output
streams: 550 MB in Python and 985 MB in TypeScript at a million rows.

## Two things these numbers are not

**The JVM's RSS is what it was allowed to take, not what it needed.** Java's 8.2 GB on engine 1 is
heap grown until a collection was worth running; `-Xmx` moves it. Read the Java memory column as an
upper bound.

**This is the library, single-threaded.** The TypeScript CLI spreads a run across worker processes
and neither of the other two has anything like it. Timing that here would have measured a feature
rather than a language.
