<a name="top"></a>

**English** · [Русский](../ru/compute/conditionals.md#top) · [Español](../es/compute/conditionals.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/compute/conditionals)**

← Previous: [Strings & formatting](./strings.md#top) · **[Contents](../README.md#top)** · Next: [A pack read line by line](./walkthrough.md#top) →

---

# Conditionals

Checksum algorithms branch — "if the doubled digit is over 9, subtract 9" (Luhn), "if
the remainder is 10, use 0" (mod-11). Bucketing branches too — "under 30 is low, under
80 is mid, otherwise high". [`<compute>`](overview.md#top) expresses every one of these
with a single conditional tag, `<choose>`, and a handful of yes/no predicates.

`<choose>` is the same conditional idea as the top-level `<switch>` tag, but where
`<switch>` is a plain key-to-value lookup table, `<choose>` computes a value **inside**
`<compute>` and can test any condition — a comparison, a remainder, "is this a digit" —
not just whether a key matched.

## The shape

| Tag           | What it does                                                  |
| :------------ | :------------------------------------------------------------ |
| `<choose>`    | the first `<when>` whose `<test>` is true; else `<otherwise>` |
| `<when>`      | one branch: a `<test>` predicate and a `<then>` value         |
| `<test>`      | holds exactly one predicate, yields yes/no                    |
| `<then>`      | the value returned when this branch's `<test>` is true        |
| `<otherwise>` | the "else" branch — **required**                              |

Predicates live **only** inside `<test>` and return yes/no (never a value):

| Predicate        | True when                      |
| :--------------- | :----------------------------- |
| `<equals>`       | two integers are equal         |
| `<greater_than>` | A &gt; B (strict)              |
| `<less_than>`    | A &lt; B (strict)              |
| `<is_digit>`     | a character is a digit `0`–`9` |

There's no standalone boolean type in the language: a yes/no answer exists only for the
duration of a `<test>`. The value of a branch always comes from `<then>` or
`<otherwise>`.

## `<choose>` — pick the first matching branch

**Takes** one or more `<when>` branches plus one `<otherwise>` → **gives** the value of the first branch whose test holds. Branches are tried in document order, so order is a decision, not a formality.

![](../img/compute/choose.svg)

*Asked about 7, the first test holds; the branches below it are never reached.*

- **A** — the value the branches are asked about
- **B** — the tests, tried in the order they are written
- **C** — the value of the first branch that held — the faint ones are never reached

`<choose>` walks its `<when>` children **top to bottom** and returns the `<then>` of the
first one whose `<test>` is true. If none match, it returns `<otherwise>`. First match
wins, so the order of branches matters, and `<otherwise>` is mandatory — a `<choose>`
must always be able to produce a value.

`<choose>` takes no attributes; everything is expressed through its `<when>` branches
and the required `<otherwise>`.

### Example — the Luhn "subtract 9"

The classic Luhn step: double each digit, and if the result is over 9, subtract 9. Here
[`<each>`](lists.md#top) walks the digits, [`<current/>`](lists.md#top) is the digit being
processed, and `<choose>` decides whether the subtraction applies.

```xml
<sequence name="Num"><gen type="number" value="100000..999999"/></sequence>
<sequence name="Doubled">
  <compute>
    <result>
      <join sep=" ">
        <each>
          <over><field name="Num"/></over>
          <do>
            <let name="x"><multiply><current/><int v="2"/></multiply></let>
            <choose>
              <when>
                <test><greater_than><use name="x"/><int v="9"/></greater_than></test>
                <then><subtract><use name="x"/><int v="9"/></subtract></then>
              </when>
              <otherwise><use name="x"/></otherwise>
            </choose>
          </do>
        </each>
      </join>
    </result>
  </compute>
</sequence>
```

`./run luhn.tdc`

```
692481 -> 3 9 4 8 7 2
730544 -> 5 6 0 1 8 8
815209 -> 7 2 1 4 0 9
428170 -> 8 4 7 2 5 0
903622 -> 9 0 6 3 4 4
```

Example outputs on this page are illustrative — the exact values depend on the seed and
the core version. For `692481`: `6*2=12` is over 9, so `12-9=3`; `2*2=4` isn't, so it
stays `4`; and so on. The `<otherwise>` branch handles the ordinary case, where the
`<test>` didn't fire.

![](../img/compute/studio-choose-light.png)

*The same fork on the Studio canvas — the numbers on the edges are the order the branches are tried in, and the tail is branch three.*

### Example — ranges (branch order matters)

Several `<when>` branches in a row read like an "if … else if …" ladder. Because the
first match wins, you write the thresholds in ascending order so each branch only has to
rule out the ones above it. The sequence's value is a string, so it's wrapped once in
[`<to_number>`](arithmetic.md#top) with [`<let>`](overview.md#top) and compared as an integer.

```xml
<sequence name="Score"><gen type="number" value="0..100"/></sequence>
<sequence name="Grade">
  <compute>
    <let name="s"><to_number><field name="Score"/></to_number></let>
    <result>
      <choose>
        <when>
          <test><less_than><use name="s"/><int v="30"/></less_than></test>
          <then><str v="low"/></then>
        </when>
        <when>
          <test><less_than><use name="s"/><int v="80"/></less_than></test>
          <then><str v="mid"/></then>
        </when>
        <otherwise><str v="high"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run grade.tdc`

```
96  -> high
25  -> low
58  -> mid
34  -> mid
7   -> low

```

`25` is under 30, so it takes `low`. `34` isn't under 30 but is under 80, so the second
branch wins with `mid`. `96` clears every threshold, so `<otherwise>` fires with `high`.

### `<otherwise>` is required — error `TDC184`

One `<otherwise>` closes the whole `<choose>`, not each `<when>`. It is the single tail
that runs when no branch matched, and leaving it out is an error rather than an empty
result — a config that silently produced nothing for the rows nobody thought about is
exactly the failure this refuses to allow.

Drop the `<otherwise>` and the config won't load. The engine can't prove that some branch
will always match, and a `<choose>` has to yield a value no matter what, so it rejects
the tree **before** the run:

```xml
<choose>
  <when>
    <test><greater_than><to_number><field name="D"/></to_number><int v="5"/></greater_than></test>
    <then><str v="big"/></then>
  </when>
</choose>
```

`./run no-otherwise.tdc`

```
error[TDC184]: <choose> requires an <otherwise> branch
```

Add an `<otherwise>` with a fallback value and it loads. This is one of the compile-time
tree checks (`TDC180`–`TDC187`) that catch structural mistakes before any data is
generated.

## `<when>` — one branch

**Takes** the slots `<test>` (the condition) and `<then>` (the value) → **gives** nothing on its own. A `<when>` exists only inside a `<choose>`, and it needs both slots.

A `<when>` is a single branch of a `<choose>`: a condition paired with a value. It has
exactly two children — `<test>` (the condition) and `<then>` (the value to return when
the condition holds). Both are required; omitting either is error `TDC187`. A `<choose>`
can hold as many `<when>` branches as you like, and they are checked in order.

You never write a `<when>` on its own — it always sits inside a `<choose>`, alongside
its siblings and the required `<otherwise>`.

### Example — a digit-sum threshold

One branch: "if the digit sum is over 18, high, otherwise low". A
[`<reduce>`](lists.md#top) adds the digits, and the single `<when>` inside `<choose>` picks
the answer.

```xml
<sequence name="Pin"><gen type="number" value="1000..9999"/></sequence>
<sequence name="Sum">
  <compute>
    <result>
      <reduce>
        <over><field name="Pin"/></over>
        <init><int v="0"/></init>
        <do><add><acc/><current/></add></do>
      </reduce>
    </result>
  </compute>
</sequence>
<sequence name="Bucket">
  <compute>
    <result>
      <choose>
        <when>
          <test><greater_than><to_number><field name="Sum"/></to_number><int v="18"/></greater_than></test>
          <then><str v="high"/></then>
        </when>
        <otherwise><str v="low"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run bucket.tdc`

```
3115  sum=10  -> low
9917  sum=26  -> high
5120  sum=8   -> low
5815  sum=19  -> high
9444  sum=21  -> high
```

The `<test>` checks `sum > 18` and `<then>` returns `high`. When the sum is 18 or less
(`10`, `8`), the `<when>` doesn't fire and `<otherwise>` answers `low`.

## `<test>` — the condition slot

**Takes** one predicate → **gives** true or false to the `<when>` around it. There are no booleans as values in the language: a predicate can appear here and nowhere else.

A `<test>` is the "condition slot" of a `<when>`. It holds **exactly one predicate** and
turns it into the yes/no that `<choose>` uses to decide whether to take the branch. It
doesn't compute a number or a string — it marks the part of a `<when>` where the
condition lives (the other part being `<then>`, the value). A `<test>` comes first,
before `<then>`, and is required inside a `<when>` (otherwise `TDC187`).

Predicates work **only** inside a `<test>` — anywhere else they're invalid, because they
produce a yes/no rather than a value.

### Example — parity via remainder

Here `<test>` holds an `<equals>` predicate: "the
remainder after dividing by 2 is 0". If so, the number is even.

```xml
<sequence name="N"><gen type="number" value="1000..9999"/></sequence>
<sequence name="Parity">
  <compute>
    <result>
      <choose>
        <when>
          <test>
            <equals>
              <mod><to_number><field name="N"/></to_number><int v="2"/></mod>
              <int v="0"/>
            </equals>
          </test>
          <then><str v="even"/></then>
        </when>
        <otherwise><str v="odd"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run parity.tdc`

```
8452  -> even
9083  -> odd
4216  -> even
5734  -> even
3005  -> odd
```

Inside the `<test>` sits one predicate, `<equals>`. It compares the
[`<mod>`](arithmetic.md#top) remainder against zero and yields yes/no; `3005` is odd
(remainder 1), so `<otherwise>` fires.

The wrapper slots (`<test>`, `<then>`, and the iteration wrappers `<over>` / `<do>` /
`<init>` / `<in>` / `<index>`) exist so that a tag with several parts can name each part
explicitly instead of inferring it from child order.

## The predicates

Every predicate returns yes/no and is valid only inside a `<test>` (or a `<valid>`,
below). All four take integer operands, and a single character is accepted wherever its
digit value is what's meant.

### `<equals>` — two integers are equal

**Takes** two values → **gives** true or false. Comparison is loose across types: `5` and `"5"` are equal.

True when its two children evaluate to the same integer. This is the building block for
"is the remainder zero", "did the check digit match", and "is this exactly N".

```xml
<sequence name="V"><gen type="number" value="1..1000"/></sequence>
<sequence name="Kind">
  <compute>
    <result>
      <choose>
        <when>
          <test><equals><mod><to_number><field name="V"/></to_number><int v="10"/></mod><int v="0"/></equals></test>
          <then><str v="round"/></then>
        </when>
        <otherwise><str v="other"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run equals.tdc`

```
40   -> round
417  -> other
250  -> round
83   -> other
900  -> round
```

**Use it when** a value must match a target exactly — a matched checksum, an exact bucket
key, a multiple of some base.

### `<greater_than>` — strict `A > B`

**Takes** two numbers → **gives** true or false. Strict: equal values are false.

True when the first child is strictly greater than the second (`A > B`, not `>=`). This
is the Luhn "over 9" test, and any "above a threshold" branch.

```xml
<sequence name="M"><gen type="number" value="1..1000"/></sequence>
<sequence name="Level">
  <compute>
    <result>
      <choose>
        <when>
          <test><greater_than><to_number><field name="M"/></to_number><int v="500"/></greater_than></test>
          <then><str v="high"/></then>
        </when>
        <otherwise><str v="low"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run greater.tdc`

```
742  -> high
318  -> low
906  -> high
88   -> low
651  -> high
```

**Use it when** a branch fires above a cutoff. Because it's strict, the cutoff value
itself falls through to the next branch — choose `>` or `<` deliberately at the
boundaries.

### `<less_than>` — strict `A < B`

**Takes** two numbers → **gives** true or false. Strict: equal values are false.

True when the first child is strictly less than the second (`A < B`). It's the natural
way to write ascending threshold ladders, and it's the guard used by the mod-11
`<valid>` check below.

```xml
<sequence name="K"><gen type="number" value="0..99"/></sequence>
<sequence name="Width">
  <compute>
    <result>
      <choose>
        <when>
          <test><less_than><to_number><field name="K"/></to_number><int v="10"/></less_than></test>
          <then><str v="single"/></then>
        </when>
        <otherwise><str v="double"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run less.tdc`

```
7   -> single
42  -> double
3   -> single
88  -> double
15  -> double
```

**Use it when** a branch fires below a cutoff, or you're building a `low → high` ladder
of ranges (see the grade example above).

### `<is_digit>` — a character is `0`–`9`

**Takes** one **single-character** string → **gives** true or false. A longer string is false, so `"12"` does not pass.

True when its single-character argument is a decimal digit. Useful when classifying the
characters of a mixed alphanumeric code. Here [`<slice>`](strings.md#top) takes the first
character and `<is_digit>` tests it.

```xml
<sequence name="Code"><gen type="regex" value="[A-Z0-9]{5}"/></sequence>
<sequence name="First">
  <compute>
    <result>
      <choose>
        <when>
          <test><is_digit><slice from="0" to="1"><field name="Code"/></slice></is_digit></test>
          <then><str v="numeric-first"/></then>
        </when>
        <otherwise><str v="alpha-first"/></otherwise>
      </choose>
    </result>
  </compute>
</sequence>
```

`./run isdigit.tdc`

```
7F2QK  -> numeric-first
KP83M  -> alpha-first
90ZTR  -> numeric-first
BQ4L1  -> alpha-first
5MHW2  -> numeric-first
```

**Use it when** a rule depends on whether a character is a digit — validating a leading
symbol, splitting letters from numbers, gating a per-character branch.

## `<valid>` — reject-and-retry

`<valid>` is a **reject-and-retry** check used in generator [packs](../data-packs/writing-your-own.md#top).
It holds **one predicate**; after a pack has produced its base values, the engine checks
the predicate and, if it's **false**, regenerates the base and tries again — repeating
until the result passes (with a safety cap so an impossible condition fails cleanly
instead of looping forever). The predicates are the same four as in `<choose>`.

Unlike `<choose>`, `<valid>` is written **next to** the pack's generators and its
`<data>` output, not inside a `<compute>`. It's part of pack mechanics, so it doesn't
show up in an ordinary config — there, you derive the value with a formula and never
redraw.

`<valid>` takes no attributes; the condition is its single predicate child.

### Example — keep only even numbers

A small self-contained pack: generate a number in `10..99`, compute its remainder mod 2,
and use `<valid>` to **reject the odd ones**. Only evens reach the output.

```xml
---
address: common.demo.even_only
description: demo — only even numbers (reject odd via <valid>)
generator: tdc
---
<sequence name="base"><gen type="number" value="10..99"/></sequence>
<sequence name="rest"><compute><result>
  <mod><to_number><field name="base"/></to_number><int v="2"/></mod>
</result></compute></sequence>
<valid><equals><field name="rest"/><int v="0"/></equals></valid>
<data>${{base}}</data>
```

Called as `<gen type="template" value="common.demo.even_only"/>`:

`./run even.tdc`

```
84
90
42
26
30
46
90
46
```

The `10..99` range yields both even and odd numbers, but `<valid>` passes only the rows
where `rest == 0`. No odd number appears — the engine redrew the base until an even one
came up.

### Example — an ISBN-10 whose check digit stays numeric

An ISBN-10 check value of 10 is normally written as the letter `X`. If a field must stay
purely numeric, those rows have to be thrown out. This pack computes the weighted mod-11
check and requires it to be **under 10**; anything else is regenerated. This is the same
guarantee the built-in ISBN packs give.

```xml
<sequence name="base"><gen type="regex" value="[0-9]{9}"/></sequence>
<sequence name="check"><compute><result>
  <mod>
    <subtract>
      <int v="11"/>
      <mod>
        <reduce>
          <over><field name="base"/></over>
          <init><int v="0"/></init>
          <do><add><acc/><multiply><current/>
            <at><in><list v="10,9,8,7,6,5,4,3,2"/></in><index><current_index/></index></at>
          </multiply></add></do>
        </reduce>
        <int v="11"/>
      </mod>
    </subtract>
    <int v="11"/>
  </mod>
</result></compute></sequence>
<valid><less_than><to_number><field name="check"/></to_number><int v="10"/></less_than></valid>
<data>${{base}}${{check}}</data>
```

`./run isbn.tdc`

```
4188261811
8761685496
2444206142
8745782784
0357781341
```

Every emitted value is ten clean digits: across thousands of rows not one has a check
value of 10, because `<valid>` rejects those bases and draws again.

**Use it when** a correct value can still be _invalid_ for the domain — a forbidden check
digit, an unissued range — and you want the pack to guarantee only good rows without
complicating the formula.

## Errors and limits

- **`TDC184`** — a `<choose>` with no `<otherwise>`. Every `<choose>` must be able to
  return a value, so the missing "else" is caught before the run.
- **`TDC187`** — a `<when>` missing its `<test>` or `<then>` (or a wrapper slot left
  empty). Each branch needs both a condition and a value.
- Predicates are valid **only** inside a `<test>` or a `<valid>`; there is no boolean
  value elsewhere in the language.
- Comparisons are on **integers** — a numeric string is converted with
  [`<to_number>`](arithmetic.md#top) first (as in the grade and parity examples). There are
  no floats.
- `<greater_than>` and `<less_than>` are **strict**: the boundary value itself falls
  through to the next branch. Choose the operator with the boundary in mind.

## See also

- **[Compute overview](overview.md#top)** — where conditionals fit in a full checksum.
- **[Arithmetic](arithmetic.md#top)** — the `<mod>`, `<subtract>`, and `<to_number>` used
  in the tests above.
- **[Lists & iteration](lists.md#top)** — `<each>` and `<reduce>`, the loops a per-digit
  `<choose>` runs inside.
- **[Compute functions reference](../reference/compute.md#top)** — the full tag catalog.

---

← Previous: [Strings & formatting](./strings.md#top) · **[Contents](../README.md#top)** · Next: [A pack read line by line](./walkthrough.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/compute/conditionals)**
