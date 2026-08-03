# Changelog — `tdcv2` on crates.io

What changed for someone who installs this package (cargo add).

Engine-wide changes — anything that alters what a config produces — live in
[the repository's CHANGELOG](../CHANGELOG.md) and are true of all five
implementations at the same version number. This file carries what is specific to
this package: the crate, its library API and its binary.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

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
