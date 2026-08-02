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
> **Pre-release**
>
> The Java implementation is complete and passes every cross-language fixture, but it is
> **not on Maven Central yet**. Build it from a checkout:
>
> ```bash
> cd java && ./gradlew build
> ```
>
> After the first release the same library will be one dependency — see
> [Installation](../getting-started/installation.md#top) for the whole picture, including the
> separate CLI jar.

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
