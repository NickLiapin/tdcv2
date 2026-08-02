# Changelog — `tdcv2` on npm

What changed for someone who runs `npm install tdcv2`.

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
the npm package: its API surface, its command line, its landing page.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.3] — 2026-08-02

### Fixed

- **Pack parameters are checked in more places, and the check is right in two
  more.** A plain list of values now says it has no parameters instead of
  accepting one in silence, and a locale-relative address such as
  `person.lastName` is resolved against the active locale before it is checked —
  previously only absolute addresses like `common.internet.email` were. See the
  repository CHANGELOG; the behaviour is now the same in all five
  implementations.

## [0.1.2] — 2026-08-02

### Fixed

- **A missing pack says which pack, instead of proposing another language.** npm
  ships a starter set — `common`, `en`, `usa` — and the registry carries the
  other hundred-odd, so `tdc.lang.ru.person.lastName()` on a fresh install has no
  `ru` to draw from. It answered `unknown address "ru.person.lastName" (locale
"en"). Did you mean "en.person.lastName"?`, which offers English to someone who
  asked for Russian and reads as though the address were a typo. It now names the
  pack and the command that installs it.

## [0.1.1] — 2026-08-02

### Changed

- **The landing page shows both ways of using TDC.** npm renders the README out
  of the published tarball, so 0.1.0's page could only show what 0.1.0 shipped
  with. The page opens on a fork — reach for a value (`tdc.person.lastName()`) or
  describe a dataset (a config) — because these are two tools sharing one set of
  data and a reader has to see both.
- **Package metadata written for discovery**: a description that says what the
  thing does rather than what it is called, and 27 keywords covering the terms
  people search for.

### Fixed

- **`tdcv2 --version` reported a number that agreed only with itself.** The smoke
  test compared `VERSION` to a literal `'0.1.0'`, so `npm version` moved
  `package.json` while the test stayed green. It reads `package.json` now.
- **`tdcv2-lsp` could never start**: the language-server entry point had no
  `#!/usr/bin/env node`, and npm symlinks bins on POSIX.

## [0.1.0] — 2026-08-02

First release to npm. The engine, the CLI (`generate`, `init`, `pack`, `check`,
`format`), the language server, the library API and the one-value quick API, with
a starter set of data packs and the rest downloadable from the shared registry.
