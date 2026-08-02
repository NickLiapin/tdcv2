<a name="top"></a>

**English** · [Русский](../ru/getting-started/installation.md#top) · [Español](../es/getting-started/installation.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/getting-started/installation)**

← Previous: [Introduction](../intro.md#top) · **[Contents](../README.md#top)** · Next: [Your first dataset](./first-data.md#top) →

---

# Installation

TDC targets five ecosystems — **npm** (Node.js / TypeScript), **pip**
(Python), **Maven** (Java), **NuGet** (.NET) and **Cargo** (Rust) — all producing
byte-for-byte identical output from the same config, seed, version and output mode
(see [Determinism & proportions](../core-concepts/determinism.md#top)).

**All five implementations are complete.** They share one grammar, one set of
diagnostic codes, and a suite of fixtures that hold them to producing the same
bytes — a gigabyte of output from the same config comes out identical in each.
Each one also carries the same command line, so nothing needs another
language's toolchain to run a config.

What is *not* done yet is publishing to the package registries. Until the
first release lands on npm, PyPI, Maven Central, NuGet and crates.io, you install
from a checkout
— each tab below shows how.

Pick your ecosystem. To try TDC without committing to a language, use the npm
tab: it includes a wrapper script that runs a config without any code of your
own.

#### Node.js — npm

**Requirements:** Node.js **20.0.0** or newer.

```bash
npm install -D tdcv2
npx tdcv2 demo.tdc
```

That is the whole installation. The `common`, `en` and USA data packs come with
the package, so the example below runs without downloading anything.

To work on the engine itself instead, run it from a checkout of the repository.
Build it once:

```bash
npm --workspace typescript run build
```

Then run any config by pointing Node at the built CLI:

```bash
node typescript/dist/cli/main.js demo.tdc
```

There's also a one-command wrapper at the repository root, so you don't have to
remember that path:

```bash
./run demo.tdc        # run any file you point it at
```

`./run` is the fastest way to see output: point it at a file and read the
result in the terminal. Under the hood it calls the same CLI. The
full option list — `--seed`, `--count`, `--output`, `--locale`, and the rest —
lives in the [CLI reference](../reference/cli.md#top).

#### Python — pip

**Requirements:** Python **3.10** or newer.

> [!NOTE]
> **Pre-release**
>
> Not on PyPI yet. Once it is, one command gets you both the library and the
> `tdcv2` command:

```bash
pip install tdcv2
tdcv2 demo.tdc
```

Until then, install from a checkout of the repository:

```bash
pip install -e python
tdcv2 demo.tdc
```

That is the whole setup — an editable install puts `tdcv2` on your PATH the
same way the published package will, so nothing changes when the release
lands.

The DSL and behavior are identical to the npm version: the same `.tdc` config,
run with the same `seed`, produces the same bytes. See
[Language bindings — Python](../bindings/python.md#top) for the API.

#### Java — Maven

**Requirements:** Java **17** or newer.

> [!NOTE]
> **Pre-release**
>
> Not on Maven Central yet. Once it is, the library is one dependency:

```xml
<dependency>
  <groupId>io.github.nickliapin</groupId>
  <artifactId>tdcv2</artifactId>
  <version>1.0.0</version>
</dependency>
```

Until then, build it from a checkout:

```bash
cd java && ./gradlew build
```

**The command line is a separate artifact, and stays one after release.** Maven
has no equivalent of npm's `bin` — adding a library to a project does not put a
command on your PATH — so the CLI ships as one self-contained jar that needs
nothing but a JDK:

```bash
cd java && ./gradlew cliJar
java -jar build/libs/tdcv2-*-cli.jar demo.tdc
```

Worth an alias: `alias tdcv2='java -jar /path/to/tdcv2-cli.jar'`, after which
every command on these pages reads the same as it does for the other two.

The DSL and behavior are identical to the npm version. See
[Language bindings — Java](../bindings/java.md#top) for the API.

#### .NET — NuGet

**Requirements:** .NET **6.0** or newer.

> [!NOTE]
> **Pre-release**
>
> Not on NuGet yet. Once it is, the library is one package and the command line is
> one tool:

```bash
dotnet add package Tdcv2
dotnet tool install -g Tdcv2.Cli
tdcv2 demo.tdc
```

Until then, build it from a checkout:

```bash
cd csharp && dotnet build
dotnet run --project Tdcv2.Cli.Tool -- demo.tdc
```

Unlike Maven, .NET does have an answer to npm's `bin` — a tool package — so
`tdcv2` lands on your PATH the same way it does with npm and pip, and every
command on these pages reads identically.

The DSL and behavior are identical to the npm version.

#### Rust — Cargo

**Requirements:** Rust **1.74** or newer.

> [!NOTE]
> **Pre-release**
>
> Not on crates.io yet. Once it is, one crate carries both the library and the
> command line:

```bash
cargo add tdcv2
cargo install tdcv2
tdcv2 demo.tdc
```

Until then, build it from a checkout:

```bash
cd rust && cargo build --release
./target/release/tdcv2 demo.tdc
```

The crate takes **no dependencies**, so the build needs nothing but a Rust
toolchain. HTTPS is the one exception: `tdcv2 pack` shells out to `curl`, and
says how to install it if there is none.

The DSL and behavior are identical to the npm version.

## Verify it works

Create a file called `demo.tdc`. It declares two columns and one line of output. The name
is picked from a list with [`type="text"`](../generators/text.md#top), and the age is drawn
from a range with [`type="number"`](../generators/number.md#top):

```xml
<tdc>
    <env count="3" seed="demo">
        <sequence name="Name">
            <gen type="text" value="Alice,Bob,Carol,David,Emma"/>
        </sequence>
        <sequence name="Age">
            <gen type="number" value="18..65"/>
        </sequence>
    </env>

    <block>
        <line>
            <data>${{Name}}, age ${{Age}}</data>
        </line>
    </block>
</tdc>
```

Run it with whichever command your install gave you. **Node.js is on npm**; the
other four are not on their registries yet, so for those the route today is a
checkout of the repository, and the last column is what it will be once they ship:

| Installed with | Today | Once published |
| :--- | :--- | :--- |
| Node.js | `npx tdcv2 demo.tdc` | — already there |
| Python | `.venv/bin/tdcv2 demo.tdc` | `tdcv2 demo.tdc` |
| Java | `java -jar java/build/libs/tdcv2-*-cli.jar demo.tdc` | the same |
| C# | `dotnet run --project csharp/Tdcv2.Cli.Tool -- demo.tdc` | `tdcv2 demo.tdc` |
| Rust | `cargo run --bin tdcv2 -- demo.tdc` | `tdcv2 demo.tdc` |

From the repository root, `./run demo.tdc` is the shortest of them all.

`tdcv2 demo.tdc`

```
Emma, age 59
David, age 18
Carol, age 53
```

> [!IMPORTANT]
> The exact names and numbers are illustrative — they can differ between core
> versions. What matters is that `seed="demo"` makes the run reproducible: the same
> config with the same seed gives you the same output every time.

If you get three lines of `Name, age N`, the install works. Run it a second time
to confirm — the three rows come back identical. Then override the row count and
the seed from the command line, without touching the file:

```bash
tdcv2 demo.tdc --count 20 --seed alt
```

## Install data packs (optional)

Names, cities, states, companies, and other value lists ship as **data packs**,
separately from the engine, so updating the library never overwrites your data.
A sensible default set (the top 1000 first names, for instance) is bundled, so
the example above runs without downloading anything. Larger and more specialized
sets are fetched on demand.

Setting this up takes two commands, `init` once and `pack add` for whatever you need.
`pack list` is there to show you the options:

```bash
tdcv2 init            # choose where packs live and the default locale
tdcv2 pack list       # see what the registry offers
tdcv2 pack add en usa # download and wire up the packs you want
```

`tdcv2 pack list` prints the catalog and marks what's already installed:

`tdcv2 pack list`

```
Available data packs:

  common   installed   Common (locale-agnostic)   0.0 MB
  en                   English (language)          0.1 MB
  usa                  United States (country)     0.0 MB
```

Packs **compose** along independent axes — language, country, and a
locale-agnostic `common` — so US data in English is `common` + `en` + `usa`. The
full workflow (the config file, pack shadowing, removing packs) is covered in
[Installing data packs](../data-packs/installing-packs.md#top).

## What's next

- **[Your first dataset](first-data.md#top)** — write, run, and extend a config in three minutes.
- **[CLI reference](../reference/cli.md#top)** — every flag: `--seed`, `--count`, `--output`, `--locale`, `--data-path`, and exit codes.
- **[Installing data packs](../data-packs/installing-packs.md#top)** — the full `init` / `pack` workflow.

---

← Previous: [Introduction](../intro.md#top) · **[Contents](../README.md#top)** · Next: [Your first dataset](./first-data.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/getting-started/installation)**
