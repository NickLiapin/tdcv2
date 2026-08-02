# Changelog — `Tdcv2` on NuGet

What changed for someone who installs this package (dotnet add package).

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
this package: the assembly and its library API.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.3] — unreleased

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
