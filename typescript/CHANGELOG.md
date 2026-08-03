# Changelog — `tdcv2` on npm

What changed for someone who runs `npm install tdcv2`.

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
the npm package: its API surface, its command line, its landing page.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.4] — 2026-08-03

### Changed

- **One folder for downloaded packs, not three levels of near-duplicate names.**
  `tdcv2 pack add ru russia` used to leave `data/ru/packs/ru/…` and
  `data/russia/packs/countries/russia/…`, and appended a `dataPaths` entry per
  bundle — a hundred packs meant a hundred entries. Both extra levels belonged
  to the tooling rather than to the data: `<store>/<id>/` existed so removal
  could delete one folder, and `packs/` came out of the archive. They are gone.
  Every bundle now unpacks into ONE tree at its address path — `data/ru/…`,
  `data/countries/russia/…` — and the store is registered once.

  What each bundle owns is written down in `<store>/.tdcv2-installed.json`
  instead of implied by a folder name, so `pack remove` deletes exactly the
  paths that bundle brought and leaves the country beside it alone.

  A store from an earlier version is moved to the new shape in place, by the
  first `tdcv2 pack` command of any kind, which also replaces the per-bundle
  `dataPaths` entries with the store and says on stderr what it moved. Nothing
  has to be downloaded again. If a path in the new layout is already taken the
  move is refused whole, with the collisions named, rather than half-done.

### Fixed

- **`tdcv2 init --help` and `tdcv2 pack --help` printed an error instead of
  help.** The flag parser saw `--help` before anything thought to answer it, so
  both exited 2 with "unknown option". They now print the same usage text the
  four ports print, byte for byte, and `pack --help` answers before the pack
  store is resolved — which is the machine where somebody needs it.

- **The quick API's error handling, four defects.** This is the odd case where
  the reference was the worst of the five and the ports were right; each fix is
  theirs, carried back.

  Whether a pack was missing was decided by a lookup in a hardcoded table of
  locales and countries, so an address outside that table got the opposite
  answer to the one intended: `zz.person.lastName` was told "did you mean
  ar.person.lastName?" — proposing a different language, the exact outcome the
  message exists to avoid. It is a structural test now.

  A failure the address could not explain was rewritten into one about the
  address: an undeclared pack parameter raised TDC072 and the user was shown
  "unknown address common.internet.email — did you mean common.internet.email?".
  The engine's own diagnostic survives.

  Formatting a diagnostic read the project config unguarded, so a broken
  `tdcv2.config.json` replaced the real message — an error thrown from inside an
  error handler.

  The two halves of one message read two different lists, so a typo near a pack
  installed through the project's `dataPaths` got no suggestion.

- **The uninstalled-pack message no longer says `npx`.** All five now emit the
  same sentence.

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
