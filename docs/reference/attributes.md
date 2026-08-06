<a name="top"></a>

**English** · [Русский](../ru/reference/attributes.md#top) · [Español](../es/reference/attributes.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/attributes)**

← Previous: [Tags](./tags.md#top) · **[Contents](../README.md#top)** · Next: [Generators](./generators.md#top) →

---

# Attributes reference

Every attribute in the tag DSL, with a one-line description and where it's covered.

The `<compute>` tags have attributes of their own (`v`, `sep`, `as`, `width`, `fill`,
`from`, `to`, `size`, `pattern`, `default`). Each one belongs to a single tag and is
covered where that tag is explained — see the [compute reference](compute.md#top).

## Environment & config

| Attribute       | What it sets                                  | See                                                           |
| :-------------- | :-------------------------------------------- | :------------------------------------------------------------ |
| `version` / `v` | The DSL version the file requires             | [Configuration](../core-concepts/configuration.md#top)           |
| `count`         | Number of records                             | [Determinism](../core-concepts/determinism.md#top)               |
| `seed`          | RNG seed, for reproducibility                 | [Determinism](../core-concepts/determinism.md#top)               |
| `local`         | Locale for template data                      | [Template](../generators/template.md#top)                        |
| `inject`        | Custom interpolation marker                   | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `mode`          | `memory` / `disk` — which engine family; `stream` is a legacy alias that forces engine 2 | [Large outputs](../guides/large-outputs.md#top)                  |
| `engine`        | `1` / `2` / `3` — force one engine (advanced) | [Large outputs](../guides/large-outputs.md#top)                  |
| `comment`       | Free-form comment                             | [Configuration](../core-concepts/configuration.md#comment)   |

## Sequences & dependencies

| Attribute   | What it sets                                                                                                                                                | See                                                                  |
| :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| `name`      | On `<sequence>`: its name. On `<gen>`: makes it a field, `Sequence.Field`. On `<data>` inside a sequence: a constant field, the only one that costs no draw | [Sequences](../core-concepts/sequences.md#a-constant-field)         |
| `parent`    | Parent filter, `Parent.Value`                                                                                                                               | [Hierarchical dependencies](../guides/hierarchical-dependencies.md#top) |
| `uniq`      | Combination that must be unique across all rows                                                                                                             | [Unique values](../constructs/unique-values.md#top)                     |
| `on` / `is` | Subject / branch key for `<switch>`                                                                                                                         | [Switch](../constructs/switch.md#top)                                   |
| `filter`    | On `<gen type="pool">`: which members this row may draw from                                                                                                | [Coherent records](../pools/filter.md#top)                              |
| `of`        | On `<gen type="running">`: the column to accumulate. On `<gen type="stat">`: the column to summarise                                                        | [Running total](../generators/running.md#top), [Statistic](../generators/stat.md#top) |
| `op`        | On `<gen type="stat">`: which statistic — `sum`, `mean`, `median`, `min`, `max`, `count` or `stddev`                                                        | [Statistic](../generators/stat.md#top)                                  |
| `reset`     | On `<gen type="running">`: a column whose change restarts the total                                                                                         | [Running total](../generators/running.md#top)                           |

## Generator values

| Attribute             | What it sets                                                                              | See                                                                                                       |
| :-------------------- | :---------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------- |
| `type`                | Which generator to use                                                                    | [Generators](../generators/overview.md#top)                                                                  |
| `value`               | The generator's main value (type-specific)                                                | [Generators](../generators/overview.md#top)                                                                  |
| `percent`             | Exact distribution of the values                                                          | [Text](../generators/text.md#top)                                                                            |
| `accumulate`          | Replace a `repeat` list with its running total, or say how a `running` column accumulates | [Several values in a cell](../constructs/multiple-values.md#accumulate--a-running-total-across-the-list) |
| `alphabet`            | Named Unicode alphabet                                                                    | [Symbol](../generators/symbol.md#top)                                                                        |
| `length`              | Output length or width                                                                    | [Number](../generators/number.md#top)                                                                        |
| `first_zero`          | Allow a leading zero                                                                      | [Number](../generators/number.md#top)                                                                        |
| `weekdays`            | Which weekdays a walked date axis keeps: `mon..fri`, `sun,wed`                            | [Date](../generators/date.md#top)                                                                          |
| `step`                | Counter stride, or how far a walked date axis advances: `15m`, `1h30m`, `3mo`             | [Counters](../generators/counters.md#top), [Date](../generators/date.md#top)                                     |
| `regex_max_length`    | Length cap for a regex                                                                    | [Regex](../generators/regex.md#top)                                                                          |
| `include` / `exclude` | Keep or drop values from the pool                                                         | [Number](../generators/number.md#top)                                                                        |
| `decimals`            | Digits after the decimal point                                                            | [Number](../generators/number.md#top)                                                                        |
| `oldest` / `youngest` | Birthday age window                                                                       | [Date](../generators/date.md#top)                                                                            |
| `format`              | Date output format                                                                        | [Date](../generators/date.md#top)                                                                            |
| `from` / `to`         | Range endpoints, given separately                                                         | [Date](../generators/date.md#top)                                                                            |
| `precision`           | Step size for a date-time range                                                           | [Date](../generators/date.md#top)                                                                            |
| `range`               | Date range for `date.range`                                                               | [Template](../generators/template.md#top)                                                                    |

## Statistical shape

| Attribute        | What it sets                             | See                                                      |
| :--------------- | :--------------------------------------- | :------------------------------------------------------- |
| `distribution`   | Named distribution (`normal`, `zipf`, …) | [Distributions](../guides/statistical-distributions.md#top) |
| `min` / `max`    | Clip the drawn values to a range         | [Distributions](../guides/statistical-distributions.md#top) |
| `missing`        | Share of rows left empty                 | [Missing data](../guides/missing-data.md#top)               |
| `missing_as`     | How an empty cell is written             | [Missing data](../guides/missing-data.md#top)               |
| `anomaly`        | Share of rows turned into outliers       | [Anomalies](../guides/anomalies.md#top)                     |
| `anomaly_factor` | How far an outlier is pushed             | [Anomalies](../guides/anomalies.md#top)                     |
| `anomaly_flag`   | Answer column that marks the outliers    | [Anomalies](../guides/anomalies.md#top)                     |

**Each distribution takes its own parameters**, and they are only read when
`distribution=` names that one. Every distribution also accepts `decimals`, `min`
and `max`. Each is explained, with a histogram, on the
[distributions guide](../guides/statistical-distributions.md#top).

| `distribution=` | Parameters        | What they mean                                                                          |
| :-------------- | :---------------- | :-------------------------------------------------------------------------------------- |
| `normal`        | `mean` `sd`       | The centre and the spread                                                               |
| `lognormal`     | `meanlog` `sdlog` | The centre and spread **of the logarithm** — the value itself is skewed right           |
| `exponential`   | `rate`            | Events per unit of time; the mean is `1/rate`                                           |
| `pareto`        | `alpha` `xmin`    | Tail thickness, and the smallest possible value                                         |
| `weibull`       | `shape` `scale`   | `shape` below 1 = early failures, above 1 = wear-out; `scale` sets the typical lifetime |
| `poisson`       | `lambda`          | Average count per interval (capped at 700)                                              |
| `zipf`          | `n` `s`           | How many ranks, and how steeply they fall off                                           |
| `gamma`         | `shape` `scale`   | Total wait for `shape` events that each take `scale` on average                         |
| `beta`          | `alpha` `beta`    | Pull toward 1 and toward 0 — the result is between 0 and 1                              |

## Timeseries

| Attribute   | What it sets                 | See                                        |
| :---------- | :--------------------------- | :----------------------------------------- |
| `base`      | Starting level of the series | [Timeseries](../generators/timeseries.md#top) |
| `trend`     | Drift per step               | [Timeseries](../generators/timeseries.md#top) |
| `period`    | Length of one seasonal cycle | [Timeseries](../generators/timeseries.md#top) |
| `amplitude` | Height of the seasonal swing | [Timeseries](../generators/timeseries.md#top) |
| `peak_at`   | Which row the seasonal wave peaks on | [Timeseries](../generators/timeseries.md#top) |
| `noise`     | Random jitter added on top   | [Timeseries](../generators/timeseries.md#top) |

## Pattern (a drawing as the source)

| Attribute         | What it sets                                         | See                                  |
| :---------------- | :--------------------------------------------------- | :----------------------------------- |
| `points`          | Inline `x,y` pairs instead of a file                 | [Pattern](../generators/pattern.md#top) |
| `upper` / `lower` | Two boundary curves — a corridor                     | [Pattern](../generators/pattern.md#top) |
| `mode`            | `signal` (a trajectory) / `density` (a distribution) | [Pattern](../generators/pattern.md#top) |
| `y_range`         | `min..max` — the vertical scale                      | [Pattern](../generators/pattern.md#top) |
| `interp`          | `linear` / `smooth` / `step` between points          | [Pattern](../generators/pattern.md#top) |
| `spread`          | Widen the line into a band of ±N                     | [Pattern](../generators/pattern.md#top) |
| `ink_threshold`   | How dark a PNG pixel has to be to count as ink       | [Pattern](../generators/pattern.md#top) |

`mode` is really two different attributes that share a name: on `<env>` it picks the
engine family; on a `pattern` generator it picks what you're asking the drawing for.

## Files & CSV

| Attribute   | What it sets                       | See                                          |
| :---------- | :--------------------------------- | :------------------------------------------- |
| `src`       | Path to a data file                | [File](../generators/file.md#top)               |
| `column`    | CSV column (name or number)        | [File](../generators/file.md#top)               |
| `header`    | Skip the first CSV row             | [File](../generators/file.md#top)               |
| `delimiter` | CSV separator                      | [File](../generators/file.md#top)               |
| `row`       | Linked-row key                     | [File](../generators/file.md#top)               |
| `weight`    | Frequency column for weighted rows | [Coherent data](../guides/coherent-data.md#top) |

## HTTP service

| Attribute  | What it sets                                            | See                                    |
| :--------- | :------------------------------------------------------ | :------------------------------------- |
| `src`      | Service URL (the same attribute as the file path above) | [HTTP service](../generators/http.md#top) |
| `in`       | Sequence whose value is sent with each row              | [HTTP service](../generators/http.md#top) |
| `on_error` | `fail` (default) or `empty` when a request fails        | [HTTP service](../generators/http.md#top) |
| `timeout`  | Seconds to wait for a response (default 30)             | [HTTP service](../generators/http.md#top) |

## Output & formatting

| Attribute              | What it sets                               | See                                                           |
| :--------------------- | :----------------------------------------- | :------------------------------------------------------------ |
| `if`                   | Display condition (an expression)          | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `pair`                 | Paired marker for a literal `</data>`      | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `mask`                 | Display mask (`x`/`w`/`*`)                 | [Masks & case](../guides/masks-and-case.md#top)                  |
| `case`                 | Letter case (`upper`/`lower`/…)            | [Masks & case](../guides/masks-and-case.md#top)                  |
| `order`                | Value order (`random` / `sequential`)      | [Generators](../generators/overview.md#top)                      |
| `cycle`                | With `sequential`: cycle or raise an error | [Generators](../generators/overview.md#top)                      |
| `repeat` / `separator` | Several values in one cell                 | [Multiple values](../constructs/multiple-values.md#top)          |
| `each`                 | Repeat a line for each list element        | [Relational tables](../constructs/relational-tables.md#top)      |
| `flag`                 | Answer column that marks `<mix>` outliers  | [Mix](../constructs/mix.md#marking-outliers-with-flag)       |

---

← Previous: [Tags](./tags.md#top) · **[Contents](../README.md#top)** · Next: [Generators](./generators.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/attributes)**
