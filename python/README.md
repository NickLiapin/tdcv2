# TDC — The Data Constructor

Test data that is coherent **inside each record**. In one row, the name matches the
gender, the city sits in the right country, the diagnosis fits the patient. Run it
again with the same seed and you get the same rows, byte for byte.

An ordinary fake-data library draws every field on its own, so a row is a bag of
individually plausible values that contradict each other. TDC draws a field from what
the previous field chose.

```bash
pip install tdcv2
```

**[Documentation](https://nickliapin.github.io/tdcv2/)** ·
[Getting started](https://nickliapin.github.io/tdcv2/docs/getting-started/installation) ·
[Generators](https://nickliapin.github.io/tdcv2/docs/generators/overview) ·
[The DSL reference](https://nickliapin.github.io/tdcv2/docs/reference/attributes) ·
[Data packs](https://nickliapin.github.io/tdcv2/docs/data-packs/overview) ·
[Source](https://github.com/NickLiapin/tdcv2)

## Two ways to use it

They are different tools that happen to share one set of data, and most people
need both at different moments.

**Reach for a value.** Import the library, call an address, get a string — the job
a faker does. Nothing is tied to anything else, and there is no config in sight.

```python
from tdcv2 import tdc

tdc.person.lastName()               # Jones
tdc.person.male.firstName()         # Robert
tdc.company.industry()              # Pharmaceuticals

tdc.common.id.uuid()                # 3ff6ff76-6ea7-4fad-8b99-3075a14cc7e9
tdc.common.finance.iban()           # DE62299399441396459682
tdc.country.usa.docs.ssn()          # 699209702 — with its real check digits

tdc.lang.ru.person.lastName()       # after `tdcv2 pack add ru`

tdc.person.lastName.many(5)         # ['Bush', 'Armstrong', 'Andrews', …]
tdc.gen.number("18..80")            # '66'
```

A dot in the code is a dot in the address: `person.male.firstName` here is
`person.male.firstName` in a config and in the reference — one vocabulary, not two.
That is also why the segments are camelCase in a Python module: they are not names
we chose, they are the names the data already has. A bare address reads against the
active locale; `common.`, `country.<code>.` and `lang.<code>.` name a pack outright.

Values are random per process. Pin a seed when the value should be part of the test
rather than a variable in it:

```python
t = tdc.seed("demo")
t.person.lastName()                 # Jones, today and next year
```

The same seed gives the same value in the TypeScript implementation — the streams
are one contract, and a test compares the two.

**Describe a dataset.** Write a config saying what the records are and how they
should look, then generate as many as you want. This is where the exact
proportions, the parent-child distributions and the coherent records live — none
of which a sequence of loose calls can give you. That is the rest of this page.

## A first config

A config says what the records are; a block says how they should look on the page.

```xml title="people.tdc"
<tdc>
    <env count="10" seed="demo" local="en">
        <sequence name="Gender">
            <gen type="text" value="Male,Female" percent="60,40"/>
        </sequence>

        <sequence name="MaleName" parent="Gender.Male">
            <gen type="template" value="person.male.firstName"/>
        </sequence>
        <sequence name="FemaleName" parent="Gender.Female">
            <gen type="template" value="person.female.firstName"/>
        </sequence>

        <sequence name="Age"><gen type="number" value="18..65"/></sequence>
    </env>

    <block>
        <line><data>${{_count}}. ${{Gender}} — ${{MaleName}}${{FemaleName}}, age ${{Age}}</data></line>
    </block>
</tdc>
```

```bash
tdcv2 people.tdc
```

```
1. Male — Robert, age 59
2. Female — Mary, age 18
3. Male — James, age 53
...
```

Exactly six men and four women — `percent="60,40"` is apportioned across whole rows by
the Hamilton method, not approximated by independent coin flips. Every name matches its
gender, because a female row cannot reach the male list at all. Change the `<block>` and
the same records come out as CSV, JSON, SQL, YAML or a format you spell out yourself.

## From Python

```python
from tdcv2 import TDC

data = TDC("people.tdc")
print(data)                        # the whole run as text

for row in data:
    print(row["Gender"], row["Age"])

data.write_file("people.parquet")  # the extension picks the format
```

The constructor also takes `config_string=` instead of a path, and `count=`, `seed=`,
`locale=`, `now=` and `engine=` override whatever `<env>` declared. `now=` is the one
worth remembering in a test: a config with a date generator reads the clock, so pinning
it is what keeps such a test stable for longer than a day.

### Large runs

```python
data.write_file("people.csv", workers="auto")   # one process per core, bar one
```

A row is a function of its own index — that is what the streaming engine is built
around — so a run splits across processes with nothing to coordinate. The output is byte
for byte what one process writes; on one machine a gigabyte went from 11m37s to 87s
across eleven processes.

You do not need `if __name__ == "__main__":` around the call. Workers are launched as a
named module rather than through `multiprocessing`, so nothing of yours is re-imported
and re-executed.

Splitting is skipped, silently and safely, wherever it would not be sound: the in-memory
and exact engines, a config passed as a string rather than a file, Parquet output, and
runs short enough that starting processes costs more than the rows do.

## The command line

`pip install tdcv2` puts `tdcv2` on the PATH — the same commands as the TypeScript, Java,
C# and Rust CLIs, flag for flag. A Python user should not have to install Node to run a
`.tdc` file.

```bash
tdcv2 people.tdc -o people.csv --count 100000 --jobs 8
```

|                                              |                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `tdcv2 <file.tdc>`                           | Generate. `-o`, `--seed`, `--count`, `--locale`, `--data-path`, `--engine`, `--jobs` |
| `tdcv2 init`                                 | Write a `tdcv2.config.json` — asks at a terminal, takes `--yes` in a script          |
| `tdcv2 pack list \| add <id> \| remove <id>` | Data packs, from the shared registry                                                 |
| `tdcv2 check <file.tdc>`                     | Validate and say nothing when it is fine — for a pre-commit hook                     |
| `tdcv2 format [-w] <file.tdc>`               | Pretty-print a config; `-w` rewrites it in place                                     |

`--jobs` is the process split described above, and changes nothing but the wall clock.

## Data packs

A pack is the _data_ — the name lists, cities, streets and locale rules that
`type="template"` draws from. The wheel carries a starter set: `common`, `en` and the USA
country pack, which is what the example above uses. Ten languages and more than ninety
country packs — with the right check-digit rule for each national ID format — are
downloaded on demand:

```bash
tdcv2 init                 # write a tdcv2.config.json, once per project
tdcv2 pack list            # what the registry has
tdcv2 pack add ru france   # download and wire up
```

Or from code:

```python
from tdcv2.packs import DataPacks

DataPacks.install(None, "ru", "france")   # downloads, verifies, registers in tdcv2.config.json
```

One registry, one `tdcv2.config.json`, one store, shared by all five implementations: a
pack installed from here is a pack the others find. `--registry` accepts an `http`,
`https` or `file` address, so an offline mirror or a folder on a share works the same way
as the public one.

## One config, five implementations

TDC exists in TypeScript, Python, Java, C# and Rust. The same config and seed produce the
same bytes in all five — that is the contract, and a shared fixture suite under
`fixtures/cross-language/` checks it on every change: the shared cases through the router
and on all three engines, the diagnostic cases by code and position, the PRNG and
apportionment vectors, and the Parquet files byte for byte.

It is why this package reimplements what a dependency would otherwise have provided. The
only runtime dependency is `antlr4-python3-runtime`, and only because the grammar is
shared with the other implementations and the parse tree has to be the same tree. The
PRNG, the Snappy encoder, the Parquet writer and the date arithmetic are written here, so
no library's choice of rounding or compression can change the bytes.

| Module         | What it owns                                                                      |
| -------------- | --------------------------------------------------------------------------------- |
| `prng`         | The seekable generator, and the format-preserving permutation                     |
| `distribution` | Hamilton apportionment and the `percent=` mask                                    |
| `generators`   | number, regex, advanced_regex, symbol, counter, file, http, repeat, imperfections |
| `date`         | A UTC calendar written out, eleven locale tables, the Moment-style formatter      |
| `stats`        | Named distributions, the special functions behind gamma and beta, time series     |
| `pattern`      | A drawn curve as a signal or a distribution; SVG and PNG readers                  |
| `format`       | The positional mask, the interpolation filters, `${{Name\|filter}}`               |
| `compute`      | The check-digit language, and the `if=` expression language                       |
| `packs`        | Pack loading, the project cascade, the shared registry client                     |
| `engine`       | The three engines and the router that picks between them                          |
| `validator`    | Every `TDC###` code, each at the position an editor would underline               |
| `output`       | Declared column types and the Parquet writer                                      |

## Working on the repository

The parser is generated from the shared grammar and the generator runs on Node. A
released package ships it already generated; a checkout does not.

```bash
node scripts/generate-parsers.mjs --only python
cd python
python3 -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest                  # 970 tests
.venv/bin/ruff check src tests
```

`node scripts/five-ways.mjs --only python` does the same and regenerates the parser
first, which is what CI runs.

## Links

- [Documentation](https://nickliapin.github.io/tdcv2/) — the DSL reference, guides and generators
- [The Python binding](https://nickliapin.github.io/tdcv2/docs/bindings/python)
- [Source](https://github.com/NickLiapin/tdcv2)

## License

MIT
