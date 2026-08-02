<a name="top"></a>

**English** · [Русский](../ru/bindings/java.md#top) · [Español](../es/bindings/java.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/java)**

← Previous: [Python](./python.md#top) · **[Contents](../README.md#top)** · Next: [C#](./csharp.md#top) →

---

# Java

The Java package reads the **same `.tdc` config** and, for the same seed, produces the
**same output** as the TypeScript, Python, C# and Rust implementations — the same
cross-language guarantee.

## Getting it

> [!NOTE]
> **Not on Maven Central yet**
>
> Java is the one implementation of the five still to be published. It is complete and
> passes every cross-language fixture — the jar even carries the starter data packs — so
> for now it is built from a checkout:
>
> ```bash
> cd java && ./gradlew build
> ```
>
> See [Installation](../getting-started/installation.md#top) for the whole picture, including
> the separate CLI jar.

## Using it

```java
var data = new TDC("users.tdc");
System.out.println(data.toString());

for (var row : data.iterate()) {
    System.out.println(row.get("Gender"));
}
```

The method names mirror the [TypeScript API](typescript.md#top).

---

← Previous: [Python](./python.md#top) · **[Contents](../README.md#top)** · Next: [C#](./csharp.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/java)**
