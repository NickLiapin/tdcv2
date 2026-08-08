<a name="top"></a>

**English** · [Русский](../ru/guides/performance.md#top) · [Español](../es/guides/performance.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/performance)**

← Previous: [Writing a service generator](./writing-a-service.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../data-packs/overview.md#top) →

---

# Performance

How long a run takes, and how much memory it wants. Every number here was measured on one
machine by running the five published command lines against the same config — not estimated,
not remembered from a previous version.

The short answer, if that is all you need: **two million records of six fields take between
nine and fifteen seconds**, and on the streaming engine the memory does not grow with the row
count. Python is the outlier at about ninety seconds.

## What was measured, and how

The benchmark drives the command line each registry hands out, installed into a throwaway
directory. Nothing in it reads a checkout, which is also what makes it reproducible by
someone who is not us.

Every rule below exists to keep this a measurement rather than an advertisement:

- **The same config file**, byte for byte, with only `count` and `engine` substituted.
- **The engine is chosen in the config**, not on the command line, so all five are asked in
  the one way each certainly understands.
- **`--now` is pinned**, so a date generator cannot drift between runs.
- **`--jobs 1` everywhere.** TypeScript is the only implementation that spreads a run across
  workers; timing that against four single-threaded ones would measure a feature rather than
  an engine.
- **Wall clock and peak memory come from `/usr/bin/time -l`**, outside the process, so no
  implementation measures itself with its own timer.
- **Every output is hashed and the hashes must match.** A speed number for a run that produced
  different data is worthless, so a mismatch fails the row instead of being reported. All the
  numbers below come from runs that agreed to the byte.

### The machine

| | |
| :--- | :--- |
| Processor | Apple M2 Max, 12 cores (8 performance, 4 efficiency) |
| Memory | 32 GB |
| Storage | Apple SSD AP1024Z, 1 TB, APFS, TRIM on — 94% full at the time |
| System | macOS 26.5.1 |

**The storage does not matter as much as you would think, and that is worth showing rather
than asserting.** Sequential write on this volume measures 810 MB/s cold and about 1.3 GB/s
warm. The largest run here produces a 141 MB file, and writing 141 MB and flushing it takes
**0.24 seconds** measured directly — out of a nine-to-fifteen second run, so between two and
three percent, and a quarter of one percent for Python. These numbers are bound by the
processor, so you can scale them to your own machine by core speed and largely ignore your
disk. Nothing large is read: data packs are kilobytes and are cached after first use.

### The versions

Every number here was taken on the published **0.1.4**, exactly as a user installs it, with
one exception: Rust was built from source, because its published streaming engine still held
the whole run when writing to a file. That fix shipped in **0.1.5**, so the Rust figures are
what 0.1.5 does and the other four are what 0.1.4 did.

The engine changes between the two releases were a routing recovery and three diagnostic
messages — none of which touches how fast a row is produced or how much memory a run holds.

**These numbers have not been re-measured since.** The engine is at 0.2.0 now, and
the work in between was correctness and diagnostics rather than throughput, so the shape —
which engine wins where, how memory behaves — is the part to trust. Treat the absolute
seconds as a measurement of 0.1.5 on one machine, not as a promise about your own.

## The three engines, briefly

Nothing here needs choosing: **TDC picks the engine from your config, deterministically, and
the same config gets the same engine on every machine.** The tables are split by engine only
because that is what explains the shape of the numbers.

| Engine | What it does | What it costs |
| :----- | :----------- | :------------ |
| **1 — in memory** | Holds whole columns and answers instantly | Memory grows with the row count |
| **2 — streaming** | Resolves one row at a time | Memory stays flat; almost everything runs here |
| **3 — exact on disk** | Keeps promises about a **finished column**, such as `uniq` | Memory stays bounded, paid for with an external sort |

The difference between 2 and 3 is the one worth holding on to, and it is not a matter of
degree. Uniqueness is a promise about the **finished dataset**, not about any one row, so it
cannot be settled a row at a time — the streaming engine would have to know what comes next.
That is why the second table below compares engine 1 with engine **3**: engine 2 is not a
candidate for that config at all.

[Large outputs](large-outputs.md#top) has the full account, including the six config shapes that
send a run back to engine 1.

## An ordinary config

Six fields chosen to cost different things rather than to look realistic: a counter, two
weighted draws from a data pack, an exact percentage split, a decimal number, a date, and a
value assembled from two others.

```xml
<sequence name="Id"><gen type="increment" value="1"/></sequence>
<sequence name="First"><gen type="template" value="person.male.firstName"/></sequence>
<sequence name="Last"><gen type="template" value="person.lastName"/></sequence>
<sequence name="Status"><gen type="text" value="active,trial,closed" percent="70,20,10"/></sequence>
<sequence name="Balance"><gen type="number" value="0..99999" decimals="2"/></sequence>
<sequence name="Joined"><gen type="date" range="2015-01-01..2025-12-31" format="YYYY-MM-DD"/></sequence>
```

The three sizes below are the ones worth having a feel for — a file you can open in
an editor, a file you would not, and a file that takes a moment to copy:

| | Rows | The CSV it writes |
| :--- | ---: | ---: |
| **small** | 10 000 | 0.7 MB |
| **medium** | 200 000 | 14 MB |
| **large** | 2 000 000 | 141 MB |

About 74 bytes a row, so you can read any size off that: a gigabyte is roughly
fourteen million rows of this shape.

### Time

Seconds, best of three runs (two at the largest size). Lower is better.

| | 10 000 rows<br/>0.7 MB | 200 000 rows<br/>14 MB | 2 000 000 rows<br/>141 MB |
| :--- | ---: | ---: | ---: |
| **Rust** | 0.05 / 0.04 | 0.87 / 0.89 | **8.97 / 8.82** |
| **Java** | 0.30 / 0.29 | 1.21 / 1.19 | 9.62 / 9.50 |
| **Node.js** | 0.22 / 0.23 | 1.21 / 1.41 | 12.97 / 14.37 |
| **C#** | 0.30 / 0.29 | 1.78 / 1.76 | 14.37 / 15.34 |
| **Python** | 0.55 / 0.66 | 8.35 / 10.24 | 91.30 / 112.11 |

Each cell is *engine 1 / engine 2*. The same run, at the largest size, with the
bars drawn:

| 2 000 000 rows · 141 MB | engine 1 — in memory | engine 2 — streaming |
| :--- | :--- | :--- |
| **Rust** — crates.io | `8.97 s` █░░░░░░░░░░░░░ | `8.82 s` █░░░░░░░░░░░░░ |
| **Java** — Maven Central | `9.62 s` █░░░░░░░░░░░░░ | `9.50 s` █░░░░░░░░░░░░░ |
| **Node.js** — npm | `12.97 s` ██░░░░░░░░░░░░ | `14.37 s` ██░░░░░░░░░░░░ |
| **C#** — NuGet | `14.37 s` ██░░░░░░░░░░░░ | `15.34 s` ██░░░░░░░░░░░░ |
| **Python** — PyPI | `91.30 s` ███████████░░░ | `112.11 s` ██████████████ |

*Seconds for the 141 MB file. Both columns share one scale, so the bars are comparable across the whole table; green is the fastest measurement on it and red the slowest.*

At ten thousand rows you are mostly measuring start-up: a JVM booting, a Python interpreter
importing. Below about a hundred thousand rows, the choice of implementation barely matters.

### Memory

Peak resident set, megabytes. Lower is better.

| | 10 000 rows<br/>0.7 MB | 200 000 rows<br/>14 MB | 2 000 000 rows<br/>141 MB |
| :--- | ---: | ---: | ---: |
| **Rust** | 10.6 / **3.7** | 146 / **3.7** | 1322 / **3.7** |
| **C#** | 53.6 / 48.5 | 187 / 49.4 | 1375 / 49.4 |
| **Python** | 40.0 / 32.1 | 197 / 32.2 | 1529 / 32.3 |
| **Node.js** | 97.6 / 98.0 | 190 / 154 | 1188 / 190 |
| **Java** | 147 / 120 | 885 / 395 | 4140 / 397 |

| 2 000 000 rows · 141 MB | engine 1 — in memory | engine 2 — streaming |
| :--- | :--- | :--- |
| **Node.js** — npm | `1188 MB` ████░░░░░░░░░░ | `190 MB` █░░░░░░░░░░░░░ |
| **Rust** — crates.io | `1322 MB` ████░░░░░░░░░░ | `3.7 MB` █░░░░░░░░░░░░░ |
| **C#** — NuGet | `1375 MB` █████░░░░░░░░░ | `49.4 MB` █░░░░░░░░░░░░░ |
| **Python** — PyPI | `1529 MB` █████░░░░░░░░░ | `32.3 MB` █░░░░░░░░░░░░░ |
| **Java** — Maven Central | `4140 MB` ██████████████ | `397 MB` █░░░░░░░░░░░░░ |

*Peak memory for the same 141 MB file, on one scale. The right-hand column is what the streaming engine is for: Rust's bar is 3.7 MB against its own 1322 MB on the left.*

**This is the table to read if you read only one.** On engine 1 the memory column tracks the
row count: ten times the rows, roughly ten times the memory, in every implementation. On
engine 2 it does not move at all — Rust holds 3.7 MB whether you ask for ten thousand rows or
two million, C# holds about 49 MB, Python about 32 MB.

That is the trade the streaming engine offers, and it is not "faster". It is sometimes very
slightly slower. What you buy with those fractions of a second is a run whose memory you can
predict before you start it.

## A config with `uniq`

Combinations that repeat nowhere in the run — 150 × 150 × 150 possibilities, with 200 000
rows using about six percent of the space.

```xml
<sequence name="Pair" uniq="true">
  <gen type="text" name="City" value="C000,C001,…,C149"/>
  <gen type="text" name="Grade" value="G000,G001,…,G149"/>
  <gen type="text" name="Slot" value="S000,S001,…,S149"/>
</sequence>
```

A smaller file than the one above — three short codes a row rather than six fields:

| 200 000 rows · 4.1 MB | engine 1 — in memory | engine 3 — exact on disk |
| :--- | :--- | :--- |
| **Java** — Maven Central | `0.96 s` ██░░░░░░░░░░░░ | `1.32 s` ██░░░░░░░░░░░░ |
| **Rust** — crates.io | `1.03 s` ██░░░░░░░░░░░░ | `1.22 s` ██░░░░░░░░░░░░ |
| **Node.js** — npm | `1.26 s` ██░░░░░░░░░░░░ | `1.91 s` ███░░░░░░░░░░░ |
| **C#** — NuGet | `1.35 s` ██░░░░░░░░░░░░ | `1.60 s` ███░░░░░░░░░░░ |
| **Python** — PyPI | `4.79 s` ████████░░░░░░ | `8.23 s` ██████████████ |

*Seconds. Engine 2 is absent because it cannot run this config at all.*

| 200 000 rows · 4.1 MB | engine 1 — in memory | engine 3 — exact on disk |
| :--- | :--- | :--- |
| **C#** — NuGet | `188 MB` ███░░░░░░░░░░░ | `113 MB` ██░░░░░░░░░░░░ |
| **Python** — PyPI | `209 MB` ████░░░░░░░░░░ | `76.0 MB` █░░░░░░░░░░░░░ |
| **Rust** — crates.io | `216 MB` ████░░░░░░░░░░ | `138 MB` ██░░░░░░░░░░░░ |
| **Node.js** — npm | `264 MB` █████░░░░░░░░░ | `204 MB` ████░░░░░░░░░░ |
| **Java** — Maven Central | `793 MB` ██████████████ | `637 MB` ███████████░░░ |

*Peak memory for the same run. Every implementation gives some of it back on engine 3, and the two that give back the most end up lighter than anything on the left.*

Engine 3 is slower here and lighter, which is the bargain it exists to offer. Its cost also
grows faster than engine 1's as the row count climbs — it verifies with an external sort — so
a very large `uniq` run is the one case on this page where you should measure your own config
rather than read a table.

> [!NOTE]
> **The two engines produce different data — and that is safe**
>
> For a `uniq` config, engine 1 and engine 3 arrange the values differently. Both are valid,
> both are exactly reproducible, and within each engine all five implementations agree to the
> byte. They differ from each other because they reach uniqueness by different routes.
>
> This cannot surprise you in practice: the engine is chosen from your config, so one config
> always gets one engine and therefore one answer. You would have to override the engine by hand
> to see the difference — which is also why overriding it is not something to do casually.

## Running it yourself

The harness is in the repository, and it installs the published command lines itself:

```bash
python3 bench/cli_bench.py --config customers --tier all --repeats 3
```

`python3 bench/cli_bench.py --config customers --tier medium`

```
=== customers medium: 200 000 rows
  npm        e1     1.21s     189.9 MB  3bca9c07410bf117
  pypi       e1     8.35s     196.9 MB  3bca9c07410bf117
  crates.io  e1     0.87s     146.1 MB  3bca9c07410bf117
  nuget      e1     1.78s     187.0 MB  3bca9c07410bf117
  maven      e1     1.21s     885.2 MB  3bca9c07410bf117

every implementation produced identical bytes, on every engine it ran
```

The digest at the end of each line is the point: it is the same across all five, so the
timings are comparable because the work was.

## See also

- **[Large outputs](large-outputs.md#top)** — the engines in full, and how to keep a big run
  inside its memory.
- **[Unique values](../constructs/unique-values.md#top)** — what `uniq` promises and what it costs.
- **[CLI reference](../reference/cli.md#top)** — `--jobs`, `--engine`, `--now`.

---

← Previous: [Writing a service generator](./writing-a-service.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../data-packs/overview.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/performance)**
