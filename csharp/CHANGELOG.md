# Changelog — `Tdcv2` on NuGet

What changed for someone who installs this package (dotnet add package).

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
this package: the assembly and its library API.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.4] — 2026-08-03

### Added

- **A pack file that lands at no address is now named — TDC171.** A file carrying
  a `---` header whose path starts with no locale, country or `common`, and whose
  header does not say where it belongs, was dropped in silence; the author met it
  later as "unknown template path" about a file sitting in their own folder. Both
  halves are now reported. The scan stays lazy — it runs when a lookup has
  already missed, which is when the author is looking — so an ordinary run pays
  nothing for it.

- **`Tdcv2.Cli`, a second package: the command line.** `dotnet tool install -g
Tdcv2.Cli` puts `tdcv2` on your PATH, the same command the npm, pip and cargo
  packages already carry.

  It has to be a separate package. NuGet has no equivalent of npm's `bin`, so a
  tool is a package kind of its own and cannot be an extra file inside `Tdcv2`.
  Both go out together, at one version, from one tag — a command line one release
  behind the library it drives would be a puzzle nobody should have to solve.

  The tool bundles the library's assembly rather than depending on it, so the
  starter data packs ride along inside. `scripts/verify-tool.mjs` installs the
  built package into a directory outside the repository and compares a run with
  the TypeScript reference, because that is the only way to see data that is
  missing from an artefact but present a few directories up.

- **The memory preflight, `TDC200` and `TDC201`.** `Tdc.Preflight()` estimates
  what a run will cost in RAM before generating anything: a warning when it is a
  large share of the machine, a refusal when it cannot plausibly fit. The command
  line prints it and exits 1 on the refusal, as the other four implementations do.
  A config that will not fit now says so in a millisecond instead of taking
  minutes to say so by thrashing.

- **`Tdc.WriteFile(path, workers)` — one run written by several threads.** Every
  draw is keyed by seed, stream and row index, so a shard is a range of rows and
  needs no coordination with any other. The worker count therefore never changes
  the bytes, only how long they take; zero means "decide from the machine". It
  applies to the streaming engine only, and everything else writes on one thread.
  `WriteFile(path)` on its own is unchanged: still one thread.

- **`Engine` and `Mode` on `Tdc.Options`.** Name an engine outright (1 in memory,
  2 streaming, 3 exact on disk) or state the constraint and let the router pick.
  Either beats what `<env>` declared.

### Changed

- **One folder for downloaded packs, not three levels of near-duplicate names.**
  `tdcv2 pack add ru russia` used to leave `data/ru/packs/ru/…` and
  `data/russia/packs/countries/russia/…`, and appended a `dataPaths` entry per
  bundle — a hundred packs meant a hundred entries. Both extra levels belonged to
  the tooling rather than to the data: `<store>/<id>/` existed so removal could
  delete one folder, and `packs/` came out of the archive. They are gone. Every
  bundle now unpacks into ONE tree at its address path — `data/ru/…`,
  `data/countries/russia/…` — and the store is registered once.

  What each bundle owns is written down in `<store>/.tdcv2-installed.json`
  instead of implied by a folder name, so `pack remove` deletes exactly the paths
  that bundle brought and leaves the country beside it alone. The new
  `Tdcv2.Packs.PackStore` holds that bookkeeping, and `PackRegistry.Install` now
  answers with the file count and the paths rather than a folder to register.

  A store from an earlier version is moved to the new shape in place, by the
  first `tdcv2 pack` command of any kind, which also replaces the per-bundle
  `dataPaths` entries with the store and says on stderr what it moved. Nothing
  has to be downloaded again. If a path in the new layout is already taken the
  move is refused whole, with the collisions named, rather than half-done.

### Fixed

- **`tdcv2 --version` printed 0.1.0.** The number was a constant in the source
  that no release ever bumped, so it agreed with itself and with nothing else. It
  now comes from the assembly, which cannot drift from the package.

- **`--engine`, `--mode`, `--disk` and `--jobs` were parsed and then discarded.**
  Every one of them is now honoured: a named engine overrides the router, a mode
  sets the routing constraint, and `--jobs` splits the write. All four outrank
  `<env>` — a flag typed on this run is a more recent statement of intent than a
  line in the file.

- **A config the router sent to the streaming engine could be refused outright.**
  A running total, an env-level `<distinct>` over a `<mix>`, a pool reference
  under a parent: nothing in their shape says the streaming engine cannot build
  them, so the router sent them there and the refusal reached the user. The other
  four implementations fall back to the in-memory engine and render them. This
  one now does too — but only when the ROUTER chose. `engine="2"`, `--engine 2`
  and the older `mode="stream"` still refuse, because forcing an engine is a
  request to be told when it cannot do the job, and answering from a different
  engine would hide exactly that.

  A parallel write that fails now reports why. Every worker builds the same
  config, so they fail identically, and "a worker failed" was hiding the one
  sentence that explains the run.

- **`-o out.parquet` wrote text into a file named `.parquet`.** The writer was
  reachable only by calling `ParquetOutput` directly. The extension is the switch
  now, as it is in the reference and in the Java and Python ports: a `.parquet`
  target (in any case) gets the typed binary form, byte for byte what the
  reference writes for the same config and seed. Parquet is written by one thread
  whatever `--jobs` asks, because the file is a single framed container with a
  footer rather than a concatenation of pieces.

- **A syntax error underlined whatever started at its position.** The carets are
  measured off the source line — a value runs to its closing quote, an element to
  its closing tag — which is right for a validator complaint and wrong for the
  parser's, which names a character and says nothing about what ends. An unclosed
  `<data pair="…">` was underlined through the whole element, where the reference
  marks the one character. Positions and codes are unchanged; only the width is.

## [0.1.3] — 2026-08-02

The first release to NuGet. Everything below is what changed in this
implementation on the way there; the engine itself has been at parity with the
TypeScript reference since before it, held there by the shared fixtures under
`fixtures/cross-language/`.

### Added

- **The quick API** — one call, one value, no config file, answered from the same
  data packs a config draws on. See the binding's README for the shape it takes
  here.

### Fixed

- **The package shipped without any data at all.** It looked for packs beside the
  assembly and then walked up for `data/packs` — which works in a checkout and
  cannot work in `~/.nuget/packages`, where an installed package has nothing above
  it. The .nupkg held 6 files and none of them data, so `dotnet add package Tdcv2`
  produced an assembly that threw `no data packs found` on the first
  `type="template"`. All 775 tests were green: every test runs inside the
  repository.

  The starter set is embedded in the assembly now — the same `common`, `en` and
  USA the other four carry, under the same `tdc/packs/…` resource names the jar
  uses. The package is 384 KB. A folder on disk still wins, so a downloaded pack
  shadows it.

  `scripts/verify-package.mjs` is the guard: it packs the project, installs it
  into a console app OUTSIDE the repository, runs three pack-backed columns and
  compares them with the TypeScript reference. No in-repo test can see this class
  of bug.

- **Pack parameters now work.** A pack whose body declares
  `<sequence name="domain">` accepts `domain="…"` from the caller, and the
  engine replaces that sequence with the constant. This implementation refused
  the whole config with `TDC015`, so a `.tdc` file that ran under the
  TypeScript reference failed here.
