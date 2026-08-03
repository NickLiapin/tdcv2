<a name="top"></a>

**English** · [Русский](../ru/bindings/python.md#top) · [Español](../es/bindings/python.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/python)**

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Java](./java.md#top) →

---

# Python

The Python package reads the **same `.tdc` config** and, for the same seed, produces
the **same output** as the TypeScript, Java, C# and Rust implementations. That
cross-language guarantee is one of TDC's core promises.

## Getting it

> [!TIP]
> **On PyPI — version 0.1.6**
>
>
> ```bash
> pip install tdcv2
> ```
>
> That gives you both the library and the `tdcv2` command, with a starter set of data
> packs inside the wheel. See [Installation](../getting-started/installation.md#top) for the
> whole picture.

## Using it

```python
from tdcv2 import TDC

data = TDC(config_file="users.tdc")
print(data.to_string())

for row in data.iterate():
    print(row["Gender"])
```

The method names mirror the [TypeScript API](typescript.md#top) — `to_string`,
`write_file`, `iterate`, `to_array`, `get_at`, `preflight` — written in Python's
snake_case.

## One value, without a config

The package also exports `tdc`, which draws a single value from the same data packs
a config reads — no file, no `<env>`, one call:

```python
from tdcv2 import tdc

tdc.person.lastName()                             # Jones
tdc.country.usa.docs.ssn()                        # 699209702, with its real check digits
tdc.person.lastName.many(5)                       # five of them
tdc.seed("demo").locale("ru").person.lastName()   # pinned and in Russian
```

The segments stay camelCase here, unlike the method names above. They are addresses
the packs already carry, not identifiers this package chose, and `person.lastName`
has to read the same way in a config, in the reference and in the other four
implementations. [One value at a time](../core-concepts/quick-api.md#top) is the whole
surface.

---

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Java](./java.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/python)**
