# TDC — Python Implementation

Complete. Every cross-language fixture passes: the 104 shared cases through the router and on all
three engines, the 108 diagnostic cases by code and position, the PRNG and apportionment vectors,
and the six Parquet files byte for byte.

```bash
cd python
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest                  # 799 tests
.venv/bin/ruff check src tests
```

## Using it

```python
from tdcv2 import TDC

data = TDC("users.tdc")
print(data)                        # the whole run as text

for row in data:
    print(row["Gender"], row["Age"])

data.write_file("users.parquet")   # the extension picks the format
```

The constructor takes `config_string=` instead of a path, and `count=`, `seed=`, `locale=`, `now=`
and `engine=` override whatever `<env>` declared. `now=` is the one worth remembering in a test: a
config with a date generator reads the clock, so pinning it is what makes such a test stable for
longer than a day.

### Large runs

```python
data.write_file("users.csv", workers="auto")   # one process per core, bar one
```

A row is a function of its own index — that is what the streaming engine is built around — so a run
splits across processes with nothing to coordinate. The output is byte for byte what one process
writes; on this machine a gigabyte went from 11m37s to 87s across eleven processes.

You do not need `if __name__ == "__main__":` around the call. Workers are launched as a named module
rather than through `multiprocessing`, so nothing of yours is re-imported and re-executed.

Splitting is skipped, silently and safely, wherever it would not be sound: the in-memory and exact
engines, a config passed as a string rather than a file, Parquet output, and runs short enough that
starting processes costs more than the rows do.

## The command line

`pip install tdcv2` puts `tdcv2` on the PATH — the same four commands as the TypeScript and Java
CLIs, flag for flag. A Python user should not have to install Node to run a `.tdc` file.

```bash
tdcv2 users.tdc -o users.csv --count 100000 --jobs 8
```

|                                              |                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `tdcv2 <file.tdc>`                           | Generate. `-o`, `--seed`, `--count`, `--locale`, `--data-path`, `--engine`, `--jobs` |
| `tdcv2 init`                                 | Write a `tdcv2.config.json` — asks at a terminal, takes `--yes` in a script          |
| `tdcv2 pack list \| add <id> \| remove <id>` | Data packs, from the shared registry                                                 |
| `tdcv2 check <file.tdc>`                     | Validate and say nothing when it is fine — for a pre-commit hook                     |
| `tdcv2 format [-w] <file.tdc>`               | Pretty-print a config; `-w` rewrites it in place                                     |

`--jobs` is the process split described above, and changes nothing but the wall clock.

A pack installed here is a pack the TypeScript and Java implementations find: one registry, one
`tdcv2.config.json`, one store. `--registry` accepts an `http`, `https` or `file` address, so an
offline mirror or a folder on a share works the same way as the public one.

## What is here

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
| `validator`    | 109 `TDC###` codes, each at the position an editor would underline                |
| `output`       | Declared column types and the Parquet writer                                      |

## Data packs

The wheel ships a starter set only — `common`, `en`, and the USA country pack. Everything else
comes from the shared registry on demand, the same one the command-line tool and the Java library
read:

```python
from tdcv2.packs import DataPacks

DataPacks.install(None, "ru", "france")   # downloads, verifies, registers in tdcv2.config.json
```

The starter packs are generated from `../data/packs` at build time by `scripts/bundle_packs.py`;
they are not committed, because the packs live once.

## Stack

- Python 3.10+
- One runtime dependency: `antlr4-python3-runtime`, because the grammar is shared with the other
  implementations and the parse tree has to be the same tree. Everything else — the PRNG, the
  Snappy encoder, the Parquet writer, the date arithmetic — is written here, so no library's
  choice of rounding or compression can change the bytes.
- `pytest` and `ruff`

## The promise

Bit-identical output to the TypeScript reference for the same config and seed. That is what the
fixtures under `../fixtures/cross-language/` check, and it is why so much of this package
reimplements what a dependency would otherwise have provided.

## References

- [../docs/bindings/](../docs/bindings/) — how one config runs in three languages
- [../docs/bindings/python.md](../docs/bindings/python.md) — the Python binding
