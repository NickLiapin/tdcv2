<a name="top"></a>

**English** · [Русский](../ru/reference/errors.md#top) · [Español](../es/reference/errors.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/errors)**

← Previous: [Identifier catalog](./identifiers.md#top) · **[Contents](../README.md#top)** · Next: [Expressions](./expressions.md#top) →

---

# Error codes

Every diagnostic TDC can raise, listed by code. Look one up when a run stops and the
message alone isn't enough.

## How to read a diagnostic

A diagnostic carries four things. The code is the part that never changes between
versions — the wording may improve, but `TDC193` stays `TDC193`:

`./run demo.tdc`

```
error[TDC193]: "Naem" is not a declared sequence — it would be printed literally
 --> demo.tdc:8:11
  |
8 |     <line><data>${{Naem}}</data></line>
  |           ^^^^^^^^^^^^^^^^^^^^^^
  |
help: did you mean "Name"?
note: Declare it in <env>, or set a different inject= pattern if you really want the text ${{…}} in the output.
```

- the **code** — what went wrong, stable across releases;
- the **place** — file, line, and column, with the offending element underlined;
- **`help:`** — a guess at what you meant, when the name is a near miss;
- **`note:`** — what to do about it.

Validation runs before generation, so a config with errors produces no data at all rather
than half a file. Almost every diagnostic here is an **error** and stops the run: if the
config asked for something it wouldn't actually get, TDC refuses rather than handing back
data that looks right but isn't. The exceptions are eleven **warnings** that let the run finish: `TDC136` (a malformed
`<map>` row is skipped and the valid rows still apply), `TDC171` (a pack file whose header
puts it at no address), `TDC200` (a memory estimate that is large but still fits),
`TDC216` (an expression that is always true or always false), `TDC221` (a `<uniq>` or
`<distinct>` group with one member, which constrains nothing), `TDC231` (a `<pool>` nothing
reads), `TDC234` (a pool over
100,000 members), `TDC236` (a `uniq` column past 100,000 rows, which cannot stream — its
second meaning, a pool declared out of order, is an error) `TDC251` (a `percent` share
that asks for less than one row), `TDC272` (a locale that is a fine source of names and
ships no month names, so the dates come out English) and `TDC284` (a `secret=` written into
the config as a literal — a key travels wherever the config does). Each says
as much in its row below.

The numbers run roughly in the order a config is checked — structure first, then
generators, then everything built on top of them — but a number is an identifier, not a
classification. Use the groups below.

## Document structure

| Code     | Fires when                                                        | Fix                                                                                                                                    |
| :------- | :---------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC001` | The file has no `<tdc>` root, **or** it could not be parsed at all — a syntax error, including a closing tag that names another element (`<sequence>…</gen>`) or elements nested deeper than **64 levels**, which no real config reaches and a generated one does | Wrap everything in a single `<tdc>…</tdc>`, or fix the syntax the message points at. Nothing else is checked until the file parses      |
| `TDC002` | `<tdc>` has no `<block>` child                                    | Add the `<block>` that describes one record's layout                                                                                   |
| `TDC003` | Both `version` and `v` are given on `<tdc>`                       | Keep one — they're aliases                                                                                                             |
| `TDC004` | The declared document version isn't a valid version number        | Use a version this runtime supports, e.g. `v="0.1"` (a value newer than the runtime raises `TDC005`)                                   |
| `TDC005` | The file asks for a version newer than this runtime               | Upgrade TDC, or lower the declared version                                                                                             |
| `TDC010` | A tag other than `<env>` or `<block>` sits directly under `<tdc>` | Move it inside one of those two                                                                                                        |
| `TDC013` | A tag is nested somewhere it isn't allowed                        | See [Tags](tags.md#top) for what may contain what                                                                                         |
| `TDC014` | A tag that has to hold children is written self-closing           | Write `<env …></env>`, not `<env …/>` — its children would be silently dropped                                                         |
| `TDC015` | A tag carries an attribute the engine doesn't read                | The run stops, because the config asked for something it wouldn't get. Check the spelling — the message suggests the nearest real name |
| `TDC020` | `count` isn't a non-negative integer                              | `count="1000"`                                                                                                                         |
| `TDC021` | An `inject` pattern has no `%` placeholder                        | The marker needs a `%` for the name, e.g. `inject="[[%]]"`                                                                             |

## Sequences

| Code     | Fires when                                                                                                                               | Fix                                                                                |
| :------- | :--------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------- |
| `TDC030` | A tag that requires a name doesn't have one                                                                                              | Add `name="…"`                                                                     |
| `TDC031` | A sequence name starts with `_`                                                                                                          | That prefix is reserved for [built-ins](builtins.md#top)                              |
| `TDC032` | Two sequences share a name                                                                                                               | Rename one — references to it would be ambiguous                                   |
| `TDC033` | A name collides with a built-in                                                                                                          | Pick another one; built-ins always win                                             |
| `TDC034` | A `parent` value isn't in `Parent.Value` form                                                                                            | Use the two-part form, e.g. `parent="Gender.Male"`                                 |
| `TDC035` | The parent sequence is declared _after_ this one                                                                                         | Move the parent above it — resolution is top-down                                  |
| `TDC214` | `parent=` names a compound sequence                                                                                                      | A parent is filtered by the value it produced, and a group of fields produces none |
| `TDC036` | A `<sequence>` has no `<gen>` inside it                                                                                                  | A sequence needs a generator to produce anything                                   |
| `TDC110` | _retired_ — an unnamed `<gen>` beside a named one now [composes](../core-concepts/sequences.md#a-composed-sequence) rather than failing | —                                                                                  |
| `TDC111` | Two fields of one compound sequence share a name                                                                                         | Rename one                                                                         |
| `TDC129` | A `<sequence>` inside a config-level tag produces nothing usable there                                                                   | See [Sequences](../core-concepts/sequences.md#top)                                    |

## Generators

| Code     | Fires when                                                                                          | Fix                                                                                                                                                                             |
| :------- | :-------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TDC040` | A `<gen>` has no `type`                                                                             | Add `type="…"` — see [Generators](generators.md#top)                                                                                                                               |
| `TDC041` | The `type` is unknown, or isn't supported on an inline `<gen>`                                      | Check the spelling; TDC suggests the nearest name                                                                                                                               |
| `TDC050` | `type="text"` without `value`                                                                       | Give it the list, e.g. `value="a,b,c"`                                                                                                                                          |
| `TDC051` | A `percent` on a value list has more entries than the list has values                               | One percentage per value, e.g. `value="a,b"` with `percent="70,30"`                                                                                                             |
| `TDC052` | A `percent` entry isn't a non-negative number                                                       | Every filled position has to be a number; an empty position splits what's left equally                                                                                          |
| `TDC053` | The `percent` values don't add up to 100                                                            | Adjust them to total 100, or leave a position empty to absorb the remainder                                                                                                     |
| `TDC060` | `type="file"` without `src`                                                                         | Point `src` at the file                                                                                                                                                         |
| `TDC061` | The file can't be read                                                                              | Check the path — it's relative to the config file — or use `--data-path`                                                                                                        |
| `TDC062` | `column` doesn't resolve                                                                            | Use a header name (`column="email"`) or a 1-based index (`column="2"`)                                                                                                          |
| `TDC064` | `row` is used without `column`                                                                      | Row linking needs to know which CSV column to draw from                                                                                                                         |
| `TDC065` | `type="http"` without `src`                                                                         | Point it at the service — `src="http://127.0.0.1:5566/gen"`                                                                                                                     |
| `TDC066` | `src` isn't an http(s) URL                                                                          | Use `http://…` or `https://…`, with a host and a path                                                                                                                           |
| `TDC067` | `in=` names nothing that was declared before it                                                     | The value sent with each row has to come from an earlier `<sequence>`                                                                                                           |
| `TDC068` | `on_error` is neither `fail` nor `empty`                                                            | `fail` (default) stops the run; `empty` blanks the cell                                                                                                                         |
| `TDC069` | `timeout` isn't a positive number of seconds                                                         | `timeout="30"` waits thirty seconds for one answer; omit it for the default of 30                                                                                               |
| `TDC070` | `type="template"` without `value`                                                                   | Give it the dotted address, e.g. `value="person.lastName"`                                                                                                                      |
| `TDC071` | The template address is unknown                                                                     | Check the spelling, or install the pack that provides it                                                                                                                        |
| `TDC072` | `value="date.range"` without `range`, **or** a `type="template"` parameter the pack doesn't declare | Add `range="…"`, or check the parameter name — the message lists the ones the pack accepts                                                                                      |
| `TDC073` | A legacy `range` isn't two valid dates                                                              | Use `YYYY.MM.DD - YYYY.MM.DD`                                                                                                                                                   |
| `TDC081` | A number range is malformed                                                                         | `value="10..99"`                                                                                                                                                                |
| `TDC082` | `first_zero` isn't `true` or `false`                                                                | Those are the only two values                                                                                                                                                   |
| `TDC083` | `length` isn't a count, a range, or a comma-separated list                                          | e.g. `length="8"`, `length="6..9"`, `length="4,6,8"`                                                                                                                            |
| `TDC084` | A `percent` on a numeric `value` has more entries than the range allows                             | One percentage per value                                                                                                                                                        |
| `TDC085` | A `percent` entry on a number isn't a non-negative number                                           | Every filled position has to be a number                                                                                                                                        |
| `TDC086` | The `percent` values on a number don't add up to 100                                                | Adjust them to total 100                                                                                                                                                        |
| `TDC087` | `include`/`exclude` without a numeric range in `value`                                              | They filter a range, so there has to be one                                                                                                                                     |
| `TDC088` | `distribution` is combined with an attribute it rules out                                           | A named distribution shapes the draw on its own                                                                                                                                 |
| `TDC089` | The distribution parameters are wrong                                                               | See [Distributions](../guides/statistical-distributions.md#top)                                                                                                                    |
| `TDC090` | An attribute that has to be a number isn't one                                                      | Check the value                                                                                                                                                                 |
| `TDC095` | `type="regex"` without `value`                                                                      | The pattern goes in `value`                                                                                                                                                     |
| `TDC096` | `regex_max_length` isn't a positive integer                                                         | e.g. `regex_max_length="64"`                                                                                                                                                    |
| `TDC097` | The regex doesn't parse                                                                             | Fix the pattern — the parser's own message follows                                                                                                                              |
| `TDC098` | `type="symbol"` is given both `value` and `alphabet`, or **neither**                                | Give exactly one: an inline set in `value`, or a named `alphabet`                                                                                                               |
| `TDC099` | The named alphabet is unknown                                                                       | See [Symbol](../generators/symbol.md#top)                                                                                                                                          |
| `TDC128` | `type="advanced_regex"` without `value`                                                             | The pattern goes in `value`                                                                                                                                                     |
| `TDC128` | _(second meaning)_ `default=` or `if=` written on a `<case>`                                        | A `<mix>` picks its case by percentage and a `<switch>` by the `is` key — neither asks a condition. For condition-driven values use a `<sequence>` with `<gen if="…">` branches |
| `TDC130` | The advanced pattern doesn't parse                                                                  | See [Advanced regex](../generators/advanced-regex.md#top)                                                                                                                          |
| `TDC244` | `type="pattern"` with no `points`, `src` or `upper`                                                 | A drawing needs a shape to read: `points="0,0 1,5 2,3"`, a file in `src`, or `upper`/`lower` for a band                                                                         |

## Expressions in `if`

| Code     | Fires when                                                                                                              | Fix                                                                                                                                                                                |
| :------- | :---------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC100` | The expression doesn't parse                                                                                            | See [Output & formatting](../core-concepts/output-formatting.md#top)                                                                                                                  |
| `TDC101` | A binary operator isn't supported                                                                                       | Supported: `== != === !== < > <= >= && \|\| + - * /`                                                                                                                               |
| `TDC102` | A unary operator isn't supported                                                                                        | Supported: `!`, `-`, `+`                                                                                                                                                           |
| `TDC103` | The expression uses computed member access                                                                              | Only plain names are allowed                                                                                                                                                       |
| `TDC215` | A name in an `if=` that no sequence has                                                                                 | It reads as its own text: alone the branch always fires, compared it never does                                                                                                    |
| `TDC216` | _(warning)_ `if="Seq.Value"` names a value the sequence never produces                                                  | The branch is dead. A warning, not an error: a list narrowed on purpose is a real thing to write                                                                                   |
| `TDC217` | A template path exists, but not for the run's locale                                                                    | The message names the locale; set `local=` on the `<gen>` or `<env>`, or pick a path your locale ships                                                                             |
| `TDC218` | `uniq="true"` on a sequence with no values of its own — `<compute>` reads other sequences, `if=` picks a branch per row | Put `uniq=` on the sequences it reads, or wrap them in `<uniq>`                                                                                                                    |
| `TDC219` | A `<compute>` and a `<gen>` in the same `<sequence>` — one of them would be dropped                                     | Move the `<compute>` into its own `<sequence>` and read the drawn one with `<field>`                                                                                               |
| `TDC220` | `uniq="true"` on a composed value joining two or more drawn parts                                                       | The parts have no fixed width, so a unique set of parts is not a unique string: `9`+`15` and `91`+`5` are the same three characters. Keep one drawn part, or make the widths fixed |
| `TDC221` | _(warning)_ A `<uniq>` or `<distinct>` around fewer than two `<sequence>`s                                              | A group constrains its members against each other, so one member constrains nothing. Add a second member, or write `uniq="true"` on the sequence itself                            |

## `<pool>`

See [Coherent records](../pools/overview.md#top).

| Code     | Fires when                                                              | Fix                                                                                                                                                                                                                                                       |
| :------- | :---------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TDC222` | A `<pool>` with no `name`, or with no `count`                           | A pool is read by name and holds a fixed number of members: `<pool name="Doctors" count="30">`                                                                                                                                                            |
| `TDC223` | A `<pool count="…">` that is not a whole number of at least 1           | A pool of nothing has no member to hand out                                                                                                                                                                                                               |
| `TDC224` | `<gen type="pool" value="X">` where no `<pool name="X">` is declared    | The message lists the declared pools. Declare it in the same `<env>`                                                                                                                                                                                      |
| `TDC225` | `filter="field == X"` where the two sides can never hold a common value | Both lists are written in the config, and they do not meet — so every row is narrowed to no member at all. The message names both. Only a certain contradiction is reported here; a value that merely comes up rarely is refused at the row that draws it |
| `TDC226` | `filter=` reads `Pool.field` and the pool has no such field             | The message lists the pool's fields. An **unqualified** unknown name is left alone — the expression language reads a bare word as a literal                                                                                                               |
| `TDC229` | `${{Ref}}` where `Ref` draws a whole member                             | A member is a record, not a value. Read a field: `${{Ref.lastName}}`                                                                                                                                                                                      |
| `TDC230` | A `<block>`, a fixture tag, or another `<pool>` inside a `<pool>`       | A pool is a table other columns read, not something written to a file, and pools do not nest                                                                                                                                                              |
| `TDC231` | _(warning)_ A `<pool>` no `<gen type="pool">` reads                     | It is built in full before the first row and kept in memory for the whole run, so an unread one is paid for and thrown away. Read it, or remove it                                                                                                        |
| `TDC232` | A name in `filter=` that is both a field of the pool and a sequence     | Rename one of them. Qualifying one side does not help — the other name still reads as the member's field, so the test compares a value with itself                                                                                                        |
| `TDC234` | _(warning)_ Over 100,000 members                                        | A pool stays in memory for the whole run — about 320 bytes a member with four fields. If you meant the number of ROWS, that is `count` on `<env>`                                                                                                         |
| `TDC235` | Over 1,000,000 members                                                  | Same cause, past the point where it is worth running. Reduce the pool, or move the number to `<env count="…">`                                                                                                                                            |
| `TDC236` | _(warning)_ `uniq="true"` over 100,000 rows                          | Drawing without replacement means remembering what has been drawn, so the whole column stays in memory and the run cannot stream. Measured at about 250 bytes a value — 2,000,000 rows cost about 477 MB. It works; it is worth being deliberate about                                                     |
| `TDC236` | A pool reads a pool declared below it, or itself                        | Pools are built in declaration order, so a pool can only read the pools above it. Move the one it reads up. That order is also why a cycle between pools cannot be written down                                                                           |
| `TDC241` | Two pools declared under one name                                       | A pool is reached by name, so two cannot share one. The second used to replace the first in silence, and the only sign was a `TDC193` in the block about a field that "does not exist"                                                                    |

Three numbers in this range were reserved while pools were being designed and will
stay unused, so the gaps are declared rather than silent:

- **`TDC227`** — `filter=` naming a column that does not exist. A bare word in the
  expression language has always been a string literal, and that is what
  `filter="clinic == North"` uses to say "northern only". A typo and a literal are
  the same thing written down, so the check would put an error on working configs.
  Where the literal is a certain mistake — no member could ever hold that value —
  `TDC225` says so instead, without guessing.
- **`TDC228`** — `${{Pool.field}}` addressing a pool without going through a
  reference. `TDC193` already reports it as a name that resolves to nothing, and a
  second code for the same sentence is not worth the number.
- **`TDC233`** — no candidate passed `filter=` on row N, for expressions richer
  than a simple equality. That refusal happens and is worth having; it just is not
  a diagnostic code. It compares against a value that only exists once the row is
  being built, so it belongs to the run, and the run's message names the row and
  the value that matched nobody.

## Running totals

See [`accumulate=`](../constructs/multiple-values.md#accumulate--a-running-total-across-the-list)
and [`<gen type="running">`](../generators/running.md#top).

| Code     | Fires when                                                                            | Fix                                                                                                                                  |
| :------- | :------------------------------------------------------------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------- |
| `TDC237` | `accumulate=` on a generator with no `repeat=`                                        | There is no list to accumulate. Add `repeat="N"`, or drop `accumulate=`. (`type="running"` is exempt — it accumulates down a column) |
| `TDC238` | `accumulate=` names an operation that does not exist                                  | One of `sum`, `min`, `max`                                                                                                           |
| `TDC239` | `<gen type="running">` does not say what (`of=`) or how (`accumulate=`) to accumulate | A running total reads another column and draws nothing of its own, so both are required                                              |
| `TDC240` | `of=` or `reset=` names a column not declared above                                   | The total is built from a column that already exists — the same rule `parent=` follows                                               |

## `<compute>`

| Code     | Fires when                                                                                                | Fix                                                                                                                                                     |
| :------- | :-------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TDC180` | A tag inside `<compute>` that the compute language does not have, or a predicate written outside `<test>` | The message names the tag. Check it against the [compute reference](../compute/overview.md#top) — a predicate such as `<eq>` is valid only inside `<test>` |
| `TDC181` | `<current>`, `<current_index>`, or `<acc>` is used outside its iteration body                             | They exist only inside a `<do>` (or a `<reduce>`'s `<do>`)                                                                                              |
| `TDC182` | `<use name="X">` names no enclosing `<let>`                                                               | Wrap it in `<let name="X">…</let>`, or fix the name                                                                                                     |
| `TDC183` | A compute op that takes exactly two operands got another number | Only `<divide>` and `<mod>` are binary — a third operand has no meaning there. `<add>`, `<subtract>` and `<multiply>` are variadic: `<add>` over three operands sums all three, and over none it is `0` (`<multiply>` is `1`) |
| `TDC184` | `<choose>` has no `<otherwise>` branch                                                                    | Add `<otherwise>` — every record needs an answer                                                                                                        |
| `TDC185` | A `<let name="X">` shadows an outer binding of the same name                                              | Rename one — the inner binding would hide the outer one                                                                                                 |
| `TDC186` | `<encode>`: unknown encoding                                                                              | One of: `base36`, `ascii`, `unicode`, `hex`, `binary`, `octal`                                                                                          |
| `TDC187` | A predicate is missing its wrapper child                                                                  | `<when>` wants `<test>`, `<choose>` wants `<then>` — the message names the pair                                                                         |
| `TDC188` | `<int v="…">` isn't a whole number                                                                        | Write a whole number; for text, use `<str v="…"/>`                                                                                                      |
| `TDC189` | `<compute>` has more than one `<result>`                                                                  | Keep a single `<result>` — the earlier ones would be dropped                                                                                            |

## `<mix>`, `<switch>`, fixtures

| Code     | Fires when                                                                                                 | Fix                                                         |
| :------- | :--------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------- |
| `TDC120` | `<mix>` has no `<case>`                                                                                    | A mix needs branches to pick between                        |
| `TDC121` | A `percent` on a `<mix>`/`<switch>` has more entries than there are cases                                  | One percentage per case                                     |
| `TDC122` | A `percent` entry on a `<mix>`/`<switch>` isn't a non-negative number                                      | Every filled position has to be a number                    |
| `TDC123` | The `percent` values on a `<mix>`/`<switch>` don't add up to 100                                           | Adjust them to total 100                                    |
| `TDC124` | `<mix>` has a child that isn't a `<case>`                                                                  | Only `<case>` belongs there                                 |
| `TDC125` | `<case>` has an unknown child                                                                              | Allowed: `<data>`, `<gen>`, `<mix>`, `<switch>` — a nested `<switch>` inside a branch is a first-class construct (see TDC245) |
| `TDC131` | A fixture holds a tag it does not accept, or a `<data>` with no `<line>` around it                          | A fixture body is made of `<line>`s. A bare `<data>` used to validate and render nothing at all |
| `TDC132` | A tag that doesn't belong there sits inside `<line>`                                                       | The output block is for layout — generators live in `<env>` |
| `TDC133` | `<switch>` has no `on`                                                                                     | Name the sequence being switched on                         |
| `TDC134` | `on` names a sequence, or a field of one, that doesn't exist                                               | Check the name — the message says which half is wrong       |
| `TDC135` | `<switch>` has no entries                                                                                  | Add a `<map>`, `<case>`, or `<default>`                     |
| `TDC136` | _(warning)_ A `<map>` row isn't `KEY:VALUE` — the bad row is skipped and the rest of the map still applies | One pair per entry, separated by a colon                    |
| `TDC137` | A `<case>` inside `<switch>` has no `is`                                                                   | `is` is the branch key                                      |
| `TDC245` | `name` on a `<switch>` written inside a `<case>` | The nested form contributes a value to that branch; only an env-level `<switch>` becomes a column |

## Dates

| Code     | Fires when                               | Fix                                                                 |
| :------- | :--------------------------------------- | :------------------------------------------------------------------ |
| `TDC150` | Only one of `from` / `to` is given       | Give both endpoints or neither                                      |
| `TDC151` | The date value doesn't parse             | `value="2020-01-01..2025-12-31"`, `"birth"`, `"today"`, `"now"`     |
| `TDC152` | A `format` token is unknown              | See the [token table](../generators/date.md#formatting-the-output) |
| `TDC153` | `local` names a locale with no date data | Built in: `ar`, `de`, `el`, `en`, `es`, `fr`, `it`, `pl`, `pt`, `ru`, `zh-cn`, plus three-letter aliases |
| `TDC154` | `precision` isn't a supported step       | See [precision](../generators/date.md#top)                             |

## While rendering

These are raised during generation rather than validation — the config is well-formed,
but the combination it asks for can't be carried out.

| Code     | Fires when                                                                                      | Fix                                                                                     |
| :------- | :---------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------- |
| `TDC160` | `row="…"` is used on an inline `<gen>`                                                          | Row linking needs a `<sequence>`                                                        |
| `TDC161` | Weighted `advanced_regex` choices are used inline                                               | Exact percentages need the whole column — move it into a `<sequence>`                   |
| `TDC162` | An inline counter's `value` or `step` isn't numeric                                             | `value="1" step="2"`                                                                    |
| `TDC170` | A data-pack file can't be loaded                                                                | The message names the file — see [Writing your own](../data-packs/writing-your-own.md#top) |
| `TDC171` | _(warning)_ A data-pack file lands at no address, so it is skipped                              | Add `address:` or `locale:` to its header, or move it under a locale folder             |
| `TDC200` | _(warning)_ The estimated memory use is a large share of this machine's RAM — the run continues | For very large sets, use `mode="disk"`, which keeps memory flat                         |
| `TDC201` | The estimated memory use is more than this machine's RAM                                        | Lower `count`, batch the run, or use `mode="disk"`                                      |

> [!NOTE]
> **Three of these cannot be reached from a config**
>
> `TDC160`, `TDC161` and `TDC162` describe an inline `<gen>` — one written directly
> inside `<line>` rather than in a `<sequence>`. Validation refuses that shape first, with
> `TDC131` (`a <gen> is not allowed inside <line>`) or `TDC013`, so a real config never gets
> far enough to raise them. They are reachable only through the low-level `render(parse(src).tree)`
> export, which walks an unvalidated tree on purpose. That is also why the four ports do not
> have them: they compile a config into a model that has no place to put such a `<gen>`.

## Formatting and modifiers

| Code     | Fires when                                                       | Fix                                                                      |
| :------- | :--------------------------------------------------------------- | :----------------------------------------------------------------------- |
| `TDC190` | `case` isn't a known transform                                   | `upper`, `lower`, `capitalize`, `title`                                  |
| `TDC191` | `order` is neither `random` nor `sequential`                     | Those are the only two values                                            |
| `TDC192` | An interpolation filter is unknown                               | See [Masks & case](../guides/masks-and-case.md#top)                         |
| `TDC193` | `${{Name}}` or `${{Name.field}}` names nothing that was declared | It would print literally — the whole reference is checked, field and all |
| `TDC194` | A typed `<data>` has no `name`                                   | Only a named `<data>` becomes a column                                   |
| `TDC195` | `repeat` isn't a count or a range                                | `repeat="3"` or `repeat="1..5"` (0 to 64)                                |
| `TDC196` | `repeat` is used on a `<mix>`                                    | A mix picks one branch; it doesn't produce a list                        |
| `TDC198` | `separator` without `repeat`                                     | It joins repeated values, so there have to be some                       |
| `TDC199` | A `mask` index is malformed                                      | Indices are 0-based and ranges use `..` — `x[0..3]`, `w[-1]`             |
| `TDC202` | `flag` is set but no `<case>` is marked `anomaly="true"`         | The column would be all-negative — mark the outlier branch               |
| `TDC203` | `flag` is used on a nested `<mix>`                               | Only a named env-level mix carries the answer column                     |
| `TDC204` | `repeat` is used on a generator that can't repeat                | The message names the type                                               |
| `TDC206` | `each=""` names no sequence                                      | Name the list to walk                                                    |
| `TDC207` | `each` names a single-value sequence                             | It has to be a list — add `repeat` to the source                         |
| `TDC209` | A named `<data>` sits inside an `each=` line                     | That line produces several rows, so a column name is ambiguous           |
| `TDC211` | `weight` is used on a generator other than `file`                | Weights come from a CSV column                                           |
| `TDC212` | `weight` without `column`                                        | The weights live in a second column, which has to be named               |
| `TDC213` | `weight` is combined with `order`                                | `order` walks the rows by position; weighting picks them by frequency    |
| `TDC242` | `anomaly` or `missing` isn't a number in `[0, 1]`                | Both are a SHARE of the values: `anomaly="0.05"`, `missing="0.1"`        |
| `TDC243` | `anomaly` on a `value` list with no number in it                 | An anomaly multiplies a number, so a list of words comes back unchanged  |
| `TDC246` | `anomaly_flag` on a `<gen>` inside a `<case>`                    | A case body is several parts joined, so a flag on one part doesn't describe the row — put `flag="NAME"` on the `<mix>` instead |
| `TDC247` | `step` on a `<gen type="date">` is not a step it can walk, or mixes a calendar unit with a fixed one | Write `15m`, `1h30m`, `2d`, `3mo`, `1y` — units `s`, `m`, `h`, `d`, `w`, `mo`, `y`; a bare number means days |
| `TDC248` | `step` without `order="sequential"` on the same `<gen>`            | Nothing walks the range — the dates are still drawn at random. Add `order="sequential"`, or drop `step` |
| `TDC249` | `weekdays` names a weekday that does not exist                    | sun, mon, tue, wed, thu, fri, sat — a span like `mon..fri` or a list like `sun,wed` |
| `TDC250` | `weekdays` with a step of a whole number of weeks, or a calendar step | Two reasons under one code. A whole number of weeks fixes the weekday, so the filter matches every row or none. A calendar step does the opposite — `1mo` walks Thursday, Sunday, Sunday, Wednesday — so which rows survive would follow the calendar rather than the config |
| `TDC252` | `peak_at` on a `<gen type="timeseries">` is not a number                     | `peak_at` is the row the seasonal wave peaks on, counted like `period` — `peak_at="182"` over `period="365"` puts the peak at the first of July |
| `TDC253` | `peak_at` with no `period` on the same `<gen>`                              | A wave needs a length before it can have a highest point. Add `period`, or remove `peak_at` |
| `TDC251` | _(warning)_ A `percent` share asks for less than one whole row              | `percent` is an exact quota over the rows that reach it, so 10% of a five-row subset asks for half a record. Half a record cannot be emitted: the branch fires once or not at all, and the seed decides which. Raise the share, or raise `count`
| `TDC254` | `repeat=` and `order="sequential"` on the same `<gen>`                       | Keep one. A walked column takes one value per row from its source; a repeating column takes several drawn values. Together the engines disagreed, so the combination is refused rather than answered three ways |
| `TDC255` | `decimals=` together with `include=` or `exclude=`                            | Drop one. A set built by `include`/`exclude` holds whole numbers and the pick is uniform over them, so there is nothing fractional to round — the engine was quietly emitting integers |
| `TDC256` | A mask with no pattern — `<mask>` without `pattern=`, or `${{X\|mask}}` with no argument | Give it a pattern. Without one the mask keeps nothing and returns the empty string, so the column comes out blank |
| `TDC257` | An `if=` expression calls a function that is not there | Either a typo, answered with the near name, or one of `sin`, `cos`, `exp`, `log` and their kin, answered with the reason: every host language computes those slightly differently, and a comparison turns the last bit into a different row. Available today: `abs`, `ceil`, `floor`, `max`, `min`, `round`, `trunc` |
| `TDC258` | A function in an `if=` expression is given the wrong number of arguments | `abs`, `ceil`, `floor`, `round` and `trunc` take exactly one; `min` and `max` take as many as you give them |
| `TDC259` | A `[list]` sits somewhere other than the right of `in` | A list is a set of values to test against, so it only means something as `Country in [US, CA, MX]`. On its own it has no value for the condition to be |
| `TDC260` | `at()` is given something that is not a list | A `repeat` list reaches an expression as its joined text, so `at(Items, 1)` asks for the second element of a one-element list and answers with nothing. Cut it first: `at(split(Items, ","), 1)` |
| `TDC261` | `at()` is given an index that is not one | An index is a whole number, zero or more. Past the end is empty text on purpose — rows made by `repeat="1..4"` have different lengths — but `-1`, `1.5` and `"one"` are mistakes, and each of them used to produce that same blank column |
| `TDC262` | `<gen type="stat">` does not say what (`of=`) or which statistic (`op=`), or names one that does not exist | A statistic reads another column and draws nothing of its own, so both are required. `op=` is one of `sum`, `mean`, `median`, `min`, `max`, `count`, `stddev`; `decimals=` is 0 to 10 |
| `TDC263` | `${{Name}}` in an attribute that does not expand it | Interpolation reaches the text inside `<data>` and `<gen type="template" value=>`, and nowhere else — anywhere else the braces are literal characters. To make one column depend on another, read it in an `if=` condition, or build the value in a `<compute>` sequence |
| `TDC264` | `<gen type="date" of="…">` is written wrong | An offset needs `plus=` (`7d`, `3..10d`, `1..3mo`, `-10..-3d`), written smallest bound first, in a unit `step=` also uses. The attributes that bound the generator's OWN draw — `value`, `from`, `to`, `range`, `oldest`, `youngest`, `order`, `step` — say nothing once `of=` has placed the date relative to another column, so they are refused rather than ignored |
| `TDC265` | `<assert>` has no condition | An assertion is the one construct whose whole worth is that it fails, and without `that=` it never can. Write the property the run must have, in the `if=` language, over whole-run columns |
| `TDC266` | `<assert>` has no message | `says=` is what a reader is told when it fires, months later, in a CI log. An expression on its own leaves them to work out what it was defending |
| `TDC267` | `uniq="true"` together with `mask=`, `case=`, `missing=`, `repeat=`, `separator=` or `anomaly=` | A draw without replacement produces the column directly and never reaches the layer that rewrites values, so the attribute could only ever be dropped. Applying it would break the other promise: a mask maps two distinct draws onto the same characters |
| `TDC268` | `if=` on a `<gen type="pool">` | A reference publishes a whole MEMBER, and a `<gen>` carrying `if=` becomes a conditional branch the pool resolver does not recognise — so no `Ref.field` column was registered and `${{Ref.name}}` reached the output as its own literal text. Use `parent=` to leave rows without a member |
| `TDC269` | `if=` on a `<gen>` inside a `<case>` | A case body is several parts joined into one value, so a condition on one part has no value to fall back to. It was accepted and ignored, and the part appeared on every row — including the ones the condition excluded. Put the condition on the branch: `<case if="…">` |
| `TDC270` | `<tdc>` holds a second `<env>` or `<block>` | Both are read by taking the FIRST of their kind, so a second one is discarded whole — every sequence it declares, every line it lays out — while the run finishes looking healthy. Reported on the second one |
| `TDC271` | `percent=` beside `order="sequential"` | Walking the list in order fixes which value each row gets, so there is no share left to apportion. The percentage was accepted and dropped: `percent="98,1,1"` over a hundred rows came out 34 / 33 / 33 |
| `TDC272` (warning) | `<env local=…>` names a locale with no date translations | The locale is a fine source of NAMES and ships no month names, so the dates render in English. Refused outright on `<gen type="date" local=…>` (TDC153) and silent here until now. Fires only when the format reads the locale — `format="YYYY-MM-DD"` is the same in every language |
| `TDC273` | a filter argument the filter cannot use | `slice:5,2` ends before it starts and empties the column; `slice:abc`, `group:abc`, `group:0`, `compact:1` and `compact:99` leave the value untouched. `group` and `compact` with NO argument keep their documented defaults (3, base 36) |
| `TDC274` | an argument on a filter that reads none | `trim`, `sql`, `upper`, `lower`, `capitalize` and `title` are whole transforms; `${{X\|trim:junk}}` silently ignored the `junk`. Chain instead: `${{X\|trim\|upper}}` |
| `TDC275` | `replace` with nothing to look for | `${{X\|replace}}` and `${{X\|replace:,to}}` change nothing at all. Write both parts: `${{X\|replace:from,to}}` |
| `TDC276` | a pinned pack parameter of the wrong width | An identifier with a check digit has a fixed layout, so a wider or narrower part breaks it rather than shifting it. `usa.finance.aba_routing prefix="12345"` aborted the run; `tail="678"` wrote a six-digit non-number. Only reported where the width can be PROVEN from the pack's own body |
| `TDC277` | `decimals=` with no range to round | Without `value=` the generator produces a digit STRING — an identifier — so there is nothing to round. `<gen type="number" length="4" decimals="2"/>` emitted 4566, 5773, 5192 |
| `TDC278` | `decimals=` beside `length=` | A fractional value has no integer width to pad to, so `length=` was the one discarded: `value="1..9" length="3" decimals="2"` emitted 3.78, 2.89 |
| `TDC279` | `first_zero="false"` the range can never satisfy | Every draw from `0..5` is one digit, so a three-wide rendering always pads. The generator redrew a hundred times per row and emitted the forbidden shape anyway: 005, 002, 003. Only reported where the range PROVES it |
| `TDC280` | two spellings of the same date range | `value=`, the `from`/`to` pair and `range=` say one thing, and the generator reads them in that order and stops. `value="2020-05-05" from="1990-01-01" to="1990-12-31"` produced 1990-05-11 and discarded the rest without a word. `value="today"`, `"now"` and `"birth"` are spellings too |
| `TDC281` | a date range that ends before it starts | The draw took the min and max of the two ends, so `from="2020-01-01" to="2010-01-01"` produced perfectly plausible dates from a range nobody wrote. `plus="10..3d"` has been refused as a typo rather than swapped since it was written; this is the same typo |
| `TDC282` | `order="sequential"` on only some members of a `row=` link                                           | Either give every member of the link `order="sequential"`, or drop it — a mixed link stops reading one line per record                                                          |
| `TDC283` | `anomaly_flag` on a `<gen>` that is only one part of its `<sequence>` | The flag records which ROWS were made outliers, and a sequence built from several parts — a second `<gen>`, a `<data>` literal, or a `name=` that makes this gen a field — has no row-level column to put it in. Move the `<gen>` into a `<sequence>` of its own; that also gives you the value as its own column. The same reasoning as `TDC246`, one level out |
| `TDC284` | `secret=` written into the config, or an empty one | A key in a config travels wherever the config does — into version control with it. `secret="env:TDC_HTTP_SECRET"` reads it from the environment, `secret="file:~/.tdc/service.key"` from a file the repository does not hold. A literal is a WARNING, because a service on 127.0.0.1 for an afternoon is a real use; `secret=""` is an error, because signing with nothing produces a signature anyone could forge |
| `TDC285` | A drawing attribute whose value is not one of its words, or not a number | `mode=`, `interp=`, `spread=` and `decimals=` were read only at render time, so `check` called `mode="banana"` valid and the run then refused it — the one place `check` did not answer "would this run?". Allowed: `mode="signal|density"`, `interp="linear|smooth|step"`, a non-negative `spread=`, a non-negative whole `decimals=` |
| `TDC286` | `<is_digit>` or `<encode>` was handed `<field name="_count">` or `<field name="_total">` | Those two fields arrive as NUMBERS; both tags want one character of text. `<is_digit>` answered "no" on every row — including the rows where the count is a single digit — and `check` said nothing; `<encode>` stopped the run with "expected a single-character string", naming no file and no line, on a config `check` had also called valid. Compare the number with `<equals>` or `<less_than>`, wrap it in `<concat>` for `<encode>`, or put the character you mean into a `<str>` |
| `TDC287` | `<equals>`, `<greater_than>` or `<less_than>` was given a `<str>` literal that is not a number | The three comparisons work on numbers. A `<str>` holding digits is read as the number it spells — `<equals><str v="7"/><int v="7"/></equals>` is true — so only a literal that is not a number is refused. That one used to stop the run with "expected an integer in `<equals>`, got the string …", naming no file and no line, on a config `check` had called valid. Only literals are checked: what a `<field>` will hold is not known before the run |
| `TDC288` | `<var>` — the tag was renamed to `<use>` | It never declared anything: `<let>` binds a name and this reads it back, which is what the new name says. Without a refusal of its own the old spelling fell through to "unknown compute tag", which says the spelling is wrong and not what the right one is. The `name=` attribute is unchanged |

## See also

- [CLI](cli.md#top) — exit codes and flags
- [Tags](tags.md#top) and [Attributes](attributes.md#top) — what's allowed where

---

← Previous: [Identifier catalog](./identifiers.md#top) · **[Contents](../README.md#top)** · Next: [Expressions](./expressions.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/errors)**
