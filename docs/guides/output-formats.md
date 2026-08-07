<a name="top"></a>

**English** · [Русский](../ru/guides/output-formats.md#top) · [Español](../es/guides/output-formats.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/output-formats)**

← Previous: [Reading files & CSV](./files-and-csv.md#top) · **[Contents](../README.md#top)** · Next: [Masks & case](./masks-and-case.md#top) →

---

# Output formats (CSV, JSON, SQL…)

TDC has no fixed list of exporters, and that's deliberate. The
[output block](../core-concepts/output-formatting.md#top) assembles **text** —
[`<before>`](../core-concepts/output-formatting.md#top) / [`<after>`](../core-concepts/output-formatting.md#top)
wrap the whole run, [`<block>`](../core-concepts/output-formatting.md#top) is one record, and
[`<data>`](../core-concepts/output-formatting.md#top) is the raw text — so the same engine
produces CSV, JSON, SQL, YAML, NDJSON, or anything else built from characters.

The price of that freedom is that **you** own the format's syntax rules. TDC doesn't know
you're building JSON, so it won't add a comma, a quote, or a `null` for you — and it won't
add one where you don't want it either. This guide walks through the three most common
formats and the exact spots where each one breaks, then shows how to build any other shape.

> [!NOTE]
> Example outputs below are illustrative — exact values can differ from one core version or
> seed to the next. What matters is the **shape** of each format, not the specific names or
> numbers. Check a generated file with a real parser (`python -m json.tool`, `sqlite3`, a CSV
> reader), never by eye — every break below looks fine at a glance.

## CSV

CSV is the friendliest target: a header once, then one row per record. Two things bite —
where the header goes, and any value that contains the delimiter or a quote.

### The header — once, via `<before>`

A header belongs in [`<before>`](../core-concepts/output-formatting.md#top): it prints exactly
once, above every record, whether `count` is 3 or 3 million.

```xml
<tdc>
    <env count="3" seed="demo">
        <before><line><data>id,name,category</data></line></before>
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
        <sequence name="Name"><gen type="text" value="Pen,Mug,Notebook"/></sequence>
        <sequence name="Cat"><gen type="text" value="Office,Kitchen,Office"/></sequence>
    </env>
    <block>
        <line><data>${{Id}},${{Name}},${{Cat}}</data></line>
    </block>
</tdc>
```

`./run out.tdc -o out.csv`

```
id,name,category
1,Notebook,Office
2,Mug,Office
3,Pen,Kitchen
```

Putting the header in `<block>` would repeat it on every row; putting it in `<before>`
prints it once. Use `<after>` the same way for a trailing summary line or a closing marker.

### `csv` — a value with a comma or a quote

**Problem.** A product name like `Knife set, 3 pcs` contains the field separator. Written
plainly, that comma becomes a **column break**: the row grows an extra field, categories
slide into prices, and — worst of all — the file still opens without an error. The damage
only shows up when a program reads it back.

```xml
<block>
    <line><data>${{Id}},${{Name}},${{Cat}},${{Price}}</data></line>
</block>
```

`./run out.tdc (a comma inside a value)`

```
# looks fine to the eye:
7,"Knife set, 3 pcs",Kitchen,32.00

# what a CSV reader actually sees — 5 fields, not 4:

7 | Knife set | 3 pcs | Kitchen | 32.00
```

**Tool.** The [`csv`](masks-and-case.md#top) filter wraps a field in quotes and doubles any
inner quote — exactly what RFC 4180 asks for. It quotes every field you put it on, not
just the ones that would break without it; a quoted field is always valid CSV, and a
reader can't tell the difference. Put it on **every** text field that comes from outside
your config:

```xml
<block>
    <line><data>${{Id}},${{Name | csv}},${{Cat}},${{Price}}</data></line>
</block>
```

`./run out.tdc -o out.csv`

```
id,name,category,price
7,"Knife set, 3 pcs",Kitchen,32.00
8,"Coffee ""Arabica"" 250g",Grocery,5.40
9,"Mug",Kitchen,4.10
```

The commas and quotes now live safely inside quoted fields; a reader gets four columns on
every row. **Use it when** any value could carry a comma, a quote, or a newline — which is
almost always true of names, titles, and street addresses pulled from a real
[data file](files-and-csv.md#top).

### A different delimiter

The separator is just a character you type. Want semicolons (common when the values already
contain commas) or tabs? Change the literal text in `<data>` and in the header to match —
there's no mode to switch.

```xml
<env count="3" seed="demo">
    <before><line><data>id;name;category</data></line></before>
    <!-- the Id / Name / Cat sequences, unchanged -->
</env>
<block><line><data>${{Id}};${{Name}};${{Cat}}</data></line></block>
```

`./run out.tdc -o out.csv (semicolon-delimited)`

```
id;name;category
1;Pen;Office
2;Mug;Kitchen
```

(The [`delimiter`](files-and-csv.md#top) attribute is a separate thing — it tells the
[`file`](../generators/file.md#top) generator how to **read** an input CSV. On the output side
you write the character you want.)

## JSON

JSON has no "mode" in TDC either — it's text, same as CSV. But it has four syntax rules
that a plain text assembler will happily break. Here are all four, and the fix for each.

### An array with no trailing comma

**Problem.** Three objects aren't JSON until something joins them into an array. The
obvious move — a comma at the end of each object — puts a comma **after the last one** too,
and every parser rejects it:

`python -m json.tool users.json`

```
  "age": 21
},
]
JSONDecodeError: Expecting value: line 17 column 1
```

**Two clean fixes.**

The first one uses a condition. A second [`<data if="!_last">`](../core-concepts/output-formatting.md#top)
prints a comma on every record **except** the last — `_last` is the built-in "final record"
flag — so the JSON closes cleanly:

```xml
<tdc>
    <env count="3" seed="demo">
        <before><line><data>[</data></line></before>
        <after><line><data>]</data></line></after>
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
        <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
    </env>
    <block>
        <line><data>  {"id": ${{Id}}, "name": "${{Name}}"}</data><data if="!_last">,</data></line>
    </block>
</tdc>
```

`./run out.tdc -o out.json`

```
[
  {"id": 1, "name": "Robert"},
  {"id": 2, "name": "John"},
  {"id": 3, "name": "James"}
]
```

The second one uses a dedicated fixture. [`<delimiter_block>`](../core-concepts/output-formatting.md#top)
prints its text **between** records — `count - 1` times, never after the final one — which
is exactly what "a comma between array elements" means:

```xml
<env count="3" seed="demo">
    <before><line><data>[</data></line></before>
    <delimiter_block><line><data>,</data></line></delimiter_block>
    <after><line><data>]</data></line></after>
    ...
</env>
```

Use `if="!_last"` when the comma rides on the same line as the object; reach for
`<delimiter_block>` when a record spans several lines and the separator needs a line of its
own. A comma alone on a line looks odd, but it's valid JSON — newlines between array
elements mean nothing. Run the file through `jq .` if you want it pretty-printed.

### Quotes are yours to place

Notice the quotes above: `"${{Name}}"` has them, `${{Id}}` doesn't. TDC knows nothing about
JSON types — you place the quotes, and that's what keeps a number a number and a string a
string.

```xml
<line><data>  "id": ${{Id}}, "zip": "${{Zip}}", "age": ${{Age}}</data></line>
```

`./run out.tdc`

```
  "id": 1, "zip": "07105", "age": 34
```

`zip` is quoted on purpose: a postal code isn't a number (you never do arithmetic on it,
and a leading zero would vanish). `id` and `age` stay bare so they parse as integers.

### Nesting is just more lines

A nested object needs no special syntax — it's a few more `<data>` lines with the right
braces and indentation:

```xml
<line><data>  "address": {</data></line>
<line><data>    "city": "${{City}}",</data></line>
<line><data>    "zip": "${{Zip}}"</data></line>
<line><data>  },</data></line>
```

`./run out.tdc`

```
  "address": {
    "city": "Chicago",
    "zip": "60614"
  },
```

### An array inside an object

Several values in one field come from [`repeat`](../reference/attributes.md#top), and
[`separator`](../reference/attributes.md#top) is what goes between them. JSON wants `", "` —
**with the quotes** — and here you hit a wall: the grammar won't let you put a `"` inside an
attribute value, and `&quot;` passes straight through as literal text.

The way around it is to separate the values with a neutral character they never contain,
then turn that into JSON with the [`replace`](masks-and-case.md#top) filter, where quotes
**are** allowed:

```xml
<sequence name="Tags">
    <gen type="text" value="sale,new,gift,vip" repeat="1..3" separator="~"/>
</sequence>
```

```xml
<line><data>  "tags": ["${{Tags | replace:~,", "}}"],</data></line>
```

`./run out.tdc`

```
  "tags": ["vip"],
  "tags": ["sale", "gift"],
  "tags": ["gift", "vip", "new"]
```

For an array of **numbers**, none of this applies — there are no quotes, so `separator=","`
is enough on its own. [`repeat`](../reference/attributes.md#top) draws each value
independently, so a tag can show up twice in one row; if you don't want that, pin a fixed
set with [`<mix>`](../reference/tags.md#top) instead.

### `null` is a word, not emptiness

**Problem.** For an optional field, [`missing`](../reference/attributes.md#top) is the obvious
thing to reach for — but `missing` produces an **empty** value, and JSON has no such thing
as empty:

```xml
<gen type="number" value="1..100" missing="0.5"/>
```

`python -m json.tool users.json`

```
{"id": 1, "score": }
JSONDecodeError: Expecting value: line 1 column 20
```

(In CSV that same emptiness is correct — an empty cell means "no value". Formats differ.)

**Tool.** Write the literal word `null` as one branch of a [`<mix>`](../reference/tags.md#top),
which also makes the share **exact** — on 50,000 rows you get precisely 10,000 nulls, not
"about 20%":

```xml
<mix name="Score" percent="80,20">
    <case><gen type="number" value="1..100"/></case>
    <case><data>null</data></case>
</mix>
```

`./run out.tdc`

```
{"id": 1, "score": 56}
{"id": 2, "score": null}
{"id": 3, "score": 12}
```

### A quote from outside data

The last break comes from values you don't control — a name pulled from a
[file](files-and-csv.md#top). A product called `Coffee "Arabica" 250g` lands in the string
as-is, and its first inner quote closes the string early:

`python -m json.tool products.json`

```
{"name": "Coffee "Arabica" 250g"}
JSONDecodeError: Expecting ',' delimiter
```

The JSON standard escapes an inner quote with a backslash. The same
[`replace`](masks-and-case.md#top) filter does it — this is the one place you write the
backslash yourself:

```xml
<data>{"name": "${{Name | replace:",\"}}"}</data>
```

`./run out.tdc`

```
{"name": "Coffee \"Arabica\" 250g"}
```

That parses back to the original string, quotes intact.

> [!NOTE]
> If your data might also contain a literal backslash, double the backslash **first** (a
> `replace` pass for `\` → `\\`), then escape the quotes — otherwise the second pass mangles
> the escapes the first one just added.

### A nested list inside a record

A record that carries a list of its own — an order and its lines, a patient and their visits —
needs a comma **between the repetitions** of one `<line each=…>`, and that is what
[`<delimiter_line>`](../core-concepts/output-formatting.md#top) does. The per-line fixtures see the
lines a reader sees, so a line multiplied by `each=` is several of them:

```xml
<tdc>
  <env count="2" seed="orders" local="en">
    <sequence name="OrderId"><gen type="increment" value="5001"/></sequence>
    <sequence name="Sku"><gen type="regex" value="SKU-[0-9]{4}" repeat="1..3" separator="|"/></sequence>
    <before><line><data>[</data></line></before>
    <after><line><data>]</data></line></after>
    <before_block><line><data>  { "order": ${{OrderId}}, "lines": [</data></line></before_block>
    <after_block><line><data>  ] }</data></line></after_block>
    <delimiter_block><line><data>  ,</data></line></delimiter_block>
    <delimiter_line><line><data>    ,</data></line></delimiter_line>
  </env>
  <block>
    <line each="Sku"><data>    { "sku": "${{Sku}}", "qty": ${{_item}} }</data></line>
  </block>
</tdc>
```

`./run orders.tdc`

```
[
  { "order": 5001, "lines": [
    { "sku": "SKU-3547", "qty": 1 }
    ,
    { "sku": "SKU-8121", "qty": 2 }
    ,
    { "sku": "SKU-7610", "qty": 3 }
  ] }
  ,
  { "order": 5002, "lines": [
    { "sku": "SKU-4917", "qty": 1 }
    ,
    { "sku": "SKU-8482", "qty": 2 }
  ] }
]
```

`repeat="1..3"` gives each record a different number of elements, and the delimiter follows —
one comma fewer than there are lines, every time, including the record that has only one.

> [!NOTE]
> **The wrapper reads the row**
>
> A `${{Name}}` in a fixture IS expanded, and reads the row that fixture stands beside — so the
> record's own fields go in `<before_block>` right next to the opening bracket, and the array
> elements in the `<block>`. What a fixture may **not** hold is a `<gen>` (`TDC131`): a generator
> there would emit a constant that looks like a drawn value.

### Many records: NDJSON

An array has a ceiling: to read a single object, a parser has to load the **whole file**, so
a million records means gigabytes in memory. The industry answer is **NDJSON** — one object
per line, no wrapper and no commas. pandas, ClickHouse, BigQuery, and `jq` all read it.

Just drop the three fixtures and fold each record onto one line:

```xml
<block><line>
    <data>{"id": ${{Id}}, "name": "${{Name}}", "city": "${{City}}", "score": ${{Score}}}</data>
</line></block>
```

`./run out.tdc -o out.ndjson`

```
{"id": 1, "name": "James", "city": "Chicago", "score": 3}
{"id": 2, "name": "William", "city": "Austin", "score": null}
{"id": 3, "name": "Andrew", "city": "Chicago", "score": 12}
```

A consumer reads it one line at a time and needs memory for a single record instead of the
whole file — which makes it the format of choice past a few hundred thousand rows. See
[Large outputs & streaming](large-outputs.md#top) for how TDC writes these to disk without
holding the file in memory.

## SQL

For SQL you emit statements a database runs directly. TDC doesn't connect to anything — it
writes a **file of commands** that you load with `sqlite3`, `psql`, or a migration. Two
format concerns here: escaping apostrophes, and wrapping the run in a schema and a
transaction.

### `sql` — an apostrophe in a value

**Problem.** In SQL a string literal is delimited by single quotes, so a last name like
`O'Brien` closes the string early and the statement won't run:

`sqlite3 shop.db < out.sql`

```
INSERT INTO users (id, last) VALUES (2, 'O'Brien');
Error: near "Brien": syntax error
```

**Tool.** The [`sql`](masks-and-case.md#top) filter doubles the apostrophe, which is how SQL
escapes it inside a literal:

```xml
<tdc>
    <env count="3" seed="demo">
        <sequence name="Id"><gen type="increment" value="1"/></sequence>
        <sequence name="Last"><gen type="text" value="Chisholm,O'Brien,Foster" order="sequential"/></sequence>
    </env>
    <block>
        <line><data>INSERT INTO users (id, last) VALUES (${{Id}}, '${{Last | sql}}');</data></line>
    </block>
</tdc>
```

`./run out.tdc -o out.sql`

```
INSERT INTO users (id, last) VALUES (1, 'Chisholm');
INSERT INTO users (id, last) VALUES (2, 'O''Brien');
INSERT INTO users (id, last) VALUES (3, 'Foster');
```

`'O''Brien'` loads back as `O'Brien`. The stock data packs happen to carry no apostrophes,
which is why this example supplies its own list — but the moment you plug in **your** names,
apostrophes turn up, Irish and Italian ones especially. Put `sql` on every text field headed
into a statement: it costs nothing and saves you a failed import later.

### Schema first, data after — `<before>` / `<after>`

The `CREATE TABLE` runs once, so it belongs in [`<before>`](../core-concepts/output-formatting.md#top),
which prints once, ahead of every row:

```xml
<env count="3" seed="shop">
    <before>
        <line><data>CREATE TABLE customers (</data></line>
        <line><data>  id    INTEGER PRIMARY KEY,</data></line>
        <line><data>  name  TEXT NOT NULL,</data></line>
        <line><data>  city  TEXT NOT NULL</data></line>
        <line><data>);</data></line>
    </before>
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="First"><gen type="template" value="person.male.firstName"/></sequence>
    <sequence name="Last"><gen type="template" value="person.lastName"/></sequence>
    <sequence name="City"><gen type="text" value="Chicago,Austin,Denver" percent="50,30,20"/></sequence>
</env>
<block><line>
    <data>INSERT INTO customers VALUES (${{Id}}, '${{First}} ${{Last | sql}}', '${{City}}');</data>
</line></block>
```

`./run out.tdc -o shop.sql`

```
CREATE TABLE customers (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL,
  city  TEXT NOT NULL
);
INSERT INTO customers VALUES (1, 'James Smith', 'Denver');
INSERT INTO customers VALUES (2, 'Robert Williams', 'Austin');
INSERT INTO customers VALUES (3, 'John Johnson', 'Chicago');
```

### Wrap it in one transaction

A thousand bare `INSERT`s are a thousand transactions — slow. Wrap the run in
`BEGIN` / `COMMIT` so it loads as one, which takes a single extra line in each fixture:

```xml
<env count="3" seed="demo">
    <before>… schema …<line><data>BEGIN;</data></line></before>
    <after><line><data>COMMIT;</data></line></after>
    <!-- the sequences, unchanged -->
</env>
```

Then load it:

`sqlite3 shop.db < shop.sql`

```
# SQLite
sqlite3 shop.db < shop.sql

# PostgreSQL — same file

psql -f shop.sql
```

For related tables — orders that reference existing customers, with the foreign key always
valid — generate one line per list element with [`each`](../reference/attributes.md#top). See
[Coherent & relational data](coherent-data.md#top) for the full pattern.

## Anything else

The same three pieces build any text shape you like — you control every character:

- **YAML** — a `- ` before each list item, two-space indentation for nesting.
- **A Markdown table** — a `|`-delimited header plus a `|---|` rule in `<before>`, and `|`
  rows in `<block>`.
- **A fixed-width report** — pad the fields to a set width with the
  [`mask`](masks-and-case.md#top) and slice filters, then line the columns up.

```xml
<env count="3" seed="demo">
    <before>
        <line><data>| id | name  | city    |</data></line>
        <line><data>|----|-------|---------|</data></line>
    </before>
    <!-- the sequences, unchanged -->
</env>
<block><line><data>| ${{Id}} | ${{Name}} | ${{City}} |</data></line></block>
```

`./run out.tdc (Markdown table)`

```
| id | name  | city    |
|----|-------|---------|
| 1  | James | Chicago |
| 2  | Mary  | Austin  |
```

TDC just fills in the values — the format is whatever you wrote.

## See also

- **[Output & formatting](../core-concepts/output-formatting.md#top)** — `<block>`, `<line>`,
  `<data>`, the fixtures, and the `if` condition.
- **[Masks & case](masks-and-case.md#top)** — the `csv` / `sql` / `replace` escaping filters
  in full.
- **[Reading files & CSV](files-and-csv.md#top)** — pull your own values from a file with the
  [`file`](../generators/file.md#top) generator.
- **[Coherent & relational data](coherent-data.md#top)** — related tables, foreign keys, and
  the `each` / `weight` / `row` attributes.
- **[Large outputs & streaming](large-outputs.md#top)** — millions of rows and NDJSON on disk.

---

← Previous: [Reading files & CSV](./files-and-csv.md#top) · **[Contents](../README.md#top)** · Next: [Masks & case](./masks-and-case.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/guides/output-formats)**
