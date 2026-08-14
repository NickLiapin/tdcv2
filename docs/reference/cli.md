<a name="top"></a>

**English** · [Русский](../ru/reference/cli.md#top) · [Español](../es/reference/cli.md#top)

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/cli)**

← Previous: [Writing your own](../data-packs/writing-your-own.md#top) · **[Contents](../README.md#top)** · Next: [Tags](./tags.md#top) →

---

# CLI reference

The `tdcv2` command reads a `.tdc` config, generates the data, and writes it to a file or
to standard output. No code of your own is involved.

```bash
tdcv2 <input.tdc> [options]
```

> [!NOTE]
> **Where `tdcv2` comes from**
>
> `npm install -D tdcv2`, `pip install tdcv2` and `cargo install tdcv2` each put `tdcv2` on
> your PATH from the package that carries the library. Maven and NuGet have no equivalent of
> npm's `bin`, so for Java and C# the command line is a second artefact —
> [Installation](../getting-started/installation.md#top) has the tab for each. An alias makes
> every command on this page read the same. Everything below is identical whichever
> implementation you run.

Besides generating, the CLI has `tdcv2 init` and `tdcv2 pack` for setup and data — see
[Installing packs](../data-packs/installing-packs.md#top) — plus `tdcv2 check`
([below](#tdcv2-check)) and `tdcv2 format` ([below](#tdcv2-format)).

## Options

| Option                  | What it does                                        |
| :---------------------- | :-------------------------------------------------- |
| `-o, --output <path>`   | Write to a file. Without it, output goes to stdout  |
| `--seed <seed>`         | Override the `seed` from `<env>`                    |
| `--count <n>`           | Override the `count` from `<env>`                   |
| `--locale <loc>`        | Override the locale (default `en`)                  |
| `--now <date>`          | Pin the clock that `today`, `now` and `b_day` read  |
| `--data-path <dir>`     | Add a data folder for `@data/…` (repeatable)        |
| `--jobs <n>`            | Number of worker threads (TDC picks one by default) |
| `--mode <memory\|disk>` | Engine: `disk` (default) or `memory`                |
| `--engine <1\|2\|3>`    | Force a specific engine (advanced)                  |
| `--disk`                | Shortcut for `--mode disk` — already the default    |
| `--stream`              | Legacy alias for `--engine 2`                       |
| `-h, --help`            | Show help                                           |
| `-v, --version`         | Show version                                        |

Long options also accept `=`: `tdcv2 demo.tdc --output=out.csv --count=100`.

The examples below all use this `demo.tdc`:

```xml
<tdc>
  <env count="10" seed="demo" local="en">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="City"><gen type="text" value="Moscow,Berlin,Paris" order="sequential"/></sequence>
    <sequence name="Status"><gen type="text" value="new,active,closed"/></sequence>
    <before><line><data>Id,City,Status</data></line></before>
  </env>
  <block><line><data>${{Id}},${{City}},${{Status}}</data></line></block>
</tdc>
```

`./run demo.tdc`

```
Id,City,Status
1,Moscow,closed
2,Berlin,new
3,Paris,closed
4,Moscow,new
5,Berlin,closed
6,Paris,new
7,Moscow,new
8,Berlin,active
9,Paris,active
10,Moscow,active
```

## `--seed` — override the randomness

The config bakes in one seed. When you want a different set without editing the file,
`--seed` overrides it. The counter (`Id`) and cycling (`City`) columns don't depend on the
seed, so only `Status` changes.

## `--count` — how many rows

`--count 4` renders four rows. Positional columns (counters, cycling text) give
you the first four values of the same sequence; exact-proportion columns (`percent`,
`<mix>`) and `uniq` recompute against the new total. See
[Determinism & proportions](../core-concepts/determinism.md#top).

## `--output` — write to a file

`-o` (or `--output`) writes to a file; nothing goes to stdout:

```bash
tdcv2 demo.tdc -o out.csv
```

## `--locale` — the language of template data

Template generators (names, cities) default to English; `--locale ru` switches the whole
file to Russian, field for field.

## `--now` — pin the clock

Some generators read the clock: `value="today"`, `value="now"`, `person.b_day` (an age
window measured back from today) and a `date` generator given no bounds at all. They are
meant to — a birthday that tracks today is the point. But it makes the clock an input
to the run alongside the config and the seed, and the one input you cannot write down.
The same file with the same seed gives you different rows tomorrow.

`--now` writes it down:

```bash
tdcv2 people.tdc --seed demo --now 2026-04-23 -o out.csv
```

Run that in a year and you get the same bytes. Drop the flag and the run reads the real
clock, which is what you want in production and not what you want in a test.

The value is a date in the same syntax `<gen type="date" value="…">` takes — `2026-04-23`,
or `2026-04-23T09:30:00` when the hour matters. There is no time zone: every date in TDC
is UTC. A value TDC cannot read is an error, not a shrug back to the real clock:

```
tdcv2: invalid --now "yesterday" — expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss (UTC)
```

## `--data-path` — external data

When a config reads `src="@data/…"`, the CLI needs to know where `data/` lives. Pass it
with `--data-path` (repeatable — the folders are searched in order):

```bash
tdcv2 demo.tdc --data-path ./data --data-path ./private-data -o out.csv
```

A bare relative `src="names.txt"` is looked up next to the `.tdc` file first, then in the
`--data-path` folders.

## Speed and engines — `--jobs`, `--mode`, `--engine`

You usually need none of these — TDC picks the engine from the config and decides for
itself whether to parallelize. In short:

- **`--jobs N`** — set the worker count by hand. This is **only about speed**: the output
  is byte-identical to a single-threaded run.
- **`--mode memory`** — the small in-RAM engine, an escape hatch for small datasets and
  the object API. It produces the **same values** as the other engines
  ([determinism](../core-concepts/determinism.md#top)); it simply holds every column in RAM
  instead of streaming it.
- **`--engine 1|2|3`** — force a specific engine; `--stream` is a legacy alias for
  `--engine 2`.

TDC works out how many threads fit in this machine's RAM and uses that many, so on a weak
machine a run just takes longer instead of dying halfway through. Full details in
[Large outputs](../guides/large-outputs.md#top).

## `tdcv2 check`

Reads a config, validates it, and generates nothing. What you want in a pre-commit hook
or a CI step: it answers "would this run?" without spending the time to run it.

```bash
tdcv2 check demo.tdc
```

Everything goes to stderr — a valid config gets one line, an invalid one gets the same
diagnostics `tdcv2 demo.tdc` would print. **Nothing goes to stdout**, deliberately: a
hook's stdout is noise, and a caller that wants the data runs the generator instead.

`tdcv2 check demo.tdc`

```
tdcv2: demo.tdc is valid
```

Warnings do not fail the check — they are printed and the exit code stays `0`, because a
warning describes something that works but probably is not what you meant. Only an error
exits `1`.

## `tdcv2 format`

Tidies up a `.tdc` file — indentation, attribute spacing, aligned `<map>` tables. It's
the same formatter the editor uses.

```bash
tdcv2 format demo.tdc        # print the formatted config to stdout
tdcv2 format -w demo.tdc     # rewrite the file in place (-w / --write)
```

Formatting **never changes** what a config generates. If the file has a syntax error,
the formatter reports it and leaves the file untouched (exit code 1).

## Exit codes

| Code | Meaning                                         |
| ---: | :---------------------------------------------- |
|  `0` | Successful generation, `--help`, or `--version` |
|  `1` | A read, parse, validation, or runtime error     |
|  `2` | Bad CLI arguments                               |

## See also

- **[Installing packs](../data-packs/installing-packs.md#top)** — `tdcv2 init`, `tdcv2 pack`.
- **[Large outputs](../guides/large-outputs.md#top)** — `--jobs`, `--mode`, `--engine` in depth.

---

← Previous: [Writing your own](../data-packs/writing-your-own.md#top) · **[Contents](../README.md#top)** · Next: [Tags](./tags.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/cli)**
