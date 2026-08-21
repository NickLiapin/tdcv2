# Changelog — `io.github.nickliapin:tdcv2` on Maven Central

What changed for someone who installs this package (Gradle or Maven).

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
this package: the jar and the library API.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**A heading's date is load-bearing here, unlike in the other four changelogs.** Maven
Central caps how many releases it accepts from a project each month, so this jar is the
one artefact that can be built and signed at a version Central has not taken yet. Such
an entry is written `## [x.y.z] — not published`, and the documentation site reads this
file for the newest DATED heading and puts THAT number in every Maven coordinate, Gradle
line and jar URL it prints — so a reader is never handed a version that will not resolve.
Publishing means replacing `not published` with the date it went out; the pages follow on
the next build, and nothing else is edited.

## [Unreleased]

### Added

- **One vocabulary for the finished run, in all five implementations.** The object a run
  hands back now answers to the same names everywhere, spelled each language's own way.
  Added `toArray()`.

  Nothing is renamed and nothing is deprecated: `toList()` keep working exactly as before.
  This library is meant to be used BESIDE the generator, so a reader following an example
  written in another language should not have to translate the method names.

  Guarded by `fixtures/cross-language/api.json`, which all five test suites read. There was
  no guard on this surface before, which is why it drifted at all — each choice was
  reasonable in its own language and wrong for a reader crossing between them.

## [0.2.2] — 2026-08-15

Held back at first — the account was over Central's monthly release count — then
published the same day: until 1 October 2026 that limit is a notice rather than a block.
Nothing about the Java code differs from the other four at this version.

## [0.2.1] — 2026-08-11

### Fixed

- **`check --brief` now keeps its promise for warnings.** The flag prints one line per
  diagnostic and no source excerpt, and errors always did — but warnings arrive on the
  successful-parse path, which called the overload that defaults `brief` to false, so they
  came out through the full renderer instead:

  ```
  TDC236 1:45 uniq on "U" holds all 200,000 values …     what the other implementations print
  warning[TDC236]: uniq on "U" holds …                   what this one printed
  ```

  `--brief` is what an editor panel reads, so a second shape is not cosmetic. One line.

## [0.1.7]

### Fixed

- **The published POM declared the ANTLR compiler as a runtime dependency.** Gradle's
  `antlr` plugin makes `api` extend the `antlr` configuration, so `org.antlr:antlr4` — the
  code generator, and about 30 MB of ICU4J behind it — was a `compile` dependency of the
  library. Every consumer downloaded a compiler to run a parser that was generated at our
  build time, not theirs. The POM now declares `antlr4-runtime` and nothing else.

  The same leak filled the executable jar: `tdcv2-<version>-cli.jar` was 16.68 MB, of
  which our own classes were 1.49 MB. It is 1.24 MB now.

## [0.1.4] — 2026-08-03

### Changed

- **The pack store is one flat tree with one `dataPaths` entry.** A bundle used to
  unpack to `<store>/<id>/packs/<address>/…` and add a data root of its own, so
  ten languages and a hundred countries meant three near-duplicate levels and a
  hundred roots. Everything now lands at its address path — `<store>/ru/…`,
  `<store>/countries/usa/…` — and the store itself is registered once. Which
  bundle owns which path is written in `<store>/.tdcv2-installed.json` instead of
  being implied by a folder name, so `pack remove` deletes exactly what a bundle
  brought and `pack list` marks what the store has actually recorded. A store
  written by an earlier version is moved to the new shape by the first
  `tdcv2 pack` of any kind, in place, with a report on stderr; anything in an old
  bundle folder that was never pack data is left where it is. `PackRegistry.install`
  now returns the store's entry for the bundle rather than a pack root, and
  `PackRegistry.Bundle` carries the index's optional `version`.

### Added

- **A pack file that lands at no address is now named — TDC171.** A file carrying
  a `---` header whose path starts with no locale, country or `common`, and whose
  header does not say where it belongs, was dropped in silence; the author met it
  later as "unknown template path" about a file sitting in their own folder. Both
  halves are now reported. The scan stays lazy — it runs when a lookup has
  already missed, which is when the author is looking — so an ordinary run pays
  nothing for it.

### Fixed

- **`tdcv2 --version` printed 0.1.0** while the build declared 0.1.3. Gradle now
  generates the constant from `project.version`, so the two cannot drift. Reading
  `Implementation-Version` from the jar manifest was the other candidate and was
  rejected: it is null on a plain classpath, which is how the tests run.

- **`--jobs` was accepted and silently ignored without `-o`.** A worker owns a
  range of rows and writes it at a known offset; stdout is one ordered stream
  with no offsets. It says so now, and only when more than one worker was asked
  for.

- **Quick API:** `RESERVED_PATH_NAMES` was missing, so nothing stopped a shared
  pack shipping a `many` segment — unreachable in the three implementations
  whose quick API is a proxy. Added, with a static seeded entry point and a bare
  string as a generator parameter, both of which existed elsewhere. The
  uninstalled-pack message told a Java user to run `tdcv2 pack add`, which is not
  a command they have.

### Added

- **The command line ships from Maven Central too**, as a second file under the
  same coordinates: `tdcv2-<version>-cli.jar`, self-contained, `java -jar` and it
  runs. Maven puts nothing on a PATH, so a command line cannot arrive as a
  dependency — but it can arrive as a download, and one set of coordinates can
  carry several files told apart by a classifier. No second address, no second
  signature pass.

  `scripts/verify-jar.mjs` now runs that jar too, outside the repository with
  nothing beside it on the command line — which is where a dropped dependency or
  a missing data pack would show.

## [0.1.3] — 2026-08-02

The first release to Maven Central. Everything below is what changed in this
implementation on the way there; the engine itself has been at parity with the
TypeScript reference since before it, held there by the shared fixtures under
`fixtures/cross-language/`.

### Added

- **The quick API** — one call, one value, no config file, answered from the same
  data packs a config draws on. See the binding's README for the shape it takes
  here.

- **`scripts/verify-jar.mjs`** — builds the library jar, compiles against it
  OUTSIDE the repository with only the jar and the ANTLR runtime on the
  classpath, and compares the output with the TypeScript reference.

  Nothing was broken here: the Gradle build has always copied the starter packs
  into the jar as resources, which is why this is the one implementation of the
  five that was already correct. That is exactly why the check is worth having —
  the Rust crate and the NuGet package both shipped dataless, and in both cases
  every test in the repository was green, because every test runs inside it.

### Fixed

- **Pack parameters now work.** A pack whose body declares
  `<sequence name="domain">` accepts `domain="…"` from the caller, and the
  engine replaces that sequence with the constant. This implementation refused
  the whole config with `TDC015`, so a `.tdc` file that ran under the
  TypeScript reference failed here.
