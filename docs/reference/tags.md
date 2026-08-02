<a name="top"></a>

**English** · [Русский](../ru/reference/tags.md#top) · [Español](../es/reference/tags.md#top)

← Previous: [CLI](./cli.md#top) · **[Contents](../README.md#top)** · Next: [Attributes](./attributes.md#top) →

---

# Tags reference

Every tag in the TDC DSL, and where each one is covered in depth.

## Structure

| Tag                 | What it is                                     | See                                                |
| :------------------ | :--------------------------------------------- | :------------------------------------------------- |
| `<!--…-->`          | A comment                                      | —                                                  |
| `<tdc>`             | The root element                               | [Configuration](../core-concepts/configuration.md#top) |
| `<env>`             | The environment: parameters, sequences, fixtures | [Configuration](../core-concepts/configuration.md#top) |
| `<sequence>`        | A named sequence declaration                   | [Sequences](../core-concepts/sequences.md#top)        |
| `<gen>`             | A data generator                               | [Generators](../generators/overview.md#top)           |
| `<data>`            | Inside a `<sequence>`: literal text joined into the sequence's value, or — with a `name` — a constant field | [Sequences](../core-concepts/sequences.md#a-composed-sequence) |
| `<compute>`         | A computed value                               | [Compute Language](../compute/overview.md#top)        |

## Output layout

| Tag                 | What it is                                     | See                                                |
| :------------------ | :--------------------------------------------- | :------------------------------------------------- |
| `<block>`           | The layout of one output record                | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `<line>`            | One line inside a record                       | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `<data>`            | Inside a `<line>`: literal text with interpolation | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `<before>` / `<after>` | Text before / after the whole run           | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `<before_block>` / `<after_block>` / `<delimiter_block>` | Text around / between records | [Output & formatting](../core-concepts/output-formatting.md#top) |
| `<before_line>` / `<after_line>` / `<delimiter_line>` | Text around / between lines    | [Output & formatting](../core-concepts/output-formatting.md#top) |

## Distributions and choice

| Tag                 | What it is                                              | See                                                |
| :------------------ | :----------------------------------------------------- | :------------------------------------------------- |
| `<mix>`             | A distribution: a value split by exact percentages     | [Distributions (mix)](../constructs/mix.md#top)           |
| `<switch>`          | A lookup table: a value picked by key                  | [Lookup tables (switch)](../constructs/switch.md#top)     |
| `<map>`             | A compact `KEY:VALUE` table inside `<switch>`          | [Lookup tables (switch)](../constructs/switch.md#top)     |
| `<case>`            | One branch inside `<mix>` or `<switch>`                | [Distributions (mix)](../constructs/mix.md#top) · [Lookup tables (switch)](../constructs/switch.md#top) |
| `<default>`         | The "else" branch inside `<switch>`                    | [Lookup tables (switch)](../constructs/switch.md#top)     |

## Whole records

| Tag                 | What it is                                              | See                                                |
| :------------------ | :----------------------------------------------------- | :------------------------------------------------- |
| `<pool>`            | A small table built before the rows; a row draws one whole member from it | [Coherent records (pool)](../pools/overview.md#top) |

## Uniqueness

| Tag                 | What it is                                              | See                                       |
| :------------------ | :----------------------------------------------------- | :---------------------------------------- |
| `<distinct>`        | Fields or sequences that must differ within one row     | [No repeats within a row](../guides/distinct.md#top) |
| `<uniq>`            | A combination of sequences that must be unique across all rows | [Unique values](../constructs/unique-values.md#top) |

`<data>` is listed twice because it reads two ways. Inside a `<line>` it is output:
literal text with `${{…}}` interpolated into it. Inside a `<sequence>` it is data:
bare, it is the glue between the generators of a
[composed sequence](../core-concepts/sequences.md#a-composed-sequence); with a
`name`, it is a [constant field](../core-concepts/sequences.md#a-constant-field) and
the only field that costs no draw.

Compute tags (the ones that go inside `<compute>`) have their own list in the
[Compute functions reference](compute.md#top).

---

← Previous: [CLI](./cli.md#top) · **[Contents](../README.md#top)** · Next: [Attributes](./attributes.md#top) →
