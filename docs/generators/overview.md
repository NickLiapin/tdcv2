<a name="top"></a>

**English** · [Русский](../ru/generators/overview.md#top) · [Español](../es/generators/overview.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/overview)**

← Previous: [One value at a time](../core-concepts/quick-api.md#top) · **[Contents](../README.md#top)** · Next: [Text](./text.md#top) →

---

# Generators

A `<gen>` produces the values of a [sequence](../core-concepts/sequences.md#top). Its
`type` attribute chooses which generator to use, and every other attribute is a
parameter of that generator:

```xml
<sequence name="Status">
    <gen type="text" value="new,active,closed"/>
</sequence>
```

`./run demo.tdc`

```
active
new
closed
active
closed
```

Example outputs on this page are illustrative — the exact values depend on the
seed and can shift between core versions. What stays fixed is the **shape** of the
result: the format, the counts, and the distribution.

## Where a generator can live

A `<gen>` lives **where data is declared**:

- inside a [`<sequence>`](../core-concepts/sequences.md#top) — simple, composed,
  compound, or conditional — where it fills `count` values (or as many as the filtered
  subset holds, if the sequence has a `parent`). "An array of `count` values" is the
  model to reason with; the default engine produces them one row at a time as the file
  streams, without ever holding the array;
- inside a [`<case>`](../reference/tags.md#top) of a [`<mix>`](../reference/tags.md#top) —
  one branch of a percentage split.

Several `<gen>`s can share one sequence body, and `name` decides what each becomes.
Leave a generator **unnamed** and its value is concatenated into the sequence's own
value, along with any `<data>` literal beside it — a
[composed sequence](../core-concepts/sequences.md#a-composed-sequence). Give it a
`name` and it is a field of its own, read as `${{Sequence.Field}}` — a
[compound sequence](../core-concepts/sequences.md#a-compound-sequence). The two mix
freely in one body.

It is **not** allowed directly in the output block. A `<gen>` placed as a child of
[`<line>`](../core-concepts/output-formatting.md#top) is error `TDC131`: the block only
formats text; it doesn't generate anything. To put a generated value in the output,
declare a named sequence and reference it with `${{Name}}` — see
[Output & formatting](../core-concepts/output-formatting.md#top).

## Common attributes

These work on **every** generator; the rest depend on `type`.

| Attribute | Required | What it does                                                                                                                                                                               |
| :-------- | :------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | **yes**  | Which generator to use (see the table below)                                                                                                                                               |
| `name`    | no       | Makes this generator a **field** of its sequence, read as `${{Sequence.Field}}`. Without it the value joins the [sequence's own value](../core-concepts/sequences.md#a-composed-sequence) |
| `if`      | no       | Branch condition inside a [conditional sequence](../core-concepts/sequences.md#top) — the first true `<gen>` wins                                                                             |
| `comment` | no       | Free-form comment, ignored by the engine                                                                                                                                                   |

## The generators

Each type has its own page, with every parameter and worked examples.

| `type`                                    | Produces                                                            |
| :---------------------------------------- | :------------------------------------------------------------------ |
| [`text`](text.md#top)                        | A value from a set — uniform, or by exact `percent`                 |
| [`number`](number.md#top)                    | An integer in a range, or a fixed-width digit string                |
| [`template`](template.md#top)                | Built-in realistic data and technical IDs                           |
| [`file`](file.md#top)                        | Values read from your own files and CSV columns                     |
| [`date`](date.md#top)                        | A date or date-time in a range and format                           |
| [`symbol`](symbol.md#top)                    | A string of characters from a set or named alphabet                 |
| [`regex`](regex.md#top)                      | A string matching a finite regular expression                       |
| [`advanced_regex`](advanced-regex.md#top)    | Regex plus weighted choice between alternatives                     |
| [`increment` / `decrement`](counters.md#top) | Rising and falling counters                                         |
| [`timeseries`](timeseries.md#top)            | A time series — trend + seasonality + noise                         |
| [`pattern`](pattern.md#top)                  | A distribution shaped like a drawn curve                            |
| [`http`](http.md#top)                        | Values answered by your own service, batch by batch                 |
| [`running`](running.md#top)                  | A total that carries down the column — a balance, a high-water mark |
| [`stat`](stat.md#top)                        | One number for the whole run — an average, a total, a largest        |

**On presets.** The old `type="preset"` no longer exists. Algorithmic identifiers —
UUIDs, IBANs, credit-card numbers, git SHAs, national IDs — are now
[`template`](template.md#top) paths: global ones under the `common.` prefix (for example
`common.id.uuid`), country ones under their country (for example `usa.docs.ssn`). The
full catalog lives on the [`template`](template.md#top) and
[generators reference](../reference/generators.md#top) pages.

## Declared shares, or a draw from a source

Two kinds of generator sit side by side in that table, and they answer "how often does
each value appear?" differently. It is worth knowing which one you are holding.

**You declared the shares — you get them exactly.** Where the values are written out in
the config, TDC lays the quota across the rows and then shuffles it. `percent="30,70"`
is 30 and 70, not "about". Left unset, the shares are equal, and equal is exact too:

`10 values over 1000 rows`

```
text:  100 100 100 100 100 100 100 100 100 100
```

That covers [`text`](text.md#top) and [`<mix>`](../constructs/mix.md#top), and
[`number`](number.md#top) **when its `percent` splits `length` groups** — `length="2,3"
percent="70,30"` over a thousand rows is 700 and 300 exactly.

> [!CAUTION]
> **`missing=` on the same generator changes the counts**
>
> The quota is laid over the whole column first, and `missing=` then blanks cells without
> regard to which value they hold. So `percent="90,10" missing="0.5"` over a thousand rows
> gives about 450 / 50 / 500 blank: the RATIO of the surviving values is still 90:10, and
> the absolute counts are not what `percent` alone would give.
>
> That is not a rounding slip, and no ordering fixes it — the two requests are inconsistent.
> Exactly 100 `fail` rows AND half the file blank would make `fail` 100 of the 500 surviving
> values, which is 20%, not the 10% asked for. If you need an exact number of a value in the
> finished file, keep `missing=` off that generator.

A plain numeric range is the other kind. `value="1..10"` draws, and over a thousand rows
the ten values come out `97 84 106 112 107 102 90 95 86 121` — the spread of a draw, not
a quota. The rule is what the config wrote down: shares written out are honoured exactly,
a range is reached into.

**You pointed at a source — you get a draw.** A [file](file.md#top) or a
[pool](../pools/overview.md#top) is a set you reach into, once per row, independently. Over
the same 1000 rows the counts land where chance puts them:

`the same 10 values, read from a source`

```
file:   81  88  93  97  98 102 103 105 111 122
pool:   90  92  95  97 100 102 104 105 106 109
```

This is not a weaker version of the first. Nobody declared a proportion, so there is
none to honour — a source behaves the way drawing from a hat behaves, which is what
makes it look like real usage rather than a rota.

**When a source needs proportions, it takes them from the data.** A CSV that knows how
often each item sells says so in a column, and
[`weight="sales"`](../guides/coherent-data.md#top) makes the draw follow it — exactly, like
`percent`. That is the honest place for the numbers: a catalog of 3,000 items has its
frequencies in the file, not in your config.

## Formatting on any generator

A handful of attributes work on **any** `type`. The value is generated as usual,
then reshaped on its way out. The generator itself is unaffected by which of these
you attach.

### `case=` / `mask=` — letter case and display masks

**Use it when** the raw value is correct but should _look_ a certain way: a column
that has to be all uppercase, or a plain number that should read like a formatted ID.

`case=` changes letter case; `mask=` splits and rearranges characters into a fixed
template. Both wrap the **whole** generator. The example below feeds the same four
US cities through three sequences — the raw value, then the same list with
`case="lower"` and `case="upper"`. `order="sequential"` keeps the cities in step so
the columns line up.

```xml
<sequence name="Raw"><gen type="text" value="New York,Chicago,Denver,Austin" order="sequential"/></sequence>
<sequence name="Low"><gen type="text" value="New York,Chicago,Denver,Austin" order="sequential" case="lower"/></sequence>
<sequence name="Up"><gen type="text" value="New York,Chicago,Denver,Austin" order="sequential" case="upper"/></sequence>
...
<data>${{Raw}}  ->  lower: ${{Low}}  |  upper: ${{Up}}</data>
```

`./run cities.tdc`

```
New York  ->  lower: new york  |  upper: NEW YORK
Chicago   ->  lower: chicago   |  upper: CHICAGO
Denver    ->  lower: denver    |  upper: DENVER
Austin    ->  lower: austin    |  upper: AUSTIN
```

`mask=` does the same for identifiers that should read as formatted: a bare
`37898432363` with `mask="xxx-xxx-xxx xx"` comes out as `378-984-323 63`. Every
mask slot (`x`, `w`, `*`), every case mode, and multi-step filter chains are covered
in full on **[Masks & case](../guides/masks-and-case.md#top)**.

### `order=` / `cycle=` — the order of values

**Use it when** values must come out in a fixed sequence rather than at random —
month names in calendar order, a lookup list walked top to bottom, or two columns
that have to stay aligned (as in the example above).

By default `order="random"`. Set `order="sequential"` and row _i_ takes the _i_-th
value in order, cycling back to the start when the list runs out. `cycle="false"`
turns that wrap-around into a clear error instead — useful when running out of
values should be a failure, not a silent repeat.

```xml
<sequence name="Rand"><gen type="text" value="Jan,Feb,Mar"/></sequence>
<sequence name="Seq"><gen type="text" value="Jan,Feb,Mar" order="sequential"/></sequence>
...
<data>random=${{Rand}}   sequential=${{Seq}}</data>
```

`./run order.tdc (7 rows)`

```
random=Feb   sequential=Jan
random=Feb   sequential=Feb
random=Mar   sequential=Mar
random=Jan   sequential=Jan
random=Feb   sequential=Feb
random=Mar   sequential=Mar
random=Jan   sequential=Jan
```

The same applies to files: `<gen type="file" src="cities.txt" order="sequential"/>`
walks the file line by line. Full details are on
**[Masks & case](../guides/masks-and-case.md#top)**.

### `missing=` / `anomaly=` — blanks and outliers

**Use it when** you need data that looks like the real world — where some fields are
empty and a few values sit far outside the normal range. `missing=` injects blank
cells (missing-completely-at-random gaps); `anomaly=` injects outliers so a
downstream pipeline or model has something abnormal to cope with. Both attach to the
generator like `case=` and are applied after the value is produced.

Both attach to any generator and change what the column looks like as a whole — some
cells empty, a few values far out of range — rather than how the underlying value is
drawn. They differ in what they can act on: `missing=` blanks a cell whatever was in it,
while `anomaly=` **multiplies**, so it only bites on values that read as numbers. A
numeric string from a `text` list is multiplied; a name is passed through unchanged and
without a warning. Full rules on
**[Anomalies & missing values](../guides/anomalies.md#top)**.

---

← Previous: [One value at a time](../core-concepts/quick-api.md#top) · **[Contents](../README.md#top)** · Next: [Text](./text.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/generators/overview)**
