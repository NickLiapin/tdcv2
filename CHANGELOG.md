# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This file is the engine's: anything that changes what a config produces belongs
here, and is true of all five implementations at the same version number.

What is specific to one package — its API surface, its command line, its landing
page — is tracked in that implementation's own changelog:
[TypeScript](typescript/CHANGELOG.md) · [Python](python/CHANGELOG.md) ·
[Java](java/CHANGELOG.md) · [C#](csharp/CHANGELOG.md) · [Rust](rust/CHANGELOG.md).

## [Unreleased]

## [0.2.0] — 2026-08-07

### Added

- **`<gen type="stat">` — one number for the whole run, on every row.** `op=` is `sum`,
  `mean`, `median`, `min`, `max`, `count` or `stddev`, over a column declared above it.
  "Is this row above average" cannot be asked any other way: the average is not knowable
  until the last row exists, so the statistic has to be a column of its own. It draws
  nothing, so adding one leaves every other column exactly where it was.

- **A date measured from another date — `of=` and `plus=`.** The interval in almost every
  real record: admitted and discharged, ordered and shipped, issued and expires.
  `plus="3..10d"` draws a fresh gap per row, `plus="7d"` is the same distance every row,
  and both bounds may be negative to measure backwards. The offset reads the source
  column's VALUE, not the text in the cell, so a source rendered as `MMMM D` — which
  throws the year away — still offsets correctly, and a month lands on the last day of
  February rather than 30 days later.

- **`<split>` in the compute layer — a string to a list.** The inverse of `<join>`, and
  the fourth way to get a list. A `repeat=` column arrives at an expression as its joined
  text; until now there was no way to read it back apart, so "sum quantity × price over
  the items of this order" was unwritable.

- **`<assert that="…" says="…"/>` — a config that checks its own output.** A statement
  about the whole run, in `<env>` beside `<uniq>` and `<distinct>`. What is worth
  asserting is the property the config does NOT state: you write `percent="70"`, a
  `parent=` filter and a condition stack up, and the share that reaches the file is 42
  percent with nothing to say so. If the condition holds, nothing happens; if it does not,
  the run stops with the author's own sentence and exit code 1, before a line is written.

  Three existing mechanisms, no new language: `that=` is the `if=` expression language,
  the numbers come from `<gen type="stat">`, `says=` is the sentence a reader gets. There
  is no flag — an assertion runs because it is written.

  Every name the expression reads must be the same on every row, or a per-row column would
  be read at row 0 and the run called verified. A column left empty by a filter is refused
  for the same reason. TDC265 and TDC266 refuse the half-written forms.

### Fixed

- **A `uniq` group asked for more rows than its values can make now says so before
  allocating.** The check existed and its message was right, but it ran over the finished
  columns — so two lists of ten values and `count="1000000000"` died in the allocator with
  a heap dump, and `count="5000000000"` with `Invalid array length`. Exactly where the
  warning is worth most, since the alternative is an eight-hour run that was never going
  to succeed. The ceiling is now computed from the specs, before a single column is built,
  and it only ever answers "definitely impossible": a member whose capacity is not knowable
  from its spec leaves the group unbounded and the old check does its work as before.

- **An offset from a WALKED source (`order="sequential"`) came out empty, in silence.** A
  walked date returns from a different branch of the builder than a drawn one, and that
  branch was not filling the instant the column keeps beside its text — so the offset read
  every row as "this row has no date". The safety net closes the whole class: the instants
  are attached only when every applicable row filled one, because a sink asked for and left
  unfilled means "this build never wrote one", which is the opposite answer to "no date
  anywhere".

- **The npm package told CommonJS callers a lie the runtime then refused.** `exports` and
  `types` promised type definitions for `require()`, while the module is ESM-only, so the
  editor type-checked a call that could not run. `attw --pack` is green on all four
  resolutions now, and the CJS type IS the message: it resolves to a string telling the
  reader to `import` instead. Kept runnable as `npm run types:pack`.

## [0.1.7] — 2026-08-04

### Fixed (Java packaging)

- **The Java library made every consumer download the ANTLR compiler.** Gradle's `antlr`
  plugin quietly puts the code generator on the runtime classpath, so the published POM
  asked for `org.antlr:antlr4` and, behind it, ICU4J — about 34 MB of build tooling to run
  a parser generated at our build time. The executable jar carried the same cargo: 16.68 MB,
  of which 1.49 MB was ours. Now: the POM names `antlr4-runtime` alone, and the jar is
  1.24 MB. The other four implementations were checked and were already clean — each names
  its runtime dependency by hand, which is why only the one with a plugin doing it silently
  went wrong.

### This release changes what a config produces

Two kinds of config come out different from the same `seed`. Neither is a
regression: both were wrong before and are right now. If you compare a fresh run
against a snapshot taken on 0.1.6, expect a diff.

- **Any config with a `percent` inside a `<switch>` branch.** The share was
  apportioned over the whole run and the values that landed on rows belonging to
  another branch were dropped. It is a quota over the branch now, so the values
  and the rows they sit on both move.
- **Any config with `local="ru"`.** The Russian name lists were filled out to the
  scale of the English ones and the feminine forms are derived rather than
  listed, so the names drawn from them differ.

### Added

- **A `<switch>` may be written inside a `<case>`.** A branch can hold a whole second
  lookup, which is what a value that depends on two fields needs — a national id whose
  shape depends on the sex, and for one sex only, on the region. Writing that before took
  one sequence per combination plus an expression to choose between them.

  `<case>` is shared by `<mix>` and `<switch>`, so the nested form works under both: the
  mix decides whether a record is an invoice, the switch decides which tax it names.

  The nested form takes no `name` — it contributes its value to the branch around it and
  nothing can interpolate it, so a name would name nothing (`TDC245`). It partitions only
  the rows of the branch it sits in, and `<default>` covers the rows of THAT BRANCH which
  matched no inner key. A share inside a nested branch is exact, and routes the config to
  the in-memory engine, because a nested branch covers an intersection of two partitions
  that the streaming engines cannot number a row at a time.

### Fixed

- **Python and Rust never validated the body of a `<switch>` branch.** Anything written
  inside `<case>` or `<default>` of a switch went unchecked in those two, so a config the
  reference rejected ran there. Found by making all five agree on the nested form.

### Fixed

- **A percentage inside a `<switch>` branch was a quota over the whole run, not over the
  branch.** A `<mix percent="20,80">` inside `<case is="Male">` handed out its 20% over
  every row and dropped the values that landed on a row belonging to another branch.
  Measured over 100 runs of 10 rows split 5/5: 0, 1 or 2 survivors, and 23 runs with
  none, where the config asked for one man in five. It was not randomness — it was an
  exact share over the wrong denominator, which is worse, because it looks like a
  working feature.

  A branch now draws over the rows that chose it. A branch keyed on a single value gets
  the same subset `parent="Gender.Male"` already gets, so it still streams. A share
  inside a multi-key branch (`is="US|CA|MX"`) or inside `<default>` covers a union of
  subsets, or what every other branch left behind, and neither can be numbered one row at
  a time — those configs are routed to the in-memory engine, where the share is exact.
  Measured on 200,000 rows: 45,000 of an exact 45,000, where it used to read 44,999.

  **This changes output.** Any config with a percentage inside a `<switch>` branch
  produces different bytes from the same seed.

- **`--jobs` could kill a run the same config survived single-threaded.** A worker is
  handed a forced streaming engine and has nowhere to fall back to, so a refusal reached
  while building was fatal there and merely a fallback everywhere else. The engine for
  such a config is now decided before the run starts, where every path sees the same
  answer.

## [0.1.6] — 2026-08-03

### Fixed

- **The Rust crate on crates.io carried no data packs.** 0.1.5 went out without the
  starter set embedded, so `cargo install tdcv2` produced a binary that answered every
  `type="template"` with "no data packs found" — a release that cannot generate a name.
  Nothing in the engine was wrong: the packs live once at the repository root and are
  copied into the crate before packaging, because a published crate has nothing above
  it. npm does that copy in its `prepack` hook; Cargo has no such hook, so the step is
  manual, and it was skipped.

  0.1.5 is yanked from crates.io. This release carries the 489 embedded files, verified
  by unpacking the crate outside the repository, building it cold and running it.

  The four other implementations were unaffected — same version, same bytes, checked
  from their registries — but they are republished at 0.1.6 so one number keeps meaning
  one contract.

### Added

- **`./release-check.sh` — one command that decides whether publishing would be honest.**
  Every existing check reads the working tree; not one of them packages an artefact, so
  all of them were green while the crate above was broken. The one check that would have
  caught it was written after this same bug happened once before, and was wired into
  nothing. It now runs here, along with the version agreement, the five suites, the
  documentation audit and the other three artefacts.

## [0.1.5] — 2026-08-03

### Fixed

- **A running total failed on Rust and worked on the other four.** The router picks an engine
  from the config; the streaming engine then discovers, while building its resolvers, that
  this particular config needs the whole column after all. A running total is the plain case —
  row 900 000 000 IS the sum of everything before it. Four implementations answered that
  refusal by building the run in memory; Rust let it escape, so `tdcv2 ledger.tdc` — the exact
  config on the running-total documentation page — failed there and nowhere else.

  Rust now recovers in its engine dispatch, and the file-writing path removes its half-written
  output before handing the run back to be built the ordinary way. A config that NAMES its
  engine still gets the refusal: `engine="2"` and `mode="stream"` are requests to be told, not
  requests to be helped.

  Python had the recovery in its facade only, and its shared-case harness dispatched for itself
  without it — so the library and the contract harness disagreed about what one config
  produces. Dispatch now lives in one place and both call it.

  Nothing caught this because all three shared running-total cases pinned `mode="memory"`, so
  no case ever reached the router. The new one writes what a reader writes.

- **`uniq` on a number refused for a reason it did not name.** The check blocks five
  attributes — `decimals=`, `distribution=`, `include=`, `exclude=` and `first_zero=` — and
  the message listed four. `first_zero=` is the missing one and the one people reach for, since
  it is how a number gets a fixed width. The reader set it, was refused, and read a list of
  four attributes they had not used. `length=` stays out of the list because it does not
  block: `value="100000..999999"` is already six digits wide.

- **Running off the end of a source named the wrong number.** With
  `order="sequential" cycle="false"`, a run longer than its source stops rather than looping
  back and duplicating rows. But the message printed the row it stopped at as if it were the
  requested size: a config asking for `count="6"` over a four-line file was told "only 4 values
  for 5 rows". It now names the row that ran out, which is true on the streaming path as well —
  that one resolves a row at a time and does not know the run's length there.

- **Rust: `-o` on the streaming engine held the whole run.** The engine produced rows one at
  a time, but every way out of it assembled the complete output as one string, and writing to
  a file then copied that string again. Measured on the published 0.1.4 across four sizes,
  memory grew straight in line with the row count — 9 MB, 57 MB, 266 MB, **1051 MB** from
  10 000 to 2 000 000 rows — where C# stayed at 50 MB throughout and Python at 32 MB. It also
  made Rust's streaming engine slower than its own in-memory one, which is backwards.

  It now renders into the file a row at a time: **4 MB at every size**, from ten thousand rows
  to two million. Nothing about the output changed — the bytes match the previous release, the
  other four implementations, and Rust's own stdout path, all on the same digest.

  This was a known deviation rather than a surprise: a comment in the command line described
  it and the memory preflight was written to be honest about it. The benchmark supplied what
  the comment could not, which is what it costs. That preflight no longer needs the exception.

## [0.1.4] — 2026-08-03

### Fixed

- **One rule for where the packs come from, in all five implementations.** A config that
  lived outside a checkout read Polish names in TypeScript, Rust and C# and was told
  `pl.person.lastName` did not exist in Python and Java — the same config, five
  implementations, two answers. Three different rules were in play: three implementations
  walked up from their own location looking for `data/packs`, two did not look at all, and
  only two honoured `TDCV2_PACKS`.

  All five now ask the same three questions in the same order: `TDCV2_PACKS` if it names a
  folder, then the TDC source checkout this build came from, then the starter set inside the
  package. The middle step no longer settles for any folder called `data/packs` — it has to
  be recognisably this repository — so a folder of yours that shares the name can never be
  picked up by accident. [Installing packs](docs/data-packs/installing-packs.md) states the
  rule; a test in each implementation holds it.

- **`uniq=` and `order=` inside a data pack are refused instead of ignored.** Both describe
  the whole column — which values may repeat across rows, in what order they come out — and
  a pack is asked for one value per row, so it has neither the row count nor the other rows
  to answer with. All five accepted them and did nothing, which costs a pack author more
  time than any error: the file says what they meant and the output does not do it.

  `<distinct>` is untouched. It reads like a sibling of `uniq=` and is not one — it
  constrains fields against each other _within_ one row, which a pack can answer on its own,
  and five shipped full-name packs use it to keep a person's two surnames from matching.

- **A `<mix>` inside a pack's `<sequence>` is refused instead of leaking into the data.**
  A config refuses this with TDC013 — distribution is a construct of its own, declared beside
  the sequences rather than inside one — but a pack body had no such check. The reference was
  the worst of the five here: it emitted the interpolation as eight literal characters, so
  `${{p.m}}` landed in the output and the run looked like it had worked. All five now refuse
  it with the same message.

- **A data pack can no longer reach the network, or the filesystem, in four of five.** A
  pack body may only use generators that produce a value on their own — `text`, `number`,
  `regex`, `advanced_regex`, `symbol`, `date`, `increment`, `decrement`, plus `template`
  inside a `<sequence>`. The reference had always refused the rest by name; the four ports
  had no such check, so a pack containing `<gen type="http">` exited **0 with an empty
  line** — the worst shape a failure can take.

  The check walks the parse tree rather than the built model, so a `<gen>` hidden inside a
  `<mix>` is found too — which the model-walking version would have missed in the ports.

  Two smaller refusals came with it, also missing in the four: a single-`<gen>` body is held
  to the eight primitive types and the message names them, and a `<gen>` with no `type=`
  is told exactly that. All four previously answered the second one with an internal "is
  not ported yet", and C# threw an unhandled exception with a stack trace.

- **Two files claiming one address are refused in all five.** The extension is not part of
  an address, so `thing.txt` and `thing.tdc` in one folder are the same address. The
  reference had always said so; the four ports quietly read the `.txt` and left the other
  file dead weight its author could not see.

### Removed

- **`src="pkg:…"` on the file and pattern generators.** It read a data file out of
  an installed npm package. `node_modules` is npm's folder and nothing outside the
  JavaScript runtime has it, so this was the one `src` form that worked in
  TypeScript and failed in the other four implementations — against the promise
  that one config produces one result everywhere.

  Nothing used it: no data pack, no example, no shared fixture, and the package
  the documentation named as its example was never published. Getting data out of
  someone else's package is what data packs are for, and those work in all five.

  A config that still writes `pkg:@scope/name/file.txt` now treats it as an
  ordinary file name and stops with the usual unreadable-source error, the same
  way the four ports have always answered it.

## [0.1.3] — 2026-08-02

All five implementations released together at one version number.

### Added

- **The quick API now exists in all five implementations.** It was TypeScript-only,
  which is why the npm landing page could show a way of working the other four
  could not: `tdc.person.lastName()` — one call, one value, no config.

  The shape follows what each language can actually do, and only the shape
  differs:

  ```python
  tdc.person.lastName()                      # Python  — attribute access
  ```

  ```csharp
  tdc.person.lastName();                     // C#      — dynamic
  ```

  ```java
  tdc.get("person.lastName");                // Java    — the address as a string
  ```

  ```rust
  tdc.get("person.lastName")?;               // Rust    — the address as a string
  ```

  Java and Rust take the address as a string on purpose. The other shape —
  `tdc.person().last_name()` — needs a generated method per address, and a
  generated surface can only ever cover the packs shipped in the artefact. Most
  packs are downloaded at runtime, so `tdc.lang().ru()` would simply not exist for
  the pack a user had just installed, while `get("ru.person.lastName")` works the
  moment the download finishes.

  Underneath they are one implementation, not five: the same synthesised config,
  the same 512-row batch, the same `#`-derived seed for the batch after it. The
  same seed and address therefore give the same value everywhere.

- **`quick-vectors.json`** — the shared fixture that holds them to it. One of its
  cases deliberately draws 600 values, because everything below 512 comes out of a
  single underlying run: two implementations can agree on all of that while
  disagreeing completely about what happens when the run is exhausted. Generated
  by `npm run fixtures:quick`, checked by `npm run check`, read by all five test
  suites.

- **`DataPacks.addresses()` / `AddressList()` / `addressList()` / `address_list()`**
  — every address the packs can answer to. The quick API needs the whole list to
  say "did you mean", not a yes-or-no about one.

### Fixed

- **Pack parameters worked only in the reference; they work in all five now.** A
  pack whose body declares a named sequence lets a caller override it —
  `<gen type="template" value="common.internet.email" domain="example.test"/>`
  replaces the pack's own `domain` sequence with that constant. TypeScript read
  the pack's declared parameter names and allowed the attribute; Python, Java, C#
  and Rust had no such notion and refused the whole config with `TDC015`, so the
  same `.tdc` file ran in one implementation and failed in four. Nothing in the
  shared fixtures covered it, which is why it survived.

  The override draws nothing, so the rest of the pack body's stream is exactly
  where it would otherwise be — checked by putting a parameterised column and an
  un-parameterised one side by side and comparing all five outputs byte for byte.

- **Two holes in the reference's own check, found while closing the gap.**

  A parameter aimed at a plain LIST pack was accepted in silence:
  `<gen type="template" value="person.lastName" domain="x"/>` did nothing at all
  and said nothing, which is indistinguishable from a typo — the exact failure
  `TDC072` exists to catch. A list has no parameters, and now says so.

  And only ABSOLUTE addresses were checked. A bare `person.lastName` is read
  against the active locale, exactly as the engine reads it, so every
  locale-relative address went unchecked — the same mistake was caught on
  `common.…` and waved through one line later. Both now behave the same way in
  all five, with three shared diagnostic cases and a runtime fixture holding them
  there.

- **The DSL version ceiling was tied to the package version, in one
  implementation only.** `<tdc version="0.1.3">` ran under TypeScript and was
  refused with `TDC005` by Python, Java, C# and Rust — the same config, five
  implementations, two answers. A package version moves for a fixed message or a
  rewritten README; the language does not, so every patch release quietly raised
  the reference's ceiling while the ports stayed where the DSL actually was.

  The two are separate now. The ceiling is `0.1.0` in all five — the current
  dialect — and rises only when the DSL gains something a previous runtime could
  not have understood, in all five at once. Two shared diagnostic cases say so if
  one is forgotten.

- **The Rust crate shipped without any data at all.** It found packs by walking
  up from the build directory looking for `data/packs` — which works in a
  checkout and cannot work in `~/.cargo/registry`, where a published crate has
  nothing above it. Packaged as it stood, `cargo install tdcv2` produced a binary
  that answered every `type="template"` with "no data packs found", while all 32
  test binaries were green: every test runs inside the repository.

  The starter set is compiled into the binary now — the same `common`, `en` and
  USA the other four carry, 489 files, and the crate is 0.5 MB against a 10 MB
  limit. A folder on disk still wins, so a downloaded pack shadows it.

  `rust/scripts/verify-crate.mjs` is the guard: it packages the crate, unpacks it
  OUTSIDE the repository, builds it there, and compares three pack-backed columns
  against the TypeScript reference. No in-repo test can see this class of bug.

### Changed

- **Every package now carries a version and the metadata to publish it.** The C#
  project had no `PackageId`, version, licence or description at all, so there was
  nothing for NuGet to show. Rust was at `0.1.0` and Java at `0.1.0-SNAPSHOT`,
  which Maven Central does not accept.

## [0.1.2] — 2026-08-02

Published to npm and, as the first release there, to PyPI.

### Added

- **The quick API now exists in Python too** — `from tdcv2 import tdc`, then
  `tdc.person.lastName()`. It was TypeScript-only, which made the npm landing
  page show a way of working the PyPI page could not.

  ```python
  from tdcv2 import tdc

  tdc.person.male.firstName()      # Robert
  tdc.country.usa.docs.ssn()       # 699209702
  tdc.person.lastName.many(5)      # five of them
  tdc.gen.number("18..80")         # '66'
  ```

  Not a second implementation of the idea: the same synthesised config, the same
  512-row batch, the same derived seed for the batch after that. So the same seed
  and address give the same value in both, and a test pins six of them plus the
  values either side of the batch boundary — the one place two implementations
  would drift. `seed()` and `locale()` return a new object rather than mutating
  a global, so two tests can hold two seeds at once.

  A missing pack says which pack and how to install it, as TypeScript now does.
  Python decides that structurally — nothing under the first segment, but the
  rest of the address resolves elsewhere — rather than from a table of locale
  codes, so it holds for packs that do not exist yet.

- **`DataPacks.addresses()`** — every address the packs can answer to. The quick
  API needs the whole list to say "did you mean", not a yes-or-no about one.

- **The Python implementation is published to PyPI** as `tdcv2`. Equal version
  numbers mean the same engine: the five are held to one contract by
  `fixtures/cross-language/`, so `tdcv2 0.1.2` from PyPI and `tdcv2 0.1.2` from
  npm produce the same bytes. Verified by running one config through both CLIs
  and comparing the sha256. The numbers need not move in lockstep — a library
  feature in one implementation moves only that one.

### Fixed

- **`tdcv2 --version` in Python reported a hand-written constant.** It was a
  second copy of the number in `pyproject.toml` and agreed with nothing but
  itself, which is the bug the TypeScript smoke test had and shipped with. It
  reads the installed distribution's metadata now, and a test compares the two.

### Changed

- **The Python README is a landing page rather than a checkout guide.** PyPI
  renders it as the project's front page, and it opened with `node
scripts/generate-parsers.mjs` and an editable install — instructions for
  someone who cloned the repository, shown to someone who just ran `pip
install`. Its relative links to `../docs/` would have 404'd on pypi.org as
  well. Checkout instructions are still there, under their own heading at the
  end.
- **Package metadata written for discovery**, matching what npm carries: a
  description that says what the thing does, 25 keywords, trove classifiers, and
  project URLs for the documentation, the source and the changelog.

### Fixed

- **A missing pack now says it is missing, instead of proposing another
  language.** npm ships a starter set — `common`, `en`, `usa` — and the registry
  carries the other hundred-odd, so `tdc.lang.ru.person.lastName()` on a fresh
  install has no `ru` to draw from. It answered `unknown address
"ru.person.lastName" (locale "en"). Did you mean "en.person.lastName"?`, which
  suggests English to someone who asked for Russian and reads like the address
  was a typo. When the leading segment names a real pack that is not reachable,
  the message now names the pack and the command that installs it. A typo inside
  an installed pack still gets the nearest address, as before.

## [0.1.1] — 2026-08-02

### Changed

- **The npm landing page now shows both ways of using TDC.** npm renders the
  README out of the published tarball, so 0.1.0's page could only show what
  0.1.0 shipped with. The page opens on a fork — reach for a value
  (`tdc.person.lastName()`) or describe a dataset (a config) — because these are
  two tools sharing one set of data and a reader has to see both.
- **Package metadata written for discovery.** A description that says what the
  thing does rather than what it is called, and 27 keywords covering the terms
  people actually search: `mock-data`, `fake-data-generator`, `synthetic-data`,
  `deterministic`, `fixtures`, `faker`, and the output formats.

### Fixed

- **A smoke test that was not testing what its name said.** It claimed to check
  `VERSION` against `package.json` and compared it to the literal `'0.1.0'`, so
  it agreed with itself and nothing else: `npm version` moved `package.json`
  while the test stayed green and `tdcv2 --version` reported the old number. It
  reads `package.json` now.

## [0.1.0] — 2026-08-02

First public release, to npm. Everything below shipped in it.

### Fixed

- **The four ports accepted eight attributes on a `<gen>` that the reference
  refuses.** `seed`, `engine`, `version` and `inject` belong to `<env>` or
  `<tdc>`, `uniq` to `<sequence>`, `is` to `<case>`, `on` to `<switch>`, `v` to
  `<tdc>`; each port kept ONE flat union of every attribute name in the language
  and judged a generator against it. The same config was valid in four
  implementations and refused in the fifth. Found by diffing the five lists after
  the fix below; a shared diagnostic case pins it now. Rust also reported the
  attributes of one tag in alphabetical rather than document order — its map is
  sorted — so two bad attributes came back to front.

- **Autocomplete offered less than the validator accepts.** The editor's attribute
  map was a hand-written copy of the validator's and had drifted: `<pool>` was
  missing entirely, `<gen>` was short 34 names, and `<line>`, `<case>`, `<data>`,
  `<mix>` and `<env>` each lacked one or more. Among the missing were `order` and
  `cycle` — the only two attributes the engine gives to `text` and `file` alone —
  so narrowing the list by `type=` had nothing to narrow with, and `<gen
type="text">` and `<gen type="number">` offered nearly the same thing. The map
  is derived from the validator now, and a test compares the two in both
  directions. Reported by the Studio agent, who measured it against a live server.

- **`parent=` on a `<gen>` was accepted and did nothing.** It is read on
  `<sequence>` and `<mix>`; on a `<gen>` nothing read it, so a config that plainly
  said "only build this where `a == A`" produced the value on every row with
  nothing said. Now `TDC015`, with a hint naming the tag that reads it. Deriving
  the completion map turned up a second of the same kind: `percent=` on a
  `<switch>`, which picks its case from `on=` and has no split to describe.

- **`TDC241`: two pools under one name.** The second replaced the first in
  silence, and the only sign was a `TDC193` in the block about a field that "does
  not exist" — the wrong place to look. `<sequence>` has said this since `TDC032`.

- **The ANTLR parser was regenerated on every test run.** `antlr-ng` rewrites
  `src/generated/*.ts` unconditionally — same bytes, new timestamp — and it ran
  from `prebuild`, `pretest` and `pretypecheck`. That made `tsc --incremental`
  re-emit the largest generated files after every run, and made "is `dist` older
  than `src`?" answer yes about a build minutes old. Regeneration is now
  conditional on the grammar's own timestamp (`npm run generate:force` overrides).

### Added

- **`accumulate=` — a running total across a `repeat` list.** A cell holding
  `100, 150, 150` becomes `100, 250, 400`. That is the shape most "I need a running
  total" questions actually have: a receipt's subtotal, the elapsed time of a session,
  the odometer over the legs of a trip.

  ```xml
  <gen type="number" value="150..900" decimals="2" repeat="3" separator=", " accumulate="sum"/>
  ```

  `sum`, `min` and `max`. The accumulation lives inside ONE record, so it costs nothing:
  rows stay independent, and streaming, parallel workers and `getAt` are untouched. The
  arithmetic runs on scaled integers, never floating point, so `19.99 + 0.01` is `20.00`
  in all five implementations. `min` and `max` return an element that already exists, so
  a value drawn as `007` stays `007`; an empty element (from `missing=`) passes over the
  accumulator instead of counting as a zero. `TDC237` when there is no list to
  accumulate, `TDC238` for an operation that is not one of the three.

- **`<gen type="running">` — a total that carries down the column.** An account balance
  after each transaction, a meter that only goes up, the largest load seen so far.

  ```xml
  <sequence name="Op"><gen type="number" value="-400..500"/></sequence>
  <sequence name="Balance"><gen type="running" of="Op" accumulate="sum" base="1000"/></sequence>
  ```

  `of=` names the column to accumulate and `reset=` splits it into segments — one
  balance per account rather than one per run — and both must be declared above the
  total (`TDC240`), the same rule `parent=` has. `base=` is the opening value and joins
  the decimal scale, so an opening `1000.00` widens the whole column to two decimals.
  A running total draws nothing, so adding one leaves every other column where it was.
  `TDC239` when it does not say what or how to accumulate.

  This is the one construct that cannot be computed from a row index, so the streaming
  engines refuse it by name and the router sends the config to the in-memory engine.
  The limit is per config: a run without a running total still streams.

- **`<pool>` — a row can reference a whole record.** A pool is a small table built once
  before the rows; a sequence draws one whole member from it, and the fields are read
  as `${{Ref.field}}`. Two thousand patients seen by thirty doctors, with the doctor's
  first name, last name and room always belonging to the same doctor.

  ```xml
  <pool name="Doctors" count="30">
      <sequence name="lastName"><gen type="template" value="person.lastName"/></sequence>
      <sequence name="room"><gen type="number" value="100..199"/></sequence>
  </pool>

  <sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>
  ```

  A pool is a miniature `<env>`: its body takes the same children the top level takes —
  `<sequence>`, `<mix>`, `<switch>`, `<uniq>`, `<distinct>`, `if=`, `parent=` — with the
  member count in place of the row count. One pick per row per reference, so a first
  name and a last name read in the same row always belong to the same member.

  `filter=` narrows the members a row may draw from, and takes a full expression:
  `filter="clinic == Clinic"`, `filter="price <= Budget"`. It differs from `if=` by
  result — `if=` false leaves the cell empty, `filter=` substitutes a matching member and
  never produces an empty cell.

  **Pools link to each other.** A member of one pool can hold a whole member of
  another declared above it, so a doctor belongs to a clinic and the clinic's own
  fields travel with him: `${{Seen.at.city}}`. And because a reference's fields are
  columns like any other, a `filter=` can name them — a nurse drawn from the clinic
  the row's doctor works at. Declaration order is the whole cycle check: a cycle
  cannot be written down.

  New diagnostics: `TDC222`–`TDC224`, `TDC226`, `TDC229`, `TDC230`, `TDC232`,
  `TDC236` (a pool drawing from a pool below it, or from itself), and the memory
  ceiling `TDC234` (warn over 100,000 members) / `TDC235` (refuse over 1,000,000).
  Documented in its own section, [Pools](webdoc/docs/pools/overview.mdx).
  All five implementations agree on the shared fixtures.

- **A `<sequence>` can compose its own value.** A body that is not all named `<gen>`s
  concatenates its unnamed `<gen>`s and the `<data>` literals between them, in
  declaration order, into `${{Name}}`; a named `<gen>` stays a field beside it. One
  value, so it goes into a card or a Parquet column as it stands — nothing to join at
  the output.

  ```xml
  <sequence name="FullName">
      <gen type="template" value="person.male.firstName"/>
      <data> </data>
      <gen type="template" value="person.lastName"/>
  </sequence>
  ```

  Purely additive: every body this gives a meaning to was `TDC110` before, so no
  config that used to render renders differently. It closes two silent failures — a
  `<data>` inside a `<sequence>` used to be dropped with no diagnostic at all, and
  `${{Name}}` on a body with several gens reached the output as a literal marker.

- **A named `<data>` is a constant field, and the only one that costs no draw.**
  `<data name="source">import-2026</data>` registers `Name.source` on every record.
  The equivalent `<gen type="text" value="import-2026"/>` yields the same value and
  still takes one draw per row, so dropping it into a config someone already uses
  shifts every column declared after it. A shared case pins the difference by
  rendering the same config with and without the constant and expecting identical
  bytes for the columns around it.

- **Rust joins the family, and C# reads drawings.** The Rust crate is now a complete
  implementation — the CLI, all three engines, Parquet, the registry client and
  `<gen type="http">` — held to the same contract as the other four: 111 shared cases,
  109 diagnostics, 47 CLI cases and 6 SHA256-pinned Parquet files. It takes no crate
  dependencies, so PNG, DEFLATE, SHA-256, Thrift and Snappy are written out; HTTPS
  shells out to `curl`, and says how to install it when there is none.

  With it, `<gen type="pattern" src="sketch.png">` — a curve read from a drawing —
  landed in Rust and in C#, which were the two implementations still refusing it. All
  five now read the same PNG or SVG into the same numbers.

- **The pack picker is in all five now.** `tdcv2 pack` on a terminal opened the
  full-screen picker — continent map, search, basket, review — in TypeScript, Python and
  Java, while C# and Rust printed the list. Both have it, drawing the same screens from
  the same registry geography.

  Rust reaches raw input the way Java does, by shelling out to `stty`, because the
  standard library has no API for it and the crate takes no dependencies; C# needs
  neither, since .NET reads a keystroke on its own. It does not decode the whole escape
  sequence on every terminal, though — measured, not assumed: a probe reports `Escape`
  and then `B` for a down arrow where the terminal database is missing — so the picker
  decodes what arrives instead of trusting the runtime, and is navigable either way.

  Verified frame by frame against the reference through a pseudo-terminal: seven
  journeys through the screens, and every drawn screen byte-identical including the
  colours of the map.

### Fixed

- **A run with no seed was not random in the ports, and the message said it was.** The
  reference invents a seed when neither `--seed` nor `<env seed=…>` supplies one, so a
  seedless run is a fresh sample and the seed printed beside it is the way back to that
  sample. C#, Python, Java and Rust left the seed empty instead: every seedless run
  produced the _same_ bytes, while the command line reported

  ```
  no seed specified — using random seed "". Re-run with --seed "" to reproduce this exact output.
  ```

  Two bugs in one sentence — the behaviour differed from the reference, and the advice
  reproduced nothing. All four now invent a seed and use it, shaped like the reference's
  `String(Math.random())` so the value looks the same whichever implementation printed
  it. Each has a test that two seedless runs differ and that the reported seed replays
  the first.

- **A composed value made only of literals was empty on the streaming engines.** A body
  whose every `<gen>` is named, with a bare `<data>` beside them, is composed — the
  literals are its value. Engine 1 said so and engines 2 and 3 returned an empty cell,
  because a streaming composed cell decided "is this row inside the parent's filter?"
  by asking its unnamed parts, and here there are none. A named field is asked instead,
  which draws for exactly the rows the sequence applies to. Two shared cases pin it:
  the value, and the fact that constant does not mean unconditional.

- **A name inside `if=` that names nothing was never caught** (`TDC215`), and it failed in
  both directions at once. `if="Ready"` where nothing is called Ready reads as the literal
  text `"Ready"`, which is not empty, so the branch fired on **every** row; `if="Ready ==
'x'"` equals nothing, so it fired on **none**. Both silently, in `<gen if=>`, `<line
if=>` and `<data if=>` alike, and `tdcv2 check` called the config valid. Nothing lands
  in the output to show for it — unlike a bad `${{…}}`, which at least leaves its marker —
  so the data looks right and the wrong branch was simply always taken.

  The check is positional, because an unknown name is otherwise a feature: `if="Gender ==
Male"` compares against the bare word `Male`, and the documentation is written that way
  throughout. The whole condition, the left of a comparison and anything arithmetic are
  names; the right of a comparison is left alone, since `A == B` is a value comparison when
  B is declared and a bare word when it is not. A dotted root must exist, and where the
  root is a compound the tail must be one of its fields — on a plain sequence the tail is a
  value (`Gender.Male`), which the config cannot be asked about.

- **A run with only warnings no longer reports itself as aborted.** The summary line said
  `aborted: 1 warning` when nothing had been aborted — the config was accepted, the data
  written, the exit code 0. It now says `1 warning`, and keeps `aborted:` for the case
  where something actually stopped.

- **A typo in the VALUE after the dot is now said out loud** (`TDC216`), where the config
  says outright what a sequence produces. `if="Gender.Mail"` makes a branch nothing can
  ever take, and nothing said so.

  Narrow on purpose. It applies only to a body that is one unnamed `<gen type="text"
value="a,b,c">` with no `case=`, `mask=` or `repeat=` — because those rewrite the value
  before the comparison sees it (`case="upper"` turns `Male` into `MALE`, `mask="xxxx"`
  turns `Female` into `Fema`), and a check against the written word would then be wrong in
  both directions at once. 13 of 615 text generators in the corpus carry one, and those are
  simply left alone.

  A **warning**, not an error, and the corpus decided that: a test in this repo narrows a
  list to `value="Man" percent="100"` on purpose and keeps the branch for `Woman`. That
  config works, so refusing it would be wrong — but the dead branch is still worth saying.

- **A conditional `<gen>`'s own `if=` was only checked by the reference.** All four ports
  walked past it, so an unsupported operator there was silent in everything but
  TypeScript.

- **A dotted reference was only checked up to the dot.** `${{Typo}}` was caught;
  `${{Person.frstName}}`, where `Person` exists and the field does not, reached the
  output verbatim — the exact failure `TDC193` was written to stop, and the more likely
  typo of the two, since the sequence name is right there in `<env>` while the field
  names are the ones you invent yourself. The whole reference is now checked, and the
  message names the field and lists the ones that do exist. A `<mix>`, a `<switch>` and
  a built-in have no fields at all, so any dot on one is refused.

  Found from the studio side, and the fix had a trap in it: the constant field added by
  a named `<data>` was registered nowhere, so comparing the full name would have raised
  a **false** error on a feature that shipped days earlier. Constants are registered
  first, and a shared case pins the half that must never fire.

  The four ports had been stricter than the reference here all along — nothing in the
  shared corpus had ever exercised the difference.

- **`parent=` on a compound sequence is refused before the run** (`TDC214`). It used to
  pass `tdcv2 check` and then die mid-generation with "unknown parent", naming a
  sequence declared right above. A parent selects rows by the value it produced, and a
  compound is a group of fields that produces none — so the message now says that
  instead of sending the reader after a name that is not the problem.

- **`<switch on="Seq.field">` blamed the sequence for a bad field.** `TDC134` now names
  the field, and lists the ones the sequence has.

- **The reference let two mistakes through that every port caught.** A drawing named
  by `src=` was never checked for existence, so a missing picture surfaced on row one
  of the run rather than at `check` time; and a `<gen type="file">` with `row=` but no
  `src=` reported only the missing `src`, hiding the missing `column` until the next
  run. Both are shared cases now, so the five cannot drift apart there again.

- **The ports underlined one character where the reference underlines the whole
  mistake.** Java, Python, C# and Rust printed a single `^` at the start column; they
  now cover the value inside its quotes, or the element with its children, exactly as
  the reference does on all 115 carets the shared fixtures produce.

- **CLI: piped stdout silently dropped most of the data.** `tdcv2 big.tdc | gzip`
  produced ~36% of the rows and still exited 0, because `fs.writeSync` short-writes
  to a non-blocking pipe and the return value was discarded. Every write to a
  caller-supplied descriptor now loops until fully drained (`src/output/write-all.ts`).
- **`uniq` refused satisfiable configs** and reported an invented, count-dependent
  capacity. It now redraws an unlucky sample (only where it previously threw, so
  working configs are unchanged) and, for quota-fixed draws, explains that the share
  is the limit. See `docs/decisions/2026-07-23-uniq-redraw.md`.
- **`uniq` + `percent` could hang.** The swap-repair copied its tally map on every
  candidate swap (cubic in the row count); 19,000 rows never finished. Now four
  in-place deltas — 278s → 2s, output byte-identical.

### Changed

- **`TDC110` is retired.** The body it complained about — an unnamed `<gen>` beside a
  named one — is the one people were trying to write, and now composes. The row stays
  in the errors table marked retired so the code is never reused for something else.
- **A `<data>` inside a `<sequence>` reads `name` and `comment` only.** Anything else,
  a `type=` above all, is `TDC015` rather than silently dropped; an output type belongs
  on the `<data>` in the `<line>`, where the column is actually emitted.
- **Validation is strict: config errors stop the run.** `TDC010`, `TDC015`, `TDC031`,
  `TDC124`, `TDC125`, `TDC194`, `TDC202` were warnings that let generation proceed with
  silently-wrong output; they are now errors. The only non-fatal diagnostics left are
  `TDC136` (a skippable malformed `<map>` row) and `TDC200` (a memory advisory). See
  `docs/decisions/2026-07-23-validation-is-strict.md`.
- **`TDC015` now catches a real attribute on the wrong generator** (e.g. `min`/`max` on
  a plain number, `range` on a number, `order` on a range-based type), and the two
  pack-less builtin templates (`person.b_day`, `date.range`).

#### Documentation

- Completed the error-code reference (15 previously-undocumented codes, a `<compute>`
  section, second meanings of `TDC072`/`TDC098`) and fixed examples that were broken or
  contradicted the engine (`usa.card.visa`, misplaced `<before>`, the `pair` and
  `TDC004` examples, the missing-data drop count).
- Fixed the determinism page: added the per-engine caveat and corrected the false
  "prefix" claim for weighted `template` packs.
- Russian docs: stopped the page that told users `location.country` errors under `ru`
  (it works), localized eight examples that showed Cyrillic from `en` configs, fixed the
  SQL-escaping example and stale weighted-pack numbers, and added `i18n/ru/code.json` so
  the site chrome renders in Russian.
- Added `docs/decisions/` (recorded engineering decisions) and `DEPENDENCIES.md`.

- Added a unified project gap audit and active roadmap, superseding the
  completed practical development plan.
- Added a current practical development plan that prioritizes external
  file/CSV data sources, row-linked data, data packs, CLI usability, scenario
  docs, streaming proof, and cross-language fixtures.
- Synced the Russian library API reference with the current direct-generator
  facade, including global preset domains, country document helpers, and
  business/tax/bank helper groups.
- Added a dedicated Russian direct preset route reference that maps every
  public `tdc.gen.*` helper route to its preset registry path.
- Documented the direct preset route metadata maintenance workflow so new
  preset registry paths stay synchronized with `tdc.gen.*` helpers.

#### TypeScript library internals

- Memory preflight can now distinguish materialized text output from streaming
  output, and the CLI uses the streaming estimate.
- Split direct generator facade types and preset-domain builders into
  `src/lib/direct/*`, keeping the public `tdc.gen.*` API unchanged while
  reducing `gen.ts` orchestration complexity.
- Direct preset facade builders now generate their nested helper trees from
  route metadata instead of maintaining separate manual object literals.
- Direct preset route metadata now lives in `src/lib/direct/preset-routes.ts`,
  separate from facade tree construction.
- Exposed internal direct preset route metadata for `tdc.gen.*` helper
  synchronization, including route names, preset paths, and explicit default
  attrs.

### Added

#### TypeScript generators

- Added a shared data-source resolver for file-backed generators, including
  config-relative paths, `dataPaths`, `@data/...` aliases, and
  `pkg:package/path` package lookups.
- CSV-backed `<gen type="file">` now supports row-linked fields via
  `row="key"` in sequence context, preserving coherent multi-column records
  across compound or separate sequences.
- `<gen type="file">` now supports CSV column sources via `column`, optional
  `header`, and optional `delimiter`, while keeping the existing text-list mode
  unchanged.

#### Russian user documentation

- Added a streaming and large-output guide covering `toString()`,
  `toIterator()`, `toStream()`, `writeFile()`, CLI output, object output, and
  `preflight({ output: "streaming" })`.
- Added scenario-driven recipe documentation for CSV customers, SQL inserts,
  external lists, CSV columns with row links, and direct generator usage.
- Added a CLI guide covering package installation, `tdc <input.tdc>`, output
  files, `--data-path`, and exit codes.
- Added a data-source resolver guide and documented `baseDir`, `dataPaths`,
  `@data/...`, and `pkg:...` file source forms.
- Documented row-linked CSV file generation with the new `row` attribute.
- Documented CSV-column usage for `<gen type="file">`, including the new
  `column`, `header`, and `delimiter` attributes.

#### TypeScript test coverage

- Added shared cross-language determinism fixtures for PRNG, Hamilton
  distribution, and byte-exact runtime rendering, plus TypeScript coverage that
  reads the implementation-neutral fixture files directly.
- Added large-output streaming proof coverage for materialized vs streaming
  memory estimates, lazy `toIterator()` chunks, `toStream()`, and `writeFile()`
  using the iterator path.
- Added a documentation smoke test that extracts XML configs from Russian
  recipe pages and renders them through the public `TDC` facade.
- Added CLI coverage for npm-bin symlink detection, `--data-path`, `--name=value`
  options, and stricter argument errors.
- Added sequence, renderer, and validator coverage for row-linked CSV-backed
  `<gen type="file">` fields.
- Added generator, renderer, sequence, and validator coverage for CSV-backed
  `<gen type="file">` sources.
- Added public direct preset helper smoke coverage that resolves every
  `tdc.gen.*` helper from route metadata and invokes the real facade.
- Added a documentation guard that keeps the direct preset route reference
  aligned with `DIRECT_PRESET_ROUTES`.
- Added a type-level guard that verifies every direct preset metadata route is
  present on the public `TdcGenFacade` type.
- Added public direct-generator API type smoke tests that import from the
  package entrypoint and verify exported facade, attribute, and generator
  alias types.
- Added direct preset facade guard tests to keep helper methods synchronized
  with the preset registry and explicit attr-forwarding behavior.
- Added preset registry integrity guard tests for path/source-map alignment,
  public resolver sync, registry path naming, and default preset callability.

#### TypeScript library API — object output and direct generators

- `TDC` now supports object output via `toArray()`, `iterate()`, and
  `getAt(index)`, exposing materialized `<sequence>` values as plain
  JavaScript records while ignoring text-output wrappers.
- `TDC.toStream()` now exposes text output as a Node.js `Readable` stream for
  `tdc.toStream().pipe(...)` workflows.
- Simple sequences become scalar object properties, compound sequences become
  nested objects, and parent-filtered sequences use `undefined` on rows where
  the value does not apply.
- Added `createGen({ seed, locale, now })`, a faker-like direct generator
  facade for small one-off values without a DSL document.
- Added the ready-to-use `gen` facade plus direct helpers such as
  `gen.num(...)`, `gen.person.firstName(...)`, `gen.woman.firstName()`,
  `gen.internet.email(...)`, `gen.id.uuid()`, `gen.regex(...)`, and
  `gen.date(...)`.
- Added the lowercase `tdc` facade so callers can use the intended
  `tdc.gen.*` style and create seeded facades with `tdc.createGen(...)`.
- Direct generator facades now support `withSeed(seed)` and
  `forRecord(scope, index)` for independent, reproducible one-off values
  without advancing the parent facade's PRNG state.
- Direct generator facades now expose common global preset domains directly:
  `phone.*`, `finance.*`, `payment.cardPan`, `product.*`, `book.*`,
  `periodical.issn`, `device.*`, `logistics.containerIso6346`,
  `security.*`, `vehicle.vin`, `system.semver`, `git.sha`, and `docs.mrz.*`.
- Direct generator facades now expose country-specific preset domains directly:
  `docs.<country>.*`, `tax.<country>.*`, `bank.ru.*`, and
  `finance.us.abaRouting`, using camelCase method names for snake_case preset
  paths.
- Direct `preset(...)` calls and their helper aliases now validate preset
  attributes before generation and report the same errors as the DSL validator.
- Russian user docs now include a library API page covering text output,
  object output, and direct generator calls.

#### DSL runtime — preset generators

- `<gen type="preset" value="..."/>` adds a separate algorithmic generator
  layer for common reusable identifiers and safe synthetic technical values.
- Initial preset paths: `id.uuid`, `id.ulid`, `id.nanoid`, `id.object_id`,
  `internet.email`, `internet.username`, `internet.domain`, `internet.ipv4`,
  `internet.ipv6`, `internet.mac`, `system.semver`, and `git.sha`.
- Structured preset paths now include `tax.br.cpf`, `tax.br.cnpj`,
  `docs.es.dni`, `docs.es.nie`, and `vehicle.vin`, including check
  digit/letter generation.
- Country preset coverage now includes `docs.us.ssn`, `tax.us.ein`,
  `docs.ca.sin`, `docs.pl.pesel`, `tax.pl.nip`, `docs.ru.snils`,
  `tax.ru.inn_org`, `tax.ru.inn_person`, and `docs.uk.nino`.
- Americas business/tax preset coverage now includes `tax.us.itin`,
  `finance.us.aba_routing`, `tax.ca.bn`, `tax.ca.program_account`,
  `tax.mx.rfc`, `tax.mx.rfc_person`, and `tax.mx.rfc_org`.
- Latin America preset coverage now includes `docs.ar.dni`, `tax.ar.cuit`,
  `tax.ar.cuil`, `docs.cl.run`, `tax.cl.rut`, `docs.co.cc`, and
  `tax.co.nit`.
- Latin America preset coverage now also includes `docs.pe.dni`, `tax.pe.ruc`,
  `docs.uy.ci`, `tax.uy.rut`, `docs.py.ci`, and `tax.py.ruc`.
- Latin America preset coverage now adds Ecuador, Venezuela, Dominican
  Republic, Costa Rica, Panama, Guatemala, El Salvador, Bolivia, Honduras, and
  Nicaragua country presets, including checksum-backed EC/VE/DO/SV generators
  and structural Central America document/tax formats.
- Russian business/finance preset coverage now includes `tax.ru.ogrn`,
  `tax.ru.ogrnip`, `tax.ru.kpp`, `bank.ru.bik`, `bank.ru.account`, and
  `bank.ru.correspondent_account`.
- EU business/tax preset coverage now includes `tax.eu.vat`, `tax.de.vat`,
  `tax.fr.siren`, `tax.fr.vat`, `tax.it.vat`, `tax.es.cif`, `tax.es.vat`,
  and `tax.pl.vat`.
- `tax.eu.vat` now covers all current EU VAT prefixes (`AT`, `BE`, `BG`,
  `CY`, `CZ`, `DE`, `DK`, `EE`, `EL`, `ES`, `FI`, `FR`, `HR`, `HU`, `IE`,
  `IT`, `LT`, `LU`, `LV`, `MT`, `NL`, `PL`, `PT`, `RO`, `SE`, `SI`, `SK`)
  with matching country-specific `tax.xx.vat` paths.
- Global standards preset coverage now includes `finance.iban`, `finance.bic`,
  `payment.card.pan`, `product.ean13`, `product.upc_a`, `product.gtin14`,
  `book.isbn10`, `book.isbn13`, `periodical.issn`, `device.imei`,
  `device.iccid`, `logistics.container_iso6346`, `docs.mrz.passport_td3`,
  and `docs.mrz.id_td1`.
- Utility preset coverage now includes `internet.slug`, `internet.url`,
  `phone.e164`, country phone aliases, `security.api_key`, `security.otp`,
  `security.totp_secret`, `security.jwt`, and hash-shaped security values.
- Presets work both inside `<sequence>` and inline inside `<line>`.
- `internet.email` defaults to safe synthetic domains and supports an explicit
  `domain` override; `id.nanoid`, `internet.username`, and `internet.email`
  support bounded `length`.
- `tax.br.cpf` and `tax.br.cnpj` support `format="raw|formatted"`;
  `docs.es.nie` supports `prefix="X|Y|Z"`.
- New country preset attrs include `format="raw|formatted"` for maskable IDs,
  `prefix` for SIN/NINO/EIN/NIE, `suffix` for NINO, `sex` for PESEL, and
  `tax_office` for Russian INN generators.
- Russian business/finance preset attrs include `year`, `reason`, `serial`,
  `region`, `rkc`, `participant`, `bik`, and `currency`.
- EU business/tax preset attrs include `country`, `siren`, and `entity`.
- Americas business/tax preset attrs include `group`, `bn`, `program`,
  `reference`, `kind`, and `date`.
- Utility preset attrs include `scheme`, `path`, `algorithm`, and phone
  `format="e164|raw|formatted"`.
- Latin America preset attrs include `dni`, `body`, `branch`, and `kind`, plus
  reused `prefix`, `length`, and `format`.
- Expanded Latin America preset attrs include `ci`, `establishment`,
  `province`, `class`, and `suffix` for country-specific structures.
- Validator diagnostics now cover missing, unknown, and malformed preset
  declarations, including typo suggestions for known preset paths.
- Russian user docs now include a dedicated `presets.md` reference page.

#### DSL runtime — Unicode alphabets

- `<gen type="symbol" alphabet="..." length="..."/>` now generates
  fixed-length Unicode strings from named alphabets.
- Initial named alphabets include Latin, ASCII/fullwidth digits, Russian
  Cyrillic with `Ё/ё`, Greek, Hebrew, Arabic, Japanese Hiragana/Katakana,
  basic CJK unified ideographs, and roman numeral letters.
- `type="regex"` and `type="advanced_regex"` now support named alphabet
  escapes such as `\a{kana.hiragana}` and `\a{cyrillic.ru.letters}`, both as
  standalone atoms and inside character classes.
- Regex character-class ranges already work for BMP Unicode ranges such as
  `[а-я]`, `[א-ת]`, and `[ぁ-ゖ]`; named alphabets are now the recommended
  user-facing syntax when the set needs stable documentation or extra symbols.
- Shared preset character helpers now pick by Unicode code point rather than
  UTF-16 code unit, so non-BMP alphabets are not split into surrogate halves.
- Russian user docs now describe `type="symbol"`, the `alphabet` attribute,
  and the shared named-alphabet syntax for regex generators.

#### DSL runtime — date generator

- Added a portable TDC date runtime with strict date/datetime parsing, UTC
  calendar arithmetic, `en`/`ru` locale data, and Moment-like output tokens
  without depending on moment.js.
- Added `<gen type="date" .../>` for random date ranges, datetime ranges,
  fixed `today` / `now` values, and `birth` mode with `oldest` / `youngest`
  age bounds.
- Date generation supports `value="START..END"`, `range="START..END"`,
  `from="..." to="..."`, `precision="day|second|millisecond"`, and
  `format` tokens such as `YYYY-MM-DD`, `DD.MM.YYYY`, `L`, `LL`, and
  `YYYY-MM-DDTHH:mm:ss.SSS`.
- Legacy templates `person.b_day` and `date.range` now use the new TDC date
  runtime internally while keeping their public template paths.
- Date validation now catches calendar-invalid dates such as `2024.02.30`,
  malformed ranges, invalid age bounds, unknown date locales, bad precision
  values, and unterminated format literals.
- Removed the TypeScript implementation's runtime dependency on moment.js.

### Changed

#### TypeScript internals — preset module layout

- Preset implementation is now split by domain under `typescript/src/presets`:
  technical/global helpers, global standards, country packages, shared utility
  functions, and thin registry aggregators. Public `<gen type="preset">` paths
  are unchanged.

#### DSL runtime — advanced regex generator

- `<gen type="advanced_regex" value="..."/>` adds a separate experimental
  generator track without changing the stable `type="regex"` behavior.
- Advanced Regex supports the finite regex subset plus TDC weighted-choice
  syntax such as `(?%{70:RU;20:US;10:DE})`.
- Weighted-choice branches are recursive advanced-regex patterns, so nested
  weighted choices such as `(?%{50:A(?%{80:X;20:Y});50:B})` materialize exact
  percentages inside the subset that reached the branch.
- Weighted choices are supported only in sequence contexts, where a known
  `count` allows Hamilton-exact distribution and deterministic shuffle. Inline
  `advanced_regex` is accepted only when it contains no weighted choices.
- Russian user docs and vision notes now document the Advanced Regex track,
  sequence-only percent semantics, and the planned path toward named captures
  and conditionals.
- Advanced Regex tests now cover the finite-regex core, capture/backreference
  links, nested weighted choices, parent-filtered subsets, switch-case subsets,
  malformed patterns, and user-facing validation diagnostics.

#### DSL runtime — finite regex generator

- `<gen type="regex" value="..."/>` now generates strings from a finite,
  AST-parsed regex subset without external runtime dependencies.
- Supported regex constructs include literals, escaped literals, character
  classes, shorthand classes (`\d`, `\w`, `\s` and inverse forms), dot
  wildcard, alternation, capturing and non-capturing groups, bounded
  quantifiers (`?`, `{n}`, `{n,m}`), and backreferences to already generated
  groups.
- Unbounded constructs (`*`, `+`, `{n,}`), lookarounds, named captures,
  conditional groups, multiline escapes, and Unicode property classes are
  rejected by validation.
- `<tdc regex_max_length="N">` defines the global regex safety limit; local
  `<gen type="regex" regex_max_length="N"/>` overrides it per generator. The
  default limit is `32`.
- Regex generators work in sequences, compound sequence fields, switch cases,
  and inline `<line>` rendering.
- Russian user docs and vision notes now describe the finite-regex contract
  and implementation plan.
- Russian user docs now include a dedicated finite regex language reference
  page alongside the Advanced Regex reference.
- The Advanced Regex reference now explains the difference from ordinary
  `regex`, sequence-only weighted-choice semantics, parent-filter behavior,
  and practical examples.

#### DSL runtime — extended number generators

- `<gen type="number" length="N" [first_zero="true|false"]/>` now
  generates fixed-length digit strings without requiring a numeric
  range, so very large numeric-looking identifiers are generated as
  text instead of JavaScript numbers.
- `<gen type="number"/>` now defaults to one random digit, and
  `<gen type="number" value="bit"/>` generates `0`/`1`.
- Numeric ranges preserve width when the bounds encode leading zeros,
  e.g. `value="0000..9999"` can emit `0034`.
- Numeric ranges now use `MIN..MAX` as their only range separator,
  including negative bounds, e.g. `value="-500..-200"`.
- `length` now supports ranges and grouped distributions such as
  `length="2-10"` and `length="2,10-12" percent="85,15"`.
- `<gen type="number" value="[MIN..MAX],[MIN..MAX]"/>` now supports
  multi-range selection. The generator chooses a declared range
  uniformly, then chooses a value uniformly inside that range.
- Number validation now accepts length-only mode, validates multi-range
  syntax, and rejects the pre-release `value="MIN-MAX"` spelling.
- Russian user docs now describe number digit-string mode and
  multi-range mode.

#### DSL runtime — document version compatibility

- `<tdc version="...">` and short `<tdc v="...">` now declare the DSL
  version required by a config file.
- The validator rejects documents whose declared version is newer than
  the current TypeScript runtime version, preventing old binaries from
  silently processing newer DSL dialects.
- Invalid version strings and documents that declare both `version` and
  `v` now produce stable validator diagnostics.
- Russian user docs now describe root document version compatibility.

#### DSL runtime — presentation switch/case

- `<switch>` / `<case>` now works inside `<line>` and nested inside
  `<case>`, choosing exactly distributed cases with the same percent-mask
  and Hamilton logic as `type="text"`.
- `<switch>` / `<case>` now also works as a scalar `<sequence>` source.
  Sequence cases can compose values from `<data>`, `<gen>`, and nested
  `<switch>` blocks; `parent` filters are applied before switch
  percentages.
- Nested switch percentages inside sequence cases are computed against
  the subset that selected the parent case.
- Switch cases can contain `<data>`, inline `<gen>`, and nested
  `<switch>` blocks.
- Validator diagnostics now cover empty switches and invalid switch
  percent masks, plus ambiguous sequence roots that mix direct `<gen>`
  and `<switch>`.
- Russian user docs now include `<switch>` and `<case>`.

#### DSL runtime — inline numeric generators

- Inline `<gen>` inside `<line>` now supports `type="number"`,
  `type="increment"`, and `type="decrement"` in addition to `file` and
  `template`.
- Inline counter generators keep independent per-tag state and advance
  only when their own `<gen>` is actually rendered.
- `number` generator range parsing now supports negative lower bounds
  such as `value="-5..5"`, matching the documented syntax.

#### DSL runtime — paired data and percent masks

- `<data pair="X">...</data pair="X">` now supports literal nested
  `</data>` text inside raw data blocks. Pair values are checked for
  duplicate use and mismatched close tags are reported as parser
  diagnostics.
- `percent` on `<gen type="text">` now accepts the short mask forms
  from the vision docs: `42`, `,58`, `,10,10`, `,,25,,`, and trailing
  masks such as `46,`. Empty positions split the remaining percentage
  equally before Hamilton distribution runs.
- User documentation, playground notes, and grammar notes were updated
  to describe the implemented behavior.

#### Phase 6, Weeks 13-16 — TDC class + CLI + 0.1.0 version bump

- `typescript/src/lib/tdc.ts` — `TDC` class facade described in
  `docs/vision/17-library-api.md`. Constructor takes either
  `configFile` or `configString` plus optional `seed`/`count`/
  `locale`/`now` overrides; terminal methods are `toString()`,
  `writeFile(path)`, and `toIterator()` (generator yielding one row
  per line). Eager parsing, lazy rendering, reusable per-instance.
- `typescript/src/cli/main.ts` — minimal CLI (`tdc <input.xml>
[--seed ...] [--count ...] [--locale ...] [-o <out>]`), wired via
  `package.json` `bin` so `npm install` gives users the `tdc`
  command. Exits 0 on success, 2 on usage error, 1 on runtime error.
- `package.json` version bumped to 0.1.0 (the first publishable
  shape). `VERSION` constant in `src/index.ts` kept in sync.
- Public API re-exports `TDC`, `TdcOptions`, `evaluateIf`, and the
  number/increment/decrement generators alongside prior phases.

#### Phase 5, Weeks 11-12 — Expressions, number, counters

- `typescript/src/expr/evaluate.ts` — `evaluateIf(expr, registry,
iteration)` parses `if`-attribute expressions once (caches by
  source), then walks the AST per iteration. Supports `==`, `!=`,
  `<`, `>`, `<=`, `>=`, `&&`, `||`, `!`, and the arithmetic
  operators. Unknown identifiers are treated as bare string literals
  so `if="Gender == Male"` works without quoting.
- `jsep` 1.x added as a runtime dependency — minimal parser, no
  transitive deps.
- `typescript/src/generators/number.ts` — `<gen type="number"
value="MIN..MAX" [length="N"] [first_zero="true|false"]/>`, uniform
  integer with optional zero-padding and first-digit-non-zero retry.
- `typescript/src/generators/counter.ts` — `<gen type="increment"
[value="N"] [step="M"]/>` and `<gen type="decrement" ...>`.
  Seed-independent (positional), so counters advance for every row
  regardless of `if` filters.
- Processor gates `<line if="...">` and `<gen if="..."/>` on the
  result of the expression; filtered lines don't emit and their
  between-line delimiters don't emit either.
- Sequence engine dispatches `number`, `increment`, and `decrement`
  types alongside text / file / template.
- `fixtures/tdc_conditional_demo.xml` — 20 rows, age gate at 18,
  counter-backed UID column with visible gaps where the filter
  rejected a row.

#### Phase 4, Weeks 9-10 — Sequence engine with parent-child dependency

- `typescript/src/sequence/` — types, extraction, and build of
  `<sequence>` declarations inside `<env>`. `parent="Name.Value"`
  dot-notation restricts a child sequence to rows where the parent
  produced the literal value; bare `parent="Name"` applies to rows
  where the parent produced any value. Percentages inside child
  `<gen>` evaluate over the constrained subset.
- `buildSequences()` seeds the registry with the built-in `_count`
  (1-based iteration index) and processes user sequences in
  declaration order; unresolved parents throw with a clear message.
- Processor integration: `extractSequenceSpecs` + `buildSequences`
  run immediately after env-config extraction and before the main
  render loop. Interpolation of `${{SequenceName}}` references is
  served from the same registry. Filtered-out rows interpolate to
  the empty string.
- `fixtures/tdc_sequence_demo.xml` — Gender 42/58, ProstateIssue
  (Male only, 20/80), BreastIssue (Female only, 15/85). Baseline
  locks in exact per-value counts within each subset and the
  "opposite column empty" contract.

#### Phase 3, Weeks 7-8 — End-to-end MVP

- `typescript/src/templates/` — stock locale data and path resolver.
  Data is the verbatim 17 string arrays from the 2022-2024 prototype's
  `Templates.ts`, exported to `/data/templates.json`. Resolver maps
  dotted paths (`person.male.firstName`, `person.female.diagnosis`,
  `person.gender`, `location.country`, `person.b_day`, `date.range`)
  to per-cell value factories; matches the prototype's list-combination
  semantics (`*.lastName` concatenates with `*_common_last_name`,
  `*.diagnosis` concatenates with `*_common_diagnosis`).
- `typescript/src/generators/date.ts` — `person.b_day` and `date.range`
  template sources using `moment.js` for format-string fidelity with
  the prototype. Registered into the template resolver at module load.
- `typescript/src/processor/` — the render pipeline.
  - `walk.ts` exposes typed helpers over the ANTLR parse tree
    (`elementKind`, `extractAttrs` with quote stripping,
    `extractDataText`, `findChildElement`).
  - `render.ts` is the main entry point: extracts `<env>` config
    (`count`, `seed`, `inject`, `local`), materializes fixture blocks
    (`<before>`, `<after>`, `<before_block>`, `<after_block>`,
    `<delimiter_block>`, `<before_line>`, `<after_line>`,
    `<delimiter_line>`), iterates over `<block>`'s lines for each of
    `count` cards, dispatches `<gen type="...">` to the appropriate
    source (`template` via resolver, `file` via `fileUniform`), and
    applies inject-configurable interpolation for `${{_count}}`.
    Newline placement and ordering match the prototype exactly.
- `fixtures/expected-tdc_*.out` — byte-exact reference outputs for the
  five canonical fixtures, captured from the prototype with a fixed
  `now = 2026-04-23T12:00:00Z`. These are the cross-language
  bit-identical contract the Python and Java implementations must
  honour.
- `moment` added as a runtime dependency (temporary — swap to `Intl` /
  `Temporal` tracked for post-v1 when a conscious break of byte
  compatibility is acceptable).
- Coverage after Phase 3: 117/117 tests green, 98.77% statements,
  84.81% branches, 100% functions.

#### Phase 2, Weeks 4-6 — PRNG, distribution, and first generators

- `typescript/src/prng/` — deterministic pseudo-random number generator.
  - `cyrb128(seed)` hashes the seed string into four 32-bit unsigned
    integers; `sfc32(a,b,c,d)` turns that state into a zero-arg
    `() => number` producing floats in `[0, 1)`. `createPrng(seed)`
    composes the two. Algorithm ported verbatim from the 2022-2024
    prototype; test file locks six seeds × ten values as GOLDEN_VECTORS
    so backwards compatibility is a single commit away from being
    detected.
  - `randomInt(prng, min, max)`, `randomPick(prng, arr)`, and
    `shuffle(prng, arr)` — stateless utilities over a supplied PRNG.
    Fisher-Yates `shuffle` returns a fresh array without mutating the
    input. Golden-vector tests against the prototype for all three.
- `typescript/src/distribution/` — Hamilton largest-remainder method
  for exact percentage distribution.
  - `distributeByPercent({count, values, percents, prng})` returns a
    materialized + shuffled array whose per-value counts exactly
    match the requested percentages.
  - `computeCountsPerValue(...)` exposes the raw counts without
    materialization for use by future engine code.
  - Bit-identical golden vectors for (count=100, [M,W], [42,58]) on
    the fixture seed and two other representative cases.
- `typescript/src/generators/` — first two generator kinds, matching
  what the fixtures use.
  - Shared `Generator = (count, prng) => readonly string[]` contract:
    a generator materializes its sequence's per-cell values in one
    call, so the future sequence engine stays simple.
  - `textWithPercents(values, percents)` — Hamilton-distributed text
    generator.
  - `textUniform(values)` — independent uniform-random picks per cell.
  - `fileUniform(path, loader?)` — eager list-file load then uniform
    random picks. Loader is injectable so callers can substitute
    in-memory / HTTP / npm-pack sources without touching the
    generator.
  - `loadListFile(path)` — filesystem reader (one trimmed non-empty
    line per entry, CRLF-tolerant).
  - Throws on empty input lists rather than producing `undefined` cells.
- Public API re-exports in `typescript/src/index.ts` now expose
  `createPrng`, `cyrb128`, `sfc32`, `randomInt`, `randomPick`,
  `shuffle`, `distributeByPercent`, `computeCountsPerValue`,
  `textUniform`, `textWithPercents`, `fileUniform`, `loadListFile`,
  and the `Generator` / `DistributeOptions` types.
- Coverage after Phase 2: 98.54% statements, 93.33% branches, 100%
  functions across all modules. 80/80 tests passing.

#### Phase 1, Weeks 2-3 — Parser milestone

- ANTLR4 grammar for the TDC DSL, split into
  `grammar/TDCLexer.g4` (lexer with dedicated `DATA_MODE` for raw-text
  `<data>` semantics via pushMode/popMode) and `grammar/TDCParser.g4`
  (parser using the shared token vocabulary).
- TypeScript parser pipeline at `typescript/src/parser/`: `parse()`
  returning `{ tree, diagnostics }`, and `parseStrict()` throwing
  `TdcParseError` on any diagnostic. Both share a single
  `DiagnosticCollector` wired to both lexer and parser so all errors
  end up in one ordered collection with `line`/`column`/`source` info.
- Toolchain: `antlr4ng` 3.0.16 (runtime) and `antlr-ng` 1.0.10
  (generator) — pure-TypeScript ports with no Java requirement for the
  generator, consistent with the minimum-dependency policy in
  `docs/vision/16-portability.md`. The same `.g4` grammar files will
  drive future Python and Java implementations via `antlr-ng`'s other
  language targets.
- `npm run generate` invokes `antlr-ng` to produce
  `src/generated/{TDCLexer,TDCParser,TDCParserListener}.ts`; runs
  automatically as a `prebuild`/`pretest`/`pretypecheck` step so
  downstream checks never operate on stale or missing generated code.
  Generated code is gitignored.
- Test coverage: all 5 canonical fixtures
  (`tdc_csv.xml`, `tdc_json.xml`, `tdc_sql.xml`, `tdc_markdown.xml`,
  `tdc_txt.xml`) parse successfully via `parseStrict`. 23/23 tests
  green; coverage 98.4% statements / 83.3% branches / 100% functions.

### Changed

- `typescript/tsconfig.json` no longer enables `noUnusedLocals`,
  `noUnusedParameters`, or `verbatimModuleSyntax`. These would flag the
  ANTLR-generated code under `src/generated/`, which we cannot modify.
  ESLint still enforces `@typescript-eslint/no-unused-vars` on
  hand-written code (generated code is in the ESLint ignore list), so
  the check is preserved — just relocated to the tool that can scope it.
- `eslint.config.mjs` test-file override pattern changed from
  `test/**/*.ts` to `**/test/**/*.ts` so it applies whether ESLint is
  invoked from the `typescript/` workspace directly or from the repo
  root (as `lint-staged` does during pre-commit).

#### Phase 1, Week 1 — TypeScript scaffold and tooling

- npm workspaces at repo root with `typescript/` as the first workspace
  member; husky v9 + lint-staged as root dev-dependencies.
- Repo-root `.editorconfig` for consistent editor behavior across languages.
- TypeScript workspace (`typescript/`) scaffolded with:
  - TypeScript 5.6 in strict mode plus extra-strict options
    (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
    `noImplicitOverride`, etc.)
  - Vitest 2.1 for testing with v8 coverage (80% threshold floor)
  - ESLint 9 flat config via typescript-eslint 8.6 strictTypeChecked +
    stylisticTypeChecked + eslint-config-prettier
  - `max-lines: 1000` rule per engineering discipline spec
  - `no-explicit-any` as error, `explicit-module-boundary-types` as warn
  - Prettier 3.3 with project conventions
  - Separate `tsconfig.build.json` for production output
  - Smoke test (2 tests) verifying package exports a semver-shaped
    `VERSION` constant
- Husky pre-commit hook that runs lint-staged on touched files
- GitHub Actions workflow (`typescript-ci.yml`) with matrix on Node 20.x
  and 22.x: typecheck, lint, format:check, test with coverage, build,
  plus a separate gitleaks secret-scan job

#### Initial project structure

- Language-agnostic `docs/`, `grammar/`, `fixtures/`, `data/` directories,
  and self-contained per-language directories (`typescript/`, `python/`,
  `java/`).
- Full project specification and design documentation in `docs/vision/`
  (22 markdown files), migrated from the brainstorming phase.
- Regression test fixtures (`fixtures/*.xml`) from the 2022-2024 prototype,
  covering 5 canonical output formats: CSV, JSON, SQL, Markdown, plain text.
- Shared data files (`data/firstName.txt`, `data/lastName.txt`,
  `data/eng.json`) — portable word lists usable by all language
  implementations via the `type="file"` generator.
- Agent onboarding entry points: `CLAUDE.md` and `AGENTS.md` at repo root,
  directing new AI agents or developers to `docs/vision/START_HERE.md`.
- MIT license.
- Root-level `.gitignore` covering common artifacts across all planned
  language ecosystems.
