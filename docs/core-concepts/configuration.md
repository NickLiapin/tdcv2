<a name="top"></a>

**English** · [Русский](../ru/core-concepts/configuration.md#top) · [Español](../es/core-concepts/configuration.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/core-concepts/configuration)**

← Previous: [Editor support](../getting-started/editor-support.md#top) · **[Contents](../README.md#top)** · Next: [Sequences](./sequences.md#top) →

---

# Configuration structure

Every TDC config is a single [`<tdc>`](../reference/tags.md#top) root element. It holds two
things: an optional [`<env>`](../reference/tags.md#top) (generation parameters,
[sequences](sequences.md#top), and fixtures) and a **required**
[`<block>`](output-formatting.md#top) (the layout of each output record).

```xml
<tdc version="0.1.0" comment="demo config">
    <env count="5" seed="demo">
        <sequence name="Id">
            <gen type="increment" value="1"/>
        </sequence>
    </env>
    <block>
        <line><data>id=${{Id}}</data></line>
    </block>
</tdc>
```

`./run demo.tdc`

```
id=1
id=2
id=3
id=4
id=5
```

The `<block>` ran exactly `count="5"` times, and on each pass `${{Id}}` picked up the
next value from the `Id` [sequence](sequences.md#top).

> [!NOTE]
> **Outputs are illustrative**
>
> The terminal outputs on this page are examples — the exact values can differ by core
> version. What's stable is the shape: a fixed `seed` reproduces the same records byte
> for byte (see [Determinism](determinism.md#top)).

## `<tdc>` — the root

A file has exactly one `<tdc>`, and it has to be the root. A document without one fails
with `error[TDC001]: document has no <tdc> root element`. It holds an optional `<env>`
(covered below) and a required [`<block>`](output-formatting.md#top).

| Attribute          | Required | What it does                                                    |
| :----------------- | :------- | :-------------------------------------------------------------- |
| `version` / `v`    | no       | Minimum DSL version the file needs                              |
| `regex_max_length` | no       | Global length cap for [`type="regex"`](../generators/regex.md#top) |
| `comment`          | no       | Free-form comment, ignored by the engine                        |

### `version` (alias `v`)

Declares the minimum DSL version the file relies on. If `version` — or its short alias
`v` — is higher than the running engine's version, the file is rejected outright: a
newer DSL may use [generators](../generators/overview.md#top), conditions, or syntax the
older engine doesn't understand, and quietly producing wrong data would be worse than
stopping. Use it when a config depends on a feature added in a specific release and you
want an out-of-date engine to fail clearly instead of confusingly.

<!-- doc-check: skip the error's location line embeds a machine temp path -->

```xml
<tdc version="9.9.9">
    <block><line><data>hello</data></line></block>
</tdc>
```

`./run future.tdc`

```
error[TDC005]: TDC document version "9.9.9" is newer than this runtime (0.1.0)
note: Update TDC before processing this file; newer DSL features may not exist in this runtime.
```

Leaving the version off is still allowed, so older configs keep working.

### `regex_max_length`

A global ceiling (default **32**) on how long any [`type="regex"`](../generators/regex.md#top)
result can get. A pattern that could exceed it is rejected **before** generation, so one
runaway quantifier can't quietly produce a megabyte per row. Set it on `<tdc>` when
several long patterns share one config and you want a single place to raise the ceiling.

```xml
<tdc regex_max_length="64">
    <env count="3" seed="demo">
        <sequence name="Token"><gen type="regex" value="[A-Z0-9]{40}"/></sequence>
    </env>
    <block>
        <line><data>${{Token}}</data></line>
    </block>
</tdc>
```

`./run token.tdc`

```
MURI40FXS16A2ABROOBQFGMSDBLWP3TCDTA16VVK
NPJ3PVSU1NGARTRDQHT92IHGWJZVUST4531IOEAW
66WWVKTAA2XWUQJBJA8P0SNZ6W3Q75R3CP12JIXW
```

Without the raised cap, the same pattern fails before a single row is generated — the
default ceiling is 32:

`./run token.tdc   (no regex_max_length)`

```
error[TDC097]: invalid regex generator pattern: regex can produce 40 characters, which exceeds regex_max_length=32
 --> token.tdc:3:57
  |
3 |         <sequence name="Token"><gen type="regex" value="[A-Z0-9]{40}"/></sequence>
  |                                                         ^^^^^^^^^^^^
  |
note: Use finite regex: bounded quantifiers such as {n} or {n,m}; unbounded *, +, and {n,} are rejected.

aborted: 1 error
```

Raising the cap only lets an already-finite result run longer — it never makes an
infinite pattern finite. The full treatment is on the
[Regex generator](../generators/regex.md#top) page.

### `comment`

A free-form note for whoever reads the config next. The engine ignores it completely and
it never reaches the output. Use it to record what a file is for, or who owns it.

```xml
<tdc comment="seed accounts for the staging import">
    <env count="2" seed="demo">
        <sequence name="Id"><gen type="increment" value="100"/></sequence>
    </env>
    <block><line><data>acct-${{Id}}</data></line></block>
</tdc>
```

`./run accounts.tdc`

```
acct-100
acct-101
```

### The `<block>` is required

`<block>` describes the layout of one record, and it's the one child `<tdc>` can't do
without. A config with an `<env>` but no `<block>` has nothing to render:

`./run no-block.tdc`

```
error[TDC002]: <tdc> has no <block> child — nothing to render
```

## `<env>` — parameters, sequences, fixtures

`<env>` (short for _environment_) holds the generation parameters, the
[sequence](sequences.md#top) declarations, and fixtures — text printed before, after, or
between records. It's optional: if all you need is one fixed line repeated `count`
times, leave it out. But as soon as you want sequences, parameters, or fixtures, this
is where they go.

| Attribute | Default  | What it sets                                                    |
| :-------- | :------- | :-------------------------------------------------------------- |
| `count`   | `10`     | How many records to generate                                    |
| `seed`    | random   | Seed for the random number generator                            |
| `local`   | `en`     | Locale for [`type="template"`](../generators/template.md#top) data |
| `inject`  | `${{%}}` | The interpolation pattern for values                            |
| `comment` | —        | Free-form comment, ignored by the engine                        |

> [!NOTE]
> **CLI overrides win**
>
> `--count`, `--seed`, and `--locale` on the command line override the values in
> `<env>`, so the same file can drive different volumes of data. See the
> [CLI reference](../reference/cli.md#top).

### `count`

How many times the [`<block>`](output-formatting.md#top) is rendered — one record per pass.
It defaults to **10**. Use it to size a dataset, and override it per run with `--count`
when you want a quick 3-row smoke test out of a config that normally produces thousands.

```xml
<env count="3" seed="demo">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
</env>
```

`./run ids.tdc`

```
id=1
id=2
id=3
```

For most generators a short run is a prefix of a long one: the three rows you get from
`count="3"` are the first three rows of `count="1000"`. Exact-proportion and uniqueness
layouts are the exception, and [Determinism & proportions](determinism.md#top) explains why.

### `seed`

Pins the random number generator so a config is **reproducible**: the same seed and the
same config always produce exactly the same records. Use it whenever a dataset has to be
stable: a snapshot test, a shared fixture, a bug report. Leave it out and every run is
different, and you lose any way to get a particular output back.

```xml
<env count="3" seed="demo" local="en">
    <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
</env>
```

Run it twice — byte for byte identical:

`./run names.tdc   (run 1  |  run 2)`

```
Robert     Robert
John       John
James      James
```

Change the seed and you get a different set that's just as stable. The full story,
including the cross-language guarantee, is in
[Determinism & proportions](determinism.md#top).

### `local` — the data locale

Sets the locale the [`template`](../generators/template.md#top) generator uses when it
resolves names, cities, and other localized data. It defaults to **en**, which is why
the examples above produce English names with no extra configuration.

```xml
<env count="3" seed="demo" local="en">
    <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
</env>
```

`./run names.tdc  (local=en)`

```
Robert
John
James
```

Switching the locale is how you get the same layout in another language, which makes it
an easy way to demo localization. With `local="ru"` the identical config draws from the
Russian name pack instead:

`./run names.tdc  (local=ru)`

```
Владимир
Сергей
Александр
```

Only the _data_ changes — the structure, the seed behavior, and everything else stay
exactly the same. Which locales you have available depends on the installed
[data packs](../data-packs/overview.md#top).

### `inject` — the interpolation marker

Sets the token that marks a value substitution inside [`<data>`](output-formatting.md#top).
It defaults to `${{%}}`, where the `%` stands in for the sequence name. Change it when
the output itself has to contain a literal `${{...}}` — a CI config, a Handlebars
template, another TDC file — so your markers and the target's don't collide.

A `%` is the hole only where it has **text on both sides**, and a marker has exactly one hole.
That is why `inject="%{%}%"` is fine — only its middle `%` qualifies, so the name goes between
`%{` and `}%` and the outer two are literal text. It is also why `inject="[%]-[%]"` is refused
([`TDC021`](../reference/errors.md#top)): two `%` qualify there, the engine would read the
rightmost, and the other would survive as a literal `%` your text does not contain — so nothing
would be substituted and nothing would be said. Repeat the name in the `<data>` instead.

```xml
<env count="2" seed="demo" inject="[%]">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
</env>
<block>
    <line><data>id=[Id]</data></line>
</block>
```

`./run bracket.tdc`

```
id=1
id=2
```

Only the substitution syntax changes, not the data. There's more on interpolation in
[Output & formatting](output-formatting.md#top).

### `comment`

Same as on `<tdc>`: a free-form note the engine ignores. Use it to record why a
particular `seed` or `count` was chosen, right next to the parameters themselves.

### Sequences

`<env>` is where [`<sequence>`](sequences.md#top) declarations go — each one a named
column of values feeding the output block. They get their own page:
**[Sequences](sequences.md#top)**.

### Fixtures — text around the records

Fixtures are text slots printed around the generated records: banners, separators, and
per-line wrappers. They let a single config emit a complete file — a JSON array with its
`[` and `]`, a CSV with a header row — instead of just the bare records.

| Fixture             | Prints                               |
| :------------------ | :----------------------------------- |
| `<before>`          | Once, before the whole run           |
| `<after>`           | Once, after the whole run            |
| `<before_block>`    | Before each record                   |
| `<after_block>`     | After each record                    |
| `<delimiter_block>` | Between records (not after the last) |
| `<before_line>`     | Before each line of a record         |
| `<after_line>`      | After each line of a record          |
| `<delimiter_line>`  | Between the lines of a record        |

```xml
<tdc>
    <env count="3" seed="demo">
        <before><line><data>[</data></line></before>
        <after><line><data>]</data></line></after>
        <delimiter_block><line><data>,</data></line></delimiter_block>
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
    </env>
    <block>
        <line><data>  {"id": ${{Id}}}</data></line>
    </block>
</tdc>
```

`./run array.tdc`

```
[
  {"id": 1}
,
  {"id": 2}
,
  {"id": 3}
]
```

The `[` and `]` each printed once, and the comma landed **between** records but not
after the last one — valid JSON. Interpolation **does** run inside a fixture: a `${{...}}`
there reads the record the fixture stands beside — `<before>` the first, `<after>` the
last, a delimiter the one before it. The record-side details are on
[Output & formatting](output-formatting.md#fixtures--text-around-the-records).

### Declaration order matters

A child [sequence](sequences.md#top) — one with `parent="…"` — has to be declared **after**
its parent in `<env>`. The engine resolves dependencies top to bottom, so a child that
comes first has no parent to filter against. The full model is in
**[Hierarchical dependencies](../guides/hierarchical-dependencies.md#top)**.

### `<env>` cannot be self-closing

Writing `<env … />` is error `TDC014`:

`./run selfclose.tdc`

```
error[TDC014]: <env/> cannot be self-closing — its attributes and children would be ignored
```

This guards against a silent-data bug: a self-closing `<env>` used to drop both `count`
and `seed`, so a config that asked for three seeded records quietly produced ten on a
random seed instead. Always write the full `<env> … </env>` form.

## Next

- **[Sequences](sequences.md#top)** — declaring the columns of your data.
- **[Output & formatting](output-formatting.md#top)** — `<block>`, `<line>`, `<data>`, and `${{…}}`.
- **[Determinism & proportions](determinism.md#top)** — `seed`, `count`, and `percent`.

---

← Previous: [Editor support](../getting-started/editor-support.md#top) · **[Contents](../README.md#top)** · Next: [Sequences](./sequences.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/core-concepts/configuration)**
