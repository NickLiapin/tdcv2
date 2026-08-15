<a name="top"></a>

**English** · [Русский](../ru/generators/advanced-regex.md#top) · [Español](../es/generators/advanced-regex.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/advanced-regex)**

← Previous: [Regex](./regex.md#top) · **[Contents](../README.md#top)** · Next: [Increment & Decrement](./counters.md#top) →

---

# The `advanced_regex` generator

**Use it when** you need everything [`regex`](regex.md#top) does, but the shape of the
string itself carries a **statistical distribution** of variants — say, exactly 70%
of the codes start with `RU`, 20% with `US`, 10% with `DE`.

Plain [`regex`](regex.md#top) picks an alternation `(RU|US|DE)` **randomly**, so the
split only comes out right on average. `advanced_regex` adds **weighted choice**,
which lays the variants out in **exact** counts.

```xml
<gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{6}"/>
```

`advanced_regex` is a superset of `regex`: the ordinary
[`type="regex"`](regex.md#top) generator stays stable and TDC-neutral, while
`advanced_regex` layers TDC-specific power on top of the same finite, portable
engine. Today that extra power is exactly one construct — **weighted choice** — and
everything else on this page is inherited unchanged from
[Regex](regex.md#top).

## Why you need it

Without weighted choice, "70% `RU`, 20% `US`, 10% `DE`, each followed by six random
digits" would take several sequences or a [`<mix>`](../reference/tags.md#distributions-and-choice)
to express. With `advanced_regex` it collapses into a single generator. It's a
natural fit for:

- codes for countries, branches, regions, or customer tiers
- test identifiers that must vary in structure but hold fixed proportions
- document numbers where one part of the string has to repeat another
- synthetic data where the **shares** matter as much as the values
- AI-generated `.tdc` files, where an agent finds it easier to emit one compact
  pattern than a tree of sequences

Example outputs below are illustrative — exact rows depend on the seed and can shift
slightly between core versions — but the **counts** a distribution promises are
exact.

## Weighted choice

The construct is:

```text
(?%{PERCENT:BRANCH;PERCENT:BRANCH;...})
```

Piece by piece:

```text
(?%{   70:RU   ;   20:US   ;   10:DE   })
 │      │  │        │  │        │  │     │
 │      │  branch   │  branch   │  branch│
 │      percent     percent     percent  │
 └── start of weighted choice            ┘
```

The rules:

- percentages must be numbers, and they must be **non-negative**
- the percentages must **sum to 100**
- a branch may be empty
- a branch is itself a full `advanced_regex` expression, so branches nest
- `;`, `}`, and `:` are the control characters — [escape them](#escaping-inside-a-weighted-choice)
  if a branch needs them literally

## Exact proportions, by default

This is the headline: weighted choice promises **exact** percentages (exactly 70 of
100, not "about 70"), and TDC delivers them **out of the box** — you switch nothing
on.

To measure the split exactly, the engine builds the **whole column at once** and
hands out branches with the Hamilton (largest-remainder) method. It does this
automatically the moment a `(?%{…})` appears in the pattern — even under the default
`disk` mode. All you supply is the pattern; the shares come out exact.

```xml
<env count="100" seed="countries">
  <sequence name="CountryCode">
    <gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/>
  </sequence>
</env>
```

Count the prefixes across all 100 rows — exactly 70/20/10:

`./run countries.tdc (100 rows, by prefix)`

```
RU   70
US   20
DE   10
```

> [!NOTE]
> **The cost of exactness is memory**
>
> To measure the split exactly, a weighted-choice column is built entirely in RAM.
> Fine for small and medium sets. If you need exact shares while **streaming** (O(1)
> memory, any output size), [`<mix percent>`](../reference/tags.md#distributions-and-choice)
> and [`<gen type="text" percent="…">`](text.md#exact-proportions-with-percent) give
> exact proportions in a stream, without holding the whole column. And if you
> _manually_ force the pure streaming engine (`mode="stream"` on `<env>`, an attribute-only
> legacy alias, or `--engine 2` on the command line — `--mode stream` is not a thing), TDC
> won't silently ruin the percentages — it can't count them one row at a time, so it
> refuses with a clear error. Drop the override and it's exact again.

## The weights really move the distribution

The percentages are not decoration — they are the actual makeup of the column. Take
one pattern, `(?%{…})-[0-9]{2}` at `count="1000"`, change **only the weights**, and
count the prefixes:

```xml
<gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/>  <!-- variant 1 -->
<gen type="advanced_regex" value="(?%{34:RU;33:US;33:DE})-[0-9]{2}"/>  <!-- variant 2 -->
<gen type="advanced_regex" value="(?%{10:RU;10:US;80:DE})-[0-9]{2}"/>  <!-- variant 3 -->
```

`./run weights.tdc (1000 rows, by prefix)`

```
weights          RU     US     DE
70 / 20 / 10     700    200    100
34 / 33 / 33     340    330    330
10 / 10 / 80     100    100    800
```

Over 1000 rows the counts reproduce the weights exactly. Change the weights and the
makeup of the column changes with them.

## `regex` vs `advanced_regex`

| Capability                               | `regex` | `advanced_regex` |
| :--------------------------------------- | :------ | :--------------- |
| Generate a string from a pattern         | yes     | yes              |
| Character classes                        | yes     | yes              |
| Named Unicode alphabets                  | yes     | yes              |
| Groups and backreferences                | yes     | yes              |
| Length cap via `regex_max_length`        | yes     | yes              |
| **Exact percentages inside the pattern** | no      | **yes**          |
| **Nest weighted variants**               | no      | **yes**          |
| Weighted choice in the output block      | no      | no               |

The difference is easiest to see side by side. Plain [`regex`](regex.md#top) picks each
character freely — the shape is fixed, the shares are not:

```xml
<gen type="regex" value="[A-Z]{2}[0-9]{6}"/>
```

`./run plain.tdc`

```
FZ399441
YH481897
LR586083
YA900972
WT831899
```

`advanced_regex` keeps the same kind of code but pins the prefix shares — 70% `RU`,
20% `US`, 10% `DE` over the full run:

```xml
<gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{6}"/>
```

`./run coded.tdc (first 8 of 100 rows)`

```
RU-441627
RU-476822
RU-948319
US-450875
RU-398584
RU-131212
RU-418648
RU-830959
```

In short: use `regex` for a string of a given form; use `advanced_regex` when the
form itself carries a statistical distribution.

## It inherits the whole regex language

Every finite construct from [`regex`](regex.md#top) works here too — literals, escapes,
character classes, BMP ranges, named alphabets `\a{…}`, `\d`/`\w`/`\s` and their
inverses, `.`, alternation, groups, backreferences, bounded quantifiers, and the
[`regex_max_length`](../reference/attributes.md#top) cap. A simple weighted split over
plain Latin codes:

```xml
<gen type="advanced_regex" value="(?%{70:[A-Z]{2};30:[A-Z]{3}})-[0-9]{4}"/>
```

`./run mixed.tdc`

```
QY-3500
ZT-3381
GSK-1914
VO-5921
DW-7570
SO-1660
MSE-2247
```

**Unicode demo.** Because the branches accept
[named alphabets](symbol.md#named-alphabets-with-alphabet), you can hold exact
shares across scripts. Here 7 of 10 codes take a Cyrillic prefix and 3 take a Latin
one — a deliberate Unicode/localization example, showing that the exact-percentage
machinery is script-agnostic:

```xml
<gen type="advanced_regex" value="(?%{70:\a{cyrillic.ru.upper}{2};30:\a{latin.upper}{2}})-[0-9]{4}"/>
```

`./run unicode.tdc (count=10)`

```
ЭЗ-2477
WJ-0170
ЧП-8026
СЦ-1020
ЫЦ-2747
FJ-7879
РЛ-6827
ЩЕ-4485
ПВ-0297
UD-1550
```

## Nested weighted choice

Because branches are full expressions, weighted choices nest — and the inner split
is computed **inside the subset** that reached the outer branch:

```xml
<gen type="advanced_regex" value="(?%{50:A(?%{80:X;20:Y});50:B})"/>
```

At `count="100"`:

`./run nested.tdc (100 rows)`

```
AX   40
AY   10
B    50
```

80% of the 50 `A` rows gives 40 `AX`; the other 20% gives 10 `AY`. This
"percentages within a subset" behavior matches TDC's
[sequence-hierarchy](../core-concepts/sequences.md#top) philosophy exactly.

## Several weighted choices in one pattern

```xml
<gen type="advanced_regex" value="(?%{60:M;40:F})-(?%{25:00;75:99})"/>
```

Each distribution is worked out exactly, over the same set of rows. At `count="100"`:

`./run two.tdc (100 rows)`

```
M-99   44
F-99   31
M-00   16
F-00    9
```

Add up each part and both are exact: `M` = 44 + 16 = 60 and `F` = 31 + 9 = 40
(60/40); `99` = 44 + 31 = 75 and `00` = 16 + 9 = 25 (75/25). Two independent picks,
each laid out by the same exact-percentage method.

## With a `parent` filter

`advanced_regex` lives inside the normal sequence-dependency model. If the sequence
is filtered by [`parent`](../core-concepts/sequences.md#dependent-sequences-parent), the
percentages count **only within the filtered subset**:

```xml
<sequence name="Gender">
    <gen type="text" value="M,F" percent="50,50"/>
</sequence>

<sequence name="MaleCode" parent="Gender.M">
    <gen type="advanced_regex" value="M-(?%{40:A;60:B})-[0-9]{2}"/>
</sequence>
```

At `count="100"` (50 men):

`./run parent.tdc (100 rows)`

```
F      50    (MaleCode empty)
M-A    20
M-B    30
```

The 40/60 split is measured against the **50 filtered rows**, not the full 100.

## Captures and backreferences

A backreference repeats a group that was already generated. This works exactly as in
plain [`regex`](regex.md#top) — the first three digits are echoed at the end:

```xml
<gen type="advanced_regex" value="([0-9]{3})-[A-Z]{2}-\1"/>
```

`./run backref.tdc`

```
299-YZ-299
929-UE-929
462-VR-462
905-BC-905
876-JF-876
```

**A weighted branch can be captured** and repeated with `\1` — the captured part is
echoed verbatim and the percentages still hold. At `count="40"`:

```xml
<gen type="advanced_regex" value="((?%{25:AB;75:CD}))-\1"/>
```

`./run branch-capture.tdc (40 rows)`

```
AB-AB   10
CD-CD   30
```

The captured pair is repeated literally, and the 25/75 split survives.

**A capture made before a weighted choice** can be used inside a branch. Here half
the rows repeat the captured two letters, half print the fixed `XX` (`count="8"`):

```xml
<gen type="advanced_regex" value="([A-W]{2})-(?%{50:\1;50:XX})"/>
```

`./run capture-in-branch.tdc`

```
TV-XX
GR-GR
RN-XX
OU-OU
WM-WM
SS-XX
CL-XX
QG-QG
```

**A backreference can live inside a branch.** Where the `(A[0-9])` branch was taken,
`\1` repeats its capture; where the `B` branch was taken, there is no capture, so
`\1` comes out empty (`count="20"`):

```xml
<gen type="advanced_regex" value="(?%{40:(A[0-9]);60:B})-\1"/>
```

`./run optional-capture.tdc`

```
A2-A2
B-
B-
A1-A1
B-
A8-A8
B-
```

It isn't a full `if`, but it's already a useful logical link: one part of a string
can depend on an already-generated group.

## Escaping inside a weighted choice

`;`, `}` and `:` are the control characters of a weighted choice. To use them as
literal text in a branch, escape them (`count="6"`):

```xml
<gen type="advanced_regex" value="(?%{50:A\;\}\:;50:B})"/>
```

`./run escape.tdc`

```
A;}:
A;}:
B
B
A;}:
B
```

The branch `A\;\}\:` prints the literal `A;}:`, and the branch `B` prints just `B`.

## Where weighted choice works

Weighted choice sets an exact percentage split, so the runtime has to know how many
rows fall into each branch. That count is known everywhere a `<gen>` can appear:

- inside a [`<sequence>`](../core-concepts/sequences.md#top) — from `count`, or from a
  `parent` subset
- inside a `<case>` of a [`<mix>`](../reference/tags.md#distributions-and-choice) —
  from the size of that case

Both are valid:

```xml
<sequence name="CountryCode">
    <gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/>
</sequence>

<mix name="Country" percent="50,50">
    <case><gen type="advanced_regex" value="(?%{70:RU;30:US})"/></case>
    <case><data>-</data></case>
</mix>
```

There are **no generators in the output block** — a
[`<line>`](../core-concepts/output-formatting.md#top) only formats — so weighted choice
never lands there. To print one, declare it as a sequence and interpolate it with
`${{Name}}`:

```xml
<tdc>
    <env count="100" seed="demo" inject="${{%}}">
        <sequence name="Code">
            <gen type="advanced_regex" value="(?%{70:A;30:B})-[0-9]{4}"/>
        </sequence>
    </env>
    <block>
        <line><data>code=${{Code}}</data></line>
    </block>
</tdc>
```

The first few rows, with the run splitting exactly 70 `A` / 30 `B`:

`./run code.tdc (first rows of 100)`

```
code=A-8870
code=B-2495
code=B-1961
code=A-8865
code=A-9221
code=A-3234
```

The row order is shuffled deterministically by `seed`; the totals stay exact.

## Practical examples

**Customer code by segment** — `count="1000"`, count the prefixes:

```xml
<gen type="advanced_regex" value="(?%{80:REG;15:VIP;5:TEST})-[A-Z]{2}[0-9]{4}"/>
```

`./run segment.tdc (1000 rows, by prefix)`

```
REG    800
VIP    150
TEST    50
```

**Document with a repeating block** — the first three digits and the last three
digits always match, while the middle splits 60% `A` / 40% `B` (`count="100"`):

```xml
<gen type="advanced_regex" value="([0-9]{3})-(?%{60:A;40:B})-\1"/>
```

`./run doc.tdc (first rows of 100)`

```
924-B-924
419-B-419
788-A-788
692-B-692
```

**Short vs long technical codes** — 85% short, 15% long (`count="100"`):

```xml
<gen type="advanced_regex" value="(?%{85:[A-Z]{2}[0-9]{2};15:[A-Z]{4}[0-9]{8}})"/>
```

`./run codes.tdc (100 rows, by length)`

```
length  4    85    (AB42)
length 12    15    (ABCD12345678)
```

## `<mix>` or `advanced_regex`?

Both do exact percentages, for different jobs.

Use [`<mix>`](../reference/tags.md#distributions-and-choice) when the branches have
**different structure** — each with its own generators and its own literal text (and
`<mix percent>` gives exact shares while **streaming**, without holding the column in
memory):

```xml
<mix name="Kind" percent="70,30">
    <case><data>{"type":"regular"}</data></case>
    <case><data>{"type":"vip","bonus":true}</data></case>
</mix>
```

Use `advanced_regex` when the whole thing fits in one pattern (exact by default; the
column is built in RAM — for very large outputs prefer `<mix percent>`):

```xml
<gen type="advanced_regex" value="(?%{70:REG;30:VIP})-[0-9]{6}"/>
```

## Invalid patterns

```xml
<gen type="advanced_regex" value="(?%{70:A;20:B})"/>   <!-- sums to 90, needs 100 -->
<gen type="advanced_regex" value="[a-z]+"/>            <!-- unbounded, as in plain regex -->
```

Both are rejected before generation. Here's the error for the second one:

`./run bad.tdc`

```
error: invalid advanced_regex generator pattern: unbounded "+"
quantifier is not allowed; use "{1,n}"
```

## Planned, not yet implemented

The syntax below shows the intended direction, but none of it is valid today.
Named captures:

```text
(?<sex>(?%{50:male;50:female}))
```

Conditionals, whose branches are meant to be full `advanced_regex` expressions so
that weighted choices and further conditionals can nest inside them:

```text
(?if{sex=male:MR;sex=female:MS})
```

Until they ship, model cross-field logic with a
[`parent`](../core-concepts/sequences.md#dependent-sequences-parent) filter or a
[`<mix>`](../reference/tags.md#distributions-and-choice).

## See also

- **[Regex](regex.md#top)** — the finite constructs this page inherits.
- **[Symbol](symbol.md#named-alphabets-with-alphabet)** — the named alphabets
  (`\a{name}`).
- [`regex_max_length`](../reference/attributes.md#top) in the attribute reference.
- [`<mix>`](../reference/tags.md#distributions-and-choice) — exact percentages
  across structurally different branches.

---

← Previous: [Regex](./regex.md#top) · **[Contents](../README.md#top)** · Next: [Increment & Decrement](./counters.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/advanced-regex)**
