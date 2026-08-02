<a name="top"></a>

**English** · [Русский](../ru/bindings/python.md#top) · [Español](../es/bindings/python.md#top)

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Java](./java.md#top) →

---

# Python

The Python package reads the **same `.tdc` config** and, for the same seed, produces
the **same output** as the TypeScript, Java, C# and Rust implementations. That
cross-language guarantee is one of TDC's core promises.

## Getting it

> [!NOTE]
> **Pre-release**
>
> The Python implementation is complete and passes every cross-language fixture, but it is
> **not on PyPI yet** — `pip install tdcv2` will not find it. Install from a checkout:
>
> ```bash
> pip install -e python
> ```
>
> That gives you both the library and the `tdcv2` command. See
> [Installation](../getting-started/installation.md#top) for the whole picture.

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

---

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Java](./java.md#top) →
