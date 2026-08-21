# Changelog — `tdcv2` on crates.io

What changed for someone who installs this package (cargo add).

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
this package: the crate, its library API and its binary.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **One vocabulary for the finished run, in all five implementations.** The object a run
  hands back now answers to the same names everywhere, spelled each language's own way.
  Added `to_array()`, `iterate()`, `get_at(index)` and `seed_info()`.

  Nothing is renamed and nothing is deprecated: `rows()`, `row()` and `seed()` keep working exactly as before.
  This library is meant to be used BESIDE the generator, so a reader following an example
  written in another language should not have to translate the method names.

  Guarded by `fixtures/cross-language/api.json`, which all five test suites read. There was
  no guard on this surface before, which is why it drifted at all — each choice was
  reasonable in its own language and wrong for a reader crossing between them.

## [0.2.2] — 2026-08-15

### Changed

- Engine changes only, shared by all five implementations — see the
  [engine changelog](../CHANGELOG.md#022--2026-08-15).

## [0.2.1] — 2026-08-11

### Fixed

- **`tdcv2 check` no longer calls the service.** In this implementation `Tdc::from_file` IS
  the finished run — every column materialised — so checking a config holding a
  `<gen type="http">` made a real request, from a command whose own help says it validates
  "without generating anything". Measured against a dead port, the other four printed
  `is valid` while this one reported a connection failure; a check in CI must not reach a
  production service. It now takes a `Plan`, which reads and validates without building
  rows. A genuinely broken config still fails — verified with TDC066 on a malformed `src`.

### Added

- **HMAC-SHA256 without a dependency**, for the `secret=` request signature. Written over
  the SHA-256 this crate already carried for the pack client, because the crate takes no
  dependencies and the construction is twenty lines once a hash exists. Three tests pin it:
  the value the other four implementations produce for the same inputs, and RFC 4231 cases
  2 and 6 — the short-key and over-long-key branches.

## [0.1.4] — 2026-08-03

### Changed

- **The pack store is one flat tree, and it keeps books.** `tdcv2 pack add ru`
  used to unpack to `<store>/ru/packs/ru/…` and add a `dataPaths` entry naming
  that folder; ten languages and a hundred countries meant three near-duplicate
  levels and a hundred data roots. A bundle now lands at its address path and
  nothing above it — `<store>/ru/…`, `<store>/countries/russia/…` — and the store
  itself is registered once, however many bundles go into it.

  What a folder name used to say is now written down in
  `<store>/.tdcv2-installed.json`: the paths each bundle owns, its version and
  its digest. `pack remove` deletes exactly those paths and prunes what they
  leave empty, so removing `russia` takes `countries/russia` and leaves
  `countries/usa` alone; `pack list` marks `✓ installed` from the same file, so a
  tree somebody unpacked by hand is not "installed" — nothing records what it
  owns, so nothing could remove it cleanly either. A dotfile because the store is
  a scan root and the loader skips ignored names, not unknown extensions.

  **A store written by an earlier tdcv2 is moved for you.** The first
  `tdcv2 pack` of any kind after the upgrade migrates it in place, drops the
  per-bundle `dataPaths` entries, registers the store instead, and says on stderr
  exactly what it did. Everything is planned before anything moves: on any
  collision it refuses having moved nothing and names the paths. Files that were
  in a bundle's folder but outside its `packs/` tree belong to no address and are
  left where they are. `pack --help` still runs before all of this, so it works on
  a machine where `init` never did.

  On the library side this is the new `packs::store` module — the record, what a
  bundle owns, the unpack plan and the migration, all decided without the wire.
  `Registry::install` returns an `Installation` (how many files, which paths) in
  place of the pack root it used to return; `registry::installed` and
  `registry::count_files` are gone, replaced by `store::installed_bundle_ids`;
  and `Bundle` carries the registry's optional `version`, which today's index
  does not declare and the store writes down anyway.

### Added

- **The memory estimate the other four already had — TDC200 and TDC201.** A run
  the machine cannot hold now says so in a millisecond instead of saying it in
  minutes by thrashing: `tdcv2 big.tdc` prints the estimate beside the machine's
  RAM and exits 1 without generating a byte. The constants, the wording and the
  two thresholds are the shared ones, so all five agree on which runs are refused.

  Total RAM is read from `/proc/meminfo` or `sysctl hw.memsize` — the same
  ask-the-system shape the pack downloader and the terminal-size probe use, and
  no new dependency. Where neither answers, nothing is claimed: being unable to
  measure a machine is not evidence that a run will not fit.

- **`Tdc::plan`, and `Plan::preflight` on what it returns.** The other four build
  their rows on first use and can be asked what a run will cost after the object
  exists; here a `Tdc` IS the finished run, which is what lets `text()` and
  `rows()` return values rather than results. So the question is asked one step
  earlier. `Tdc::new` is `plan()?.build()` and behaves exactly as before.

- **A pack file that lands at no address is now named — TDC171.** A file carrying
  a `---` header whose path starts with no locale, country or `common`, and whose
  header does not say where it belongs, was dropped in silence; the author met it
  later as "unknown template path" about a file sitting in their own folder. Both
  halves are now reported. The scan stays lazy — it runs when a lookup has
  already missed, which is when the author is looking.

### Fixed

- **A config drawing from a pack that declares its own shares produced different
  bytes here than in the other four.** The router never opened a pack, so such a
  config went to the streaming engine — which resolves a row at a time, computes
  the quota over that one row, and hands every row to the largest share. On
  `zh-cn.geo.streetName` the reference gives 600/200/150/50 over a thousand rows
  and this gave 1000/0/0/0, silently. The engine had its own cruder version of
  the same question, a text search for `percent=`; both now call one function.

- **A pack body opening with `<mix>` lost it.** `parse_pack_body` read only
  `<sequence>` children, so `${{s}}` reached the output as eight literal
  characters. `materialize_local` also had no arm for an inline mix, which its
  own comment had anticipated.

- **TDC229 was missing** — `${{Ref}}` where `Ref` draws a whole pool member. A
  shared fixture already expected it and passed anyway, because the diagnostics
  harness bucketed anything this implementation did not emit into "not ported
  yet". That tolerance is gone; 159 of 159 diagnostics match the reference, and
  removing it revealed nothing else.

- **The render harness checked 113 of the 130 shared engine-2 cases.**
  `engines.json` marks 17 as refused, and the harness dropped them rather than
  checking this implementation refuses them too. It asserts them now.

## [0.1.3] — 2026-08-02

The first release to crates.io. Everything below is what changed in this
implementation on the way there; the engine itself has been at parity with the
TypeScript reference since before it, held there by the shared fixtures under
`fixtures/cross-language/`.

### Added

- **The quick API** — one call, one value, no config file, answered from the same
  data packs a config draws on. See the binding's README for the shape it takes
  here.

### Fixed

- **The crate now carries data.** It found packs by walking up from the build
  directory looking for `data/packs` — which works in a checkout and cannot work
  in `~/.cargo/registry`, where a published crate has nothing above it. Packaged
  as it was, `cargo install tdcv2` produced a binary that answered every
  `type="template"` with "no data packs found". Every test was green, because
  every test runs inside the repository.

  The starter set is compiled in with `include_str!` now — 489 files, and the
  crate is 0.5 MB. `scripts/verify-crate.mjs` packages it, unpacks it OUTSIDE
  the repository, builds it there and compares the output against the TypeScript
  reference; it is the only check that can see this class of bug.

- **Pack parameters now work.** A pack whose body declares
  `<sequence name="domain">` accepts `domain="…"` from the caller, and the
  engine replaces that sequence with the constant. This implementation refused
  the whole config with `TDC015`, so a `.tdc` file that ran under the
  TypeScript reference failed here.
