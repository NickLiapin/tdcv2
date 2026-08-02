<a name="top"></a>

**English** · [Русский](../ru/bindings/csharp.md#top) · [Español](../es/bindings/csharp.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/csharp)**

← Previous: [Java](./java.md#top) · **[Contents](../README.md#top)** · Next: [Rust](./rust.md#top) →

---

# C#

The .NET package reads the **same `.tdc` config** and, for the same seed, produces the
**same output** as the TypeScript, Python, Java and Rust implementations — byte for byte, on
all three engines and in Parquet.

Two packages: the library, and the command line as a `dotnet tool`.

## Getting it

> [!NOTE]
> **Pre-release**
>
> Not on NuGet yet — `dotnet add package Tdcv2` will not find it. Build from a checkout:
>
> ```bash
> cd csharp && dotnet build
> dotnet run --project Tdcv2.Cli.Tool -- demo.tdc
> ```
>
> After the release it becomes `dotnet add package Tdcv2` plus
> `dotnet tool install -g Tdcv2.Cli`; see
> [Installation](../getting-started/installation.md#top).

## Using it

```csharp
using Tdcv2;

var data = new Tdc("users.tdc");
Console.WriteLine(data);

foreach (Tdc.Row row in data.Rows())
{
    Console.WriteLine(row["Gender"]);
}

data.WriteFile("users.csv");
```

## Rows, not strings

A row is the reason to use the library rather than the command line. A test that asserts
on `row["Gender"]` says what it means; the same test parsing CSV back out of a string
spends most of its lines on the parsing.

Text output and row output read the same generated values, so the two can never disagree.
The row view ignores `<block>` and the text wrappers entirely — those describe a file
format, and a row has no format.

```csharp
var data = new Tdc(new Tdc.Options
{
    ConfigFile = "users.tdc",
    Count = 100,        // overrides what <env> declared
    SeedValue = "test", // pins the run
});

Tdc.Row first = data[0];
Console.WriteLine(first["Address.city"]);          // a compound's field
Console.WriteLine(first.Nested()["Address"]);      // or the whole address at once
```

A sequence that does not apply to a row returns `null`, never `""`. A column declared
`parent="Gender.Male"` has no value on a female row, and a blank would claim it had one
that happened to be empty.

## Options

| | |
| --- | --- |
| `ConfigFile` / `ConfigString` | Exactly one of the two |
| `Count`, `SeedValue`, `Locale` | Override what `<env>` declared |
| `NowMillis` | Pin the clock, so a test asserting on a date does not expire overnight |
| `PacksDir`, `DataPaths` | Where packs and `@data/…` sources are found |
| `BaseDir` | What a relative `src=` is relative to |

`Diagnostics` carries anything the config was warned about but not refused for; errors
are thrown from the constructor, so whatever is left there is worth saying and not worth
stopping for. `SeedInfo` reports whether the seed was generated — an unseeded run is not
reproducible, which is almost never what was wanted.

## Requirements

.NET **6.0** or newer. See the [C# README](https://github.com/NickLiapin/tdcv2/tree/main/csharp)
for the places where .NET needed care the JVM did not — overflow, shifts, endianness, case
mapping and locale data — each of which would otherwise have changed the bytes.

---

← Previous: [Java](./java.md#top) · **[Contents](../README.md#top)** · Next: [Rust](./rust.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/csharp)**
