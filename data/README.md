# Shared Data Files

Language-agnostic data files used by the `type="file"` generator (and eventually
by the legacy `type="template"` if we keep it).

## Why shared

These are just text and JSON files — they contain **data**, not code. All three
language implementations (TypeScript, Python, Java) can read them directly from
their standard libraries. Keeping them at the repository root avoids duplication
and keeps them in sync across implementations.

## Current files (from the 2022-2024 prototype)

| File            | Content                      | Format            |
| --------------- | ---------------------------- | ----------------- |
| `firstName.txt` | English first names          | One name per line |
| `lastName.txt`  | English last names           | One name per line |
| `eng.json`      | English locale template data | JSON structure    |

## Usage

From a TDC DSL file:

```xml
<gen type="file" src="./data/firstName.txt"/>
```

The TDC library loads the file once (cached per path), then picks random values
from it. Bit-identical determinism holds: with the same seed, the same file, and
the same iteration, all languages pick the same value.

## Future

After v1.0, this directory may grow to include:

- Additional locales (`names/ru/`, `names/es/`, `names/ar/`, ...)
- More domain-specific lists (cities, companies, diagnoses, products, ...)
- Per-culture structured packs (see
  [../docs/generators/](../docs/generators/) — every generator type for the
  pack/list discussion)

Eventually, large or specialized locale data may move to separate npm/PyPI/Maven
packages (e.g., `@tdc/data-ru`, `tdc-data-ru`, `com.tdc.data.ru`) to keep the
core lean. For now, everything stays here.

## References

- [../docs/generators/](../docs/generators/) — every generator type
- [../docs/bindings/python.md](../docs/bindings/python.md) — the Python binding
