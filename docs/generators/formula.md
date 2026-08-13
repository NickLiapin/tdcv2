<a name="top"></a>

**English** · [Русский](../ru/generators/formula.md#top) · [Español](../es/generators/formula.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/formula)**

← Previous: [Statistic](./stat.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../pools/overview.md#top) →

---

# The `formula` generator

**Use it when** a column is not drawn but **computed** — from the other columns of the
same row. A weight that follows a height. A BMI from both. A price times a quantity. A
remainder you want to print rather than test.

```xml
<gen type="formula" expr="0.75 * Height - 58 + 6 * Z" decimals="1"/>
```

`expr=` is the same little language as [`if=`](../reference/expressions.md#top) — the same
operators, the same functions, the same names for the same columns. The only difference is
where the answer goes: `if=` consumes it as a yes/no, and a formula keeps it as the value
of its column.

| Attribute  | What it sets                                                              |
| :--------- | :------------------------------------------------------------------------ |
| `expr`     | **Required.** The arithmetic this column is                               |
| `decimals` | Digits after the point, 0 to 10. Without it the value prints in full      |

## A column that follows another one

Real data is not a set of independent columns — weight follows height, income follows
education, area follows price. A formula is how you say so:

```xml
<sequence name="Height"><gen type="number" distribution="normal" mean="170" sd="10" decimals="1"/></sequence>
<sequence name="Z">     <gen type="number" distribution="normal" mean="0" sd="1" decimals="4"/></sequence>

<sequence name="Weight"><gen type="formula" expr="0.75 * Height - 58 + 6 * Z" decimals="1"/></sequence>
<sequence name="BMI">   <gen type="formula" expr="Weight / pow(Height / 100, 2)" decimals="1"/></sequence>
<sequence name="Label"> <gen type="formula" expr="BMI > 25 ? over : normal"/></sequence>
```

`./run clinic.tdc`

```
152.3,62.1,26.8,over
187.3,73.4,20.9,normal
172.9,69.6,23.3,normal
164.9,59.8,22.0,normal
159.3,60.9,24.0,normal
157.4,63.9,25.8,over
```

`Height` is drawn, `Z` is the noise that keeps the relationship from being a straight line,
and the other three are computed. **`Z` never has to be printed** — leave a column out of
`<block>` and it stays in the calculation without reaching the file. A data-science config
usually has several of those.

The last line is worth noticing on its own: a ternary makes a formula produce a **label**,
not only a number, which is how a training set gets its target column.

## Division, and the remainder you can print

Division is real here, and always was — it is the one operator that cannot stay whole,
because the whole numbers are not closed under it:

```xml
<sequence name="N">   <gen type="number" value="1..20"/></sequence>
<sequence name="Half"><gen type="formula" expr="N / 2"/></sequence>
<sequence name="Rem"> <gen type="formula" expr="N % 3"/></sequence>
<sequence name="Row"> <gen type="formula" expr="_count"/></sequence>
```

`./run numbers.tdc`

```
n=15 half=7.5 rem=0 row=1
n=9  half=4.5 rem=0 row=2
n=9  half=4.5 rem=0 row=3
n=5  half=2.5 rem=2 row=4
```

`_count` and every other [built-in](../reference/builtins.md#top) is readable, so a trend by
hand is `expr="100 + 0.05 * _count"`.

> [!NOTE]
> **A comparison prints `true` / `false`, not 1 / 0**
>
> `expr="BMI > 25"` gives the word `true`, matching `_last`, `_first` and every
> `anomaly_flag` column — one spelling for a flag across the whole engine.
>
> A training set usually wants the other shape, and the ternary is right there:
>
> ```xml
> <gen type="formula" expr="BMI > 25 ? 1 : 0"/>
> ```

## Whole numbers stay whole

An operand that IS a whole number is carried as one and only becomes a double when
something asks it to. So a formula is exact wherever its inputs are exact — `1000000 *
1000000` is the right answer here, not a rounded one — and only becomes approximate when
the config asked for something inexact. The rules are the same as everywhere else in the
expression language and are written out in
[Expressions](../reference/expressions.md#whole-numbers).

> [!CAUTION]
> **Two fractions are rarely equal**
>
> `0.1 + 0.2 == 0.3` is **false**, here and in every other language, because 0.1 has no exact
> binary form. That is honest IEEE arithmetic rather than a quirk of this engine — but it
> means a branch written as `if="A + B == 0.3"` may never fire. Compare with `<` and `>`, or
> round both sides first.

## An empty source makes an empty answer

A cell that [`parent=`](../core-concepts/sequences.md#top) or [`missing=`](../guides/missing-data.md#top)
left empty is not a zero, and a formula reading it produces nothing rather than
inventing a number:

```xml
<sequence name="H" parent="G.M"><gen type="number" value="170..190"/></sequence>
<sequence name="W"><gen type="formula" expr="H * 2"/></sequence>
```

`./run people.tdc`

```
F,,
F,,
M,170,340
M,172,344
```

The rows where `H` has no value leave `W` empty too. That is the same rule
[running](running.md#top) and [stat](stat.md#top) follow when they skip an emptied cell,
seen from the other side — and it is what makes a formula safe to put over a
`missing=` column: the blanks stay blanks instead of turning into arithmetic.

## The wrappers a formula does not take

`mask=`, `case=`, `missing=`, `missing_as=`, `repeat=`, `anomaly=` and
`anomaly_factor=` are refused with [`TDC015`](../reference/errors.md#top) rather than
accepted and ignored. A formula is resolved before the formatting layer runs — the
same position `running` and `stat` hold.

The answer already exists one step later and is better, because it works where the
value is PRINTED:

```xml
<data>${{Weight|mask:x}}</data>
```

## Which layer: formula or `<compute>`

Both compute a value, and the split is not a matter of taste:

| | |
| :--- | :--- |
| **`formula`** | mathematics — fractions, division, functions, anything derived |
| **[`<compute>`](../compute/overview.md#top)** | check digits and text shaping — mod-11, Luhn, padding, slicing |

`<compute>` is deliberately whole-number-only, because that is what a check digit needs.
Writing a formula in its tag tree is possible and miserable: `(x - lo) / (hi - lo)` is a
screenful of nesting there and thirteen characters here.

## What `check` refuses

Everything a formula needs is knowable from the config, so none of it waits for the run:

- **no `expr=`** — [`TDC294`](../reference/errors.md#top). A formula IS its expression.
- **an `expr=` that does not parse** — `TDC294`, pointing at the offending token.
- **a name that is not a column declared above** — [`TDC240`](../reference/errors.md#top),
  the same code `running` and `stat` use for the same rule, with a `did you mean` when the
  name is close to a real one. This is the one that matters most: a typo in an `if=` is a
  bare word and the branch quietly stops firing, but a typo in a formula reaches
  arithmetic.

The run refuses two more, because they depend on the values rather than the config:
arithmetic on a **text** column (which is where `NaN` would otherwise come from, and a
file full of `NaN` nobody was warned about is worse than a stopped run), and a **division
by zero**.

## Details

- **Reads its own row.** Row *i* is computed from row *i* and nothing else, so a formula
  consumes no randomness — adding one leaves every other column exactly where it was.
- **Declaration order.** A formula is built out of columns that already exist, so every
  name in `expr=` must belong to a sequence declared above it.
- **It streams.** Reading only its own row is exactly what the
  [streaming engine](../guides/large-outputs.md#top) is built on, so a formula runs there like
  any drawn column — memory stays flat as the row count grows. Measured on one config:
  1M rows 2.1 s, 5M rows 3.9 s, 20M rows 9.5 s and a 291 MB file, with peak memory rising
  1.3× while the row count rose 20×. The in-memory engine on the same 5M config took 12.5 s
  and used more memory, and cannot reach 20M at all.

  This is what separates a formula from [running](running.md#top) and [stat](stat.md#top): those
  two need rows other than this one — every row before, and every row at all — so they stay
  in memory by definition, not by omission.

## See also

- **[Expressions](../reference/expressions.md#top)** — the operators, the functions, and the
  whole-number rules.
- **[Running total](running.md#top)** — when the answer needs the rows *before* this one.
- **[Statistic](stat.md#top)** — when it needs the whole run.
- **[Number](number.md#top)** — for the drawn columns a formula reads.

---

← Previous: [Statistic](./stat.md#top) · **[Contents](../README.md#top)** · Next: [Overview](../pools/overview.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/formula)**
