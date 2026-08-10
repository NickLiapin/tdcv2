<a name="top"></a>

**English** · [Русский](../ru/compute/arithmetic.md#top) · [Español](../es/compute/arithmetic.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/compute/arithmetic)**

← Previous: [Overview](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Lists & iteration](./lists.md#top) →

---

# Arithmetic

Integer math inside [`<compute>`](overview.md#top). Every operation is its own tag; nest
them to build an expression tree. These are the arithmetic operators of the TDC
language — they live in a [`<sequence>`](../core-concepts/sequences.md#top) right next to
[`<gen>`](../generators/overview.md#top), both in your own config and inside the built-in
identifier packs.

| Tag                       | What it does                                    | Example → result           |
| :------------------------ | :---------------------------------------------- | :------------------------- |
| [`<add>`](#add)           | sum of all children (empty → `0`)               | `add(2, 3, 4)` → `9`       |
| [`<subtract>`](#subtract) | first minus the sum of the rest                 | `subtract(10, 3, 2)` → `5` |
| [`<multiply>`](#multiply) | product of all children (empty → `1`)           | `multiply(2, 3, 4)` → `24` |
| [`<divide>`](#divide)     | integer division toward −∞ (exactly 2 children) | `divide(7, 2)` → `3`       |
| [`<mod>`](#mod)           | remainder, always ≥ 0 (exactly 2 children)      | `mod(17, 5)` → `2`         |

Two rules hold for **all** of them:

- **Integers only.** A single-digit string (`"7"`) is coerced automatically, but a
  **multi-digit** string like a sequence value (`"342"`) is **not** — wrap it in
  [`<to_number>`](#to_number) first. This is deliberate: it keeps "add two values as
  numbers" from being confused with "glue two strings together"
  ([`<concat>`](strings.md#top)).
- **Overflow is an error.** A 64-bit overflow is reported, not silently wrapped, so you
  find out about it before bad data ships.

Example outputs on this page are illustrative: the exact values depend on the seed and
the core version, but the arithmetic shown is always correct.

## `<add>`

**Takes** any number of children → **gives** a number. No children gives `0`. A single-digit string coerces on its own; a multi-digit one needs [`<to_number>`](#to_number) first.

`<add>` sums all of its children in order and returns an integer. With **no** children
it returns `0` (the additive identity). **Use it when** you need a derived total — an
order sum, a total score — or a running accumulator inside a fold.

### Sum of two fields

Sequence values are strings, so each field is wrapped in [`<to_number>`](#to_number):

```xml
<sequence name="Base"><gen type="number" value="100..900"/></sequence>
<sequence name="Tax"><gen type="number" value="10..90"/></sequence>
<sequence name="Total">
  <compute>
    <result>
      <add>
        <to_number><field name="Base"/></to_number>
        <to_number><field name="Tax"/></to_number>
      </add>
    </result>
  </compute>
</sequence>
```

`./run add.tdc — ${{Base}} + ${{Tax}} = ${{Total}}`

```
742 + 55 = 797
318 + 61 = 379
560 + 24 = 584
193 + 88 = 281
607 + 39 = 646
```

### Digit sum inside a fold

Inside [`<reduce>`](lists.md#top), `<add>` accumulates a result:
[`<current/>`](lists.md#top) is the next digit (a one-character string, so it coerces on
its own) and [`<acc/>`](lists.md#top) is the running total. No `<to_number>` is needed
here, because each element is a single digit.

```xml
<sequence name="Pin"><gen type="number" value="1000..9999"/></sequence>
<sequence name="DigitSum">
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
```

`./run digitsum.tdc — ${{Pin}} -> sum ${{DigitSum}}`

```
4821 -> sum 15
3067 -> sum 16
9145 -> sum 19
5530 -> sum 13
7284 -> sum 21
```

`4+8+2+1 = 15`, `3+0+6+7 = 16`, and so on. This weighted-then-summed shape is the core
of every check-digit scheme (see [`<mod>`](#mod)).

## `<subtract>`

**Takes** any number of children → **gives** a number: the first minus the sum of the rest.

`<subtract>` takes the **first** child and subtracts the **sum of all the rest**,
returning an integer. It needs **at least one** child (otherwise error `TDC183`); with
a single child it returns that value unchanged (`subtract(9)` → `9`). **Use it when**
you need a difference — a balance, change due, seats remaining, or age as "current year
minus birth year".

### Account balance

```xml
<sequence name="Deposit"><gen type="number" value="500..900"/></sequence>
<sequence name="Withdrawal"><gen type="number" value="100..400"/></sequence>
<sequence name="Balance">
  <compute><result>
    <subtract>
      <to_number><field name="Deposit"/></to_number>
      <to_number><field name="Withdrawal"/></to_number>
    </subtract>
  </result></compute>
</sequence>
```

`./run balance.tdc — ${{Deposit}} - ${{Withdrawal}} = ${{Balance}}`

```
830 - 245 = 585
655 - 190 = 465
719 - 302 = 417
588 - 137 = 451
742 - 168 = 574
```

### First minus the sum of the rest

With **three** children `<subtract>` takes the first minus the _sum_ of the other two —
used when several items draw down one budget:

```xml
<sequence name="A"><gen type="number" value="10..40"/></sequence>
<sequence name="B"><gen type="number" value="10..40"/></sequence>
<sequence name="Left">
  <compute><result>
    <subtract>
      <int v="100"/>
      <to_number><field name="A"/></to_number>
      <to_number><field name="B"/></to_number>
    </subtract>
  </result></compute>
</sequence>
```

`./run left.tdc — 100 - ${{A}} - ${{B}} = ${{Left}}`

```
100 - 22 - 31 = 47
100 - 15 - 28 = 57
100 - 34 - 19 = 47
100 - 27 - 27 = 46
100 - 11 - 40 = 49
```

`100 − (22 + 31) = 47` — what gets subtracted is the **sum** of everything after the
first child. The `11 − remainder` step in many check-digit schemes is written as
`<subtract>` paired with [`<mod>`](#mod).

## `<multiply>`

**Takes** any number of children → **gives** a number. No children gives `1`.

`<multiply>` multiplies all of its children in order and returns an integer. With
**no** children it returns `1` (the multiplicative identity). **Use it when** you need
a derived product — area, volume, "price × quantity" — or, most often, to weight a
digit by its position when computing a check digit.

### Area

```xml
<sequence name="W"><gen type="number" value="2..9"/></sequence>
<sequence name="H"><gen type="number" value="2..9"/></sequence>
<sequence name="Area">
  <compute><result>
    <multiply>
      <to_number><field name="W"/></to_number>
      <to_number><field name="H"/></to_number>
    </multiply>
  </result></compute>
</sequence>
```

`./run area.tdc — ${{W}} x ${{H}} = ${{Area}}`

```
6 x 7 = 42
3 x 9 = 27
8 x 4 = 32
5 x 5 = 25
2 x 8 = 16
```

### Weighted digit sum inside a fold

The classic use for `<multiply>` is weighting each digit by its position when computing
a check digit (Luhn, ISBN, IBAN). Inside [`<reduce>`](lists.md#top), each digit —
[`<current/>`](lists.md#top), a one-character string that coerces on its own — is
multiplied by a weight pulled from a list by position with [`<at>`](lists.md#top) and
[`<current_index/>`](lists.md#top):

```xml
<sequence name="Base"><gen type="number" value="100000000..999999999"/></sequence>
<sequence name="Weighted">
  <compute><result>
    <reduce>
      <over><field name="Base"/></over>
      <init><int v="0"/></init>
      <do>
        <add>
          <acc/>
          <multiply>
            <current/>
            <at><in><list v="1,3,1,3,1,3,1,3,1"/></in>
                <index><current_index/></index></at>
          </multiply>
        </add>
      </do>
    </reduce>
  </result></compute>
</sequence>
```

`./run weighted.tdc — ${{Base}} -> weighted ${{Weighted}}`

```
384019267 -> weighted 86
512700483 -> weighted 62
907316258 -> weighted 69
146829035 -> weighted 86
673540192 -> weighted 79
```

Each digit is multiplied by its weight (`1,3,1,3,…`) and [`<add>`](#add) accumulates
the sum of the products. That weighted sum is then usually taken [`<mod>`](#mod) some
base, and that's exactly how a check digit is produced.

## `<divide>`

**Takes** exactly two children → **gives** a **whole** number. The remainder is dropped, so 7 divided by 2 is 3 and 1 divided by 3 is 0. A zero divisor is refused.

`<divide>` divides the **first** child by the **second** and returns an integer — the
fractional part is dropped. It takes **exactly two** children (otherwise error
`TDC183`), and dividing by `0` is an error. **Use it when** you split a quantity into
equal parts (price per unit, average per head, cents → dollars with `÷ 100`), or to
peel digits off a number alongside [`<mod>`](#mod).

### How much each

```xml
<sequence name="Total"><gen type="number" value="100..900"/></sequence>
<sequence name="Count"><gen type="number" value="3..7"/></sequence>
<sequence name="Per">
  <compute><result>
    <divide>
      <to_number><field name="Total"/></to_number>
      <to_number><field name="Count"/></to_number>
    </divide>
  </result></compute>
</sequence>
```

`./run per.tdc — ${{Total}} / ${{Count}} = ${{Per}}`

```
645 / 5 = 129
480 / 3 = 160
733 / 6 = 122
218 / 4 = 54
591 / 7 = 84
```

`218 ÷ 4 = 54` — the remainder (`2`) is dropped. If it's the remainder you want, use
[`<mod>`](#mod).

### Rounding is toward −∞

One detail worth knowing: division rounds **down** (floor), not toward zero. With
positive operands that's the familiar result (`7 ÷ 2 = 3`); with negative ones it goes
lower:

```xml
<sequence name="D1"><compute><result><divide><int v="-7"/><int v="2"/></divide></result></compute></sequence>
<sequence name="D2"><compute><result><divide><int v="7"/><int v="2"/></divide></result></compute></sequence>
<sequence name="D3"><compute><result><divide><int v="-8"/><int v="4"/></divide></result></compute></sequence>
<sequence name="D4"><compute><result><divide><int v="-1"/><int v="2"/></divide></result></compute></sequence>
```

`./run floor.tdc — -7/2=${{D1}}  7/2=${{D2}}  -8/4=${{D3}}  -1/2=${{D4}}`

```
-7/2=-4   7/2=3   -8/4=-2   -1/2=-1
```

`−7 ÷ 2` gives `−4` (rounded down), and `−1 ÷ 2` gives `−1`. An exact division like
`−8 ÷ 4` stays `−2`. `<divide>` and [`<mod>`](#mod) are a matched pair, which is what
checksum algorithms expect.

## `<mod>`

**Takes** exactly two children → **gives** a number in `0 … |divisor|-1`. Never negative, unlike `%` in C, Java or JavaScript — `<mod>7, -5</mod>` is `2`.

`<mod>` returns the **remainder** of the first child divided by the second — an
integer, **always non-negative**. It takes **exactly two** children (otherwise error
`TDC183`), and dividing by `0` is an error. The remainder is **Euclidean**: always in
`[0, |divisor|)`, so it is **never negative** even when the dividend is
(`−3 mod 5 = 2`, not `−3`). This differs from `%` in some languages, where the
remainder carries the sign of the dividend.

**Use it when** you compute a check digit (the heart of every validation scheme), split
a number into digits, or wrap an index into a list's bounds.

### Last digit and parity

`n mod 10` extracts the last digit; `n mod 2` tells you even or odd (`0` is even, `1` is
odd):

```xml
<sequence name="N"><gen type="number" value="1000..9999"/></sequence>
<sequence name="Last">
  <compute><result><mod><to_number><field name="N"/></to_number><int v="10"/></mod></result></compute>
</sequence>
<sequence name="Parity">
  <compute><result><mod><to_number><field name="N"/></to_number><int v="2"/></mod></result></compute>
</sequence>
```

`./run mod.tdc — ${{N}}: last=${{Last}}, parity=${{Parity}}`

```
4827: last=7, parity=1
9060: last=0, parity=0
3514: last=4, parity=0
6288: last=8, parity=0
7135: last=5, parity=1
```

### The remainder is always ≥ 0

With negative dividends you can see that `<mod>` is Euclidean — the result never goes
negative:

```xml
<sequence name="M1"><compute><result><mod><int v="-3"/><int v="5"/></mod></result></compute></sequence>
<sequence name="M2"><compute><result><mod><int v="3"/><int v="5"/></mod></result></compute></sequence>
<sequence name="M3"><compute><result><mod><int v="-13"/><int v="10"/></mod></result></compute></sequence>
```

`./run modneg.tdc — -3 mod 5=${{M1}}  3 mod 5=${{M2}}  -13 mod 10=${{M3}}`

```
-3 mod 5=2   3 mod 5=3   -13 mod 10=7
```

`−3 mod 5` gives `2` (because `−3 = −1·5 + 2`) and `−13 mod 10` gives `7`. The result
always lands in `[0, divisor)`. This is why a weighted digit sum taken `mod 11`,
`mod 97`, or through Luhn produces a stable, positive check digit — the full worked
example is in the [compute overview](overview.md#top).

## `<to_number>`

**Takes** one string → **gives** a number. This is the border between the two worlds, and most first-time errors are a missing crossing.

![](../img/compute/border.svg)

*One border, two crossings: one you write, one that happens on its own.*

- **A** — the string side: a value from a <field>, digits and all
- **B** — the crossing you have to write — <to_number>
- **C** — the crossing that happens on its own: a number placed in <concat> becomes its digits
- **D** — the number side, where arithmetic lives

`<to_number>` turns a **digit string** into an **integer**. It's the workhorse of
arithmetic: without it you can't add, subtract, multiply, or divide multi-digit
sequence values. A leading `-` is allowed (`"-42"` → `-42`); a non-digit string is an
error.

It exists because of type coercion. Sequence values
([`<field name="…"/>`](overview.md#top)) and `${{…}}` values are **strings**. Arithmetic
accepts only integers: it coerces a **single-digit** string (`"7"`) on its own, but
**not** a multi-digit one — that's an error. `<to_number>` is the one and only way to
say "parse this digit string into a number," and keeping it explicit stops "add as
numbers" from being confused with "glue as strings" ([`<concat>`](strings.md#top)).

### Without it — an error

Adding two multi-digit fields directly fails before any data is generated:

```xml
<sequence name="A"><gen type="number" value="10..90"/></sequence>
<sequence name="B"><gen type="number" value="10..90"/></sequence>
<sequence name="Sum">
  <compute><result><add><field name="A"/><field name="B"/></add></result></compute>
</sequence>
```

`./run bad.tdc — error before generation`

```
tdcv2: expected an integer in <add>, got the string "10" — wrap it in <to_number> to convert a multi-digit string
```

`"10"` is a two-digit string, so it isn't coerced on its own. The error message points
straight at the fix.

### With it — it works

Wrap each field and the addition goes through:

```xml
<sequence name="A"><gen type="number" value="10..90"/></sequence>
<sequence name="B"><gen type="number" value="10..90"/></sequence>
<sequence name="Sum">
  <compute><result>
    <add>
      <to_number><field name="A"/></to_number>
      <to_number><field name="B"/></to_number>
    </add>
  </result></compute>
</sequence>
```

`./run sum.tdc — ${{A}} + ${{B}} = ${{Sum}}`

```
10 + 76 = 86
67 + 30 = 97
61 + 75 = 136
54 + 27 = 81
51 + 53 = 104
```

### When you don't need it

A single-digit string is coerced on its own. So inside a digit walk
([`<reduce>`](lists.md#top), [`<each>`](lists.md#top)), the element
[`<current/>`](lists.md#top) is a **one-character** string and can be added or multiplied
without a wrapper — which is why the "digit sum" and "weighted sum" examples above skip
`<to_number>`. You need the wrapper only when the number is **multi-digit**: a whole
field value, a `${{…}}`, or a chunk from [`<slice>`](strings.md#top).

## `<encode as="…">`

**Takes** one **single-character** string plus `as=` → **gives** a string.

`<encode as="…">` turns a **single character** into its numeric code, returning the
result as a **string**. The `as` attribute picks the table. **Use it when** a scheme
weights letters as numbers — IBAN's mod-97, for instance, replaces each letter with its
base-36 value before the modulus.

To get a single character to feed it, pull one out of a string:
[`<current/>`](lists.md#top) inside a walk, [`<slice>`](strings.md#top), or a literal
`<str v="A"/>`.

| `as`      | What it produces                                             |
| :-------- | :----------------------------------------------------------- |
| `base36`  | `0`–`9` → `0…9`, letters `A`–`Z`/`a`–`z` → `10…35` (decimal) |
| `ascii`   | decimal code point, `0`–`127` only (otherwise an error)      |
| `unicode` | decimal code point, no `127` limit                           |
| `hex`     | the code point in base 16                                    |
| `octal`   | the code point in base 8                                     |
| `binary`  | the code point in base 2                                     |

An unknown `as` value is caught before the run (error `TDC186`).

### `base36` — a letter to a number

Walk a string character by character with [`<each>`](lists.md#top), encode each in
`base36`, and glue the results with [`<join>`](lists.md#top):

```xml
<sequence name="Codes">
  <compute><result>
    <join sep=" ">
      <each>
        <over><str v="A9z"/></over>
        <do><encode as="base36"><current/></encode></do>
      </each>
    </join>
  </result></compute>
</sequence>
```

`./run base36.tdc — A9z -> ${{Codes}}`

```
A9z -> 10 9 35
```

`A` → `10`, the digit `9` → `9`, `z` → `35` (case doesn't matter). These are
**decimal** weights, not "base-36 digits". This is exactly the table IBAN uses before
taking `mod 97`.

### One character in every base

The same character `A` (code point 65) through each table:

```xml
<sequence name="Asc"><compute><result><encode as="ascii"><str v="A"/></encode></result></compute></sequence>
<sequence name="Uni"><compute><result><encode as="unicode"><str v="A"/></encode></result></compute></sequence>
<sequence name="Hex"><compute><result><encode as="hex"><str v="A"/></encode></result></compute></sequence>
<sequence name="Oct"><compute><result><encode as="octal"><str v="A"/></encode></result></compute></sequence>
<sequence name="Bin"><compute><result><encode as="binary"><str v="A"/></encode></result></compute></sequence>
```

`./run bases.tdc — A: ascii/unicode/hex/octal/binary`

```
ascii    65
unicode  65
hex      41
octal    101
binary   1000001
```

`ascii`/`unicode` give decimal `65`; `hex`/`octal`/`binary` give the same code point in
base 16/8/2. The result is a string — to keep computing on it, wrap it in
[`<to_number>`](#to_number) (though a single `base36` character feeds arithmetic
directly, since a one-character string is coerced on its own).

## Limitations

- **No expression strings** — every operation is its own tag.
- **Integers only** — no floats, no booleans; a 64-bit overflow is an error, not a
  silent wrap.
- **Tag names use `_`**: `to_number`, `current_index`, and so on.
- **Tree errors are caught before the run** (codes `TDC180`–`TDC187`): an unknown tag,
  a wrong child count, an unbound [`<use>`](overview.md#top), and the like.

## See also

- **[Lists & iteration](lists.md#top)** — sum or weight a whole list with `<reduce>`.
- **[Conditionals](conditionals.md#top)** — branch on `<greater_than>` / `<mod>` in a check digit.
- **[Compute overview](overview.md#top)** — the full Luhn / check-digit example.
- **[Compute functions reference](../reference/compute.md#top)** — the alphabetical catalog.

---

← Previous: [Overview](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Lists & iteration](./lists.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/compute/arithmetic)**
