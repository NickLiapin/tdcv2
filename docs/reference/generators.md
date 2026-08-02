<a name="top"></a>

**English** · [Русский](../ru/reference/generators.md#top) · [Español](../es/reference/generators.md#top)

← Previous: [Attributes](./attributes.md#top) · **[Contents](../README.md#top)** · Next: [Compute functions](./compute.md#top) →

---

# Generators reference

Every `type` for [`<gen>`](../generators/overview.md#top). Each one links to its full page.

| `type`                                        | Produces                                                     |
| :-------------------------------------------- | :---------------------------------------------------------- |
| [`text`](../generators/text.md#top)              | A value from a set — uniform or by exact `percent`          |
| [`number`](../generators/number.md#top)          | An integer in a range, or a fixed-width digit string        |
| [`template`](../generators/template.md#top)      | Built-in realistic data and technical IDs                   |
| [`file`](../generators/file.md#top)              | Values from your own files and CSV columns                  |
| [`date`](../generators/date.md#top)              | A date or date-time in a range and format                   |
| [`symbol`](../generators/symbol.md#top)          | A string of characters from a set or named alphabet         |
| [`regex`](../generators/regex.md#top)            | A string matching a finite regular expression               |
| [`advanced_regex`](../generators/advanced-regex.md#top) | Regex, plus weighted choice between alternatives     |
| [`increment` / `decrement`](../generators/counters.md#top) | Rising and falling counters                       |
| [`timeseries`](../generators/timeseries.md#top)  | A time series — trend + seasonality + noise                 |
| [`pattern`](../generators/pattern.md#top)        | A distribution shaped like a drawn curve                    |
| [`http`](../generators/http.md#top)              | A value fetched over HTTP from a service you wrote           |
| [`pool`](../pools/overview.md#top)             | One whole member of a `<pool>` — a record, not a value       |
| [`running`](../generators/running.md#top)      | A total accumulated down the column, not drawn              |

## Cross-cutting attributes

These work on **any** generator (see [Masks & case](../guides/masks-and-case.md#top)):

- `case=` / `mask=` — letter case and display masks.
- `missing=` — leave a share of the cells blank.

The next two only work when the generator produces something they can act on. Everywhere
else they're ignored:

- `order=` / `cycle=` — value order: random by default, or `sequential`. Ordering walks a
  list, so it applies to [`text`](../generators/text.md#top) and
  [`file`](../generators/file.md#top). A [`number`](../generators/number.md#top) or a
  [`date`](../generators/date.md#top) draws from a range rather than a list, so it ignores
  the attribute.
- `anomaly=` — push a share of the values out of range by multiplying them. The rule is
  about the **value**, not the generator: anything that reads as a number is multiplied,
  including a numeric string from [`text`](../generators/text.md#top),
  [`file`](../generators/file.md#top) or a pack. Anything else — a name, a city — passes
  through unchanged and **without a warning**, because there is no "further out" for it.
  See [Anomalies & missing values](../guides/anomalies.md#top).

See also the [Generators overview](../generators/overview.md#top).

---

← Previous: [Attributes](./attributes.md#top) · **[Contents](../README.md#top)** · Next: [Compute functions](./compute.md#top) →
