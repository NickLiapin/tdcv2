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
> **On PyPI — version 0.1.3**
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

---

← Previous: [TypeScript](./typescript.md#top) · **[Contents](../README.md#top)** · Next: [Java](./java.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/python)**
