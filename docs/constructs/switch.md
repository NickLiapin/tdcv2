<a name="top"></a>

**English** · [Русский](../ru/constructs/switch.md#top) · [Español](../es/constructs/switch.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/constructs/switch)**

← Previous: [Choosing between values (mix)](./mix.md#top) · **[Contents](../README.md#top)** · Next: [Conditional output (if)](./conditional-output.md#top) →

---

# Lookup tables — `<switch>`

**Use it when** one field must be **derived from another**, not drawn on its own. You
have a `Country` column and you need a `Currency` beside it that is _always_ consistent:
`US` → `USD`, `JP` → `JPY`. A second random generator is exactly wrong here — it would
hand you a currency that doesn't match the country. What you want is a **lookup table**:
read one field, return the value keyed to it.

That's `<switch>`. On every row it reads the value of one subject
[sequence](../core-concepts/sequences.md#top) (named by [`on`](#the-subject--on)) and
returns the value stored under that key. Unlike
[`<mix>`](../reference/tags.md#top), which splits a field **randomly by percentage**,
`<switch>` is **deterministic** — the subject's value fixes the result.

```xml
<tdc>
  <env count="8" seed="demo" local="en">
    <sequence name="Country">
      <gen type="text" value="US,FR,DE,JP" percent="40,25,20,15"/>
    </sequence>

    <switch name="Currency" on="Country">
      <map>US:USD, FR:EUR, DE:EUR, JP:JPY</map>
    </switch>
  </env>
  <block><line><data>${{Country}} -> ${{Currency}}</data></line></block>
</tdc>
```

`./run currency.tdc`

```
US -> USD
US -> USD
FR -> EUR
DE -> EUR
US -> USD
JP -> JPY
FR -> EUR
DE -> EUR
```

> [!NOTE]
> **Outputs are illustrative**
>
> The values below come from a fixed `seed`, so they're reproducible, but exact strings
> can differ between core versions. Treat them as examples of _shape_, not guarantees.

On every row, TDC reads `Country` and returns the currency keyed to it. This is the
"derive one field from another" job that [`<mix>`](../reference/tags.md#top) (random) and
`if` chains (verbose) both handle awkwardly.

![](../img/guides/switch.svg)

*A three-row lookup table and 24 rows generated through it.*

- **A** — the table: each key carries one value
- **B** — the generated rows — the same key always produces the same number, every time

## At a glance

`<switch>` lives **directly in `<env>`**, next to [`<sequence>`](../core-concepts/sequences.md#top)
and [`<mix>`](../reference/tags.md#top). It takes two attributes and holds one or more
branches.

| Attribute | Required | What it does                                  |
| :-------- | :------- | :-------------------------------------------- |
| `name`    | yes      | The name you interpolate with `${{name}}`     |
| `on`      | yes      | The subject sequence whose value is looked up |
| `comment` | no       | Free-text note                                |

| Child tag       | What it is                                           |
| :-------------- | :--------------------------------------------------- |
| `<map>`         | Compact `KEY:VALUE` table of **literals**            |
| `<case is="…">` | A branch whose value is a **generator or composite** |
| `<default>`     | The "else" branch — used when no key matches         |

You need **at least one** branch (a `<map>` row or a `<case>`).

## The subject — `on`

`on` names the **subject**: the sequence whose value is looked up on each row. It's
**required** on `<switch>`, and it must point at a sequence
[declared earlier](../core-concepts/sequences.md#top) in the same `<env>` (a plain
sequence, a composite field `Parent.Field`, or a built-in like `_count`). An
undeclared subject is error `TDC134`.

```xml
<sequence name="Country">
  <gen type="text" value="US,CA,MX,FR,DE,JP"/>
</sequence>

<switch name="Currency" on="Country">
  <case is="US|CA|MX"><data>USD</data></case>
  <case is="FR|DE"><data>EUR</data></case>
  <case is="JP"><data>JPY</data></case>
</switch>
```

`./run currency.tdc`

```
CA -> USD
MX -> USD
FR -> EUR
JP -> JPY
US -> USD
JP -> JPY
FR -> EUR
DE -> EUR
```

Whatever value `Country` drew on a row decides the result: `JP` always yields `JPY`,
and any of `US/CA/MX` yields `USD`. **Why it matters:** the subject is the single input.
Point `on` at a different sequence and the same table starts reading _its_ values
instead — the lookup logic is reusable.

## `<map>` — a compact literal table

When every value is a plain literal, don't write a stack of near-identical branches —
collapse them into one `<map>`. Its body is **plain text** (like
[`<data>`](../reference/tags.md#top)): not markup, but `KEY:VALUE` records.

```xml
<switch name="Currency" on="Country">
  <map>US:USD, FR:EUR, DE:EUR, JP:JPY</map>
</switch>
```

This is byte-for-byte equivalent to four separate `<case is="US"><data>USD</data></case>`
branches — just shorter. The format rules:

- Records are separated by a **comma** `,`.
- Key and value are split by the **first colon** `:` — so colons _inside_ a value are
  kept (`US:Down : Left` → `Down : Left`).
- **Multiple keys → one value** with `|`: `CA|MX:USD` matches both `CA` and `MX`.
- Whitespace and line breaks around records are ignored, so you can wrap the table
  across lines for readability.
- The value is **always a literal**. A generator belongs in a [`<case>`](#case--a-branch-with-a-generator), not in a `<map>` row.

```xml
<switch name="Currency" on="Country">
  <map>
    US:USD, FR:EUR, DE:EUR, JP:JPY,
    CA|MX:USD
  </map>
</switch>
```

`./run currency.tdc`

```
FR -> EUR
DE -> EUR
JP -> JPY
MX -> USD
US -> USD
MX -> USD
JP -> JPY
CA -> USD
```

The multi-key row `CA|MX:USD` matches both `CA` and `MX` — both print `USD`.

> [!NOTE]
> **One limit: commas**
>
> A value that contains a comma won't fit in a `<map>` (the comma is the record
> separator). For those, use a [`<case is="…">`](#case--a-branch-with-a-generator)
> instead. A line with no colon isn't a record at all, and the validator warns
> (`TDC136`).

## `<case>` — a branch with a generator

A `<map>` row can only hold a literal. When a branch needs to **generate** its value —
a random amount, a counter, a prefix plus a generator — reach for `<case>`. Its content
is assembled left-to-right from [`<data>`](../reference/tags.md#top) literals and
[`<gen>`](../generators/overview.md#top) generators, exactly like a
[sequence](../core-concepts/sequences.md#top) branch.

Inside `<switch>`, a `<case>` needs [`is`](#matching-keys--is) — the key(s) it matches.
Here a customer tier drives a discount _range_, something a flat table can't express:

```xml
<sequence name="Tier">
  <gen type="text" value="gold,silver,bronze" percent="20,30,50"/>
</sequence>

<switch name="Discount" on="Tier">
  <case is="gold"><gen type="number" value="15..25"/></case>
  <case is="silver"><gen type="number" value="5..10"/></case>
  <default><data>0</data></default>
</switch>
```

`./run discount.tdc`

```
silver -> 7
gold   -> 22
bronze -> 0
gold   -> 18
silver -> 5
bronze -> 0
```

`gold` draws a fresh number in `15..25` on every matching row, `silver` in `5..10`, and
`bronze` falls through to the `<default>` literal `0`. **Why it matters:** the value is
computed per row, not looked up from a fixed string — that's the whole reason `<case>`
exists alongside `<map>`.

### Matching keys — `is`

`is` gives a `<case>` its key(s): the subject values that make the branch fire.

- **Required** on a `<case>` inside `<switch>` — without it the branch can never match
  (error `TDC137`).
- **Multiple keys** via `|`: `is="US|CA|MX"` matches if the subject equals **any** of
  them, folding a whole group of values into one branch.
- Comparison is **string** equality against the subject's value.

```xml
<switch name="Currency" on="Country">
  <case is="US|CA|MX"><data>USD</data></case>
  <case is="FR|DE"><data>EUR</data></case>
  <case is="JP"><data>JPY</data></case>
</switch>
```

`./run currency.tdc`

```
CA -> USD
MX -> USD
FR -> EUR
JP -> JPY
US -> USD
DE -> EUR
```

> [!NOTE]
> **Inside `<mix>` there is no `is`**
>
> The same [`<case>`](../reference/tags.md#top) tag is also used inside
> [`<mix>`](../reference/tags.md#top), but there the branches are chosen **randomly by
> percentage** and carry no `is`. `<case>` never supports `if` or `default` in either
> parent — for arbitrary conditions, use a [sequence](../core-concepts/sequences.md#top)
> with `<gen if="…">` branches.

## `<default>` — the fallback

`<default>` is the "else" branch: its value is used when the subject matches **no** key.
It's a tag, not an attribute, precisely so it can hold a generator — the same
`<data>` / `<gen>` content as a `<case>`.

Without a `<default>`, an unmatched key produces an **empty** value (the brackets below
are only there to make the hole visible):

```xml
<switch name="Currency" on="Country">
  <map>US:USD, FR:EUR</map>
</switch>
```

`./run currency.tdc`

```
FR -> [EUR]
FR -> [EUR]
JP -> []
GB -> []
US -> [USD]
GB -> []
DE -> []
JP -> []
```

Five rows out of eight are blank — a silent defect in a real export. Add a `<default>`
to cover everything the table missed:

```xml
<switch name="Currency" on="Country">
  <map>US:USD, FR:EUR</map>
  <default><gen type="text" value="XXX"/></default>
</switch>
```

`./run currency.tdc`

```
FR -> EUR
FR -> EUR
JP -> XXX
GB -> XXX
US -> USD
GB -> XXX
DE -> XXX
JP -> XXX
```

The same unmatched keys (`DE`, `JP`, `GB`) now yield `XXX` — no holes left. If the
fallback is just a literal, put it in `<data>`: `<default><data>Other</data></default>`.

- Put it **last**, where the eye looks for it — the same place it goes in a `switch`
  statement in code.
- It's **optional.** With no `<default>` and no matching key, the value is empty on
  that row.

## Selection rules

- The **first** matching branch wins. `<map>` rows are checked first (in written
  order), then `<case>` branches. If a key appears in both, the higher one — the map
  row — takes it.
- Keys are compared as **strings** against the subject value.
- A multi-key `A|B|C` matches when the subject equals any of `A`, `B`, or `C`.

A tiny precedence demo — the same key `CA` in both a map row and a case:

```xml
<switch name="Label" on="Country">
  <map>CA:from-map</map>
  <case is="CA"><data>from-case</data></case>
</switch>
```

`./run precedence.tdc`

```
CA -> from-map
CA -> from-map
CA -> from-map
```

The map row wins because map rows are checked before cases.

## Putting it together

All three branch kinds in one `<switch>` — a literal table, a generated branch, and a
fallback:

```xml
<switch name="Currency" on="Country">
  <!-- 1. Literals — compact, multi-key via | -->
  <map>
    US:USD, FR:EUR, DE:EUR, JP:JPY,
    CA|MX:USD
  </map>

  <!-- 2. A branch whose value is generated -->
  <case is="TR|BR"><data>REG-</data><gen type="number" value="100..999"/></case>

  <!-- 3. The fallback when nothing matched -->
  <default><gen type="text" value="XXX"/></default>
</switch>
```

`./run currency.tdc (subject in US,FR,CA,MX,TR,BR,GB)`

```
GB -> XXX
CA -> USD
GB -> XXX
TR -> REG-473
US -> USD
BR -> REG-208
MX -> USD
TR -> REG-819
FR -> EUR
MX -> USD
```

`CA` and `MX` resolve through the map's `CA|MX:USD` row, `TR`/`BR` build a generated
`REG-###` code, and `GB`, which matches no branch at all, falls through to
`<default>`.

## Deterministic across engines

A `<switch>` value is a **pure function** of its subject: same subject value on a row,
same result, every time. There's no per-row random draw to keep in sync, so a lookup
table behaves identically across all three engines (memory / stream / disk) — see
[Large outputs](../guides/large-outputs.md#top) for the streaming path, and
[Determinism](../core-concepts/determinism.md#top) for the guarantee.

## `<switch>` is generation, not formatting

Like [`<mix>`](../reference/tags.md#top), `<switch>` **produces a value** and lives **only
in `<env>`**. It's **not** allowed inside the output block (`<line>`) — that's error
`TDC132`. Declare it in `<env>`, give it a `name`, and interpolate `${{name}}` where you
want it.

The one-line contrast to keep in mind:

- [`<mix>`](../reference/tags.md#top) chooses **randomly, by percentage** — for realistic
  proportions.
- `<switch>` chooses **deterministically, by key** — for a value derived from another
  field.

## See also

- **[Coherent & relational data](../guides/coherent-data.md#top)** — the other way to keep two
  fields consistent: a child sequence drawn from a per-parent file.
- **[Sequences](../core-concepts/sequences.md#top)** — declaring the subject and other fields.
- **[Text](../generators/text.md#top)** and **[Number](../generators/number.md#top)** — the
  generators used inside `<case>` and `<default>`.
- **[Tag reference](../reference/tags.md#top)** — `<mix>`, `<case>`, and the full tag list.

---

← Previous: [Choosing between values (mix)](./mix.md#top) · **[Contents](../README.md#top)** · Next: [Conditional output (if)](./conditional-output.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/constructs/switch)**
