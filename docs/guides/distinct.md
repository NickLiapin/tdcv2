<a name="top"></a>

**English** · [Русский](../ru/guides/distinct.md#top) · [Español](../es/guides/distinct.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/distinct)**

← Previous: [Coherent & relational data](./coherent-data.md#top) · **[Contents](../README.md#top)** · Next: [Reading files & CSV](./files-and-csv.md#top) →

---

# The `<distinct>` tag

**Use it when** two fields in the same row draw from the same pool and must not land
on the same value — two symptoms for one patient, because nobody presents with _fever
and fever_; a country of birth and a country of residence that shouldn't be identical.
`<distinct>` says one thing: _its direct children must differ from each other within a
row._

This is a **horizontal** rule — it looks across the fields of a single row. Its
vertical twin is [`uniq`](../constructs/unique-values.md#top), which keeps the **whole row**
from repeating anywhere in the dataset. Use either one, or both in one config on
**different** fields — on the same fields the combination is refused (`TDC267`).

> [!NOTE]
> **Example outputs are illustrative**
>
> The exact draws below are what a typical run produces, and they can change with the
> core version and the `seed`. What never changes is the **structure** `<distinct>`
> guarantees — no two children of a group are ever equal within a row.

![](../img/guides/distinct-uniq.svg)

*How often each combination of two fields came up. Across the top: the first field; down the side: the second.*

- **A** — with distinct, over 60 rows: the diagonal is empty, because a row can never repeat a value across its fields
- **B** — with uniq, over 6 rows: no cell is ever above 1, because a combination can never repeat across rows — the empty cells are combinations this run simply never reached

## The problem: two fields collide

Take two fields that read from the **same** list. The two
[`<gen>`](../generators/overview.md#top) fields run independently, so sooner or later
some row draws the same word twice. Here both fields use a short four-value list,
so the collisions show up right away:

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

## The fix: wrap the fields

Wrap both fields in `<distinct>`. Everything else stays the same — same
generators, same list, even the same `seed`:

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

**The payoff.** The rows that had no collision are **byte-for-byte the same** — the
engine left them alone. Only the two collisions were repaired: `Headache, Headache`
became `Headache, Nausea`, and `Nausea, Nausea` became `Nausea, Cough`. Only the second
field was redrawn, and only where it had to be. Order and `seed` are preserved.

## Two levels

`<distinct>` works in two places, with **the same rule in both**: the direct children
of `<distinct>` produce different values in each row. All that changes is what counts
as a "child".

### 1. Inside a `<sequence>` — it wraps `<gen>` fields

Here `<distinct>` sits inside a
[`<sequence>`](../core-concepts/sequences.md#top) and wraps the `<gen name="…">`
fields. Read it as "A ≠ B". This one draws from the real symptom list in the
[data pack](../data-packs/overview.md#top) instead of a hand-written list of four:

```xml
<sequence name="Case">
    <distinct>
        <gen name="A" type="template" value="medical.symptom"/>
        <gen name="B" type="template" value="medical.symptom"/>
    </distinct>
</sequence>
```

`./run case.tdc (6 rows) — A + B`

```
Constipation + Skin Rash
Confusion + Constipation
Itching + Swelling
Sneezing + Fever
Cramping + Sneezing
Itching + Runny Nose
```

**Why here:** both fields pull from the same
[`template`](../generators/template.md#top) pool, yet the two values in each row always
differ. This is the everyday case — two attributes of one entity that share a source
but must not coincide. A value can still repeat _down_ a column (`Itching`
shows up in rows 3 and 6): `<distinct>` looks across a row, never down the dataset.

### 2. Inside `<env>` — it wraps whole `<sequence>` blocks

At the top level, `<distinct>` sits inside
[`<env>`](../core-concepts/configuration.md#top) and wraps entire `<sequence>`
blocks. The classic example is country of birth versus country of residence: two
independent picks from the same country list will occasionally come out identical in
one row.

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

**Why here:** the two values now live in separate sequences, so no single sequence can
compare them — the group has to sit one level up, in `<env>`. Within any one row, the
birth country and the country of residence never match.

## How it works

The engine generates the fields as usual. If two values inside a group collide in a
row, it **redraws** one of them with the generator's next value, and keeps going until
they differ. Determinism is preserved: the redraws run in a fixed order, so the output
for a given `seed` doesn't change. It works the same in the in-memory engine and in
streaming mode — see [Large outputs](large-outputs.md#top).

## Details and gotchas

A few rules worth keeping in mind:

### Values are compared, not sources

`<distinct>` looks at the produced **string**, not where it came from. If two
fields read from different files but happen to emit the same word, they still
count as a collision and one gets redrawn.

### Groups are independent

You can have several `<distinct>` blocks, and they don't interfere with each other. A
group for the two symptoms and a separate group for, say, two phone numbers each
enforce their own rule, with no cross-talk.

```xml
<sequence name="Case">
    <distinct>
        <gen name="A" type="template" value="medical.symptom"/>
        <gen name="B" type="template" value="medical.symptom"/>
    </distinct>
    <distinct>
        <gen name="HomePhone" type="regex" value="\+1 \([0-9]{3}\) [0-9]{3}-[0-9]{4}"/>
        <gen name="CellPhone" type="regex" value="\+1 \([0-9]{3}\) [0-9]{3}-[0-9]{4}"/>
    </distinct>
</sequence>
```

**Why:** each group scopes its own constraint. The two symptoms can never equal each
other, and neither can the home and cell numbers — but a symptom is free to match a
phone number that happens to render the same way, because the two groups can't see
each other.

### Fields outside `<distinct>` keep no constraint

Only the direct children of a `<distinct>` group are constrained. Any field left
outside the group is generated normally and is free to repeat a value that one of the
distinct fields produced.

### Too few values fails cleanly

If a list holds fewer distinct values than the number of fields that must differ — say
one word for two fields — the constraint is impossible to satisfy. Rather than looping
forever, TDC gives up after 1,000 attempts at a row and says so. Unlike `uniq`, which
proves feasibility before generating, this one trips during the run — quickly, but not
before it starts:

`./run person.tdc`

```
tdcv2: stream mode: <distinct> in sequence "Person": could not find a value
for field "B" different from the others after 1000 attempts — its source
likely has too few distinct values.
```

**Why:** an impossible request should fail loudly rather than hang. What differs from
[`uniq`](../constructs/unique-values.md#top) is the timing: `uniq` proves the whole column
feasible before generating, while `<distinct>` finds out on the first row it cannot
satisfy.

### At the `<env>` level, groups take single-value sequences only

A `<distinct>` inside `<env>` can wrap only **single-value** sequences — a plain
[`<gen>`](../generators/overview.md#top), a `<mix>` or a `<switch>`. A compound
(multi-field) sequence has no single value to compare, so putting one in the group is
rejected with error `TDC129`:

`./run migration.tdc`

```
error[TDC129]: <sequence name="Person"> inside a config-level <distinct> must produce a single value
note: A <distinct> around sequences uses one value per sequence. Use a simple
<gen> or a <switch> sequence, not a compound (multi-field) one.
```

**Why:** the horizontal rule needs one value per child to compare. Inside a sequence,
wrap the `<gen>` fields directly (the level-1 form above); at the `<env>` level, keep
each grouped sequence down to a single value.

### Two references to one `<pool>` — compared by RECORD, not by value

A `<gen type="pool">` sequence is the exception, and the case the group is most often
written for: two people drawn from the same pool who must not be the same person.

A reference holds a whole member, so there is no value to compare — the group compares
**which member the row took** instead. Put the references in the group and no row hands
two of them the same record:

```xml
<pool name="Doctors" count="6">
  <sequence name="name" uniq="true"><gen type="text" value="Adams,Brooks,Chase,Dunn,Ellis,Frost"/></sequence>
</pool>
<distinct>
  <sequence name="Duty"><gen type="pool" value="Doctors"/></sequence>
  <sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>
</distinct>
```

`./run clinic.tdc (6 rows, seed=clinic)`

```
on duty: Chase | seen by: Ellis
on duty: Brooks | seen by: Frost
on duty: Brooks | seen by: Chase
on duty: Dunn | seen by: Brooks
on duty: Ellis | seen by: Frost
on duty: Adams | seen by: Frost
```

The comparison is by identity, not by name: two members that happened to share a field
would still be two different records, and the group keeps them apart on that basis.

It composes with `filter=`. The filter decides which members this row may have; the group
then hands each reference a different one of those. Both promises hold at once.

Three shapes are refused with `TDC302`, because none of them can mean anything:

- a reference beside an ordinary sequence — one holds a record and the other a string,
  and there is no field the comparison would be about;
- references to two **different** pools — a doctor is never the same record as a ward, so
  the group would be satisfied without doing anything;
- more references than the pool has members — no arrangement exists.

`<uniq>` at the `<env>` level works over references the same way, one axis over: no two
**rows** take the same combination of members. A pool of 6 offers 36 ordered pairs, so a
run longer than the pairs the draw produced is refused up front rather than quietly
repeating.

`uniq` keeps that promise by rearranging the picks, and an arrangement needs the whole
column — it cannot be found a row at a time. So this one shape runs on the in-memory
engine, the way a running total does; `<distinct>` is settled per row and streams
normally.

## `<distinct>` vs. `uniq` at a glance

| Mechanism    | Axis       | Scope    | Meaning                                        |
| :----------- | :--------- | :------- | :--------------------------------------------- |
| `<distinct>` | horizontal | one row  | fields **don't equal each other** within a row |
| `uniq`       | vertical   | all rows | the **combination of fields** never repeats    |

They solve different problems, and one config may use both — on **different** fields.
Put them on the same fields and `check` refuses it with `TDC267`: `uniq` rearranges the
finished columns without knowing which pairings the repair ruled out, so the repair is
undone. For the vertical rule, see [Unique values](../constructs/unique-values.md#top).

## May contain

| Tag                                            | Where               | What it holds              |
| :--------------------------------------------- | :------------------ | :------------------------- |
| [`<gen/>`](../generators/overview.md#top)         | inside `<sequence>` | Fields that must differ    |
| [`<sequence>`](../core-concepts/sequences.md#top) | inside `<env>`      | Sequences that must differ |

## See also

- **[Unique values](../constructs/unique-values.md#top)** — `uniq`, the vertical twin: whole rows
  that never repeat across the dataset.
- **[Sequences](../core-concepts/sequences.md#top)** — compound sequences and fields,
  the structures `<distinct>` operates on.
- **[Determinism & proportions](../core-concepts/determinism.md#top)** — why a fixed
  `seed` reproduces the same output, redraws and all.

---

← Previous: [Coherent & relational data](./coherent-data.md#top) · **[Contents](../README.md#top)** · Next: [Reading files & CSV](./files-and-csv.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/distinct)**
