<a name="top"></a>

**English** · [Русский](../ru/generators/timeseries.md#top) · [Español](../es/generators/timeseries.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/timeseries)**

← Previous: [Increment & Decrement](./counters.md#top) · **[Contents](../README.md#top)** · Next: [Pattern](./pattern.md#top) →

---

# The `timeseries` generator

**Use it when** you need values that move like a real signal over time — daily
sales, sensor readings, web traffic. Real series aren't flat noise or a single
distribution: they're **layers** — an overall trend (rising or falling), a
repeating season (weekly, yearly), and random noise on top. `timeseries` builds a
row's value exactly that way:

```text
value(i) = base + trend·i + amplitude·sin(2π·i / period) + noise·random
```

where `i` is the row number (the time axis), counted from zero — so the first row
(`i = 0`) is exactly `base`.

Example outputs below are illustrative: exact digits can differ by core version and
`seed`, but the shape — the trend, the wave, the jitter — is what matters.

![](../img/concepts/timeseries-layers.svg)

*The same generator, four times, with one attribute added each time — 120 rows per panel.*

- **A** — base alone: a flat line
- **B** — trend added: the line starts climbing
- **C** — period and amplitude added: a wave rides on the trend
- **D** — noise added: the wave stops being perfect

## Why not just random numbers

A plain [`number`](number.md#top) generator produces **white noise** — values that
jump around a mean with no memory. Here's `number` with a normal distribution
centered on `1000`:

```xml
<sequence name="Noise"><gen type="number" distribution="normal" mean="1000" sd="120"/></sequence>
```

`./run noise.tdc`

```
Day 1     841
Day 2     1341
Day 3     1047
Day 4     1010
Day 5     1086
Day 6     1077
Day 7     862
Day 8     1072
Day 9     1114
Day 10    782
Day 11    979
Day 12    1014
```

No rise, no fall, no repeat — every day just churns around 1000. Real metrics don't
look like that: sales have a trend (the business grows), a weekly rhythm (weekends
differ from weekdays), and only _on top of those_ some random deviation. Those three
layers are exactly what `timeseries` adds.

## Attributes

```xml
<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30"/>
```

| Attribute   | What it sets                                             |
| :---------- | :------------------------------------------------------- |
| `base`      | Starting level (default `0`)                             |
| `trend`     | Slope: how much the value rises each step                |
| `period`    | Length of the seasonal wave, in rows (e.g. `7` = a week) |
| `amplitude` | Height of the seasonal wave                              |
| `peak_at`   | Which row the wave peaks on (default: a quarter period in) |
| `noise`     | Strength of the random noise (standard deviation)        |
| `decimals`  | Digits after the decimal point (default `0` — integer)   |

Every layer is optional. The sections below take them one at a time — what each
does, and when you'd reach for it.

### `base` — the starting level

`base` fixes the value of the very first row (`i = 0`), and it's the level everything
else is measured from. On its own — no `trend`, no wave, no `noise` — it's just a
flat line.

```xml
<gen type="timeseries" base="500"/>
```

`./run base.tdc`

```
500
500
500
500
500
```

Use it to anchor a metric at a realistic level — a store that averages 500 orders a
day, a sensor that idles at 20 degrees — before you add movement.

### `trend` — direction

`trend` is the slope: each row adds `trend` to the last. Positive climbs, negative
falls. With only `base` + `trend` you get a dead-straight line.

```xml
<gen type="timeseries" base="1000" trend="20"/>
```

`./run trend.tdc`

```
1000
1020
1040
1060
1080
```

Use it for growth or decay you want to be obvious at a glance — a subscriber count
that gains 20 a day, a battery that drains a fixed amount each cycle.

### `period` and `amplitude` — the seasonal wave

These two work as a pair, and neither does anything without the other. `period` is
how many rows one full cycle takes (`7` = a weekly rhythm, `365` = a yearly one);
`amplitude` is how far the wave swings above and below the trend line. Together they
lay a repeating `sin` wave on whatever `base` + `trend` gives you.

```xml
<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150"/>
```

`./run season.tdc`

```
1000
1137
1186
1125
1015
954
1003
```

Within each 7-row window the value rises to a peak and falls to a trough, then
repeats. Because the trend keeps lifting the whole line, each cycle sits higher than
the last — the wave rides up the slope. Use it for anything with a calendar rhythm:
weekday-vs-weekend traffic, summer-vs-winter demand.

### `peak_at` — which row the wave is highest on

`period` and `amplitude` say how long the wave is and how far it swings. They do not
say WHEN it peaks, and the default answer surprises people: the wave starts at the
middle of its swing and climbs, so it peaks a **quarter period** in.

Over twelve monthly rows that is row 3 — April. "Warmer in summer" is what the
config was for, and April is not it:

```xml
<gen type="timeseries" base="15" amplitude="10" period="12" decimals="1"/>
```

`./run temp.tdc — the fourth row is the highest`

```
15.0
20.0
23.7
25.0
23.7
20.0
15.0
10.0
6.3
5.0
6.3
10.0
```

`peak_at` names the row instead. Rows count from zero, so July is row 6:

```xml
<gen type="timeseries" base="15" amplitude="10" period="12" peak_at="6" decimals="1"/>
```

`./run temp.tdc — the seventh row is the highest`

```
5.0
6.3
10.0
15.0
20.0
23.7
25.0
23.7
20.0
15.0
10.0
6.3
```

Nothing else moved: same `base`, same `amplitude`, same twelve-row cycle. Only the
month the maximum lands on.

**It is a row, not an angle.** `period` is already counted in rows, so `peak_at` is
too — 182 of 365 is the first of July, and that is a number you can work out from a
calendar rather than from radians. A value beyond the period wraps, so `peak_at="18"`
over `period="12"` is the same as `6`, and a fraction is allowed when the peak sits
between two rows.

`peak_at="0"` is worth knowing separately: it makes the wave START at its maximum,
a shape a plain sine cannot produce at any amplitude.

> [!NOTE]
> **If you reached for `phase`**
>
> That is the signal-processing name and TDC does not have it. `peak_at` does the same
> job in the unit the rest of the generator uses. Writing `phase=` is an error that
> says so.

`peak_at` needs a `period` — a wave has to have a length before it can have a highest
point. Without one it is `TDC253`.

### `noise` — real-world roughness

`noise` is the standard deviation of a random wobble added to every row. It's the
difference between a textbook curve and a real measurement.

```xml
<gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30"/>
```

`./run noise-layer.tdc`

```
985
1087
1192
1107
936
966
1031
```

Compare with the clean wave above: the shape is the same, but each point jitters a
little (`1000 → 985`). Turn it up for a noisy sensor, down for a smooth aggregate.
The jitter is reproducible — see [Details](#details).

### `decimals` — fractional values

By default the output is rounded to a whole number. `decimals` keeps that many
digits after the point — for temperatures, prices, or any measured quantity.

```xml
<gen type="timeseries" base="20" trend="0.5" noise="0.3" decimals="1"/>
```

`./run decimals.tdc`

```
20.0
20.4
21.2
21.4
22.1
```

## Build it up one layer at a time

The clearest way to get a feel for the generator is to switch the layers on one at a
time. Below, three [`<sequence>`](../core-concepts/sequences.md#top) columns run over the
same "days": **trend** (only `trend`), **+season** (add `period` + `amplitude`), and
**+noise** (add `noise`).

```xml
<sequence name="A"><gen type="timeseries" base="1000" trend="20"/></sequence>
<sequence name="B"><gen type="timeseries" base="1000" trend="20" period="7" amplitude="150"/></sequence>
<sequence name="C"><gen type="timeseries" base="1000" trend="20" period="7" amplitude="150" noise="30"/></sequence>
...
<data>Day ${{Day}}   trend=${{A}}   +season=${{B}}   +noise=${{C}}</data>
```

`./run series.tdc`

```
Day   trend   +season   +noise
01    1000     1000      985
02    1020     1137      1087
03    1040     1186      1192
04    1060     1125      1107
05    1080     1015      936
06    1100     954       966
07    1120     1003      1031
08    1140     1140      1087
09    1160     1277      1311
10    1180     1326      1347
11    1200     1265      1261
12    1220     1155      1126
```

Reading the columns:

- **trend** — a dead-straight line: `+20` each day, `1000, 1020, 1040 …`. There's a
  direction, but no life to it.
- **+season** — a weekly wave (`period="7"`) laid on the line. Within each week the
  value climbs to a peak and falls to a trough: peaks land on days **3** and **10**
  (1186 → 1326), the trough on day **6** (954). Peaks and troughs repeat every 7
  rows, and each one sits higher than the last by exactly `trend · period = 20 · 7 =
140` — the wave rides up the trend.
- **+noise** — the same shape, but it jitters slightly (`1000 → 985`), the way real
  measurements do.

Each column is the previous one plus **one** attribute — direction, then rhythm,
then real-world roughness. That's how a realistic series is assembled.

## Details

- **Deterministic:** the same `seed` gives the same series. The noise is reproducible
  too — it's computed from the row number, not rolled on the fly.
- **Any size, either engine:** a value is computed from its row number, so memory
  doesn't grow (see [Large outputs](../guides/large-outputs.md#top)). A billion points is
  no problem.
- The time axis is the row number. It pairs naturally with an
  [`increment`](counters.md#top) (a day counter) or a [`date`](date.md#top) column beside
  it, so each value carries a real date.

> [!NOTE]
> **Planned**
>
> Today it's one trend + one seasonal wave + noise. Planned: several seasonalities at
> once (weekly **and** yearly) and AR noise (correlated over time).

## See also

- **[Number](number.md#top)** — single random values, with statistical distributions.
- **[Pattern](pattern.md#top)** — when the shape can't be described by trend + season.
- **[Counters](counters.md#top)** / **[Date](date.md#top)** — a day index or real date to
  put alongside the series.

---

← Previous: [Increment & Decrement](./counters.md#top) · **[Contents](../README.md#top)** · Next: [Pattern](./pattern.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/timeseries)**
