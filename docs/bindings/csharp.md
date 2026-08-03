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

> [!TIP]
> **On NuGet — version 0.1.4**
>
>
> ```bash
> dotnet add package Tdcv2
> ```
>
> The starter data packs are embedded in the assembly, so it works with nothing else
> installed. The command line is its own tool package — install it globally and `tdcv2` is
> on your PATH:
>
> ```bash
> dotnet tool install --global Tdcv2.Cli
> ```
>

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

|                                |                                                                        |
| ------------------------------ | ---------------------------------------------------------------------- |
| `ConfigFile` / `ConfigString`  | Exactly one of the two                                                 |
| `Count`, `SeedValue`, `Locale` | Override what `<env>` declared                                         |
| `NowMillis`                    | Pin the clock, so a test asserting on a date does not expire overnight |
| `PacksDir`, `DataPaths`        | Where packs and `@data/…` sources are found                            |
| `BaseDir`                      | What a relative `src=` is relative to                                  |

`Diagnostics` carries anything the config was warned about but not refused for; errors
are thrown from the constructor, so whatever is left there is worth saying and not worth
stopping for. `SeedInfo` reports whether the seed was generated — an unseeded run is not
reproducible, which is almost never what was wanted.

## One value, without a config

`Quick.Tdc` draws a single value from the same data packs a config reads — no file,
no `<env>`, one call:

```csharp
using Tdcv2.Quick;

dynamic tdc = Quick.Tdc;

tdc.person.lastName();                              // Jones
tdc.country.usa.docs.ssn();                         // 699209702, with its real check digits
tdc.person.lastName.many(5);                        // five of them
Quick.Seed("demo").locale("ru").person.lastName();  // pinned and in Russian
```

This is the one part of the library that is `dynamic`, and deliberately: an address
is a path through data rather than a fixed set of members, and a class per pack
folder would put a hundred thousand lines of nothing in the assembly. The cost is
that a misspelled address is caught when it runs, so the message it throws names
the nearest real address. [One value at a time](../core-concepts/quick-api.md#top) is
the whole surface.

## Requirements

.NET **6.0** or newer. See the [C# README](https://github.com/NickLiapin/tdcv2/tree/main/csharp)
for the places where .NET needed care the JVM did not — overflow, shifts, endianness, case
mapping and locale data — each of which would otherwise have changed the bytes.

---

← Previous: [Java](./java.md#top) · **[Contents](../README.md#top)** · Next: [Rust](./rust.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/bindings/csharp)**
