<a name="top"></a>

**English** · [Русский](../ru/guides/large-outputs.md#top) · [Español](../es/guides/large-outputs.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/large-outputs)**

← Previous: [Typed output & Parquet](./typed-output-parquet.md#top) · **[Contents](../README.md#top)** · Next: [Writing a service generator](./writing-a-service.md#top) →

---

# Large outputs & streaming

**By default, TDC generates straight to disk.** Memory does **not** grow with the row
count: each row is computed on the fly from its number rather than stored in an array, so
the practical limit is disk space and time, not RAM. This needs no setup — it is how an
ordinary run already behaves.

Example outputs on this page are illustrative and can differ by core version. Where the
page makes a numeric claim ("exactly 70/30", "128 MB flat"), watch the shape of the
result, not the exact bytes.

![](../img/guides/streaming.svg)

*Memory against rows produced. Schematic, not measured — the point is the shape of each curve, not its height.*

- **A** — holding every row in memory: the cost grows with the run
- **B** — streaming: one window at a time, so the cost stays flat however long the run is

## Two disk engines, chosen for you

There are two engines under "disk", and TDC picks the right one **from your config**:

- **The fast streaming engine** — used for almost everything. Lazy, multi-threaded (see
  [`--jobs`](../reference/cli.md#top)), memory O(number of fields). Exact percentages,
  uniqueness, [`parent`](hierarchical-dependencies.md#top) dependencies,
  [`<mix>`](../reference/tags.md#top), [`<distinct>`](../constructs/unique-values.md#top) — all on the fly.
- **The exact on-disk engine** — turns itself on for the uniqueness cases the
  streaming engine can't settle on the fly: `percent` **and** `uniq` on the same
  columns, or `uniq` over non-text fields (numbers, dates, templates). It guarantees the
  result exactly, and its memory stays bounded — but it pays for that by checking the data
  with an external sort and a repair pass, and **that check gets dramatically slower as
  the row count grows** (see the warning below).

You don't need to know which one runs. The choice is **deterministic — based on the
config, not the hardware** — so the same config gives the same result on every machine
(reproducibility across machines is a core TDC guarantee).

> [!CAUTION]
> **`uniq` on a huge output is SLOW — and `uniq` + `percent` is the slowest thing TDC does**
>
> Guaranteeing that **no two rows repeat** across a huge file is fundamentally expensive:
> the exact engine generates, then **sorts the whole output and repairs every collision**,
> and that work grows **faster than linearly** with the row count. Hundreds of thousands of
> unique rows already run in **minutes**; millions can run for **hours or longer**. Memory
> stays flat — **time does not**.
>
> **The worst case by far is `uniq` and `percent` on the same columns.** Hitting exact
> proportions *and* no repeats at once is a constrained layout problem stacked on top of the
> sort. That is dramatically slower again: a run that would finish quickly with only one of
> the two can take an unreasonable amount of time with both. If you can drop either the exactness (let
> the proportions be approximate) or the uniqueness, do.
>
> For uniqueness at scale, prefer what's cheap **by construction**: a
> [counter](../generators/counters.md#top), or a [`number`](../generators/number.md#top) range
> wide enough that a collision is vanishingly rare. Reserve `uniq="true"` — and especially
> `uniq` + `percent` — for sizes where you can afford the wait. A plain (non-`uniq`) run of
> any size stays fast.

> [!NOTE]
> **Advanced escape hatches**
>
> The old `mode="disk"` is now the default — no flag needed. `mode="memory"` runs a
> **small** in-RAM engine (exact, but doesn't scale) — the same one behind the object API
> ([`toArray`/`iterate`/`getAt`](../bindings/typescript.md#top)). Force a specific engine
> with [`--engine 1|2|3`](../reference/cli.md#top); `--stream` is a legacy alias of the fast
> streaming engine.

## A billion rows

```xml
<env count="1000000000" seed="s">
  <sequence name="Gender"><gen type="text" value="M,F" percent="70,30"/></sequence>
  <sequence name="Id"><gen type="increment" value="1"/></sequence>
</env>
```

Here are the first eight rows of that run:

`./run big.tdc   (first 8 rows of the billion)`

```
M,1
F,2
M,3
M,4
F,5
M,6
M,7
M,8
```

> [!WARNING]
> **Don't shrink `count` to preview a run that uses `percent`**
>
> Change `count="1000000000"` to `count="8"` to see it quickly and you get **different
> rows** — `M M M M M M F F`, not the eight above. `percent` is an exact quota laid out
> over the **whole** `count`, so shrinking the run re-lays the whole column; the small run
> is not the beginning of the big one. Six M and two F is exactly 70/30 of eight, and that
> is the point — the quota is honoured at every size, which is precisely why it cannot also
> be a prefix. Same for `uniq` and a weighted pack; see
> [the whole-run exceptions](../core-concepts/determinism.md#the-exception-whole-run-layouts).
> So a small `count` is the right way to check the **shape** — the format, the proportions,
> that the fields agree — and the wrong way to predict which value lands on row 5 of the
> real run.

TDC uses the fast streaming engine here (no heavy uniq). It does **not** materialize a
registry — each row's value is computed from its number, so memory is **O(fields)**, not
O(rows), and the percentages stay **exact** (precisely 70/30, with no array held
anywhere). The result is deterministic.

**The fast engine handles almost everything:** simple and compound
[`<sequence>`](../core-concepts/sequences.md#top), independent generators
([`text`](../generators/text.md#top), [`number`](../generators/number.md#top),
[`date`](../generators/date.md#top), [`regex`](../generators/regex.md#top),
[`symbol`](../generators/symbol.md#top), [`template`](../generators/template.md#top)), exact
[`percent`](../reference/attributes.md#top), [counters](../generators/counters.md#top), the
[built-ins](../reference/builtins.md#top) (`_count`/`_first`/`_last`/`_total`),
[`parent`](hierarchical-dependencies.md#top) dependencies (any depth),
[`uniq="true"`](../constructs/unique-values.md#top) over a finite text list and env-level
[`<uniq>`](../constructs/unique-values.md#top),
[`<distinct>`](../constructs/unique-values.md#top), and [`<mix>`](../reference/tags.md#top) — all on the fly,
exact, and in parallel. What it hands to the exact engine is uniqueness it can't settle
in one pass: `percent` + `uniq` on the **same** columns, and `uniq` over non-text fields
(numbers, dates, templates). So a normal run covers **any** config; the handed-off
uniqueness cases are correct too, just slower — and on huge outputs, much slower (see the
warning above).

(In the fast engine `parent` works only when the parent is a sequence with a finite list
of values — a [`text`](../generators/text.md#top) sequence. Inheriting from a numeric range
sends the config to the exact engine instead.)

### Parent dependencies in the stream

A child sequence with [`parent="Parent.Value"`](hierarchical-dependencies.md#top) is active
on exactly the rows where the parent produced that value, and its percentages are **exact
within the subset**. Nesting goes any depth (parent → child → grandchild).

```xml
<env count="1000" seed="s">
  <sequence name="Gender"><gen type="text" value="M,F" percent="70,30"/></sequence>
  <sequence name="Male" parent="Gender.M"><gen type="text" value="James,William,Robert" percent="50,30,20"/></sequence>
  <sequence name="Female" parent="Gender.F"><gen type="text" value="Mary,Emma" percent="60,40"/></sequence>
</env>
```

On `M` rows the `Male` field is filled; on `F` rows the `Female` field is. First 6 of
1000 rows:

`./run parent.tdc   (first 6 of 1000)`

```
F,,Emma
M,James,
F,,Mary
F,,Mary
M,Robert,
M,James,
```

The distribution is exact at every level — no arrays, each row computed from its number:

`./run parent.tdc   (counts over 1000 rows)`

```
Gender  M         700
Gender  F         300
Male    James     350
Male    William   210
Male    Robert    140
Female  Mary      180
Female  Emma      120
```

Exactly 700 `M` and 300 `F`; inside the 700 males exactly 350/210/140 (50/30/20 of 700),
inside the 300 females exactly 180/120 (60/40 of 300). On "foreign" rows the child field
is blank — `Male` is empty on female rows, `Female` on male rows.

### Uniqueness by construction (`uniq`)

[`uniq="true"`](../constructs/unique-values.md#top) on a compound sequence makes the **tuple of all its
fields unique across the whole dataset** — without storing what was already generated.
The field combination is treated as one number in a mixed-radix system, and a special
permutation hands each row its **own** combination number, so there are no repeats by
construction.

```xml
<env count="6" seed="s">
  <sequence name="Combo" uniq="true">
    <gen name="Letter" type="text" value="A,B,C"/>
    <gen name="Digit" type="text" value="1,2"/>
  </sequence>
</env>
```

All 6 rows are different — that's the full `3 × 2` space:

`./run uniq.tdc   (all 6 rows)`

```
C,2
A,1
B,2
A,2
C,1
B,1
```

The same holds for env-level [`<uniq>`](../constructs/unique-values.md#top), where the unique tuple is
built from **separate** sequences rather than from the fields of one:

```xml
<env count="6" seed="s">
  <uniq>
    <sequence name="A"><gen type="text" value="x,y,z"/></sequence>
    <sequence name="B"><gen type="text" value="m,n"/></sequence>
  </uniq>
</env>
```

`./run env-uniq.tdc   (all 6 combinations of 3 x 2)`

```
z,n
x,n
x,m
y,n
y,m
z,m
```

Because uniqueness is math, not bookkeeping, this scales to a terabyte file with no
memory cost — there's nothing to compare against. **Limits of the fast `uniq`:** only
[`text`](../generators/text.md#top) fields/sequences, uniform (no `percent` on the columns),
and at most `2^52` combinations.

**Capacity is checked before the run starts.** If you ask for more unique rows than the
space of combinations can hold, TDC fails immediately with a clear error — not eight
hours later, halfway through the file:

`./run oversized-uniq.tdc`

```
tdc: stream mode: uniq "K" is infeasible — only 1000000 distinct
combinations exist, but 5000000000 unique rows were requested.
```

### `<mix>` in the stream

[`<mix>`](../reference/tags.md#top) picks a case for each row by **exact percent** (the same
math as `percent`), then assembles the case body: text, generators, and **nested
`<mix>`** to any depth. A generator or nested `<mix>` inside a case runs **on that case's
subset** of rows — its counter counts within the case, and nested percentages are exact
within the subset.

```xml
<env count="1000" seed="s">
  <mix name="Status" percent="20,50,30">
    <case><data>new</data></case>
    <case><data>active-</data><gen type="number" value="1..3"/></case>
    <case><data>closed</data></case>
  </mix>
</env>
```

First 6 of 1000 rows:

`./run mix.tdc   (first 6 of 1000)`

```
active-1
new
active-3
closed
active-1
closed
```

Over 1000 rows the split is exact: 200 `new`, 500 `active-N`, 300 `closed`. `<mix>` also
composes with [`parent`](hierarchical-dependencies.md#top), in which case it's active only
on the parent's rows.

## Why the fast engine won't combine `percent` + `uniq`

Uniqueness-by-construction and exact-percent-by-construction are two **different** tricks,
and on the fly (without storing what was already generated) they don't combine — doing
both at once is either full materialization or an NP-hard problem. So for that one
combination TDC uses the **exact on-disk engine**, which holds the data and permutes it,
checking against the whole set. It's slower, but it does both exactly, at any size. The
switch is **automatic** — you don't opt in.

## Parallelism — automatic

Generation is **CPU-bound**, not disk-bound (writing is far faster than computing rows),
and rows in the streaming engine are independent (each one comes from its own number), so
TDC computes them on several cores — which the architecture allows without any extra work on your part.

**You set nothing.** If the config is splittable (fast engine, no in-line built-in
generators) and the file is big enough, TDC uses `cores − 1` (7 on an 8-core box);
otherwise it quietly runs on one core:

```bash
npx tdcv2 customers.tdc -o customers.csv
```

The result is **byte-identical regardless of core count** (same seed): each core computes
a contiguous range of rows into a temp file, and the temp files are then concatenated
strictly in order. Thread count is only about speed — it never affects the data.

A benchmark — 1,000,000 rows, six fields (a counter, two template names, a `percent`
column, a normal distribution, a date), a 74 MB file, on a 12-core machine:

| `--jobs`      |   time | speedup |
| :------------ | -----: | ------: |
| 1             | 6.93 s |      ×1 |
| 2             | 4.04 s |    ×1.7 |
| 4             | 2.27 s |    ×3.1 |
| 8             | 1.57 s |  **×4.4** |
| 12            | 1.72 s |    ×4.0 |
| auto          | 1.69 s |    ×4.1 |

Two lessons. **More threads isn't always faster:** twelve threads on twelve cores lose to
eight — they fight over the same cores and the same disk. And **there's usually nothing to
tune:** auto takes `cores − 1` and lands within ~8% of the best result, which isn't worth
chasing.

The speedup depends on how expensive a row is. On a truly cheap config (two fields, a
counter and `M,F`) the win is only ~×1.6 — spinning up threads costs time, and on light
work that overhead eats most of the gain. A speedup figure quoted without its config is
meaningless.

Set it by hand with [`--jobs N`](../reference/cli.md#top) if you want (`--jobs 1` forces
single-threaded); the output is identical either way:

```bash
npx tdcv2 customers.tdc --jobs 8 -o customers.csv
```

Sometimes parallelism does **not** kick in — a config on the **exact** engine, for
example, since `percent` + `uniq` together runs single-threaded. Auto stays quiet about
it, but if you asked for `--jobs` explicitly, TDC tells you why. The output is correct
either way.

## The engine is chosen from your config, not your hardware

Which engine runs (fast or exact) is decided by TDC **from the config's contents**, never
from the machine. This matters: if the choice depended on "how much RAM is free right
now", then **the same config with the same seed could produce different data on different
computers** — and cross-machine reproducibility is TDC's central guarantee. Because
routing depends only on the config, a given config always takes the same engine and gives
the same result everywhere.

The memory estimate (`preflight()`, below) is only **advice**; it switches nothing and
changes no output. To force a specific engine use
[`--engine 1|2|3`](../reference/cli.md#top) (advanced); `mode="memory"` is the small in-RAM
engine for small datasets.

The same override exists **inside the config**, as `engine` on `<env>` — the flag
without the command line:

```xml
<env count="1000" seed="s" engine="1">
```

`1` is in-memory, `2` streaming, `3` exact-on-disk; anything else is an error. Prefer
`mode="memory"` / `mode="disk"`, which say what you want rather than which
implementation delivers it — engine numbers are an escape hatch for reproducing a
specific behavior, and a config pinned to an engine won't benefit from better routing
later. When both are present, `engine` wins over `mode`; a `--engine` or `--mode` on the
command line overrides either.

## Terminal methods (the library)

Text output (`toString`/`toIterator`/`toStream`/`writeFile`/CLI) goes through disk and
does **not** materialize a registry — O(fields). The object methods
(`toArray`/`iterate`/`getAt`) return JS objects through the small in-RAM engine, so they
hold data in memory (fine for the small sets the object API exists for).

| Method         | Text output           | Memory                | Use for                          |
| :------------- | :-------------------- | :-------------------- | :------------------------------- |
| `toString()`   | collected whole       | O(fields) + full text | small / medium results           |
| `toIterator()` | one row at a time     | O(fields)             | large text results, row by row   |
| `toStream()`   | Node `Readable`       | O(fields)             | pipe to a file / HTTP / archiver |
| `writeFile()`  | chunks to a file      | O(fields)             | simplest way to write a big file |
| CLI            | chunks                | O(fields)             | the command line                 |
| `toArray()`    | object rows, whole    | materialized in RAM   | small / medium object fixtures   |
| `iterate()`    | object rows, one-by-one | materialized in RAM | object output, one row at a time |
| `getAt(index)` | one object row        | materialized per call | point access, not bulk           |

For big files, use the CLI, `writeFile()`, `toIterator()`, or `toStream()`:

```ts
const tdc = new TDC({ configFile: "./customers.tdc" });
tdc.writeFile("./customers.csv");
```

Or through a stream:

```ts
import { createWriteStream } from "node:fs";

tdc.toStream().pipe(createWriteStream("./customers.csv"));
```

### Proof: half a million rows, memory stays flat

Claims about "O(fields)" are worth more with real numbers behind them. Take a
500,000-row config and run the terminal methods.

**`writeFile()` — a file on disk.** It writes chunks as it generates:

`node writeFile.js   (500,000 rows)`

```
bytes: 4388895        // ~4.4 MB, 500,000 rows
M,1
M,2
M,3
```

**`toIterator()` — walk every row, memory doesn't move.** Sampling process RSS at
checkpoints as the row count grows:

`node measure.js`

```
rows=100000  RSS=128 MB
rows=200000  RSS=128 MB
rows=300000  RSS=128 MB
rows=400000  RSS=128 MB
rows=500000  RSS=128 MB
```

The line is **flat** — 128 MB at 100,000 rows and the same 128 MB at 500,000. Watch the
flatness, not the absolute number: RSS depends on the machine and the Node version, and
this was an Apple M2 Max on Node 20.

**`toStream()` equals `writeFile()` byte-for-byte.** Both take the same streaming path:

```ts
new TDC({ configFile: "./customers.tdc" })
  .toStream()
  .pipe(createWriteStream("out2.csv"));
// md5(out2.csv) === md5(out.csv)  →  true
```

## `preflight()` — a memory-risk estimate

`preflight()` estimates memory risk before generating, comparing the estimate to the
machine's **total** RAM (not "free right now" — the OS hands memory to a process on
demand, so a snapshot of what's free at this instant is misleading).

```ts
const diagnostic = tdc.preflight();
```

On a normal (disk) run even half a million rows is no risk at all — `preflight()` returns
`undefined`. It only warns for an explicit `mode="memory"` on a large `count`, where the
data really is materialized:

```ts
// disk (default), 500,000 rows:
new TDC({ configFile: "./customers.tdc" }).preflight();
//  →  undefined

// mode="memory", 50,000,000 rows — returns a Diagnostic:
const d = new TDC({
  configFile: "./customers.tdc",
  mode: "memory",
  count: 50_000_000,
}).preflight();
```

`node preflight.js`

```
d.severity  warning
d.code      TDC200
d.message   estimated memory need (~20981 MB) is a large share of this
            machine's RAM (32768 MB) — may lean on swap and slow down
d.hint      This will still run; for very large datasets mode="disk"
            keeps memory flat regardless of count.
```

So on an ordinary disk run preflight practically never fires: the streaming engine holds
O(fields), not O(rows), so a billion rows go through without a complaint — that's what
it's built for. The estimate is only **advice**; it doesn't switch engines or change
output.

If you know you'll consume streaming output through `toString()`, name the scenario
explicitly:

```ts
const diagnostic = tdc.preflight({ output: "streaming" });
```

## What gets materialized in RAM

The streaming (disk) engine keeps nothing extra in memory. Materialization happens only in
the **small in-RAM engine** — the object API (`toArray`/`iterate`/`getAt`) and an explicit
`mode="memory"`. There it holds, up front:

- the built-ins `_count`, `_first`, `_last`, `_total`;
- each simple `<sequence>`;
- each field of a compound sequence;
- parent-filtered arrays of values or `undefined`;
- CSV row-link plans for linked external data.

A rough estimate: `count × number_of_sequence_slots`. For example, this compound sequence:

```xml
<sequence name="Person">
  <gen name="FirstName" type="template" value="person.female.firstName"/>
  <gen name="LastName" type="template" value="person.lastName"/>
</sequence>
```

`./run person.tdc   (${{Person.FirstName}} ${{Person.LastName}})`

```
Emma Johnson
Olivia Smith
Sophia Brown
Ava Davis
Mia Wilson
```

takes two sequence slots: `Person.FirstName` and `Person.LastName`.

## Practical rules

- For a file of any size, just use `writeFile()` or the CLI — it's disk by default, and
  memory doesn't grow with rows.
- To speed up a big run, add [`--jobs N`](../reference/cli.md#top) (on the fast engine).
- `toString()` suits tests and small results, but collects all text into one
  string — not for big files.
- `toArray()`/`iterate()`/`getAt()` materialize object rows in RAM, so they don't replace
  streaming file output — they're for small sets.

## See also

- **[CLI](../reference/cli.md#top)** — `--jobs`, `--mode`, `--engine`.
- **[Unique values](../constructs/unique-values.md#top)** — `uniq`, `<uniq>`, `<distinct>` in depth.
- **[Hierarchical dependencies](hierarchical-dependencies.md#top)** — `parent` in depth.
- **[Language Bindings](../bindings/typescript.md#top)** — the library API in full.

---

← Previous: [Typed output & Parquet](./typed-output-parquet.md#top) · **[Contents](../README.md#top)** · Next: [Writing a service generator](./writing-a-service.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/large-outputs)**
