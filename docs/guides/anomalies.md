<a name="top"></a>

**English** · [Русский](../ru/guides/anomalies.md#top) · [Español](../es/guides/anomalies.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/anomalies)**

← Previous: [Statistical distributions](./statistical-distributions.md#top) · **[Contents](../README.md#top)** · Next: [Missing data](./missing-data.md#top) →

---

# Anomalies & outliers — `anomaly`

**Use it when** you're building test data for an anomaly detector, a monitoring
alert, or an outlier-robust model — anything that has to notice values sitting far
outside the normal range. Real data always has a few: a stuck sensor, a fat-finger
entry, a suspicious transaction. The `anomaly` attribute injects those spikes **on
purpose**, at a rate you choose, so your pipeline has something abnormal to react to.

There are two routes, and this page covers both:

| Route                                                                      | Outlier looks like             | Ground-truth column   |
| :------------------------------------------------------------------------- | :----------------------------- | :-------------------- |
| `anomaly="p"` on a [`<gen>`](../generators/overview.md#top) producing numbers | the base value **× a factor**  | `anomaly_flag="Name"` |
| `anomaly="true"` on a `<case>` inside a [`<mix>`](../reference/tags.md#top)   | whatever that branch generates | `flag="Name"`         |

Reach for the first when a "too big" number is outlier enough. Reach for the second
when the outlier needs its own shape — a different range, a garbage string, a rare
but legal event.

> [!NOTE]
> **Example outputs are illustrative**
>
> The numbers below are what a typical run produces. Exact draws can differ by core
> version and `seed` — what stays fixed is the **structure**: which rows spike is
> decided by the row number, so the ground-truth column always agrees with the value.

![](../img/guides/anomalies-missing.svg)

*The same generator, 80 rows, with each modifier switched on in turn.*

- **A** — the clean series
- **B** — with anomaly= — the marked points are the injected outliers
- **C** — with missing= — the marks on the floor are rows that produced no value

## How to enable

Put `anomaly="p"` on a generator that produces numbers, where `p` is the fraction of
values (0 to 1) that become outliers. The size of each spike is `anomaly_factor`
(default `10`):

```xml
<gen type="number" distribution="normal" mean="50" sd="3" anomaly="0.15" anomaly_factor="8"/>
```

About 15% of the values get multiplied by 8 — normal readings sit near `50`, the
outliers land near `400`. An outlier is exactly the base value **multiplied** by the
factor. It works on **numbers only**; non-numeric values pass through untouched (see
[Details](#details)).

## Before and after — the same series, with and without spikes

**Problem.** Show only the dirty column and you can't tell a spike from a genuinely
large value — is `460` a fault or just a big reading? You need a clean reference
right next to it.

**Tool.** Take one list of readings with [`order="sequential"`](masks-and-case.md#top)
(strictly in order) and build **two** columns from it: `Clean` as-is, and `Dirty` —
the same series with `anomaly`. Row by row the base value matches, so every spike is
obvious: it's the same number, times the factor.

```xml
<env count="12" seed="demo">
  <sequence name="Clean"><gen type="text" value="48,50,46,52,49,51,47,53,50,48,52,49" order="sequential"/></sequence>
  <sequence name="Dirty"><gen type="text" value="48,50,46,52,49,51,47,53,50,48,52,49" order="sequential" anomaly="0.3" anomaly_factor="10"/></sequence>
</env>
...
<data>clean=${{Clean}} | dirty=${{Dirty}}</data>
```

`./run readings.tdc (12 rows)`

```
clean=48 | dirty=48
clean=50 | dirty=50
clean=46 | dirty=460
clean=52 | dirty=52
clean=49 | dirty=49
clean=51 | dirty=510
clean=47 | dirty=47
clean=53 | dirty=53
clean=50 | dirty=50
clean=48 | dirty=480
clean=52 | dirty=52
clean=49 | dirty=49
```

Three rows spiked: `46 → 460`, `51 → 510`, `48 → 480` — exactly ×10. No "← outlier"
annotations needed: the reference is on the left, the spike is on the right, and the
difference speaks for itself. On 12 rows at `anomaly="0.3"` this run produced 3
spikes (the rate is random, and on a small sample the spread is wide).

**Why/when.** This side-by-side is the fastest way to sanity-check that `anomaly` is
doing what you think before you scale up to a real dataset.

## How big the spike is — `anomaly_factor`

**Problem.** A "soft" outlier (a little above normal) and a "hard" one (many times
over) are caught by different thresholds. You need control over the spike height.

**Tool.** Change only `anomaly_factor`; keep everything else the same — same
sequence, same `seed`, same `anomaly="0.25"`. With the seed, the name, and the rate
fixed, **the same rows spike** every time — only their height changes.

```xml
<gen type="text" value="48,50,46,52,49,51,47,53,50,48,52,49"
     order="sequential" anomaly="0.25" anomaly_factor="5"/>   <!-- then 10, then 20 -->
```

`anomaly_factor="5"` → `"10"` → `"20"`, same 12 rows in each:

`./run factor.tdc (12 rows, three factors)`

```
factor=5    factor=10    factor=20
240         480          960
50          50           50
230         460          920
52          52           52
49          49           49
51          51           51
235         470          940
265         530          1060
50          50           50
48          48           48
52          52           52
245         490          980
```

The base on row 8 is `53`: `53×5=265`, `53×10=530`, `53×20=1060`. The outlier rows
(1, 3, 7, 8, 12) are identical across all three columns — `anomaly_factor` controls
only the **height**, never **which** rows spike. (Which rows spike depends on the
`seed` and the sequence **name** — rename the sequence and the spikes move.)

**Why/when.** Sweep the factor to find where your detector's threshold starts and
stops firing, without changing anything else.

## How many spikes — the `anomaly` rate

**Problem.** A rare fault (one in a hundred) and constant noise need different
thresholds. The `anomaly` value itself sets how often a spike happens.

**Tool.** Pin the base value at `50` so a spike (`500`) is visible at a glance. Left
column `anomaly="0.1"`, right column `anomaly="0.5"`, 20 rows:

```xml
<env count="20" seed="demo">
  <sequence name="Low"> <gen type="text" value="50" order="sequential" anomaly="0.1" anomaly_factor="10"/></sequence>
  <sequence name="High"><gen type="text" value="50" order="sequential" anomaly="0.5" anomaly_factor="10"/></sequence>
</env>
...
<data>rate 0.1: ${{Low}}   rate 0.5: ${{High}}</data>
```

`./run rate.tdc (20 rows)`

```
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5: 500
rate 0.1: 500   rate 0.5:  50
rate 0.1:  50   rate 0.5: 500
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5:  50
rate 0.1:  50   rate 0.5: 500
```

The left column spiked once out of 20, the right one 11 times — a higher rate means
denser outliers. `anomaly` **combines with anything**: a range, a
[distribution](../generators/number.md#top), or [`missing`](../generators/overview.md#top).

**Why/when.** Match the rate to the phenomenon you're modeling — a rare defect at
`0.01`, a badly flaky sensor at `0.4`.

## The ground-truth column — `anomaly_flag`

**Problem.** The outliers are injected — but to **grade a detector** you need the
right answer: exactly which rows are anomalous. From the numbers alone, a faulty
spike is indistinguishable from a legitimately large reading.

**Tool.** Add `anomaly_flag="Name"` next to `anomaly` and TDC creates a **new
column** — a sequence called `Name` holding `true`/`false`, `true` on precisely the
rows that spiked:

```xml
<gen type="number" distribution="normal" mean="50" sd="3"
     anomaly="0.2" anomaly_factor="8" anomaly_flag="IsOutlier"/>
...
<data>${{Reading}},${{IsOutlier}}</data>
```

`./run labeled.tdc`

```
360,true
48,false
49,false
51,false
52,false
52,false
47,false
49,false
```

`360` (≈ 45 × 8) is marked `true`; the ordinary readings are `false`. The flag is
computed from the **same** decision as the spike itself, so the two can never
disagree — and this holds in every engine, at any volume.

**The flag is an ordinary column**, so you can filter on it with
[`if`](../core-concepts/output-formatting.md#top). Keep only the outliers with
`if="IsOutlier"` (it reads the row's truthiness, like the `_first`/`_last`
built-ins):

```xml
<block><line if="IsOutlier"><data>outlier: ${{Reading}}</data></line></block>
```

`./run outliers-only.tdc (20 readings)`

```
outlier: 360
outlier: 392
outlier: 400
```

Out of 20 readings, 3 came through as anomalies — a ready-made labeled dataset for
scoring a detector's precision and recall.

**Why/when.** Any time you need to _measure_ a detector, not just feed it.
`anomaly_flag` without `anomaly` is an error, because there is nothing to mark.

## A custom outlier — `flag` on a `<mix>`

**Problem.** `anomaly="p"` can only multiply. Sometimes the outlier has to look
different — its own range, its own text, a rare-but-legal event — and you still want
a ground-truth column that says which rows are the odd ones.

**Tool.** Describe the outlier as its own branch of a [`<mix>`](../reference/tags.md#top),
tag that [`<case>`](../reference/tags.md#top) with `anomaly="true"`, and ask the mix for
a ground-truth column with [`flag="Name"`](../reference/attributes.md#top). Here
temperatures are usually `20–24`, but a quarter of the time a stuck sensor reads
`90–99`:

```xml
<env count="12" seed="sensor-2026">
  <sequence name="Id"><gen type="increment" value="1"/></sequence>
  <mix name="Temp" percent="75,25" flag="Bad">
    <case><gen type="number" value="20..24"/></case>
    <case anomaly="true"><gen type="number" value="90..99"/></case>
  </mix>
</env>
<block>
  <line><data>${{Id}},${{Temp}},${{Bad}}</data></line>
</block>
```

Columns are `id`, `temp`, `bad`:

`./run sensor.tdc (12 rows)`

```
1,23,false
2,21,false
3,22,false
4,21,false
5,24,false
6,23,false
7,21,false
8,92,true
9,20,false
10,97,true
11,21,false
12,98,true
```

Three of twelve rows — exactly 25%, just as [`percent`](../generators/text.md#top) asked
for — and `bad` is `true` on every one of them. The label comes from the **same
choice** that picked the branch, so it can't drift away from the value.

**Why/when.** `anomaly="true"` on a `<case>` is **only a label** — it injects
nothing and changes nothing; the outlier is produced entirely by the branch's own
generator (`<gen type="number" value="90..99"/>`). That means you control exactly
what the outlier looks like — unlike `anomaly="p"`, which can only scale a number.

### The two halves only work together

TDC checks that the label and the column are both present:

| What you wrote                                   | What TDC says                                     |
| :----------------------------------------------- | :------------------------------------------------ |
| `anomaly="true"`, but the `<mix>` has no `flag=` | error `TDC203` — the label has nowhere to go      |
| `flag=`, but no `<case>` is marked               | warning `TDC202` — the column is all `false`      |
| `flag=` on a **nested** `<mix>`                  | error `TDC203` — only a named mix owns the column |

### In Parquet — a real type

When you export to Parquet, the ground-truth column becomes a genuine `BOOLEAN` and
the values keep their numeric type, with no `type=` anywhere:

`./run sensor.tdc --format parquet (schema)`

```
id     INT64    REQUIRED
temp   INT64    REQUIRED
bad    BOOLEAN  REQUIRED
```

The value type is inferred only when **all** branches agree (both are numbers here).
If one branch returns a number and another returns a word, the column stays text —
TDC never guesses a type it isn't sure of. See **[Output formats](output-formats.md#top)**.

### More ways to use it

- **Grading a data cleaner.** Tag a branch that emits junk — a malformed address, an
  empty phone — and see how many flagged rows the cleaner actually removes.
- **Several kinds of defect.** You can tag more than one branch; `flag` is `true` on
  every marked case.
- **Marking a "rare event."** The tag doesn't have to mean _broken_ — it can mark a
  rare but perfectly legal case your model should still learn to catch.

## Details

- **Deterministic.** The same `seed` gives the same outliers, on the same rows. See
  [Determinism & proportions](../core-concepts/determinism.md#top).
- **Any engine, any volume.** Outliers are decided by row number, so in-memory and
  on-disk runs agree exactly.
- **Numbers only, and it's the value that decides — not the `type=`.** In the examples
  above the list is written as `type="text"`, but the values _are_ numbers, so `anomaly`
  multiplies them. Put it on a column of names and the values pass through unchanged —
  **silently**: `tdcv2 check` reports nothing, because a text list may hold numbers and
  TDC cannot know which you meant. If a column that should have spikes comes out clean,
  this is the first thing to check.
- **`anomaly="0"`** means no outliers.

## See also

- **[Number generator](../generators/number.md#top)** — ranges and distributions to
  attach `anomaly` to.
- **[Generators overview](../generators/overview.md#top)** — `missing=` and `anomaly=`
  side by side, both applied after the value is produced.
- **[Tags reference](../reference/tags.md#top)** — `<mix>` and `<case>`, the branching
  the custom-outlier route builds on.
- **[Output & formatting](../core-concepts/output-formatting.md#top)** — the `if`
  expression that filters on a ground-truth column.

---

← Previous: [Statistical distributions](./statistical-distributions.md#top) · **[Contents](../README.md#top)** · Next: [Missing data](./missing-data.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/anomalies)**
