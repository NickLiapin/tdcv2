# TDC — C# Implementation

## Quick start

**You need:** **The .NET SDK, 6.0 or newer** — the ANTLR runtime comes from NuGet — plus
**Node** once, to generate the parser from the grammar the five implementations share. A
released package ships it already generated; a checkout does not.

```bash
node scripts/generate-parsers.mjs --only csharp
cd csharp
dotnet build
```

Then write a config and run it:

```xml title="demo.tdc"
<tdc>
  <env count="3" seed="demo" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Name"><gen type="template" value="person.lastName"/></sequence>
  </env>
  <block><line><data>${{Id}},${{Name}}</data></line></block>
</tdc>
```

```bash
dotnet run --project Tdcv2.Cli.Tool -- demo.tdc
```

`dotnet publish Tdcv2.Cli.Tool -c Release` produces a standalone binary if you
would rather not go through `dotnet run` every time.

```
1,Williams
2,Johnson
3,Smith
```

The same three names, every time, in every implementation — that is the whole
point of the `seed`.

### Data packs

A pack is the _data_ — the name lists, cities, streets and locale rules that
`type="template"` draws from. A starter set ships with the code: `common`, `en`
and the USA country pack, which is what the example above uses. Everything else
is downloaded on demand:

```bash
tdcv2 init                 # write a tdcv2.config.json, once per project
tdcv2 pack list            # what the registry has
tdcv2 pack add ru france   # download and wire up
```

One registry, one `tdcv2.config.json`, one store, shared by all five
implementations: a pack installed from here is a pack the others find. The full
story is in [the data-packs guide](../docs/data-packs/installing-packs.md).

Complete. Every cross-language fixture passes: the 104 shared cases through the router and on all
three engines, the 108 diagnostic cases by code and position, the 45 command-line cases, the PRNG
and apportionment vectors, and the six Parquet files byte for byte.

Run the checks with `dotnet test` from this folder — 615 tests. Nothing is needed beyond the .NET
SDK; the ANTLR runtime comes from NuGet.

```csharp
var data = new Tdc("users.tdc");
Console.WriteLine(data);

foreach (Tdc.Row row in data.Rows())
{
    Console.WriteLine(row["Gender"]);
}

data.WriteFile("users.csv");
```

A row is the reason to use the library rather than the command line. A test that asserts on
`row["Gender"]` says what it means; the same test parsing CSV back out of a string spends most of
its lines on the parsing. A sequence that does not apply to a row returns `null`, never `""` — a
column declared `parent="Gender.Male"` has no value on a female row, and a blank would claim it had
one that happened to be empty.

Packs are found without configuration: `TDCV2_PACKS`, else a `packs` folder beside the assembly,
else the repository's own `data/packs` found by walking upward. Everything past the starter set
comes from the shared registry the other three implementations read.

## The command line

.NET's answer to npm's `bin` is a tool package, so that is what it is:

```bash
dotnet tool install -g Tdcv2.Cli
tdcv2 users.tdc -o users.csv
```

The same five commands as the TypeScript, Java and Python CLIs, flag for flag:

|                                              |                                                                             |
| -------------------------------------------- | --------------------------------------------------------------------------- |
| `tdcv2 <file.tdc>`                           | Generate. `-o`, `--seed`, `--count`, `--locale`, `--data-path`, `--engine`  |
| `tdcv2 init`                                 | Write a `tdcv2.config.json` — asks at a terminal, takes `--yes` in a script |
| `tdcv2 pack list \| add <id> \| remove <id>` | Data packs, from the shared registry                                        |
| `tdcv2 check <file.tdc>`                     | Validate and say nothing when it is fine — for a pre-commit hook            |
| `tdcv2 format [-w] <file.tdc>`               | Pretty-print a config; `-w` rewrites it in place                            |

A pack installed here is a pack every other implementation finds: one registry, one
`tdcv2.config.json`, one store. `--registry` accepts an `http`, `https` or `file` address, so an
offline mirror or a folder on a share works the same way as the public one.

Two deliberate differences, both named rather than left to be discovered:

- `--jobs` is accepted and the count is ignored. The worker count never changes the bytes — a shard
  is a range of rows and every row is a function of its own number — so the flag exists for scripts
  written against another implementation, and the run stays single-threaded.
- The interactive pack picker is not here. It is a terminal UI, no fixture case exercises it, and
  `pack list` is what a script and CI use.

## Why C#

.NET is the other large enterprise runtime, and a .NET team should not need a JVM or Node on the
build agent to generate a fixture file. The library targets `net6.0`, which every supported .NET
version can consume.

## Stack

- **Runtime:** `net6.0`, nullable reference types on
- **Parser:** ANTLR4 C# runtime, generated from the shared `../grammar/*.g4`
- **Tests:** xUnit
- **Packages:** `Tdcv2` (library) and `Tdcv2.Cli` (a `dotnet tool`)

## Principles

**Bit-identical output** to the TypeScript reference for the same config and seed. That is what the
fixtures under `../fixtures/cross-language/` check, and it is why the PRNG, the Snappy encoder, the
Parquet writer, the date arithmetic and the month names are all written here rather than depended
on — a library's choice of rounding or compression, or a runtime's locale tables, would change the
bytes.

Five places where C# needed care the JVM did not, each found by a fixture rather than by reading:

- **Overflow.** Every mixing constant in the PRNG, the permutation and the Snappy matcher is written
  as a signed 32-bit pattern inside `unchecked`. A literal above `int.MaxValue` is a `uint` in C#,
  and the multiply would silently become 64-bit arithmetic where Java's `int` wraps.
- **Shifts.** `>>>` does not exist before C# 11; a logical shift is `(int)((uint)x >> n)`. A signed
  shift there gives a different permutation, and the same seed lands on different rows.
- **Endianness.** `BitConverter` follows the machine, so the Parquet writer reverses per value on a
  big-endian host. A file written there would otherwise be unreadable everywhere else.
- **Case mapping.** `ToUpperInvariant` is a simple 1:1 mapping and leaves `ß` as `ß`, where
  JavaScript, Java and Python all write `SS`. The multi-character table is embedded.
- **Locale data.** `CultureInfo` reads month names from ICU or the host OS. The tables are in the
  source instead: the same seed must print the same month name on every machine.

## References

- [../docs/bindings/](../docs/bindings/) — how one config runs in four languages
- [../fixtures/cross-language/](../fixtures/cross-language/) — the contract all four answer to
- [../fixtures/parity/audit.py](../fixtures/parity/audit.py) — the same broken configs through all
  four command lines, diffed by diagnostic code
