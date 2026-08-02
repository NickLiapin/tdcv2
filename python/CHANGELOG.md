# Changelog — `tdcv2` on PyPI

What changed for someone who runs `pip install tdcv2`.

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
the Python package: its API surface, its command line, its landing page.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
