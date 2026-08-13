<a name="top"></a>

**English** · [Русский](../ru/reference/generators.md#top) · [Español](../es/reference/generators.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/generators)**

← Previous: [Attributes](./attributes.md#top) · **[Contents](../README.md#top)** · Next: [Compute functions](./compute.md#top) →

---

# Generators reference

Every `type` for [`<gen>`](../generators/overview.md#top). Each one links to its full page.

| `type`                                                  | Produces                                               |
| :------------------------------------------------------ | :----------------------------------------------------- |
| [`text`](../generators/text.md#top)                        | A value from a set — uniform or by exact `percent`     |
| [`number`](../generators/number.md#top)                    | An integer in a range, or a fixed-width digit string   |
| [`template`](../generators/template.md#top)                | Built-in realistic data and technical IDs              |
| [`file`](../generators/file.md#top)                        | Values from your own files and CSV columns             |
| [`date`](../generators/date.md#top)                        | A date or date-time in a range and format              |
| [`symbol`](../generators/symbol.md#top)                    | A string of characters from a set or named alphabet    |
| [`regex`](../generators/regex.md#top)                      | A string matching a finite regular expression          |
| [`advanced_regex`](../generators/advanced-regex.md#top)    | Regex, plus weighted choice between alternatives       |
| [`increment` / `decrement`](../generators/counters.md#top) | Rising and falling counters                            |
| [`timeseries`](../generators/timeseries.md#top)            | A time series — trend + seasonality + noise            |
| [`pattern`](../generators/pattern.md#top)                  | A distribution shaped like a drawn curve               |
| [`http`](../generators/http.md#top)                        | A value fetched over HTTP from a service you wrote     |
| [`pool`](../pools/overview.md#top)                         | One whole member of a `<pool>` — a record, not a value |
| [`running`](../generators/running.md#top)                  | A total accumulated down the column, not drawn         |
| [`stat`](../generators/stat.md#top)                        | One number over the whole run, on every row            |
| [`formula`](../generators/formula.md#top)                  | A column computed from the other columns of its row    |

## Cross-cutting attributes

These work on **any** generator (see [Masks & case](../guides/masks-and-case.md#top)):

- `case=` / `mask=` — letter case and display masks.
- `missing=` — leave a share of the cells blank.

The next two only work when the generator produces something they can act on — and they
part ways on what happens elsewhere: `order=`/`cycle=` are REFUSED, `anomaly=` is about the
value rather than the generator:

- `order=` / `cycle=` — value order: random by default, or `sequential`. Ordering walks
  something, so exactly three generators read it: [`text`](../generators/text.md#top),
  [`file`](../generators/file.md#top) and [`date`](../generators/date.md#top) — a date range is
  walked a step at a time. **On every other type it is refused** ([TDC015](errors.md#top)),
  not ignored: a [`number`](../generators/number.md#top) draws from a range and has no order
  to walk, and neither has a regex, a template, a symbol, a counter, a drawing, a series
  or a statistic.
- `anomaly=` — push a share of the values out of range by multiplying them. The rule is
  about the **value**, not the generator: anything that reads as a number is multiplied,
  including a numeric string from [`text`](../generators/text.md#top),
  [`file`](../generators/file.md#top) or a pack. A non-numeric value beside numeric ones — a
  name in a mixed list — passes through unchanged, because there is no "further out" for
  it. A list with **no** numbers at all is refused ([TDC243](errors.md#top)): nothing there
  could ever be pushed out of range, so the attribute would do nothing on every row.
  See [Anomalies & missing values](../guides/anomalies.md#top).

See also the [Generators overview](../generators/overview.md#top).

---

← Previous: [Attributes](./attributes.md#top) · **[Contents](../README.md#top)** · Next: [Compute functions](./compute.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/generators)**
