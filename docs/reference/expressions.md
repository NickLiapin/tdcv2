<a name="top"></a>

**English** · [Русский](../ru/reference/expressions.md#top) · [Español](../es/reference/expressions.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/expressions)**

← Previous: [Error codes](./errors.md#top) · **[Contents](../README.md#top)** · Next: [TypeScript](../bindings/typescript.md#top) →

---

# Expressions

The little language inside `if=` — and inside `filter=` on a [pool](../pools/filter.md#top),
which reads the same way. It decides whether a `<gen>`, a `<line>`, a `<case>` or a `<data>`
takes part in a row.

```xml
<sequence name="Zone">
  <gen if="Country in [US, CA, MX]" type="text" value="NAFTA"/>
  <gen if="Country in [FR, DE]"     type="text" value="EU"/>
  <gen                              type="text" value="ROW"/>
</sequence>
<sequence name="Handling">
  <gen if="Weight > 20"      type="text" value="freight"/>
  <gen if="_count % 2 == 0"  type="text" value="courier-even"/>
  <gen                       type="text" value="parcel"/>
</sequence>
```

`./run shipping.tdc`

```
US NAFTA 2kg parcel
FR EU 14kg courier-even
CA NAFTA 7kg parcel
DE EU 30kg freight
MX NAFTA 5kg parcel
JP ROW 22kg freight
```

The last `<gen>` in each sequence has no `if=`, so it catches whatever the conditions above
did not — the same shape as an `else`.

## Values

| You write         | It means                                                                 |
| :---------------- | :----------------------------------------------------------------------- |
| `Country`         | the value that sequence produced on this row                             |
| `Person.Email`    | a field of a [compound sequence](../core-concepts/sequences.md#top)         |
| `Gender.Male`     | "is Gender currently Male?" — the same reading as `parent="Gender.Male"` |
| `Male`            | a **bare word**: a name that is no sequence is its own text              |
| `42`, `1.5`       | a number                                                                 |
| `'text'`          | a quoted string, when the text has spaces or looks like a name           |
| `_count`, `_last` | a [built-in](builtins.md#top) — the row number, the last-row flag           |

A bare word is what lets `Gender == Male` be written without quotes. It also means a **typo
compares against itself and quietly matches nothing** — which is why an unknown name on the
right of a dot raises [TDC193](errors.md#top) rather than passing.

## Operators

| Group      | Operators                        |
| :--------- | :------------------------------- |
| comparison | `== != === !== < > <= >=`        |
| logic      | `&& \|\| !`                      |
| arithmetic | `+ - * / %`                      |
| membership | `in`                             |
| choice     | `a ? b : c`                      |

> [!CAUTION]
> **`%` is Euclidean, and that is not what your language does**
>
> `-3 % 2` is **1** here. JavaScript, Java, C# and Rust all answer −1; Python answers 1.
>
> The reason is not taste. The [compute layer](compute.md#top) already had `<mod>` and already
> answered 1, so a `%` that borrowed the host convention would make one engine give two
> different answers to the same question depending on which layer you reached for.

`in` takes a list on its right and nothing else — a list anywhere else raises
[TDC259](errors.md#top). Comparison inside it is as loose as `==`, so a text column against a
list of numeric words still matches.

```xml
<gen if="Country in [US, CA, MX]" .../>   <!-- instead of three == joined by || -->
```

## Functions

Every function here is **exact**: built from comparisons and from the arithmetic IEEE-754
pins down, so the five implementations cannot disagree about a result.

| Function                   | Takes  | Gives                                            |
| :------------------------- | :----- | :----------------------------------------------- |
| `abs(x)`                   | 1      | magnitude                                        |
| `ceil(x)` `floor(x)`       | 1      | up / down to a whole number                      |
| `trunc(x)`                 | 1      | toward zero — `trunc(-7.5)` is −7, `floor` is −8 |
| `round(x)`                 | 1      | nearest, a half **away from zero**               |
| `min(…)` `max(…)`          | 1 or more | smallest / largest                            |
| `len(s)`                   | 1      | how many characters                              |
| `is_empty(s)`              | 1      | whether the text is empty                        |
| `starts_with(s, p)`        | 2      | prefix test                                      |
| `ends_with(s, p)`          | 2      | suffix test                                      |
| `contains(s, p)`           | 2      | substring test                                   |
| `lower(s)` `upper(s)`      | 1      | case                                             |

> [!NOTE]
> **Two rules worth knowing before you rely on them**
>
> **`round` sends a half away from zero.** `round(0.5)` is 1 and `round(-0.5)` is −1.
> JavaScript rounds a half toward +∞, Python rounds to even, Java rounds half up: three hosts,
> three answers, none symmetric. TDC states its own so a column of negatives behaves like a
> column of positives.
>
> **`len` counts code points.** `len("😀")` is 1, not the 2 that UTF-16 would give — but a
> family emoji built from several code points counts as several. Grapheme clusters would be
> the human answer and need a Unicode segmentation table that not every implementation can
> carry, so the portable unit wins. `len("10")` is 2: a string function reads its argument as
> text, never as a number.

## What is deliberately absent

**Trigonometry, logarithms, powers.** `sin`, `cos`, `exp`, `log`, `sqrt` and their kin are
refused by name, with the reason:

`tdcv2 check seasonal.tdc`

```
error[TDC257]: cos() is not available yet in an if expression
```

The note beside it explains why, and the reason is measurable: `tan(1)` already differs in
its last bit between Node and Python on the same machine. Sixteen of seventy-seven sampled
values disagree somewhere across the five implementations. In a `timeseries` that never
shows, because every number is rounded before it becomes output — but a comparison has no
rounding step, so one bit becomes a different row and a different file. These arrive once
TDC computes them itself, the way it computes its own random numbers rather than trusting
each language's.

**Loops and recursion.** The engine is chosen from the config before a row is generated,
[`preflight()`](../guides/large-outputs.md#top) estimates memory before the run, and `--jobs`
splits rows across workers. All three need to know the work per row without doing it. A loop
breaks all three, and what people reach for a loop to express — "is this row even?" — is
`%`.

**Bitwise operators.** `_count & 1` is `_count % 2` written for a machine. They parse, so
the message can name them, and then they are refused.

## When an expression is not enough

A [`<compute>` sequence](compute.md#top) has integer division, remainders, string surgery,
encodings and checksums. It produces a value like any other sequence, and `if=` then compares
that:

```xml
<sequence name="Checksum">
  <compute><result><mod><to_number><field name="Account"/></to_number><int v="97"/></mod></result></compute>
</sequence>
<sequence name="Flag">
  <gen if="Checksum == 0" type="text" value="divisible"/>
  <gen type="text" value="."/>
</sequence>
```

## The config is XML-shaped, but it is not XML

TDC does not expand entities, so `&lt;` is four literal characters rather than `<`. Write the
raw character:

```xml
<gen if="Weight > 20" .../>      <!-- yes -->
<gen if="Weight &gt; 20" .../>   <!-- no: TDC100, and the message says why -->
```

---

← Previous: [Error codes](./errors.md#top) · **[Contents](../README.md#top)** · Next: [TypeScript](../bindings/typescript.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/expressions)**
