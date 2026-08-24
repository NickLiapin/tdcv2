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
| `-o, --output <path>`   | Write to a file. Without it, output goes to stdout. A path ending in `.parquet` selects the [Parquet](../guides/typed-output-parquet.md#top) writer — the only way to get it |
| `--seed <seed>`         | Override the `seed` from `<env>`                    |
| `--count <n>`           | Override the `count` from `<env>` — a non-negative integer |
| `--locale <loc>`        | Override the locale (default `en`)                  |
| `--now <date>`          | Pin the clock that `today`, `now` and `b_day` read  |
| `--data-path <dir>`     | Add a data folder for `@data/…` (repeatable)        |
| `--jobs <n>`            | Number of worker threads, a positive integer (TDC picks one by default) |
| `--mode <memory\|disk>` | Engine: `disk` (default) or `memory`                |
| `--engine <1\|2\|3>`    | Force a specific engine (advanced)                  |
| `--disk`                | Shortcut for `--mode disk` — already the default    |
| `--progress`            | Write `<output>.progress`, a small JSON status file (needs `-o`) |
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

## `--progress` — watching a long run

A run of a hundred million rows is silent for a long time, and silence looks exactly like
a hang. `--progress` writes a small JSON file beside the output — `<output>.progress` —
and rewrites it about once a second:

```bash
tdcv2 demo.tdc -o out.csv --progress
```

```json
{ "phase": "render", "done": 4200000, "total": 10000000, "percent": 42, "pid": 51234 }
```

The phases in order: `uniq-scan` (every row's tuple hashed), `uniq-sort` (the piles
sorted), `uniq-repair` (the tuples that repeat checked and rearranged) and `render` (rows
written); a run without a `<uniq>` only ever reports `render`. On a large `uniq` run
`uniq-repair` is usually the longest of the four — measured at 6,000,000 rows it was 56 of
74 seconds — so that is the one to expect a wait in.

Within a phase the numbers only ever rise, and a phase ends at its own total — so a bar
drawn from them never jumps backwards and never stops short of full. `uniq-repair` is
several steps of different kinds reported on one growing scale, so its total is what the
repair has taken on so far rather than something known in advance.

The last write is `{"phase":"done","percent":100,...}` with the wall-clock seconds the run
took.

Two things make it safe to poll. The file is replaced atomically, so a reader never sees
half a JSON object. And its **modification time is the heartbeat**: a file that has not
moved for minutes means the process is gone, whatever the content still says.

It needs `-o` — the status file lives beside the output, so without an output there is
nowhere to put it, and the command says so rather than accepting the flag and dropping it.

A run split across workers is counted whole. Every worker reports the rows it has
written and the coordinator adds them up, so the percent is the file's and not one
worker's — which matters, because above a hundred thousand rows TDC splits the run by
itself unless you say otherwise.

A [Parquet](../guides/typed-output-parquet.md#top) run reports too, once per row group of
fifty thousand rows. Coarser than the text path on purpose: a row group is the unit that
writer works in, and there is no moment inside one where a partial group means anything.
If the percent ever runs to the end and then starts again, that is a run being walked
twice — worth reporting as a bug rather than living with.

The same channel is on the library in every implementation, as a callback taking
`(phase, done, total)`.

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

`--brief` is the only flag `check` takes. It prints one line per diagnostic — code,
position, message, hint — with no source excerpt, for editors, CI and anything else that
reads the output rather than looking at it:

`tdcv2 check --brief demo.tdc`

```
TDC041 1:70 unknown gen type "nosuch" :: Allowed types: text, file, template, number, regex, advanced_regex, … (11 more).
```

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
|  `2` | Bad CLI arguments — and any `pack` or `init` failure (a download, a checksum, an existing config) |

## See also

- **[Installing packs](../data-packs/installing-packs.md#top)** — `tdcv2 init`, `tdcv2 pack`.
- **[Large outputs](../guides/large-outputs.md#top)** — `--jobs`, `--mode`, `--engine` in depth.

---

← Previous: [Writing your own](../data-packs/writing-your-own.md#top) · **[Contents](../README.md#top)** · Next: [Tags](./tags.md#top) →

📖 **[Read this on the documentation site →](https://nickliapin.github.io/tdcv2/docs/reference/cli)**
