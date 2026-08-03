# Changelog — `io.github.nickliapin:tdcv2` on Maven Central

What changed for someone who installs this package (Gradle or Maven).

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
this package: the jar and the library API.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
