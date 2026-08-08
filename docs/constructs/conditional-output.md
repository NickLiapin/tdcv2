<a name="top"></a>

**English** · [Русский](../ru/constructs/conditional-output.md#top) · [Español](../es/constructs/conditional-output.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/constructs/conditional-output)**

← Previous: [Lookup tables (switch)](./switch.md#top) · **[Contents](../README.md#top)** · Next: [Multiple values in a cell (repeat)](./multiple-values.md#top) →

---

# Conditional output with `if`

**Use it when** a value should decide _whether_ a piece of a row appears, not just
_what_ it says: keep one record, drop another; tag some rows and leave the rest bare;
put a comma after every record except the last.

A generator always produces a value. The `if` attribute is a separate switch: it
looks at the row's current values and decides whether the tag it sits on reaches the
output. The expression is re-evaluated for **every** record against that record's data.

`if` accepts a small expression language — a subset of JavaScript syntax — with
comparison, logical, and arithmetic operators, string and number literals, and
sequence names. This page walks through the whole language.

Example outputs below are **illustrative**: they show the shape of the result and can
differ between core versions. The teaching examples use
[`order="sequential"`](../core-concepts/output-formatting.md#top) so the values come out in
a fixed order and the effect of each condition is easy to see.

## Before / after

Take an `Age` field and print six records with no condition at all:

```xml
<env count="6" seed="demo">
    <sequence name="Age"><gen type="text" value="15,17,18,25,40,70" order="sequential"/></sequence>
</env>
<block>
    <line><data>${{_count}}. age ${{Age}}</data></line>
</block>
```

`./run age.tdc (6 rows)`

```
1. age 15
2. age 17
3. age 18
4. age 25
5. age 40
6. age 70
```

Now hang `if="Age >= 18"` on the [`<line>`](../reference/tags.md#top) itself. When the
condition is false, TDC drops the whole line:

```xml
<block>
    <line if="Age >= 18"><data>${{_count}}. age ${{Age}} — adult</data></line>
</block>
```

`./run age.tdc (6 rows)`

```
3. age 18 — adult
4. age 25 — adult
5. age 40 — adult
6. age 70 — adult
```

The first two records (15 and 17) are gone — `Age >= 18` was false there. Notice that the
counter still reads `3, 4, 5, …`: [`_count`](../reference/builtins.md#top) is the record's
place in the whole set, decided before rendering, so suppressing a line doesn't
renumber the rest.

> [!WARNING]
> **Write `<`, `>`, and `&` literally**
>
> Inside `if` the operators are written **as-is**: `if="Age < 18"`,
> `if="A >= 1 && B <= 9"`. TDC does **not** expand XML entities — `if="Age &lt; 18"`
> breaks with error `TDC103`. Use the plain characters.

## Where `if` applies

The same expression language works on three tags, with slightly different effects:

| Tag                                                     | Effect of a false `if`                                                                   |
| :------------------------------------------------------ | :--------------------------------------------------------------------------------------- |
| [`<line>`](../reference/tags.md#top)                       | The entire line is suppressed — including the between-row separator.                     |
| [`<data>`](../reference/tags.md#top)                       | Just that text chunk is suppressed; the other `<data>` on the same line still print.     |
| [`<gen>`](../generators/overview.md#top) in a `<sequence>` | Makes a **conditional sequence** (below). Generators aren't allowed in the output block. |

### Suppressing part of a line with `<data>`

Several `<data if="…">` on one line, each with its own label, make the matched rows
obvious at a glance:

```xml
<block>
    <line><data>age ${{Age}}:</data><data if="Age >= 18"> adult</data></line>
</block>
```

`./run age.tdc (6 rows)`

```
age 15:
age 17:
age 18: adult
age 25: adult
age 40: adult
age 70: adult
```

**Why/when:** use `<data if>` to annotate a row without dropping it — the `age N:`
prefix always prints; the ` adult` tag only when the condition holds.

### Conditional sequences with `<gen if>`

When `<gen>` tags carry `if` **inside** a `<sequence>`, the sequence becomes
conditional: the **first** `<gen>` whose condition is true wins, and its value
becomes the sequence value for that row. A `<gen>` with no `if` is the fallback
("else"). If nothing matches, the sequence is empty on that row.

This keeps all the "which value depends on what" logic in `<env>`, so the output
block stays pure formatting:

```xml
<sequence name="Gender"><gen type="text" value="Male,Female" percent="42,58"/></sequence>

<sequence name="Name">
  <gen if="Gender.Male"   type="template" value="person.male.firstName"/>
  <gen if="Gender.Female" type="template" value="person.female.firstName"/>
</sequence>
```

`./run gendered-name.tdc (6 rows)`

```
Female: Emma
Male:   Daniel
Female: Sophia
Female: Olivia
Male:   James
Male:   Ethan
```

**Why/when:** every `${{Name}}` is already the right name for its gender — no
per-row branching in the block. This is the same idea explored in
[Coherent & relational data](../guides/coherent-data.md#top) and
[Hierarchical dependencies](../guides/hierarchical-dependencies.md#top).

## Referencing values

- **A sequence name** stands for its value on the current row: `Gender == Male`,
  `Age >= 18`.
- **A composite field** uses a dot: `Person.FirstName`, `Doctor.last`.
- **The `X.Value` shorthand** — if `X` is a sequence and `X.Value` is not itself a
  composite field, the expression reads as an equality test `X == "Value"`. So
  `if="Gender.Male"` means "`Gender` is currently `Male`", and `if="!Gender.Male"`
  means "not Male". It's exactly the same dotted notation used in
  [`parent="X.Value"`](../core-concepts/sequences.md#top).

```text
Gender == Male     is the same as   Gender.Male
Gender != Male     is the same as   !Gender.Male
```

## Literals and bare identifiers

| Kind       | Example             |
| :--------- | :------------------ |
| Number     | `5`, `3.14`, `-42`  |
| String     | `"admin"`, `'text'` |
| Identifier | `Name`, `_count`    |

A **bare identifier** (no quotes) is resolved in two steps:

1. TDC first looks for a sequence with that name and returns its value for this row.
2. If no such sequence exists, the identifier is treated as a **string literal**
   equal to its own name.

That's why you can write:

```xml
<data if="Role == admin">…</data>
```

There's no sequence called `admin`, so `admin` is just the word `"admin"` —
equivalent to `Role == "admin"`.

## Comparison operators

| Operator | Meaning                            |
| :------- | :--------------------------------- |
| `==`     | The same **number**                |
| `!=`     | Not the same number                |
| `===`    | The same **text**, character for character |
| `!==`    | Not the same text                  |
| `<`      | Less than                          |
| `>`      | Greater than                       |
| `<=`     | Less than or equal                 |
| `>=`     | Greater than or equal              |

Every column TDC produces is text, so "equal" has two readings and each gets its own
operator. [Comparison and truth](../reference/comparison.md#top) is the full account.

The ordering operators `<`, `>`, `<=`, `>=` always coerce both operands to numbers.

```xml
<block>
    <line><data>age ${{Age}}:</data><data if="Age < 18"> under18</data><data if="Age >= 18"> adult</data><data if="Age > 65"> senior</data></line>
</block>
```

`./run age-bands.tdc (6 rows)`

```
age 15: under18
age 17: under18
age 18: adult
age 25: adult
age 40: adult
age 70: adult senior
```

`Age < 18` is true on the first two rows, `Age >= 18` covers the rest (the boundary
value `18` lands in _adult_), and `Age > 65` tags only `70`.

**Why/when:** ordering comparisons are the everyday case — age gates, thresholds,
score cutoffs.

### Equality: `==` and `!=`

```xml
<sequence name="Role"><gen type="text" value="guest,user,admin,user,admin,guest" order="sequential"/></sequence>
...
<line><data>${{_count}}. ${{Role}}:</data><data if="Role == admin"> [admin]</data><data if="Role != admin"> [regular]</data></line>
```

`./run roles.tdc (6 rows)`

```
1. guest: [regular]
2. user: [regular]
3. admin: [admin]
4. user: [regular]
5. admin: [admin]
6. guest: [regular]
```

`==` and `!=` cut the rows into two complementary groups: wherever one is true, the
other is false.

### `==` is the number, `===` is the text

`==` asks whether the two sides are the same **number**, so it reads a column of digits as
one. `===` asks whether they print the same **characters**, and reads nothing as anything.
They part company exactly where the number and the characters differ:

```xml
<tdc>
  <env count="5" seed="strict" local="en">
    <sequence name="Order"><gen type="text" value="7,07,7.0,x,7" order="sequential"/></sequence>
  </env>
  <block>
    <line><data>"${{Order}}":</data><data if="Order == 7"> ==7</data><data if="Order === 7"> ===7</data><data if="Order !== 7"> !==7</data></line>
  </block>
</tdc>
```

`./run strict.tdc`

```
"7": ==7 ===7
"07": ==7 !==7
"7.0": ==7 !==7
"x": !==7
"7": ==7 ===7
```

`07` and `7.0` **are** seven, so `== 7` holds; neither **prints** as `7`, so `=== 7` does not.

**Why/when:** `==` is the everyday choice — amounts, ages, counts, category words. Reach for
`===` when the exact characters matter: an id of fixed width, a code that must keep its
leading zero, a flag column holding the word `true`.

### The rule `==` follows

1. Both sides whole numbers → compare as whole numbers, exactly.
2. One side a number you wrote, the other text that reads as a number → compare as numbers.
3. Otherwise → compare as text.

- `_count == 5` — `_count` is the text `5`, and step 1 makes both sides whole. ✓
- `Age == 18` — same. ✓
- `Total == 100` where `Total` holds `100.00` — step 2. ✓
- `Gender == Male` — no number anywhere, so step 3 compares text. ✓

[Comparison and truth](../reference/comparison.md#top) covers the corners: what counts as a
number, what counts as true, and which operator answers which question.

## Logical operators

| Operator | Meaning |
| :------- | :------ |
| `&&`     | AND     |
| `\|\|`   | OR      |
| `!`      | NOT     |

```xml
<line><data>${{_count}}. ${{Role}}/${{Age}}:</data><data if="Role == admin && Age >= 18"> adult-admin</data><data if="Age < 18 || Age > 65"> flagged</data></line>
```

`./run logical.tdc (6 rows)`

```
1. guest/15: flagged
2. user/17: flagged
3. admin/18: adult-admin
4. user/25:
5. admin/40: adult-admin
6. guest/70: flagged
```

`adult-admin` appears only where `Role` is `admin` **and** `Age >= 18` (rows 3 and 5).
`flagged` appears where `Age` is outside `18..65` (rows 1, 2, 6). Row 4 (`user/25`)
matches neither, so it gets no tag at all.

**Why/when:** combine conditions with `&&` / `||`, and negate with `!` — the same
`!` powers the `!Gender.Male` shorthand above.

## Arithmetic operators

| Operator | Meaning                                                                   |
| :------- | :------------------------------------------------------------------------ |
| `+`      | Addition (numeric if either operand is a number; otherwise concatenation) |
| `-`      | Subtraction (operands coerced to number)                                  |
| `*`      | Multiplication                                                            |
| `/`      | Division                                                                  |

Arithmetic works inside a comparison:

```xml
<line><data>${{_count}}/${{_total}} age ${{Age}}:</data><data if="_count * 2 > _total"> [second-half]</data><data if="Age + 5 >= 45"> [+5>=45]</data><data if="Age - 18 > 0"> [adult]</data><data if="Age / 10 >= 4"> [/10>=4]</data></line>
```

`./run arithmetic.tdc (6 rows)`

```
1/6 age 15:
2/6 age 17:
3/6 age 18:
4/6 age 25: [second-half] [adult]
5/6 age 40: [second-half] [+5>=45] [adult] [/10>=4]
6/6 age 70: [second-half] [+5>=45] [adult] [/10>=4]
```

`_count * 2 > _total` marks the second half of the set; `Age + 5`, `Age - 18` and
`Age / 10` are computed and compared as numbers.

**Why/when:** quick arithmetic (halves, offsets, ratios) without adding a whole extra
sequence just to hold the derived number.

> [!CAUTION]
> **Unsupported operators**
>
> `??` (nullish) is refused by validation, before a single row is drawn —
> `error[TDC101]: unsupported operator "??" in if expression`, and no output at all. The
> message lists every operator and function that IS available.
>
> `%` is not among the refused any more: it is the remainder, and it is Euclidean, so
> `-7 % 3` is `2`. `if="_count % 2 == 0"` selects every second row.
>
> `?.` (optional chaining) is worse because it fails **silently**: the parser reads
> `X?.length` as a plain dotted access `X.length`, which the `X.Value` shorthand turns
> into the test `X == "length"` — almost always false. Don't use `?.` in `if`.

## The `X.Value` shorthand in action

`Role.admin` is short for `Role == admin`, and it negates with `!Role.admin`:

```xml
<line><data>${{_count}}. ${{Role}}:</data><data if="Role.admin"> [Role.admin]</data><data if="!Role.admin"> [!Role.admin]</data></line>
```

`./run dotted.tdc (6 rows)`

```
1. guest: [!Role.admin]
2. user: [!Role.admin]
3. admin: [Role.admin]
4. user: [!Role.admin]
5. admin: [Role.admin]
6. guest: [!Role.admin]
```

The result matches the `==` / `!=` example exactly — two spellings of one test.

## Truthiness

In logical operators and in `if` as a whole, a bare value is read as a boolean by
these rules:

| Value               |  Read as  |
| :------------------ | :-------: |
| `null`, `undefined` |   false   |
| `0`, `NaN`          |   false   |
| `""` (empty string) |   false   |
| `"false"` (string)  | **false** |
| `"true"` (string)   |   true    |
| any other string    |   true    |
| a number ≠ 0        |   true    |

The `"false"` case is special: it exists so the
[built-in sequences](../reference/builtins.md#top) `_first` / `_last`, which are stored
as the literal strings `"true"` / `"false"`, behave intuitively in `if`.

## Built-ins in `if`

The four built-ins — `_count`, `_first`, `_last`, `_total` — are the most common
things to test. A classic pattern: a comma after every record except the last, plus a
header only on the first record.

```xml
<block>
    <line if="_first"><data>--- HEAD ---</data></line>
    <line><data>{"id": ${{_count}}}</data><data if="!_last">,</data></line>
</block>
```

`./run json-list.tdc (4 rows)`

```
--- HEAD ---
{"id": 1},
{"id": 2},
{"id": 3},
{"id": 4}
```

**Why/when:** `if="!_last"` is the standard trick for valid JSON/CSV joins;
`if="_first"` for a one-time header; `if="_count * 2 > _total"` to keep only the back
half of a set. See [Built-in sequences](../reference/builtins.md#top) for the full list.

## Operator precedence

Precedence follows JavaScript:

```text
!   →   * /   →   + -   →   < > <= >=   →   == != === !==   →   &&   →   ||
```

Parentheses `(…)` override the order explicitly — for example
`if="!(Gender == Male)"` negates the whole comparison rather than just `Gender`.

## Everything together

Combine `==`, `&&`, `>=`, and `!(…)` in one line:

```xml
<env count="6" seed="demo">
    <sequence name="Gender"><gen type="text" value="Male,Female" percent="50,50"/></sequence>
    <sequence name="Age"><gen type="number" value="10..40"/></sequence>
    <sequence name="Name">
        <gen if="Gender.Male"   type="template" value="person.male.firstName"/>
        <gen if="Gender.Female" type="template" value="person.female.firstName"/>
    </sequence>
</env>
<block>
    <line><data>${{Name}} (${{Gender}}, ${{Age}})</data><data if="Gender == Male && Age >= 18"> — adult male</data><data if="!(Gender == Male)"> — not male</data></line>
</block>
```

`./run combined.tdc (6 rows)`

```
Mary (Female, 36) — not male
Robert (Male, 10)
Patricia (Female, 32) — not male
Barbara (Female, 14) — not male
John (Male, 16)
David (Male, 20) — adult male
```

The `adult male` tag shows only when both conditions are true (`Gender == Male` and
`Age >= 18`); `not male` shows whenever `Gender` is not `Male`.

> [!NOTE]
> **Compiled once, cheap to reuse**
>
> Each expression is compiled once and cached. Over thousands of rows, re-evaluating the
> same `if="…"` costs almost nothing.

## See also

- [Built-in sequences](../reference/builtins.md#top) — `_count`, `_first`, `_last`,
  `_total`.
- [`if` in the attribute reference](../reference/attributes.md#top).
- [Coherent & relational data](../guides/coherent-data.md#top) and
  [Hierarchical dependencies](../guides/hierarchical-dependencies.md#top) — where conditional
  sequences shine.

---

← Previous: [Lookup tables (switch)](./switch.md#top) · **[Contents](../README.md#top)** · Next: [Multiple values in a cell (repeat)](./multiple-values.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/constructs/conditional-output)**
