<a name="top"></a>

**English** · [Русский](../ru/generators/text.md#top) · [Español](../es/generators/text.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/text)**

← Previous: [Overview](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Number](./number.md#top) →

---

# The `text` generator

**Use it when** you have a short, fixed list of options to pick from — gender,
status, category, payment type, tier. If you need exact shares of each (say, 60%
one, 40% the other), that's a single extra attribute.

Example outputs below are illustrative — the exact values a given `seed`
produces can shift between core versions, but the **counts** that `percent`
guarantees never do.

## At a glance

| Attribute | Required | What it does                                                             |
| :-------- | :------- | :----------------------------------------------------------------------- |
| `value`   | **yes**  | The options, comma-separated: `"a,b,c"`                                  |
| `percent` | no       | Exact share of each option; see [below](#exact-proportions-with-percent) |

On top of these, `text` accepts the cross-cutting generator attributes —
`case=` / `mask=` for [output formatting](../guides/masks-and-case.md#top) and
`order=` / `cycle=` for [value order](overview.md#top).

## `value` — a list of options

The core parameter. For `text`, `value` is a **comma-separated list** of the
options to draw from; the generator picks one at random for each row.

> [!CAUTION]
> **The comma is the separator, and there is no escape**
>
> Three consequences worth knowing before an option surprises you:
>
> - **Spaces around an option are trimmed.** `value=" x , y "` gives `x` and `y`, not
>   `" x "` and `" y "`. An option that must keep a leading or trailing space has to come
>   from a [file](file.md#top) instead.
> - **An option cannot contain a comma.** `value="Smith, Jr.,Brown"` is three options —
>   `Smith`, `Jr.` and `Brown` — not the two the author meant.
> - **A bare comma makes an EMPTY option.** `value="a,,b"` is three options, one of which
>   is the empty string, so about a third of the rows come out blank. To blank rows on
>   purpose use [`missing=`](../guides/missing-data.md#top), which says so.

```xml
<sequence name="Color">
    <gen type="text" value="red,green,blue"/>
</sequence>
```

`./run color.tdc (count=6)`

```
blue
red
green
green
red
blue
```

With no `percent`, the choice is **uniform** — every option is equally likely,
and the same `seed` always reproduces the same sequence. Values may repeat
freely from row to row (`green` twice above); if you need every row to differ,
see [Unique values](../constructs/unique-values.md#top).

For strict list order instead of random picks, add
`order="sequential"` — see [Generators overview](overview.md#top).

> [!NOTE]
> **`value` reads differently per generator**
>
> `value` is every generator's main input, but its **meaning depends on `type`**.
> In `text` it's a list of whole words; in [`number`](number.md#top) it's a numeric
> range like `1..100`; in [`date`](date.md#top) it's a date range or a mode word
> like `today`; in [`regex`](regex.md#top) it's a pattern. Same attribute, different
> grammar — this page covers the `text` reading only.

## Exact proportions with `percent`

This is what sets `text` apart from a plain random picker. Add `percent` and TDC
lays the values out to **exact** counts using the Hamilton (largest-remainder)
method — the number of times each value appears is guaranteed to match the
percentages. The randomness is only in the _order_.

```xml
<sequence name="Gender">
    <gen type="text" value="Male,Female" percent="60,40"/>
</sequence>
```

The rows come out shuffled:

`./run gender.tdc (first 6 rows)`

```
Female
Male
Female
Male
Male
Male
```

…but count **all** of them and the split is exact. Over `count="100"`:

`./run gender.tdc (count=100, tallied)`

```
Male     60
Female   40
```

Exactly 60 `Male` and 40 `Female` — not "about 60%", but 60. That's the whole
point of Hamilton: the totals are exact; only the order depends on the seed.

### Shares that don't divide evenly

Three equal shares over 100 rows works out to 33.33% each, which is not a whole
number of rows. Hamilton gives the extra row to the largest remainder, so the total
is still exactly 100:

```xml
<sequence name="Grade">
    <gen type="text" value="A,B,C" percent=",,"/>
</sequence>
```

`./run grade.tdc (count=100, tallied)`

```
A   34
B   33
C   33
```

`34 + 33 + 33 = 100` — no row is lost or double-counted. Explicit shares are taken
just as literally:

```xml
<sequence name="Tier">
    <gen type="text" value="gold,silver,bronze" percent="50,30,20"/>
</sequence>
```

`./run tier.tdc (count=100, tallied)`

```
gold     50
silver   30
bronze   20
```

### Small counts

The guarantee is "the totals sum to `count`", which only lands on the exact
percentages when `count` can be split that way. With `count="100"` and
`percent="50,50"` you get exactly 50 and 50. With `count="3"` and the same split
you can't have two-and-a-half of each, so Hamilton rounds to either `2 + 1` or
`1 + 2` — which value gets the extra row depends on the seed — but the two counts
**always sum to 3**. No row is ever dropped or duplicated.

`./run coin.tdc (value=Heads,Tails percent=50,50 count=3)`

```
Heads
Tails
Heads
```

The rounding matters most when a share is **small**. `percent="10"` over 5 rows
asks for half a row, and half a row cannot be emitted — so the value appears once
or not at all, decided by the seed. A rare option can vanish from a short run
entirely while the config looks correct. Multiply the share by the number of rows
before you trust it, and see
[A share smaller than one record](../constructs/mix.md#a-share-smaller-than-one-record)
for the worked example.

### Partial percent lists

You don't have to fill in every position. The rule is:

- **A number fixes that value's share.**
- **Every empty position takes an equal cut of whatever is left of 100** — and
  "empty" means both a bare comma inside the list _and_ any position past the end of
  a list that is shorter than the value list.

The `Values` column below gives the length of the value list the shares are applied to,
since the same `percent` expands differently depending on how many values there are:

| `percent` | Values | Expands to                   | Why                                                      |
| :-------- | :----- | :--------------------------- | :------------------------------------------------------- |
| `60`      | 2      | `60,40`                      | value 1 = 60; value 2 takes the rest                     |
| `,58`     | 2      | `42,58`                      | value 2 = 58; value 1 takes the rest                     |
| `,10,10`  | 4      | `40,40,10,10`                | values 3–4 = 10; values 1–2 split the remaining 80       |
| `46,`     | 5      | `46,13.5,13.5,13.5,13.5`     | value 1 = 46; values 2–5 split the remaining 54 (÷4)     |
| `,,25,,`  | 5      | `18.75,18.75,25,18.75,18.75` | value 3 = 25; the other four split the remaining 75 (÷4) |

Take `46,` on a five-value list: only the first share is set, so the other four
values divide the leftover `100 − 46 = 54` evenly — `13.5` each. The lone trailing
comma just signals "and the rest are open".

So the exact-60/40 example above can be written even shorter — the second share is
just "the rest":

```xml
<gen type="text" value="Male,Female" percent="60"/>
```

If every position is filled, the numbers must sum to 100. If any position is empty, the
filled numbers must sum to **at most** 100.

## Proportions inside a subset

When the sequence has a [`parent`](../core-concepts/sequences.md#top), the percentages
are computed against the size of the **filtered subset**, not the whole `count`.
That's the key to hierarchical dependencies — a "70% Private / 30% Captain" split
that applies only to the men, for example. See
**[Hierarchical dependencies](../guides/hierarchical-dependencies.md#top)**.

## `percent` beyond `text`

The same grammar and the same Hamilton layout drive the branch shares of a `<mix>`
block. There the list is matched against the number of nested `<case>` branches, and
leaving `percent` off spreads the cases evenly. Learn `percent` here and you know it
everywhere it appears.

## Formatting

Like any generator, `text` accepts `case=` / `mask=` and `order=` to transform its
output — for example uppercasing the picked word, or forcing sequential order. See
**[Masks & case](../guides/masks-and-case.md#top)**.

## Next

- **[Number](number.md#top)** — integers, ranges, and fixed-width digit strings.
- **[File](file.md#top)** — the same "pick from a list" idea, but the list lives in a file or CSV column.

---

← Previous: [Overview](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Number](./number.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/text)**
