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
  <version>0.2.2</version>
</dependency>
```

Gradle, in `build.gradle.kts`:

```kotlin
implementation("io.github.nickliapin:tdcv2:0.2.2")
```

> [!NOTE]
> **Why this version can differ from the other four**
>
> Maven Central caps how many releases it accepts from a project each month, and this
> project reaches that cap. When it does, the jar stays where it is while npm, PyPI,
> NuGet and crates.io move on, until the allowance resets and the backlog goes out
> together.
>
> The coordinate above is always **the newest jar that is actually on Central**, so it
> resolves — it is simply not always the newest TDC. When it is behind, what you are
> missing is the engine changes made since; the config language, the diagnostics and
> the output of everything older are unchanged, so a config written for this jar keeps
> working.

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

The method names mirror the [TypeScript API](typescript.md#top) — see
[the same names everywhere](same-names.md#top) for the table, which the test suites check
rather than merely assert.

## One value, without a config

`Quick` draws a single value from the same data packs a config reads — no file, no
`<env>`, one call:

```java
import io.github.nickliapin.tdc.quick.Quick;

Quick tdc = Quick.tdc();

tdc.get("person.lastName");              // Jones
tdc.get("usa.docs.ssn");                 // 699209702, with its real check digits
tdc.many("person.lastName", 5);          // five of them
Quick.seeded("demo").locale("ru").get("person.lastName");  // pinned and in Russian
```

The address is a string here, where TypeScript, Python and C# walk it as members.
The member shape needs one generated method per address, and a generated surface
could only cover the packs inside the jar — while most packs arrive at run time,
and `get("ru.person.lastName")` works the moment the download finishes. [One value
at a time](../core-concepts/quick-api.md#top) is the whole surface.

---

← Previous: [Python](./python.md#top) · **[Contents](../README.md#top)** · Next: [C#](./csharp.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/java)**
