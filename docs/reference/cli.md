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
  `--engine 2`. `--mode` describes a cost instead, and a run that describes a cost may still
  be handed to a different engine.

  `--engine 2` **refuses** anything it cannot stream, so a measurement measures what it says
  it does. `--engine 3` refuses in one case only — a `uniq` too tight for its bounded repair
  — and otherwise falls back to the in-memory engine and prints its bytes, exit 0 and no
  message. That is narrow on purpose: the shapes engine 3 falls back on are the ones the
  lazy path cannot express at all, and covering them is what engine 3 is for. It does mean a
  memory measurement taken with `--engine 3` on a `stat`, a running total or a simple `uniq`
  is a measurement of engine 1. [Which engine runs your
  config](../guides/large-outputs.md#which-engine-runs-your-config) lists the shapes.

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
{
  "phase": "render",
  "done": 4200000,
  "total": 10000000,
  "percent": 42,
  "startedAt": 1787871050458,
  "updatedAt": 1787871083822,
  "pid": 51234
}
```

`startedAt` and `updatedAt` are milliseconds since the epoch. `updatedAt` is the one to
watch: it moves on every write, so a poller can tell a live run from a stopped one without
asking the filesystem for a modification time.

Each refresh writes `<output>.progress.tmp` and renames it over `<output>.progress`, so a
reader never catches a half-written file. The `.tmp` is visible beside the output while the
run lasts. `tdcv2 format -w` does the same with `<file>.tmp`.

The first write is `{"phase":"starting"}`, before any work has a number to report. It is
there so the file EXISTS from the first moment: a watcher that finds no file cannot tell
"not started yet" from "died", and starting a dozen workers on a large config takes
seconds.

Then the phases, in this order when they occur: `uniq-scan` (every row's tuple hashed),
`uniq-sort` (the piles sorted), `uniq-repair` (the tuples that repeat checked and
rearranged) and `render` (rows written).

**Which of them a run reports depends on the engine, and cannot be known in advance.**
Measured on one config with a `<uniq>`: the in-memory engine reports `render` alone; the
streaming engine at 300,000 rows reports `uniq-repair` then `render`; the same config at
1,500,000 rows, where the run splits across workers, reports all four. And the plan is not
even fixed once it starts — the streaming engine can find a config it cannot express, give
up part way, and hand the whole run to the in-memory engine, which reports `render` and
nothing else.

That is why the file carries no phase COUNT. A "phase 2 of 4" published at the start would
be a number this run might never reach, and a progress bar built on it would jump — which
is the one thing a progress bar must not do. Draw the phase and its own numbers; they are
always true.

`uniq-repair` carries no `done`/`total` on a parallel run — the arrangement is worked out
in one call there rather than in steps that could be counted — so it reports the phase
alone. On a large `uniq` run
No one of them dominates: measured at 6,000,000 rows over 900,000,000 possible pairs,
writing the rows took 17 seconds, hashing every tuple 12, sorting the piles 3 and the repair
7, of about 40 in all.

Within a phase the numbers only ever rise, and a phase ends at its own total — so a bar
drawn from them never jumps backwards and never stops short of full. `uniq-repair` is
several steps of different kinds reported on one growing scale, so its total is what the
repair has taken on so far rather than something known in advance.

The last write is `{"phase":"done","percent":100,...}` with the wall-clock seconds the run
took.

Two things make it safe to poll. The file is replaced atomically, so a reader never sees
half a JSON object. And it is **rewritten at least once a second** whether or not the work
has anything new to say — the last state again, with a fresh `updatedAt` — so a file that
has not moved for minutes means the process is gone, whatever the content still says.

That heartbeat is best-effort, and worth knowing precisely. It is a timer inside the same
process, so a stretch of uninterrupted computation can hold it off: measured on a
1,500,000-row `uniq` run, the longest silence was 10.9 seconds, during the repair. Before
the timer existed the same shape of run went 2 minutes 16 seconds without a write while
perfectly healthy — long enough for a watcher following this page to call it dead. Judge
liveness in minutes, not seconds, and it holds.

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
