<a name="top"></a>

**English** · [Русский](../ru/guides/hierarchical-dependencies.md#top) · [Español](../es/guides/hierarchical-dependencies.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/hierarchical-dependencies)**

← Previous: [A pack read line by line](../compute/walkthrough.md#top) · **[Contents](../README.md#top)** · Next: [Coherent & relational data](./coherent-data.md#top) →

---

# Hierarchical dependencies

An ordinary fake-data library fills every field independently. TDC ties
[sequences](../core-concepts/sequences.md#top) together in a **parent → child**
relationship: a child's values are generated **only on the rows where the parent took a
given value**, and any percentages inside the child are measured against the size of that
**filtered subset**, not against the whole `count`.

That is what lets one declarative config model a real dependent distribution: male names
only for men, a diagnosis that follows from sex, children with no spouse.

> [!NOTE]
> Example outputs below are illustrative. The exact _values_ a generator emits can
> change from one core version or seed to the next; what the feature guarantees is the
> **counts** and the **structural rules** — which rows get filled and which stay empty.

![](../img/guides/parent-child.svg)

*40 real rows. The parent takes A or B; each parent value has its own child alphabet, and no row ever mixes them.*

- **drawn** — rows where the parent chose A — the child below is always 1, 2, or 3
- **alt** — rows where the parent chose B — the child below is always 7 or 8

## The problem: independent fields make impossible pairs

To see why [`parent`](../reference/attributes.md#top) matters, look at what happens
**without** it. Two [`text`](../generators/text.md#top) sequences, country and city,
declared independently:

```xml
<env count="8" seed="demo">
    <sequence name="Country"><gen type="text" value="Russia,France" percent="50,50"/></sequence>
    <sequence name="City"><gen type="text" value="Moscow,Paris" percent="50,50"/></sequence>
</env>
<block><line><data>${{Country}}: ${{City}}</data></line></block>
```

`./run demo.tdc`

```
Russia: Moscow
Russia: Moscow
France: Paris
France: Paris
Russia: Moscow
France: Paris
Russia: Paris
France: Moscow
```

Each field rolls its own dice. The last two rows are the problem: **Russia: Paris
and France: Moscow** — Paris in Russia, Moscow in France. For a test that checks that
the city belongs to its country, that data is garbage, and the more rows you generate,
the more impossible pairs you get.

## The fix: `parent`

Give each country its own city generator, filtered with `parent="Country.Value"`.
Now a city is chosen **only** on the rows where the country matches:

```xml
<env count="8" seed="demo">
    <sequence name="Country"><gen type="text" value="Russia,France" percent="50,50"/></sequence>
    <sequence name="CityRU" parent="Country.Russia"><gen type="text" value="Moscow,Kazan"/></sequence>
    <sequence name="CityFR" parent="Country.France"><gen type="text" value="Paris,Lyon"/></sequence>
</env>
<block><line><data>${{Country}}: ${{CityRU}}${{CityFR}}</data></line></block>
```

`./run demo.tdc`

```
Russia: Moscow
Russia: Moscow
France: Lyon
France: Lyon
Russia: Kazan
France: Paris
Russia: Kazan
France: Paris
```

The `Country` column is unchanged (same [`seed`](../core-concepts/determinism.md#top)),
but now the city always fits: Russia gets only `Moscow`/`Kazan`, France only
`Paris`/`Lyon`. The impossible pairs are gone. On any given row exactly one of the two
city generators is active and the other is empty, so `${{CityRU}}${{CityFR}}` yields a
single city.

## How it works

1. Declare the **parent** with a distribution
   ([`text`](../generators/text.md#top) with [`percent`](../generators/text.md#top),
   [`template`](../generators/template.md#top), or any type).
2. Declare the **child** with
   [`parent="Parent.Value"`](../reference/attributes.md#top).
3. The child materializes **only on rows where `Parent == Value`**. On every other row
   its value is undefined — an empty string in
   [interpolation](../core-concepts/output-formatting.md#top).
4. Any percentages inside the child are measured against the number of **active**
   rows — the filtered subset.

## Names by gender

The classic case: men need male names, women need female names. One shared name
generator can't do it — it doesn't know the row's gender. Two name generators, each
under its own `parent`, can:

```xml
<env count="8" seed="demo">
    <sequence name="Gender"><gen type="text" value="Male,Female" percent="60,40"/></sequence>
    <sequence name="MaleName" parent="Gender.Male"><gen type="template" value="person.male.firstName"/></sequence>
    <sequence name="FemaleName" parent="Gender.Female"><gen type="template" value="person.female.firstName"/></sequence>
</env>
<block><line><data>${{Gender}}: ${{MaleName}}${{FemaleName}}</data></line></block>
```

`./run demo.tdc`

```
Female: Alexis
Male: Bruno
Male: Khari
Male: Adriel
Male: Wayne
Male: Callan
Female: Alena
Female: Naomi
```

- `Gender` at `count="8"` yields 5 `Male` + 3 `Female` (60/40 of eight, rounded by the
  largest-remainder method — see [`percent`](../core-concepts/determinism.md#top)). At
  `count="100"` it would be exactly 60 + 40.
- `MaleName` is filled **only** on male rows (the `person.male.firstName` template
  draws from the male dictionary); on female rows it's empty.
- `FemaleName` works symmetrically: it's filled only on female rows.
- Concatenating `${{MaleName}}${{FemaleName}}` leaves exactly one name per row, and it
  always matches the gender — never `Male: Alena`.

## Probability within a subset

"30% of them are fans" — 30% of **whom**? If only Russians can be fans and you take
30% of everyone, the real share of Russian fans comes out halved. Put the
[`percent`](../generators/text.md#top) on the child and it applies to the filtered rows:

```xml
<env count="100" seed="demo">
    <sequence name="Country"><gen type="text" value="RU,US" percent="50,50"/></sequence>
    <sequence name="FootballFan" parent="Country.RU"><gen type="text" value="Yes,No" percent="30,70"/></sequence>
</env>
<block><line><data>${{Country}} -> [${{FootballFan}}]</data></line></block>
```

`./run demo.tdc  (first 10 rows)`

```
RU -> [Yes]
RU -> [Yes]
US -> []
RU -> [No]
RU -> [No]
US -> []
US -> []
RU -> [No]
RU -> [No]
RU -> [No]
```

On US rows `FootballFan` is empty — the generator never fires there. Counting all 100
rows, column by column:

| What                            | Result             |
| :------------------------------ | :----------------- |
| `Country`                       | 50 RU + 50 US      |
| `FootballFan` among **RU** rows | 15 `Yes` + 35 `No` |
| `FootballFan` among **US** rows | 50 empty           |

The 30/70 split was measured against the **50** RU rows — "30% of Russians are fans",
not "30 of all 100" (which would be 30 `Yes`).

### Variation — a different split, same subset

Change nothing but the child's percentages, to `percent="50,50"`:

```xml
<sequence name="FootballFan" parent="Country.RU"><gen type="text" value="Yes,No" percent="50,50"/></sequence>
```

`./run demo.tdc  (counts over 100 rows)`

```
FootballFan among RU rows:  25 Yes + 25 No
FootballFan among US rows:  50 empty
```

You now get exactly **25 `Yes` + 25 `No`** among the same 50 RU rows — half of the
subset, not half of `count`. The US rows stay empty. This is why the percentage lives
on the child: it always scales to the parent-filtered slice.

## Declaration order

A parent **must** be declared before its child in the document. Declare them the other
way around and rendering fails immediately:

```xml
<env count="8" seed="demo">
    <sequence name="City" parent="Country.Russia"><gen type="text" value="Moscow,Kazan"/></sequence>
    <sequence name="Country"><gen type="text" value="Russia,France" percent="50,50"/></sequence>
</env>
```

`./run demo.tdc`

```
Error: parent sequence "Country" is not declared before this sequence
```

The error names the offending line and column. Cyclic dependencies and forward
references aren't supported — the dependency graph is resolved top to bottom, so
parents always come first.

## `parent` without a value

`parent="Parent"` — with **no dot and no value** — means "any row where the parent has
a value at all", regardless of _which_ value. You rarely need it at the first level (a
top-level parent always has a value), but it's the right tool for deeper chains, where
a mid-level sequence is itself filtered and you want a grandchild only where that
mid-level one fired.

Here `Country` picks the US rows, `USCity` fills only those rows, and `USZip` should
appear wherever there **is** a US city, no matter which one — so it uses the valueless
form:

```xml
<env count="8" seed="demo">
    <sequence name="Country"><gen type="text" value="US,UK" percent="50,50"/></sequence>
    <sequence name="USCity" parent="Country.US"><gen type="text" value="New York,Chicago"/></sequence>
    <sequence name="USZip" parent="USCity"><gen type="regex" value="[0-9]{5}"/></sequence>
</env>
<block><line><data>${{Country}} | ${{USCity}} ${{USZip}}</data></line></block>
```

`./run demo.tdc`

```
US | New York 10021
US | Chicago 60614
UK |
UK |
US | New York 10021
UK |
US | Chicago 60614
UK |
```

`USZip` fires on every US row and nowhere else — `parent="USCity.New York"` would have
restricted it to New York alone. The valueless form says "inherit the parent's
filter, don't add my own", which is exactly what you want for a field that hangs off
whatever the parent produced.

## Interaction with `if`

[`if` expressions](../reference/attributes.md#top) evaluate against the current row's
values. On a filtered-out row the child's value is undefined, which counts as empty —
and empty is false. So a condition on a child column automatically excludes the rows
where that child never fired, without an explicit parent check:

```xml
<env count="8" seed="demo">
    <sequence name="Country"><gen type="text" value="RU,US" percent="50,50"/></sequence>
    <sequence name="FootballFan" parent="Country.RU"><gen type="text" value="Yes,No" percent="30,70"/></sequence>
</env>
<block><line>
    <data>${{Country}} ${{FootballFan}}</data>
    <data if="FootballFan == Yes"> BUY</data>
</line></block>
```

`./run demo.tdc`

```
RU Yes BUY
RU No
US
US
RU No
US
RU No
US
```

The ` BUY` tag is printed only where `FootballFan == Yes`. US rows have an empty
`FootballFan`, which the comparison reads as false, so they come out without it — and you
never had to write `Country == RU` in the condition.

## A tree in the data, not in the config

`parent` relates one **sequence** to another. A different job comes up almost as often:
a record that points at _another record of the same kind_. An employee whose manager is
an employee, a comment replying to a comment, a category inside a category.

That is a column, not a construct — and the whole difficulty is one word: **cycles**. A
manager chain that loops will hang whatever renders it, and no amount of redrawing fixes
it, because the problem is in the shape rather than in any one value.

The fix is arithmetic, and it needs nothing new. Point every record at a **lower id than
its own**:

```xml
<env count="10" seed="tree" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Back"><gen type="number" value="1..4"/></sequence>
    <sequence name="ParentId"><compute><result>
        <choose>
            <when>
                <test><less_than><subtract><to_number><field name="Id"/></to_number><to_number><field name="Back"/></to_number></subtract><int v="1"/></less_than></test>
                <then>
                    <choose>
                        <when><test><equals><to_number><field name="Id"/></to_number><int v="1"/></equals></test><then><int v="0"/></then></when>
                        <otherwise><int v="1"/></otherwise>
                    </choose>
                </then>
            </when>
            <otherwise><subtract><to_number><field name="Id"/></to_number><to_number><field name="Back"/></to_number></subtract></otherwise>
        </choose>
    </result></compute></sequence>
    <sequence name="Author"><gen type="template" value="person.lastName"/></sequence>
</env>
<block>
    <line><data>${{Id}},${{ParentId}},${{Author}}</data></line>
</block>
```

`./run tree.tdc`

```
1,0,Smith
2,1,Jones
3,1,Miller
4,1,Garcia
5,3,Davis
6,5,Williams
7,5,Brown
8,7,Johnson
9,7,Martinez
10,7,Rodriguez
```

Read it as `id, parent_id, author`. `Back` is how far up the tree this record attaches —
one to four rows above itself — and the two `<choose>` branches handle the top of the
file: record 1 gets `0`, the root, and anything that would reach past it attaches to the
root instead.

What that guarantees, by construction rather than by luck:

- **No cycles.** Every arrow points at a smaller number, so following them always ends.
- **One root.** Only record 1 has no parent.
- **A live shape.** Record 1 has three children here and record 2 has none, because
  `Back` is drawn per row. Widen it to `1..20` for a flat, wide tree; narrow it to `1..2`
  for a deep, thin one.

The same column works for an org chart, a threaded comment tree, a bill of materials, or
nested categories. What the records _say_ is a separate question — comment text is just
[`text.paragraph`](../generators/template.md#top) and does not have to make conversational
sense for the tree to be a valid tree.

## See also

- **[Sequences](../core-concepts/sequences.md#top)** and
  [`parent`](../reference/attributes.md#top) — the mechanics behind the filter.
- **[Determinism & proportions](../core-concepts/determinism.md#top)** — how
  [`seed`](../core-concepts/determinism.md#top) and
  [`percent`](../core-concepts/determinism.md#top) stay exact.
- **[Coherent & relational data](coherent-data.md#top)** — parent → child by name lookup.

---

← Previous: [A pack read line by line](../compute/walkthrough.md#top) · **[Contents](../README.md#top)** · Next: [Coherent & relational data](./coherent-data.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/hierarchical-dependencies)**
