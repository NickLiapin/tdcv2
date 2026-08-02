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

One dependency, from Maven Central:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>0.1.3</version>
</dependency>
```

Gradle, in `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.1.3")
```

The starter data packs travel inside the jar, so this runs with nothing else installed.

See [Installation](../getting-started/installation.md#top) for the whole picture, including
the separate CLI jar — Maven has no equivalent of npm's `bin`, so the command line ships
as its own self-contained artifact.

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
