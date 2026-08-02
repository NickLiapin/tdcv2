<a name="top"></a>

**English** · [Русский](../ru/core-concepts/determinism.md#top) · [Español](../es/core-concepts/determinism.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/core-concepts/determinism)**

← Previous: [Output & formatting](./output-formatting.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../generators/overview.md#top) →

---

# Determinism & proportions

Two properties make TDC's data trustworthy: the same **seed** reproduces the same data
byte for byte, and every share comes out at its **exact proportion**. This page covers
three attributes together — `seed`, `count`, and `percent` — because they interact:
`count` decides how many records you get, `seed` decides *which* records, and `percent`
pins their proportions.

> [!NOTE]
> The example outputs below are illustrative — the exact names and numbers can differ by
> core version, but the *properties* they show (reproducibility, prefixes, exact counts)
> always hold.

![](../img/guides/determinism.svg)

*Three runs of the same config, 60 rows each.*

- **A** — the first run, on one seed
- **B** — a second run on the same seed — identical value for value
- **C** — a different seed: the same shape of data, but none of the same numbers

## `seed` — reproducible randomness

Test data should look random but stay **reproducible**: run the same config tomorrow and
you get the same records. Without that, a bug report and a snapshot test have nothing to
stand on. Plain "random" can't give it to you — every run is a fresh set. `seed` can:
the same seed and the same config always produce exactly the same output.

> [!NOTE]
> **Same output, on the same engine**
>
> That guarantee holds within a single engine. TDC picks an engine based on the config
> (the fast streaming one by default, the small in-RAM one under `mode="memory"` or behind
> the object API `toArray`/`getAt`), and the two engines draw values in a different order.
> So for one seed the **numbers and names** can differ between them, even though the
> **shape** — row count, exact proportions, uniqueness — is identical. Text output
> (`toString`, the CLI, `writeFile`) comes from one engine and the object methods come
> from the other, so their random values aren't guaranteed to match. See
> [Large outputs](../guides/large-outputs.md#top) for how the engine gets chosen. What never
> changes is one engine on one seed.

`seed` is set on [`<env>`](configuration.md#top). Its value is any string — a hash, a word,
a number written as text — and internally the cyrb128 algorithm normalizes it to a
128-bit key. The CLI flag `--seed` and the API `{ seed }` option both override the
attribute.

```xml
<env count="4" seed="demo" local="en">
  <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
  <sequence name="Code"><gen type="number" value="1000..9999"/></sequence>
</env>
```

Both the name (from [`template`](../generators/template.md#top)) and the code (from
[`number`](../generators/number.md#top)) look random. Run the config **twice in a row** and
the output is identical, byte for byte:

`./run demo.tdc  —  two consecutive runs`

```
run 1              run 2
Braylen #2004      Braylen #2004
Amiri #2900        Amiri #2900
Andre #2771        Andre #2771
Izaiah #5951       Izaiah #5951
```

Nothing drifts. Same seed, same config, same result — that's determinism.

### Change the seed → a different, equally stable set

Swap the seed for another word and you get a *different* set that's just as
reproducible. Same config, only now `seed="alpha"`:

`./run demo.tdc  (seed=alpha)`

```
Ryland #1695
Leonidas #8152
Jakobe #8337
Jase #3363
```

That's how you keep several independent but reproducible datasets side by side:
`seed="demo"` for one test, `seed="alpha"` for another, each one stable across runs.

### Remove the seed → fresh every time

With no `seed` at all, TDC picks a random one per run and the output is new every time.
Do that when you want fresh sample data and don't care about reproducing a specific
output — but know that you're giving up the ability to point at a particular result
later.

> [!NOTE]
> **Cross-language guarantee**
>
> The PRNG (cyrb128 + sfc32) was chosen so that the same `seed` and config give identical
> results in every implementation. That portability is one of
> TDC's core promises.

## `count` — how many records

`count` is how many times the block is rendered. It's set on
[`<env>`](configuration.md#top), defaults to **10**, and is overridden by the CLI flag
`--count` or the API `{ count }` option. The value is a positive integer written as a
string.

```xml
<env count="1000" seed="demo" local="en">
  ...
</env>
```

```bash
# Override from the CLI:
./run config.tdc --count 50
```

The important property: **a short run is an honest prefix of a long run.** Most
generators — [`number`](../generators/number.md#top), an unweighted
[`template`](../generators/template.md#top), [`counter`](../generators/counters.md#top),
[`regex`](../generators/regex.md#top) — compute each row's value from its **row number**
and the seed, never from the total. So the first three rows of `count="3"` are exactly
the first three rows of `count="6"`:

`./run demo.tdc --count 3   vs   --count 6`

```
count=3        count=6
Braylen        Braylen
Amiri          Amiri
Andre          Andre
               Izaiah
               Zachariah
               Saul
```

`count` doesn't *shift* the data; it just continues the same series. So you can debug
on `count="3"` knowing those first records will be identical at `count="1000"`.

### The exception: whole-run layouts

Generators that lay their values out across the **entire** run get **recomputed** when
`count` changes, so their columns are *not* a prefix. Four features work this way:
exact proportions (`percent` on [`text`](../generators/text.md#top) and on `<mix>`, via the
Hamilton method), uniqueness ([`uniq`](../constructs/unique-values.md#top)), a
**weighted** [`template`](../generators/template.md#top) pack, and the **list lengths** of
[`repeat="min..max"`](../constructs/multiple-values.md#top) — a range there is a quota over
the run, not a die rolled per row, so 200 rows of `repeat="1..4"` come out
50 / 50 / 50 / 50 and 201 rows come out 51 / 50 / 50 / 50. The name and place packs carry
a frequency per value, and TDC turns those into exact quotas over the whole count with the
same machinery `percent` uses. So `person.male.firstName` reshuffles when
`count` changes, while an unweighted list like `location.country` stays a prefix.
Counting against the full `count` is precisely what makes the proportions come out even
and uniqueness hold at any size.

You can watch the recomputation happen. With `percent="34,33,33"` on three values, a run
of `count="4"` and a run of `count="8"` share **no** prefix at all:

`./run grade.tdc  —  percent layout is recomputed`

```
count=4:   C A A B
count=8:   A C A B A B B C
```

The first four rows differ, because the layout was rebalanced for the new total.
Positional generators (number, an unweighted template, counter, regex) would still be a
prefix here; the proportion, uniqueness, weighted-pack and `repeat`-length machinery
reshuffles.

The practical rule: **a small run tells you the shape, not the rows.** Debug on
`count="3"` to check the format, the proportions and that the fields agree — but if any
of the four features above is in the config, don't expect row 3 of the small run to be
row 3 of the big one.

### Built-ins that depend on the total

Built-in sequences that need the size of the whole run also change with `count` —
`_total` (the total number of rows) and `_count` (the current row number). Here's the
same config rendered as `${{_count}}/${{_total}}: ${{Name}}`:

`./run demo.tdc --count 3   vs   --count 6`

```
count=3            count=6
1/3: Braylen       1/6: Braylen
2/3: Amiri         2/6: Amiri
3/3: Andre         3/6: Andre
                   4/6: Izaiah
                   5/6: Zachariah
                   6/6: Saul
```

`_total` correctly reports `3` in one run and `6` in the other — by definition it
describes the whole run.

## `percent` — exact proportions

Add `percent` to a [`text`](../generators/text.md#top) generator (or to a `<mix>`) and the
shares land **exactly**, laid out by the Hamilton (largest-remainder) method: the number
of times each value occurs is guaranteed to match the percentages you gave. The only
randomness left is in the *order* of the rows.

```xml
<sequence name="Gender">
  <gen type="text" value="Male,Female" percent="60"/>
</sequence>
```

The first rows come out interleaved (the order depends on the seed):

`./run gender.tdc  —  first rows`

```
Female
Male
Female
Male
Female
Male
```

But count up **all** 100 rows and the split is exact to the record:

`./run gender.tdc  (count=100)`

```
Male     60
Female   40
```

Exactly 60 and 40 — not "about 60%". That's the Hamilton method: it distributes
precisely and leaves the randomness in the row order alone.

### Partial lists — `percent` can be shorter than the values

The list above is just `percent="60"`, yet there are two values. A list shorter than the
[`value`](../generators/text.md#top) list gets expanded: the filled positions pin their own
percent, and the empty ones split whatever is left up to 100 evenly between them. That
covers most real cases with very little typing:

| Mask     | For 2 / 4 / 5 values, expands to |
| :------- | :------------------------------- |
| `60`     | `60,40`                         |
| `,40`    | `60,40`                         |
| `,10,10` | `40,40,10,10`                   |
| `,,25,,` | `18.75,18.75,25,18.75,18.75`    |
| `46,`    | `46,13.5,13.5,13.5,13.5`        |

The rules: if every position is filled, the numbers have to sum to 100. If any are **empty**
positions, the filled numbers have to sum to **no more than** 100, and the rest is
shared out across the blanks.

### Shares that don't divide evenly

Three equal grades over 100 rows comes to 33.33% each, but "a third of 100" isn't a
whole number. Hamilton hands the leftover record to the share with the largest
remainder, so the total is still exactly `count`:

```xml
<sequence name="Grade"><gen type="text" value="A,B,C" percent=",,"/></sequence>
```

`./run grade.tdc  (count=100)`

```
A   34
B   33
C   33
```

`34 + 33 + 33 = 100` — no record is lost or double-counted. Explicit shares are taken
just as literally:

```xml
<sequence name="Tier"><gen type="text" value="gold,silver,bronze" percent="50,30,20"/></sequence>
```

`./run tier.tdc  (count=100)`

```
gold      50
silver    30
bronze    20
```

### Small counts — the sum still holds

At a small `count` the shares round off, but their total always equals `count`. With
`percent="50,50"` and `count="3"` you get either 2 + 1 or 1 + 2 (which value gets the
extra row depends on the seed) — never 1 + 1 or 2 + 2. The proportion is approximate;
the count is never wrong.

### Inside a subset — `percent` with a parent

When the sequence has a [`parent`](sequences.md#top), the percentages are measured **within
the filtered subset**, not across the whole run. A 70/30 split of active users is 70/30
*of that parent's rows*, computed independently for each group. That's the foundation of
[hierarchical dependencies](../guides/hierarchical-dependencies.md#top).

### On `<mix>`

`percent` also drives `<mix>`, where the list length is checked against the number of
nested `<case>` branches instead of against a value list. Leave `percent` off and the
cases are distributed evenly.

## See also

- **[Text](../generators/text.md#top)** — `percent` in full, including
  [partial lists](../generators/text.md#partial-percent-lists).
- **[Hierarchical dependencies](../guides/hierarchical-dependencies.md#top)** — proportions inside a subset.
- **[Unique values](../constructs/unique-values.md#top)** — the other whole-run layout that recomputes when `count` changes.
- **[Large outputs](../guides/large-outputs.md#top)** — how exact proportions hold up while streaming.

---

← Previous: [Output & formatting](./output-formatting.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../generators/overview.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/core-concepts/determinism)**
