<a name="top"></a>

**English** · [Русский](../ru/reference/builtins.md#top) · [Español](../es/reference/builtins.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/builtins)**

← Previous: [Compute functions](./compute.md#top) · **[Contents](../README.md#top)** · Next: [Identifier catalog](./identifiers.md#top) →

---

# Built-in sequences

TDC creates a few sequences automatically — they're available without being declared in
`<env>`. By convention their names start with an underscore. Use them in
[interpolation](../core-concepts/output-formatting.md#top) (`${{_count}}`) and in `if`
expressions (`if="_first"`).

Often what you need isn't the record's data but its **place in the set** — which number it
is, whether it's first or last, how many there are in total. TDC works all of that out
and hands it to you under four ready-made names.

## The list

| Name     | Value                                                           |
| :------- | :-------------------------------------------------------------- |
| `_count` | The current record number, **starting at 1**                    |
| `_first` | `"true"` on the first record, `"false"` otherwise               |
| `_last`  | `"true"` on the last record, `"false"` otherwise                |
| `_total` | The total number of records (the same as `count`), on every row |

> [!NOTE]
> **Strings, not booleans**
>
> `_first` and `_last` are the strings `"true"` and `"false"`, not booleans. That's
> deliberate: `${{_last}}` prints as the readable word `"false"` (useful for
> `"isLast": ${{_last}}` in JSON), while `if="!_last"` still reads it correctly as false.

## All four at once

```xml
<block>
    <line><data>_count=${{_count}}  _first=${{_first}}  _last=${{_last}}  _total=${{_total}}  ${{Name}}</data></line>
</block>
```

`./run demo.tdc`

```
_count=1  _first=true  _last=false  _total=5  William
_count=2  _first=false  _last=false  _total=5  Michael
_count=3  _first=false  _last=false  _total=5  Robert
_count=4  _first=false  _last=false  _total=5  John
_count=5  _first=false  _last=true  _total=5  James
```

`_count` runs `1..5`, `_total` is `5` on every row, `_first` is true only on the first
record, and `_last` only on the last.

## Common uses

**Numbering** — `${{_count}} of ${{_total}}: ${{Name}}`.

**JSON without a trailing comma** — a second `<data if="!_last">,` prints a comma on
every record except the last:

```xml
<line><data>{"id": ${{_count}}, "name": "${{Name}}"}</data><data if="!_last">,</data></line>
```

`./run demo.tdc`

```
{"id": 1, "name": "Braylen"},
{"id": 2, "name": "Amiri"},
{"id": 3, "name": "Andre"},
{"id": 4, "name": "Izaiah"}
```

**A header only on the first record** — `<line if="_first"><data>=== START ===</data></line>`.

**Highlight the second half** — the built-ins work inside expression arithmetic, so
`if="_count * 2 > _total"` turns true once the row number passes the midpoint.

## Inside an `each=` line: `_item` and `_item_id`

A [`<line each="List">`](../reference/attributes.md#top) repeats once per element of a list,
and two more built-ins are available **only there** — see
[Relational tables](../constructs/relational-tables.md#top) for the full pattern:

| Name       | Value                                                                          |
| :--------- | :----------------------------------------------------------------------------- |
| `_item`    | The position **within this record** — `1`, `2`, `3`, restarting on each record |
| `_item_id` | A number **unique across the whole run** — a ready-made primary key            |

They exist only on an `each=` line. On an ordinary line the name resolves to nothing, and
[TDC193](errors.md#top) refuses the config rather than printing `${{_item}}` literally.

## Reserved names

Don't prefix your own sequences with `_` — that prefix is reserved. You can't shadow a
built-in: TDC refuses to start and tells you which names are taken.

`./run bad.tdc`

```
error[TDC033]: sequence name "_count" collides with a builtin
note: Builtins: _count, _first, _last, _total. Pick a different name.
```

## See also

- **[Output & formatting](../core-concepts/output-formatting.md#top)** — interpolation and `if`.

---

← Previous: [Compute functions](./compute.md#top) · **[Contents](../README.md#top)** · Next: [Identifier catalog](./identifiers.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/builtins)**
