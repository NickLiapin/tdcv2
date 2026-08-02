<a name="top"></a>

**English** · [Русский](../ru/data-packs/installing-packs.md#top) · [Español](../es/data-packs/installing-packs.md#top)

← Previous: [Overview](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Writing your own](./writing-your-own.md#top) →

---

# Installing packs: `init` and `pack`

Names, cities, states, companies, and other lists are [**data packs**](overview.md#top).
They ship **separately from the engine**, so updating the library never overwrites your
data, and heavy sets don't bloat every install. A sensible default set is bundled (the
top 1000 first names, for instance); the full and extra sets are fetched on demand with
`tdcv2 pack`.

The whole flow is two commands, and the order matters:

1. `tdcv2 init` **once per project** — decide **where** downloaded data lives.
2. `tdcv2 pack add …` — fill that place with the sets you actually need.

`init` comes first because it answers a question `pack` cannot: which folder is
*yours*. Packs deliberately do not live inside the installed library — if they did,
every `npm update`, `pip install -U` or dependency bump would wipe a gigabyte of data
you chose. `init` writes down a folder that belongs to your project, and every
implementation reads that same file, so a pack downloaded once is found by all of them.

Skip `init` and `pack` has nowhere to put anything, and says so rather than guessing:

`tdcv2 pack list (no config yet)`

```
tdcv2: no pack store configured — run `tdcv2 init` first
```

> [!TIP]
> **The same commands in every language**
>
> `init` and `pack` are part of every implementation, not just the Node one. The
> commands, their output and the config file they write are identical — held there by a
> shared test fixture all five run against the same expected bytes. Only how you invoke
> them differs.
>
> ```bash
> npx tdcv2 init                              # Node
> tdcv2 init                                  # Python, Rust or C#, once installed
> java -jar tdcv2-cli.jar init                # Java
> ```
>
> A project set up by one of them is ready for the other four — same config file, same
> store, same registry.

> The example outputs below are illustrative: exact file counts, sizes, and paths
> depend on your machine and the core version, but the shape holds.

## `tdcv2 init` — set up a project

`init` writes a config file so you never have to hand-edit JSON. In an interactive
terminal it runs a short wizard: where to store the config, where to download packs,
which locale is the default. In a script or in CI, pass flags instead so nothing blocks
on a prompt.

```bash
tdcv2 init            # ask, then write
```

`tdcv2 init`

```
Wrote project config: /path/to/project/tdcv2.config.json
  data packs → /path/to/project/tdcv2-packs
  locale     → en

Next: run `tdcv2 pack` to download data packs into that folder.
```

Use it once per project, before your first `tdcv2 pack add`. Each flag below covers a
case where the wizard would get in your way.

### `--yes` / `-y` — no questions

Skips every prompt and accepts the defaults (project-local config, `./tdcv2-packs`,
`en`). This is the flag for CI and scripts, where nobody is around to answer the
wizard's questions.

```bash
tdcv2 init --yes
```

`tdcv2 init --yes`

```
Wrote project config: /path/to/project/tdcv2.config.json
  data packs → /path/to/project/tdcv2-packs
  locale     → en
```

### `--global` / `-g` — one config for every project

Writes the config into your home directory (`~/.config/tdcv2`) instead of the current
folder. Use it when you want one shared data store that every project on the machine
reads from, rather than a separate `tdcv2-packs` folder in each repo.

```bash
tdcv2 init --global
```

`tdcv2 init --global`

```
Wrote global config: /Users/you/.config/tdcv2/tdcv2.config.json
  data packs → /Users/you/.config/tdcv2/tdcv2-packs
  locale     → en
```

### `--force` / `-f` — overwrite an existing config

By default, `init` refuses to clobber a config that already exists. Pass `--force` when
you deliberately want to reset it — to change the pack folder, say, or to start clean.

`tdcv2 init (config already exists)`

```
Config already exists: /path/to/project/tdcv2.config.json
Nothing written. Re-run with --force to overwrite.
```

### `--locale <loc>` — pick the default locale

Sets the `locale` value in the config, so you don't have to name a locale on every run.
`en` is the built-in default; pass another code to make that one the project default.

```bash
tdcv2 init --yes --locale en
```

### `--data-path <dir>` — pick the pack folder

Sets where `pack add` downloads to (the `packStore`, below). Point it at a shared drive
or at a path outside the repo when you don't want packs living next to your source.

```bash
tdcv2 init --yes --data-path ../shared-tdc-packs
```

## The `tdcv2.config.json` file

`init` writes a small file like this:

```json
{
  "packStore": "./tdcv2-packs",
  "locale": "en"
}
```

- **`packStore`** — where `pack` downloads to. The folder itself is **not** scanned as
  data; on install, `pack` registers the individual pack roots in `dataPaths`.
- **`locale`** — the default locale (set by the `--locale` flag, above).
- **`dataPaths`** — the folders the engine actually scans for packs. `pack add` fills
  these in for you, and you can add your own folders here to point the engine at
  [packs you wrote yourself](writing-your-own.md#top).

The config is found by walking **up** from the current folder, the same way tools locate
`tsconfig.json`. When several sources define the same setting, priority runs low to high:

```
built-in packs  <  global config (~/.config/tdcv2)  <  project tdcv2.config.json  <  --data-path flag
```

Paths inside the file are resolved **relative to the file itself**, not to your current
working directory, so a config can travel with its project.

## `tdcv2 pack` — download and remove sets

Run with no arguments in a terminal, `pack` opens a **picker** rather than printing the
catalogue at you. 108 bundles do not fit on a screen, so they are browsed the way they
are shaped:

- **Everything**, or **choose what I need** — the first question, before anything else.
- Languages in one list; countries reached **through a continent**, off a map.
- `/` searches from anywhere: type `braz` and Brazil is there, labelled with its continent.
- <kbd>space</kbd> picks, and on a continent it takes **the whole continent** at once.
- <kbd>backspace</kbd>, <kbd>esc</kbd> or <kbd>←</kbd> steps back out of any screen.
- **Review** lists the basket with its total size; <kbd>space</kbd> drops anything you
  changed your mind about, <kbd>enter</kbd> applies. Nothing downloads before that.

The map shows what you have taken so far: the continent under the cursor lights up, and
each picked country burns a spark where it actually is. Press <kbd>m</kbd> to switch
between bare coastlines and filled land.

Every implementation opens the same picker, and the terminal decides how it is drawn:
half-blocks and colour where they exist, ASCII and a plain line drawing where they do not
(the old Windows console, a pipe, `NO_COLOR`). Java's and Rust's pickers need `stty` and
so are Unix-only; on Windows they print the list instead, which C# and Node do not have to
because their runtimes read a keystroke on their own.

In a script — or anywhere without a terminal — drive it with subcommands:

```bash
tdcv2 pack list              # what's in the registry
tdcv2 pack add en usa        # download and wire up
tdcv2 pack remove usa        # remove
```

Every subcommand also takes **`--registry <base-url>`**, which points `pack` at a
catalog other than the public one. The default is the project's own registry:

```bash
tdcv2 pack list --registry https://packs.example.internal/tdc
tdcv2 pack add en --registry=https://packs.example.internal/tdc
```

Use it for a company mirror or an air-gapped copy. The URL is a base — `pack` appends
the index and archive paths itself — and a trailing slash is ignored. The `sha256`
check still runs, so a mirror that serves altered bytes fails to install, the same way
the public registry would.

### `pack list` — see the catalog

Prints the registry, marks what you already have installed, and shows the download size
of each set.

`tdcv2 pack list`

```
Available data packs:

  common       ✓ installed  Common (locale-agnostic) (0.0 MB)
               Generators bound to neither a language nor a country: uuid,
               hashes, ISBN/ISSN, GTIN/UPC/EAN, card PANs, MRZ, IPv4/IPv6/MAC,
               semver, and more.

  ar                        Arabic (language) (0.1 MB)
               Content bound to the Arabic language rather than to any one
               country: address, airline, animal, book, clothing, color,
               commerce, company, date, education, event, finance, and 23 more.

  …

  yemen                     Yemen (country) (0.0 MB)
               Data specific to Yemen: docs, education, finance, geo, holiday,
               phone, sport.

Install with: tdcv2 pack add <id>
```

Descriptions are folded to your window, so the list stays a list however narrow the
terminal is. Piped or redirected there is no window to measure, and all three
implementations assume 80 columns — so a saved listing is the same file whichever one
wrote it.

The catalogue holds **108 sets today**: `common`, ten languages, and 97 countries. A
language or country that is not listed is not finished — an entry is a promise that every
address under it resolves, so a folder holding one file does not get one.

Use it to check what an address needs before you generate, and to confirm that a set
landed after `pack add`.

### `pack add <id…>` — download and register

`pack add` downloads the set's zip, verifies its `sha256` (a tampered or corrupted
download won't install), unpacks it, and **registers** the folder in your config, so the
data is live at its dotted addresses right away — no extra wiring step.

```bash
tdcv2 pack add en
```

`tdcv2 pack add en`

```
Installed en: 324 files → /path/to/project/tdcv2-packs/en
  registered ./tdcv2-packs/en/packs in /path/to/project/tdcv2.config.json
```

You can install several sets in one call — `tdcv2 pack add common en usa` — and that's
the normal way to assemble a locale (see [axis-pure packs](#packs-are-axis-pure) below).

### `pack remove <id…>` — delete and unregister

`pack remove` deletes the set's folder and removes its entry from `dataPaths`, so the
engine stops scanning it.

```bash
tdcv2 pack remove usa
```

`tdcv2 pack remove usa`

```
Removed usa (/path/to/project/tdcv2-packs/usa)
  unregistered from /path/to/project/tdcv2.config.json
```

Removing a set is safe: the [built-in default](#built-in-default-vs-downloaded) at those
addresses comes back on its own.

## Packs are axis-pure

Packs are organized along a **single axis** — a language, a country, or the
locale-agnostic `common` set — and they **compose**. US English data isn't one
monolithic pack; it's three layers stacked on top of each other:

```bash
tdcv2 pack add common en usa
```

`tdcv2 pack add common en usa`

```
Installed common: 145 files → /path/to/project/tdcv2-packs/common
  registered ./tdcv2-packs/common/packs in /path/to/project/tdcv2.config.json
Installed en: 324 files → /path/to/project/tdcv2-packs/en
  registered ./tdcv2-packs/en/packs in /path/to/project/tdcv2.config.json
Installed usa: 22 files → /path/to/project/tdcv2-packs/usa
  registered ./tdcv2-packs/usa/packs in /path/to/project/tdcv2.config.json
```

Which leaves a config naming all three, in the order they layer:

```json
{
  "packStore": "./tdcv2-packs",
  "locale": "en",
  "dataPaths": [
    "./tdcv2-packs/common/packs",
    "./tdcv2-packs/en/packs",
    "./tdcv2-packs/usa/packs"
  ]
}
```

This isn't a quirk of the file format. It reflects the fact that language and country
really are independent. English is shared by the US, the UK, and Canada, so it downloads
once as `en`, while country-specific data (US states, US area codes) lives in `usa`. Mix
and match to build whatever locale you need.

## Built-in default vs. downloaded

The built-in default set (shipped inside the package) is the **lowest layer**, and it's
always present. A downloaded set is laid **on top** and **shadows** the same addresses
without deleting anything underneath. Two things follow from that:

- install a full set → it **overrides** the default at those addresses;
- `pack remove` → the default **comes back** on its own. No hole in your data.

So installing and removing are both safe: the base set is never really deleted, only
shadowed for as long as a richer set sits above it.

## See also

- **[Data packs overview](overview.md#top)** — what a pack is and how dotted addresses work.
- **[Writing your own](writing-your-own.md#top)** — the pack file format and address rules.
- **[CLI reference](../reference/cli.md#top)** — the full command-line reference.

---

← Previous: [Overview](./overview.md#top) · **[Contents](../README.md#top)** · Next: [Writing your own](./writing-your-own.md#top) →
