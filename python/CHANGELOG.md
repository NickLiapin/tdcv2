# Changelog — `tdcv2` on PyPI

What changed for someone who runs `pip install tdcv2`.

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
the Python package: its API surface, its command line, its landing page.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **One folder for downloaded packs, not three levels of near-duplicate names.**
  `tdcv2 pack add ru russia` used to leave `data/ru/packs/ru/…` and
  `data/russia/packs/countries/russia/…`, and appended a `dataPaths` entry per
  bundle — a hundred packs meant a hundred entries. Both extra levels belonged
  to the tooling rather than to the data: `<store>/<id>/` existed so removal
  could delete one folder, and `packs/` came out of the archive. They are gone.
  Every bundle now unpacks into ONE tree at its address path — `data/ru/…`,
  `data/countries/russia/…` — and the store is registered once. `DataPacks.install`
  writes the same single entry.

  What each bundle owns is written down in `<store>/.tdcv2-installed.json`
  instead of implied by a folder name, so `pack remove` deletes exactly the
  paths that bundle brought and leaves the country beside it alone.

  A store from an earlier version is moved to the new shape in place, by the
  first `tdcv2 pack` command of any kind, which also replaces the per-bundle
  `dataPaths` entries with the store and says on stderr what it moved. Nothing
  has to be downloaded again. If a path in the new layout is already taken the
  move is refused whole, with the collisions named, rather than half-done.

### Added

- **A pack file that lands at no address is now named — TDC171.** A file carrying
  a `---` header whose path starts with no locale, country or `common`, and whose
  header does not say where it belongs, was dropped in silence; the author met it
  later as "unknown template path" about a file sitting in their own folder. Both
  halves are now reported. The scan stays lazy — it runs when a lookup has
  already missed, which is when the author is looking — so an ordinary run pays
  nothing for it.

## [0.1.3] — 2026-08-02

### Added

- **The quick API** — `from tdcv2 import tdc`, then `tdc.person.lastName()`. One
  call, one value, no config file. It existed only in the TypeScript
  implementation, so the npm landing page showed a way of working this package
  could not do.

  ```python
  from tdcv2 import tdc

  tdc.person.male.firstName()      # Robert
  tdc.country.usa.docs.ssn()       # 699209702 — with its real check digits
  tdc.person.lastName.many(5)      # five of them
  tdc.gen.number("18..80")         # '66'
  ```

  The segments are camelCase because they are the names the data already has, not
  names this library chose: a dot in the code is a dot in the address, the same
  address a config writes. The same seed gives the same value here and in the
  other four implementations, and a shared fixture holds it there.

- **`DataPacks.addresses()`** — every address the packs can answer to.

### Fixed

- **Pack parameters now work.** A pack whose body declares
  `<sequence name="domain">` accepts `domain="…"` from the caller, and the engine
  replaces that sequence with the constant. This package refused the whole config
  with `TDC015`, so a `.tdc` file that ran under the TypeScript implementation
  failed here.

## [0.1.2] — 2026-08-02

First release to PyPI. The engine, all three of its engines and the router, the
CLI (`generate`, `init`, `pack`, `check`, `format`), the library API, Parquet
output and multiprocess runs, with a starter set of data packs and the rest
downloadable from the shared registry.

### Fixed

- **`tdcv2 --version` reported a hand-written constant** that agreed with nothing
  but itself, so bumping `pyproject.toml` would have left the command reporting
  the old number in silence. It reads the installed distribution's metadata now.

### Changed

- **The README is a landing page rather than a checkout guide.** PyPI renders it
  as the project's front page, and it opened with `node
scripts/generate-parsers.mjs` and an editable install — instructions for
  someone who cloned the repository, shown to someone who just ran
  `pip install`. Its relative links to `../docs/` would have 404'd there as well.
- **Package metadata written for discovery**: description, 25 keywords, trove
  classifiers, and project URLs for the documentation, the source and the
  changelog.
