<a name="top"></a>

**English** · [Русский](../ru/constructs/unique-values.md#top) · [Español](../es/constructs/unique-values.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/constructs/unique-values)**

← Previous: [One row per element (each)](./relational-tables.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../compute/overview.md#top) →

---

# Unique values

Real datasets have two different "no duplicates" rules, and TDC gives you a separate
tool for each:

| Mechanism    | Scope    | Meaning                                              |
| :----------- | :------- | :-------------------------------------------------- |
| `<distinct>` | one row  | fields **don't equal each other** within a row      |
| `uniq`       | all rows | the **combination of fields** is unique across rows  |

Think of them as the same idea on two axes. `<distinct>` works **horizontally** —
inside a single row, so you never get `John John` or "born in Paris, lives in Paris".
`uniq` works **vertically** — down the whole dataset, so the same
`(first, last)` pair never appears twice. They're fully independent; use either,
or both at once.

> [!NOTE]
> **Example outputs are illustrative**
>
> The values below are what a typical run produces. Exact draws can differ by core
> version and `seed` — what stays fixed is the **structure** each tool guarantees
> (no in-row collisions for `<distinct>`, no repeated combinations for `uniq`).

![](../img/guides/distinct-uniq.svg)

*How often each combination of two fields came out. Across: the first field; down: the second.*

- **A** — with distinct, over 60 rows: the diagonal is empty, because a row can never repeat a value across its fields
- **B** — with uniq, over 6 rows: no cell is ever above 1, because a combination can never repeat across rows — the empty cells are combinations this run simply didn't reach

## `<distinct>` — different within a row

Two [`<gen>`](../generators/overview.md#top) fields that draw from the **same** list
run independently, so sooner or later some row hits the same value twice. Here two
symptoms of one patient both come from a short four-item list, so the clashes show up
immediately:

```xml
<sequence name="Case">
    <gen name="S1" type="text" value="Fever,Cough,Headache,Nausea"/>
    <gen name="S2" type="text" value="Fever,Cough,Headache,Nausea"/>
</sequence>
...
<data>${{Case.S1}}, ${{Case.S2}}</data>
```

`./run case.tdc (8 rows)`

```
Nausea, Headache
Headache, Headache
Fever, Cough
Nausea, Nausea
Headache, Fever
Cough, Nausea
Cough, Fever
Fever, Cough
```

Rows 2 and 4 are `Headache, Headache` and `Nausea, Nausea` — not a patient with two
complaints, but a patient with one complaint written down twice.

**The fix.** Wrap both fields in `<distinct>` — everything else stays the same,
even the `seed`:

```xml
<sequence name="Case">
    <distinct>
        <gen name="S1" type="text" value="Fever,Cough,Headache,Nausea"/>
        <gen name="S2" type="text" value="Fever,Cough,Headache,Nausea"/>
    </distinct>
</sequence>
```

`./run case.tdc (8 rows)`

```
Nausea, Headache
Headache, Nausea
Fever, Cough
Nausea, Cough
Headache, Fever
Cough, Nausea
Cough, Fever
Fever, Cough
```

The rows that had no clash are **byte-for-byte the same** — the engine left them
alone. The two collisions were repaired: `Headache, Headache` became `Headache,
Nausea`, and `Nausea, Nausea` became `Nausea, Cough`. Only the second field was redrawn, and only where
it had to be; order and `seed` are untouched.

### Two levels

`<distinct>` works in two places, with the same rule at both: **the direct children
of `<distinct>` produce different values in each row.**

**1. Inside a [`<sequence>`](../core-concepts/sequences.md#top)** — it wraps the
`<gen name="…">` fields. Read it as "A ≠ B", here over the real symptom list from the
[data pack](../data-packs/overview.md#top):

```xml
<sequence name="Case">
    <distinct>
        <gen name="A" type="template" value="medical.symptom"/>
        <gen name="B" type="template" value="medical.symptom"/>
    </distinct>
</sequence>
```

`./run case.tdc (6 rows)`

```
Constipation + Skin Rash
Confusion + Constipation
Itching + Swelling
Sneezing + Fever
Cramping + Sneezing
Itching + Runny Nose
```

Both fields pull from the same pool, yet the two values in each row always differ.

**2. Inside [`<env>`](../core-concepts/configuration.md#top)** — it wraps whole
`<sequence>` blocks. A classic case is "country of birth" versus "country of
residence": two independent picks from the same country list occasionally land on
the same country in one row.

```xml
<env count="100" seed="s">
    <distinct>
        <sequence name="Birth"><gen type="template" value="location.country"/></sequence>
        <sequence name="Live"><gen type="template" value="location.country"/></sequence>
    </distinct>
</env>
```

`./run migration.tdc (6 rows) — Birth -> Live`

```
France      -> Bhutan
Panama      -> Chile
Montenegro  -> Japan
Cameroon    -> Kenya
Peru        -> Namibia
Guatemala   -> Grenada
```

Now the birth country and the residence country in a single row never match.

### How it works, and the details

The engine generates the fields as usual; if two values inside a group collide in a
row, it **redraws** one of them with the generator's next value until they differ.
Determinism is preserved — the redraws happen in a fixed order, so the output for a
given `seed` doesn't change. It works the same in the in-memory engine and in
streaming.

Details worth knowing:

- **Values are compared, not sources.** If two fields read from different files but
  happen to produce the same word, `<distinct>` still redraws.
- **Groups are independent.** A `<distinct>` for first and middle names and a
  separate one for something else don't interfere with each other; you can have as
  many as you like.
- **Fields outside `<distinct>`** carry no constraint at all.
- **A list that's too short fails cleanly.** If a list has fewer distinct values
  than the number of fields that must differ (say, one word for two fields), TDC
  raises a clear error instead of looping forever.
- **At the `<env>` level the group takes single-value sequences only** — a plain
  `<gen>` or a [`<mix>`](mix.md#top). A compound (multi-field) sequence there is rejected with
  error `TDC129`.

## `uniq` — the combination never repeats

`uniq="true"` on a **compound** [`<sequence>`](../core-concepts/sequences.md#top) means
the combination of **all** its fields never repeats anywhere in the dataset.
`(James, Miller)` and `(James, Davis)` are fine; two `(James, Miller)` rows are not.

On a **simple** sequence — one unnamed `<gen>` — `uniq="true"` means the value itself
never repeats: the draw runs **without replacement**. A weighted pack keeps its meaning
(frequent names are more likely to make the cut), but nothing appears twice. When the
source holds fewer distinct values than there are records, the run refuses up front and
names both numbers — never a quiet repeat. Supported sources: `text` value lists,
`template` packs, `file` columns and plain integer ranges (`value="1..100000"`);
`increment`/`decrement` are unique by construction. A generator whose values cannot be
enumerated (`regex`, `date`, …) is refused with a message saying exactly that.

```xml
<sequence name="Person" uniq="true">
    <gen name="first" type="template" value="person.male.firstName"/>
    <gen name="last"  type="template" value="person.lastName"/>
</sequence>

<block>
    <line><data>${{Person.first}} ${{Person.last}}</data></line>
</block>
```

No `(first, last)` pair repeats. With 200 first names and 500 last names there are
up to 100,000 unique pairs; ask for more and you get an honest error up front
(see below).

### Before / after, on a tiny set

Two fields with tiny sets — `first ∈ {Ann, Bob}` and `last ∈ {Fox, Lee}` — give only
4 possible pairs. Ask for 4 rows.

**Without `uniq`** (each field random on its own):

```xml
<sequence name="P">
    <gen name="first" type="text" value="Ann,Bob"/>
    <gen name="last"  type="text" value="Fox,Lee"/>
</sequence>
<block><line><data>${{P.first}} ${{P.last}}</data></line></block>
```

`./run p.tdc (4 rows, counted)`

```
Ann Fox   2
Bob Lee   2
```

The combinations **repeat**: `Ann Fox` and `Bob Lee` each came up twice, while
`Ann Lee` and `Bob Fox` never appeared. Randomness knows nothing about uniqueness.

**With `uniq="true"`** (same config, one attribute added):

```xml
<sequence name="P" uniq="true">
    <gen name="first" type="text" value="Ann,Bob"/>
    <gen name="last"  type="text" value="Fox,Lee"/>
</sequence>
```

`./run p.tdc (4 rows, counted)`

```
Ann Fox   1
Ann Lee   1
Bob Fox   1
Bob Lee   1
```

All 4 pairs, once each, no repeats.

### Proportions are preserved

The engine only **rearranges** field values between rows; it never changes how many
of each there are. So a [`percent`](../generators/text.md#top) list stays exact —
uniqueness and an exact distribution can coexist. `percent="70,30"` still splits
70/30 even while every combination stays unique.

### The feasibility check — before generation

Before rendering, TDC works out whether `count` unique combinations are even
possible from your data. If not, you get an error **immediately**, not hours in:

`./run big.tdc`

```
uniq: sequence "Person" requested 10000 unique combinations, but its
data supports at most 5000. Add more values to a field, or lower
the count.
```

The tiny set makes the same point. Only 4 pairs exist; ask for `count="5"` and TDC
doesn't churn away at it — it says so right away:

`./run p5.tdc`

```
tdc: uniq "P" is infeasible — only 4 distinct combinations exist,
but 5 unique rows were requested.
```

> [!NOTE]
> **Keep a comfortable margin**
>
> The maximum number of unique combinations is bounded by the product of the number of
> **distinct** values in each field. When a field draws randomly ([`text`](../generators/text.md#top)
> without `percent`), a skewed sample can shrink the usable pool. For `uniq`, keep a
> comfortable margin (many more possible combinations than `count`), or set `percent`
> for an even spread.

## `<uniq>` — across separate sequences

When the fields live in **different** sequences, wrap them in `<uniq>…</uniq>` — the
**combination of those sequences' values** becomes unique across all rows:

```xml
<uniq>
    <sequence name="First"><gen type="template" value="person.male.firstName"/></sequence>
    <sequence name="Last"><gen type="template" value="person.lastName"/></sequence>
</uniq>
<block><line><data>${{First}} ${{Last}}</data></line></block>
```

Only single-value sequences (a plain [`<gen>`](../generators/overview.md#top) or a
`<mix>`) can go in the group; a compound sequence can't.

> [!NOTE]
> **Not a "unique id"**
>
> This is about the uniqueness of a **combination of fields**, not a counter. For a
> running number, use [`increment`](../generators/counters.md#top).

### Making a *joined* value unique

`uniq` is a property of a **draw**. A sequence whose value is
[computed](../compute/overview.md#top), or picked per row by `if=`, isn't drawn from a
pool — there is nothing to take without replacement — so `uniq=` on it is refused
with [`TDC218`](../reference/errors.md#top) rather than quietly ignored.

Put `uniq` on the parts instead, and glue them together in the output:

```xml
<uniq>
    <sequence name="Area"><gen type="number" value="900..999"/></sequence>
    <sequence name="Group"><gen type="number" value="1..99" length="2" first_zero="true"/></sequence>
    <sequence name="Serial"><gen type="number" value="1..9999" length="4" first_zero="true"/></sequence>
</uniq>
<block><line><data>${{Area}}${{Group}}${{Serial}}</data></line></block>
```

Every row's `(Area, Group, Serial)` triple is unique, and because each part is a
**fixed width** — 3, 2 and 4 digits — the nine-digit string can be split back into the
triple exactly one way. A unique triple is therefore a unique string.

That last sentence is the whole trick, and it is also its limit. If a part's width
varied, two different triples could join into the same string: `9|15…` and `91|5…`
read alike once the boundary is gone.

## Large volumes

`uniq` runs on disk by default, no flags — but how fast it runs depends on **what**
you're making unique:

- **Over finite text lists, without `percent`**, a fast engine guarantees uniqueness
  *by construction* (a mixed-radix numbering plus a permutation), without storing
  anything it has already generated, up to `2^52` combinations. This scales freely —
  a hundred thousand rows in a second.
- **Over numbers, dates, or templates, or with `percent` on a column**, TDC can't
  number the combinations up front, so it switches to the exact on-disk engine: it
  generates, then **sorts the whole output and repairs any collisions**.

> [!CAUTION]
> **Exact `uniq` on a huge output is SLOW — `uniq` + `percent` most of all**
>
> The sort-and-repair check is thorough, and its cost grows **faster than linearly** with
> the row count. Memory stays bounded, but time doesn't — hundreds of thousands of unique
> rows already take **minutes**, and millions can run for **hours or longer**. That's the
> honest price of guaranteeing *no repeat at all* across a huge file.
>
> **`uniq` together with `percent` on the same columns is the worst case there is:**
> asking for exact proportions and no repeats at once stacks a constrained layout on top
> of the sort, which is slower again by a wide margin. If a run is taking forever,
> dropping either the `percent` or the `uniq` is usually what fixes it.
>
> For uniqueness at massive scale, prefer the cheap-by-construction kinds — a
> [counter](../generators/counters.md#top), or a [`number`](../generators/number.md#top) range
> wide enough that a collision is vanishingly unlikely — and save `uniq="true"` over
> numeric/percent columns for the sizes where the exhaustive check is worth the wait.

The `mode="memory"` escape hatch (the small in-RAM engine) supports every form of `uniq`
too — exact, but bounded by RAM. See **[Large outputs](../guides/large-outputs.md#top)**.

## See also

- **[Sequences](../core-concepts/sequences.md#top)** — compound sequences and fields,
  the structures `uniq` and `<distinct>` operate on.
- **[Determinism & proportions](../core-concepts/determinism.md#top)** — why `uniq`
  recomputes when `count` changes.

---

← Previous: [One row per element (each)](./relational-tables.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../compute/overview.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/constructs/unique-values)**
