<a name="top"></a>

**English** · [Русский](../ru/getting-started/first-data.md#top) · [Español](../es/getting-started/first-data.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/getting-started/first-data)**

← Previous: [Installation](./installation.md#top) · **[Contents](../README.md#top)** · Next: [Editor support](./editor-support.md#top) →

---

# Your first dataset

You describe what a row is made of, and the engine builds as many rows as you ask for. The
same `seed` always returns the same output, and the shape of that output — plain text, CSV,
JSON, SQL — is yours to define with a row template.

This page walks through a small config: write it, run it, override it from the command
line, and then make one field depend on another.

## Step 1 — Write the simplest config

Create a file called `demo.tdc`:

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
        <line><data>${{Name}}, age ${{Age}}</data></line>
    </block>
</tdc>
```

What each part does:

- [`<env>`](../core-concepts/configuration.md#top) with `count="3"` — generate **3**
  rows; `seed` pins down the randomness so the result
  [repeats](../core-concepts/determinism.md#top) from run to run.
- [`<sequence>`](../core-concepts/sequences.md#top) — a **column** of data; the
  [`<gen>`](../generators/overview.md#top) inside says where its values come from
  (here, a random name from a list).
- [`type="text"`](../generators/text.md#top) — pick one value from a comma-separated
  list.
- [`type="number"`](../generators/number.md#top) with `value="18..65"` — a random
  number from a range.
- [`<block>`](../core-concepts/output-formatting.md#top) / `<line>` / `<data>` — the
  **template for one output row**; `${{Name}}` is replaced by that column's value.

## Step 2 — Run it

The quickest way, from the repository root:

```bash
./run demo.tdc        # run any file of your own
```

Under the hood that's the engine's CLI. The long form is:

```bash
node typescript/dist/cli/main.js demo.tdc
```

Once the package is published, you'll be able to run it from anywhere:

```bash
npm install -D tdcv2
npx tdcv2 demo.tdc
```

If the engine hasn't been built yet (no `typescript/dist` folder), build it once.
[Installation](installation.md#top) covers all of this.

## Step 3 — Look at the output

Because `seed="demo"` fixes the randomness, the output is the same on every run:

`./run demo.tdc`

```
Emma, age 59
David, age 18
Carol, age 53
```

> [!IMPORTANT]
> The exact names and numbers here are illustrative — they can change between core
> versions. The point is that the same seed always reproduces the same output on a
> given core version.

### Overriding count and seed from the command line

You can change the row count and the seed without touching the file. That helps
when the config is fixed — checked into a repo, say — but you want a different
volume or a different draw for a one-off run:

```bash
./run demo.tdc --count 5 --seed alt
```

`./run demo.tdc --count 5 --seed alt`

```
Alice, age 20
Bob, age 48
Carol, age 65
Emma, age 22
David, age 22
```

A new seed gives you a different set that's just as reproducible: rerun with
`--seed alt` and these exact five rows come back. The full list of flags is in
the [CLI reference](../reference/cli.md#top).

## A step further — dependent fields

Fields can depend on each other. Here the name comes from either the male or the female
list, depending on the gender the row landed on. That is what the `parent` attribute does.
`${{_count}}` is the row number:

```xml
<tdc>
    <env count="5" seed="demo">
        <sequence name="Gender">
            <gen type="text" value="Male,Female" percent="50,50"/>
        </sequence>

        <sequence name="MaleName" parent="Gender.Male">
            <gen type="template" value="person.male.firstName"/>
        </sequence>

        <sequence name="FemaleName" parent="Gender.Female">
            <gen type="template" value="person.female.firstName"/>
        </sequence>

        <sequence name="Age">
            <gen type="number" value="18..80"/>
        </sequence>
    </env>

    <block>
        <line><data>${{_count}}. ${{Gender}} — ${{MaleName}}${{FemaleName}}, age ${{Age}}</data></line>
    </block>
</tdc>
```

`./run people.tdc`

```
1. Male — John, age 72
2. Male — James, age 18
3. Female — Elizabeth, age 64
4. Female — Mary, age 26
5. Male — Robert, age 32
```

Two things are new here:

- [`percent="50,50"`](../generators/text.md#top) makes the [`text`](../generators/text.md#top)
  generator split the rows between `Male` and `Female` in that exact ratio, instead of
  picking uniformly at random. Over five rows that is three and two.
- [`type="template"`](../generators/template.md#top) with `value="person.male.firstName"`
  pulls a real first name from the built-in `person.*` data, resolved for the
  active locale — so English names under the default `en`.

`MaleName` is filled only on male rows and `FemaleName` only on female ones, so
`${{MaleName}}${{FemaleName}}` prints exactly one name and that name always matches the
gender. The two fields cannot drift apart.
[Hierarchical dependencies](../guides/hierarchical-dependencies.md#top) covers this in depth.

## Using TDC from your code

The config is identical in every language; only the host-language call changes.

#### TypeScript

```typescript
import { TDC } from "tdcv2";

const data = new TDC({ configFile: "demo.tdc" });
console.log(data.toString());
```

#### Python

```python
from tdcv2 import TDC

data = TDC(config_file="demo.tdc")
print(data.to_string())
```

#### Java

```java
var data = new TDC("demo.tdc");
System.out.println(data.toString());
```

#### C#

```csharp
var data = new Tdc("demo.tdc");
Console.WriteLine(data);
```

#### Rust

```rust
let data = tdcv2::Tdc::from_file("demo.tdc")?;
println!("{data}");
```

> [!NOTE]
> All five implementations are complete and produce the same bytes; TypeScript is the
> reference the others are held to. Each has its own page:
> [TypeScript](../bindings/typescript.md#top), [Python](../bindings/python.md#top),
> [Java](../bindings/java.md#top), [C#](../bindings/csharp.md#top),
> [Rust](../bindings/rust.md#top).

## What's next

- **[Configuration structure](../core-concepts/configuration.md#top)** — `<tdc>`, `<env>`, and how a config is organized.
- **[Hierarchical dependencies](../guides/hierarchical-dependencies.md#top)** — fields conditioned on other fields.
- **[Template values](../generators/template.md#top)** — `person.*`, `date.*`, `location.*`, and the rest of the built-in data.
- **[CLI reference](../reference/cli.md#top)** — the full command line, tags, attributes, and generators.

---

← Previous: [Installation](./installation.md#top) · **[Contents](../README.md#top)** · Next: [Editor support](./editor-support.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/getting-started/first-data)**
