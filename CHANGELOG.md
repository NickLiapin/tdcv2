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

### Added

<!-- covers: pack body seed, engine 3 whole-column packs -->

- **Engine 3 builds a share-declaring data pack itself instead of handing the run to the
  in-memory engine — and a determinism bug goes with it.** Twelve shipped full-name packs
  (`hu.person.male.fullName` and its kind) declare a share inside their own body. The streaming
  path refused them, so `--engine 3` quietly became engine 1 for any config that used one.

  The cause was one missing argument. The pack-generator call ran the body without a `seed`, so
  the body's own sequences keyed their draws off the empty string and took their tie-breaks from
  the shared sequential prng. Three things followed. The body could not be planned over a column
  at all, which is what the refusal was about. Two different packs, and the same pack in two
  columns, drew alike — the address and the column never entered the key. And **the values
  MOVED when an unrelated sequence was added to the config**: `x,y,z` at 50/30/20 under seed
  `s` came out `y y x x y y …` alone and `x y x x x y …` behind a `<uniq>`, because the
  neighbour had advanced the shared stream. Same seed, same pack, same count.

  A pack body now gets a seed and a stream identity like every other sequence, and the
  streaming builder runs the body itself at the COLUMN's count — the share is apportioned over
  the column and each row mapped into it, exactly as a top-level `percent=` has always been. All
  three engines produce the same rows; `hu.person.male.fullName` gives six distinct names where
  a per-row plan would have given six copies of the largest share.

  The ROW is part of the body's seed when the body is built for one row, and that is not a
  detail: a pack that does NOT need the whole column is built per row, and handed a column-wide
  seed at count 1 the body's own exact-layout machinery plans one slot and gives it to one value.
  Without the row salt `usa.finance.aba_routing` came out as six numbers all starting `27`.

  **Byte change, once:** any config drawing from a pack whose body declares a share, or from one
  whose body computes (`usa.finance.aba_routing`), produces different values for the same seed.
  Two shared cases and one runtime fixture moved with it.

  **And the router had to be told.** Removing the streaming refusal was not enough: every
  implementation's router still sent a config naming such a pack to the in-memory engine, so the
  run landed on the engine that holds the whole table anyway and the new lazy path was never
  reached. Measured on a 5,000,000-row `hu.person.male.fullName` column: the in-memory engine
  wanted **2 GB** and died under a 512 MB cap, while the streaming path finished the same run
  **inside 512 MB**. The rule is gone from all five.

  Verified at size, with the heap capped rather than measured: 70,000,000 rows of an env-level
  `<uniq>` — a 1.0 GB file — inside a **1 GB** heap in 137 seconds, every one of the 70,000,000
  rows distinct. And the two together, `<uniq>` beside a weighted pack, 5,000,000 rows inside
  **512 MB**.

  One shape stays with the in-memory engine: a body carrying its own `<valid>`, where rejecting
  a row and redrawing it is a whole-column decision with no lazy form yet.

<!-- covers: engine 3 named refuses -->

- **`--engine 3` no longer runs engine 1 behind your back.** Naming an engine says WHICH engine
  to run, so quietly running another hides exactly what the author asked to be told — the rule
  the streaming engine has followed all along, written in its own source. Engine 3 was never
  wired to it, and the gap was not theoretical: on a `<uniq>` too tight for engine 3's bounded
  repair, `--engine 3` and `--engine 1` wrote **byte-identical files**, while the same config
  inside the cap wrote different ones. Anyone measuring engine 3 on a tight config was measuring
  engine 1. It happened three times in one day to the person who wrote the fallback.

  A named engine 3 now refuses, and the sentence says what to do: remove the engine choice and a
  uniq this tight goes to the in-memory engine — which is what was happening anyway.
  `mode="disk"` describes a COST rather than naming an engine, so a config that says that still
  falls back and still gets its rows. Both halves are pinned by shared cases.

  Narrow on purpose: only the repair cap refuses. A shape the lazy path cannot express at all —
  a weighted pack generator, say — means engine 3 never got to run the config, and covering that
  is what engine 3 IS. Writing the refusal too broadly failed tests in three implementations,
  which is how the line came to be drawn where it is.

  Fixed alongside: `IN_MEMORY_FALLBACK_MAX_ROWS` was **declared in all four ports and used in
  none**. Past 20,000,000 rows the reference refuses rather than falling back, because there the
  fallback is not a fallback — it is half an hour of materialising, out of memory, nothing
  written. The four now do the same.

  The three API docs that promised "refuses rather than falling back" were telling the truth
  about `--engine 2` and not about `--engine 3`; all five now state the rule and the exception.

<!-- covers: TDC170 empty pack -->

- **A data pack that lists nothing is refused by name instead of crashing four of the five
  implementations.** A pack file with a header and no lines under it parses perfectly well and
  yields an empty list. Nothing downstream expects one: the generator picks
  `values[floor(random × length)]`. The reference had always said
  `data-pack address "pl.empty.list" (…/list.txt) has no values`; Python raised `IndexError`,
  Rust panicked on a subtract overflow, Java and C# went out of bounds — and none of the four
  named the file, so the author was left with a stack trace and a folder to search by hand.

  All four now say the reference's sentence, word for word, and `exists()` in each of them
  knows the difference between "no such address" and "that address found a file that lists
  nothing" — reporting the second as a misspelling would send the reader hunting for a typo
  while the real file sits next to them.

  The same mistake made a different way is fixed with it: a `generator:` pack whose body is
  missing. All four used to answer `pack generator body has no <gen> tag:` — true, and useless.
  No code, no address, no file, so the author had a folder to search by hand. They now say what
  the reference says: `generator "pl.gen.thing" (…/thing.tdc) has an empty body`.

  Found because `TDC170` was the last diagnostic `audit:fixtures` still excused as "needs a
  malformed data-pack file on disk". A `cli.json` case carries its own files and always could.
  The exemption was not documenting a limitation, it was hiding a four-way crash — which is
  what the note above that list already said every exemption eventually does. The list is
  empty now.

<!-- covers: uniq repair cap early stop -->

- **A `<uniq>` too tight for the bounded repair gives up sooner, and stops guessing at a
  number it no longer knows.** The scan that confirms which rows really repeat used to walk
  every candidate group before anyone looked at the repair cap — on a config that misses the
  cap by two orders of magnitude (1,618,803 rows needing repair against a cap of 20,000) that
  was 1,298,015 groups and **6.79 seconds** spent learning something already settled after the
  first twenty thousand. It now stops there: **0.078 seconds**.

  What it gives up is the exact figure, so the refusal says `more than 20000 rows couldn't be
placed` rather than naming a total it stopped counting. A number quietly reading 20,001 where
  the truth is 1,618,803 is worse than no number — it invites someone to widen a column by a
  little. Below a million rows there is no fingerprint scan and the count stays exact, so the
  sentence people usually see is unchanged.

<!-- covers: uniq deal stock heap -->

- **A large `<uniq>` run is more than twice as fast, and every byte of its output is where it
  was.** The deal that assembles the rows wants, for each group, "the values with the most
  stock left, ties to the one that appeared first". It got that by walking the WHOLE value
  pool and sorting it — once per group. At 30,000 values and 30,000 groups that is a sort of
  thirty thousand entries, thirty thousand times.

  Measured on a 6,000,000-row `<uniq>` whose repair pool held 179,133 rows over 30,000 values:
  **44 of the run's 85 seconds**, growing with the product of the two. The partner scan
  everyone suspected — including three earlier passes over this code — cost 2 seconds, and the
  disk ledger 6.

  It now draws from a lazy binary heap: same comparator, same ties, same values to the same
  rows. The deal went from 46 seconds to 2.4 and the whole run from 88 to 40 in the reference;
  in Python the deal alone went from 7.01 s to 0.13 s on 20,000 rows over 4,000 values, a
  factor of 54.

  Byte-identity is the point, not a bonus: which value a row draws IS the dataset, so a faster
  deal that deals differently would be a different product for every user holding a seed. All
  five implementations carry the change, and all five agree with the shared fixtures.

<!-- covers: rust cargo fmt gate -->

- **Rust is formatted by `cargo fmt`, and CI now says so.** It was the only one of the five
  implementations whose formatter nothing ever ran, and 55 places had drifted from it — all
  mechanical. Reformatted once and wired into the five-ways runner beside the hook that runs
  Python's ruff, for the reason already written above that hook: a gate nobody runs is not a
  gate.

<!-- covers: progress uniq-repair -->

- **`--progress` gained a fourth phase, `uniq-repair`, and it turned out to be the biggest
  one — which is how the entry below came to be written.** Measured on a 6,000,000-row
  `<uniq>` over 900,000,000 possible pairs: hashing every tuple took 13 s, sorting the piles
  3 s, writing the rows 18 s — and 50 to 62 s sat between the last `uniq-sort` and the first
  `render`, reporting nothing at all. More than the other three phases together, and
  indistinguishable from a hang. (It is 7 s now. The phase stays: the repair's size follows
  the collisions rather than `count`, so a tight enough config can still spend real time
  there, and a watcher should be told which part it is spending.)

  That stretch is the repair: verifying the candidate groups the fingerprints turned up, then
  rearranging the rows that really do repeat. It now reports, in all five implementations,
  from BEFORE the first deal — the deal alone is seconds on a large pool, and a watcher that
  only heard from the sweep loop would sit on a stale `uniq-sort` throughout it.

  Watching it also says where the time is NOT. Verifying the candidate groups — the part that
  looked expensive — took a tenth of a second for 19,851 groups. Practically all of it is the
  rearrangement that follows, and almost all of THAT is its first pass over a pool of 179,133
  rows.

  One trap worth writing down, because it caught this measurement twice: a config dense enough
  to blow the repair cap throws and falls back to the in-memory engine, and every second the
  repair spent is then thrown away with it. Timing that run measures the fallback. The numbers
  above are from a run that stays inside the cap.

- **A phase's numbers now only ever RISE, and a phase ends at its own total.** Two defects
  that only showed up once the repair had a phase to report under.

  The repair is several steps with different units — candidate groups to check, pool rows to
  prepare, then a deal repeated per sweep. Each reported its own count against its own total,
  so the counter restarted at zero every time a step ended: a bar drawn from `uniq-repair`
  jumped backwards two or three times per run, which reads as a bug rather than as progress.
  The steps are now added up on one growing scale — each declares its size, the phase's total
  grows to hold it — so the total is what the repair has taken on so far rather than a figure
  known in advance.

  And `render` stopped one report short of its own total in Python, Java, C# and Rust, because
  the loop reports every half-percent and the last partial slice never triggered one. A bar
  built on it sat at 99.5% for however long the tail took, indistinguishable from a stall. All
  four now close the phase.

  The guarantee is a promise to whoever draws a bar, so all five implementations test it:
  within a phase neither the count nor the scale goes backwards, and the phase closes full.

<!-- covers: uniq compound -->

- **A compound `uniq="true"` gets the fingerprint carrier it was supposed to have.** Every
  other shape of uniq moved to 13-byte fingerprints and a disk ledger; this one quietly did
  not, because the builder called the arranger with **no options at all** — no fingerprint
  buckets, so the tuples still went through the older text external sort, and no progress
  callback, so a long run of it reported nothing and looked hung. The four ports passed both
  through, which made this the reference lagging its own ports rather than leading them.

  Measured on 1,200,000 rows: 19 s → 15 s, all four phases now reported, byte-identical to
  Java before and after. Nothing about the data changed — the fingerprint path verifies every
  candidate against the true tuples, so it finds the same duplicates the text sort found.

<!-- covers: uniq jobs -->

- **An env-level `<uniq>` group splits across `--jobs` in all five.** It ran on one thread
  in Python, Java and C# — not because splitting was unsafe, but because those three asked
  "is this engine 2?" and every `uniq` routes to engine 3. The rule is now the reference's:
  anything but the in-memory engine splits, EXCEPT `uniq="true"` on a sequence, which
  rearranges the generators inside one compound column and cannot be reproduced by a worker
  resolving a row on its own.

  What makes it safe is that the arrangement is decided ONCE. Working out which rows a group
  moves where is a pass over every row to find the collisions and a second to learn which
  tuples are taken; a worker repeating it would be correct and slow, which is the failure
  that hides. The coordinator does it and hands the answer down — in memory where the workers
  are threads, as JSON where they are processes.

  Measured on 3,000,000 rows: Java 10.2 s → 6.9 s, C# 21.4 s → 17.5 s, Python 184 s → 109 s,
  every file byte-identical to the single-threaded one and to the reference. Rust is out of
  this by construction: it accepts `--jobs` and ignores it, so every run there is
  single-threaded already.

<!-- covers: gauss clamp lerp hash noise prev -->

- **`prev(Column, initial)` and `<env mode="sequential">` — a column that reads its
  own past.** Every other function answers from one row; this one reads `Column` from
  the row before, and gives `initial` on the first.

  ```xml
  <env count="3600" seed="p001" mode="sequential">
    <sequence name="RR">
      <gen type="formula" decimals="3"
           expr="clamp(prev(RR, 700) + (hash(_count, 3) - 0.5) * 180, 350, 1400)"/>
    </sequence>
  </env>
  ```

  It takes the column NAME, unevaluated — writing `RR` anywhere else in that expression
  gives THIS row's value, which is the one thing `prev` exists to look past — and it
  returns the same raw text a bare column reference gives, so the two cannot disagree
  about a comparison.

  The mode is the price. `mode="sequential"` promises that row N is computed after row
  N−1, which only the in-memory engine keeps: the streaming engine resolves ANY row in
  O(1) without touching the one before it, and that is its whole design. So the mode
  forces engine 1, the run is held in memory, and only a config that asked for it pays.

  Three refusals, all by name: `prev()` without the mode; `prev()` inside an `if=`,
  which is a per-row choice the engine may take in any order; and `mode="sequential"`
  beside `engine="2"` or `engine="3"`, which names BOTH attributes rather than telling
  a config to add the mode it already has.

  Not refused, and verified rather than assumed: `percent=`, `uniq` and `distinct` all
  work beside it. Columns register in declaration order, which is the order `prev()`
  already depends on.

  **`mode="sequential"` is not `order="sequential"`.** The `order=` attribute walks one
  generator's values in the order written; the `mode=` attribute is about the whole run.

- **The run as columns, in all five.** `toColumns()` / `to_columns()` /
  `ToColumns()` returns each column as the language's own array of doubles —
  `Float64Array`, `double[]`, `Vec<f64>`, `array('d')` — and as text otherwise.

  A column is numeric only when EVERY cell in it is a finite number. All-or-nothing
  on purpose: an array of doubles cannot hold "no value", and filling the gaps with
  NaN would put a number nobody generated where a `parent=` filter deliberately left
  nothing. A caller who wants another container — numpy, a Span — converts the one
  they get; nothing here stands in the way.

- **`noise(t, scale, salt)` — smooth drift.** A value drawn fresh every `scale`
  rows and eased between, which is what a wandering baseline actually is:

  ```xml
  <sequence name="Drift"><gen type="formula" expr="0.3 * (noise(_count, 300, 7) - 0.5)"/></sequence>
  ```

  Three modulated sine waves cannot do this. Measured over 4,096 samples, the
  sines put 74.6 per cent of their power into three frequency bins where this
  puts 51.5 — the improvement is real and it grows with the number of octaves,
  so one pair of scales is a floor rather than the whole benefit.

  At a lattice point the value is EXACTLY `hash` there, because the easing
  interpolates with `a * (1 - u) + b * u`; a cell boundary is therefore
  continuous to the last bit, not to within an ulp. The midpoint of a cell is
  the plain average of its ends. A `scale` of zero divides by zero and gives
  NaN, the same answer `sqrt(-1)` gives here.

- **`hash(n, salt)` in `expr=` — a repeatable value in [0, 1) from a pair of
  numbers.** The replacement for the shader trick a config writes when it wants a
  different random coefficient for every row N:

  ```xml
  <sequence name="Amp"><gen type="formula" expr="1.4 * (0.94 + 0.12 * hash(N, 12.9))"/></sequence>
  ```

  The trick it replaces — `sin(N * 12.9898) * 43758.5453`, minus its floor — is
  safe here, because TDC computes its own `sin` and five implementations agree on
  it. What it costs is two transcendental calls a row, an opaque listing, and a
  distribution that is an accident rather than a design.

  It is cyrb128 + sfc32, the PRNG the rest of TDC already runs on, keyed by the
  IEEE-754 BIT PATTERNS of the two arguments rather than their decimal spellings —
  because the shortest decimal form of a double is not the same string in every
  language, while those 64 bits are pinned by the standard. Different salts are
  independent streams over the same n.

  Measured before shipping: over 100 salts of 50,000 draws each, the chi-square
  median is 18.3 against a theoretical 18.3, four of the hundred exceed the 5 per
  cent critical value where five are expected, and two salts over the same n
  correlate at −0.004.

- **`gauss(x, c, w)`, `clamp(x, lo, hi)` and `lerp(a, b, t)` in `expr=`.** Three
  compositions of arithmetic that was already there, asked for by a project generating
  synthetic ECGs, where the same bell was written out nine times per config:

  ```xml
  <sequence name="R"><gen type="formula" expr="Amp * gauss(Phase, 320, Width)"/></sequence>
  ```

  `gauss` squares with a multiplication rather than `pow`, which is exact under IEEE-754
  where `pow` is not — so it is both cheaper and, measured over 300 random triples,
  bit-identical to the `exp(-pow(…, 2))` it replaces. A config that switches to it keeps
  its bytes.

  `clamp` is `min(max(x, lo), hi)`, so handing the bounds over backwards lets the CEILING
  win rather than raising: a host's own clamp throws there, and a generator that stops
  mid-run over a swapped pair is worse than one that answers.

  `lerp` is `a * (1 - t) + b * t`, not `a + (b - a) * t`. The two differ in floating
  point and only the first lands exactly on both endpoints — over 200,000 random pairs
  the naive spelling misses `b` at t=1 in 41 per cent of them. `t` outside [0, 1]
  extrapolates.

### Fixed

<!-- covers: TDC E13, `+` on two decimal columns -->

- **Adding two fractional columns CONCATENATED them in Python, Java, C# and Rust.** `A=1.5`,
  `B=2.25`, `C = "A + B"` gave `3.7500` in TypeScript and **`1.52.25`** in the other four, with
  `decimals=` ignored along with the arithmetic. Referencing a plain `number` column was fine
  everywhere, so it showed only when a formula added other formulas — which is the shape every
  real signal has. The `signals-from-formulas` guide's ECG config sums seven addends into one
  millivolt column, and on four of five implementations that column printed the seven numbers
  glued end to end for all 2500 rows.

  All four had inherited a JavaScript escape hatch — "add if one side is ALREADY a number,
  otherwise join" — and a column value never IS a number: every column is text. So `+` fell
  through to joining. The reference had already been fixed and carried a comment recording the
  same symptom (`10.00 + 5.00` giving `"10.005.00"`); the fix was never carried across. `+` was
  also the only operator with the hole — `-`, `*`, `/` and `%` all convert first, and were
  always right, which is why nothing else exposed it.

  Now all five ask whether both sides READ as numbers, and add when they do. Joining is left to
  genuine text, the one case the escape hatch was meant for: `"a" + "b"` is still `ab`.

  **Byte change:** any config where a formula adds columns holding fractional numbers now
  produces their sum in Python, Java, C# and Rust, where it produced their digits run together.
  TypeScript is unchanged.

- **The four ports never said "did you mean".** The reference prints the near name on its own
  `help:` line above the note — the one part of a diagnostic a reader can act on without reading
  anything else — and the ports had no field for it. Some left it out; some folded it into the
  front of the hint, where it read as part of the explanation. All four now carry a `suggestion`,
  render it as `help:`, and compute the near name the way the reference does: a case-only
  difference always wins, and a distance past three — or past about half the typo's length — is
  a different word rather than a slip, where saying "did you mean" is worse than saying nothing.

- **A formula's refusal called the formula "a parameter".** `TDC240` on an `expr=` said "a
  parameter reads a column that already exists" in all four ports, because one routine serves
  both `expr=` and the distribution parameters. The note is the half a reader acts on, so it has
  to be about the thing in front of them: a formula now reads "a formula is computed from columns
  that already exist", as the reference has it.

- **`TDC193` gave one answer to three different mistakes.** `${{P.gone}}` where `P` is a compound
  said "is not a declared sequence" — sending the reader to `<env>` to declare a `P` that is
  declared right there. The reference separates them: a known root with fields gets "is not a
  field of P" and the list of the fields it does have; a known root with none gets "P has no
  fields" and the reason (only a compound or composed `<sequence>` has any); an unknown root
  keeps the original. All four now do. The field list is in DECLARATION order, which cost Python,
  Rust and C# a companion list — their name stores are sets, and a set has no order to lend a
  message.

- **A refusal printed its own template instead of its sentence.** `A[0] == 1` in an `if=` gave
  `computed member access is not supported in {article} {label}` in Rust and C# — the two braces
  reaching the user as literal text because the message was written as a plain string where the
  reference builds it from the site. It now says "in an if expression", like the other three.

- **The four ports' diagnostics said the same things in different words, and some said less.**
  The shared contract pins the CODE and the position, so 383 cases could match while the sentence
  a reader actually acts on drifted. Measured against the reference across those cases: 12–18
  differing MESSAGES and 101–113 differing notes per port. Three groups closed here, and each was
  information rather than phrasing:
  - `TDC015` had one generic sentence for every unknown attribute. The reference keeps a table of
    the ones that are not typos at all — `count=` on a `<gen>` is `<env count=>` or `repeat=`,
    `flag=` belongs to a `<mix>`, `parent=` to the `<sequence>`, `phase=` is spelled `peak_at=`,
    `percent=` on a `<switch>` splits nothing. All four now carry it, so the message says where
    the attribute belongs instead of telling the reader to check a spelling that was never wrong.
  - `TDC010`/`TDC013` printed allowed-child lists three different ways ("Allowed children: …",
    "Allowed inside <X>: …") and none of the ports truncated a long one — a fifteen-name `<env>`
    list buried the name being looked for. One wording, and the reference's six-then-"(N more)"
    cut, in all four. The reference's `<pool>` list gained `data`, which every implementation
    accepts and none of them named.
  - `TDC061` said "paths are relative to the config file's own folder", which is advice; the
    reference names the paths it actually TRIED, which is an answer. A reader whose `--data-path`
    was not picked up cannot tell those apart. All four now list the candidates in search order.

- **Nine diagnostics said what was wrong and nothing about what to do, in all four ports.** The
  reference explains a parse failure with the sentence that matters — "the document did not
  parse, so the structural and semantic checks were skipped; fix this first, anything they
  reported would be describing the torn tree" — and the ports printed the bare complaint. A
  reader with one unclosed tag saw a single error and took it for the whole story; the validator
  had never run. `TDC180` was the same shape: "unknown compute tag" with no list of the tags a
  `<compute>` does take, on the one diagnostic whose whole job is to point at it. Measured across
  the 383 shared cases: 9 note-less diagnostics in each of Python, Rust, Java and C#, now 0.

- **`TDC196` was written, documented twice, and never the code anyone saw.** `repeat=` or
  `separator=` on a `<mix>` produced two refusals: the generic `TDC015: <mix> has no "repeat"
attribute` FIRST, and `TDC196` — the one written for the case — second. Only the first is read,
  and the first says "typo": it sends the reader hunting for the correct spelling of an attribute
  a `<mix>` is never going to have, when what they need is the sentence `TDC196` carries — a mix
  picks one BRANCH, so there is no list for `repeat=` to make. The generic pass now stays quiet
  about an attribute that has a check of its own. One diagnostic, the useful one, in all five.

- **A `<mix percent>` inside a pack generator: five implementations, three answers.** It is a
  documented shape — `data-packs/writing-your-own` documents it under "Exact percentages inside a
  generator" — and two shipped packs use it. **Python, Java and C# emitted the pack's own
  interpolation placeholder as data**: `${{p}}` on every row, exit 0, `check` valid. Their pack
  parsers collected only `<sequence>` children, and a standalone `<mix name="…">` is a SEQUENCE
  declared beside the others, exactly as it is in a config; skipped, it left the `${{p}}` in the
  output template with nothing to resolve against. And **Rust disagreed with the reference**
  wherever a `<gen type="template">` sat inside a `<case>`.

  Rust's cause was its own: a pack body is built by a nested engine with its own seed —
  `{run seed}|{column}` — but the columns it produces are handed back to the outer engine to
  evaluate, because a nested engine cannot be kept alive beside its parent there. So everything
  the body decided at BUILD time was keyed correctly and everything it left until VALUE time was
  keyed by the outer seed, which is no seed of the body's at all. Measured: the values did not
  change when the column was renamed, and were the same six a plain config gives. The seed now
  travels with the columns. The memory engine had the second half of it — a pack-body `<mix>`
  built with no stream, and under a key missing the `#switch` suffix the streaming engine spells.

  Fixing the parsers then exposed a crash the placeholder had been hiding: with a `<mix>` finally
  reaching them, Python, Java and C# took `--engine 1` down with a raw stack trace
  (`AssertionError`, `NullPointerException`, `NullReferenceException`) because their pack-body
  materialisers had no branch for one. All three have it now.

  Seven pack shapes across five implementations and three engines: all five agree everywhere.

- **An interpolated template address threw away the pack's weights, in all five.**
  `value="person.${{Sex}}.firstName"` — TDC's parent→child-by-name, the whole point of the
  coherent-data guide — drew UNIFORMLY in TypeScript and handed every row the SAME value in
  Python, Rust, Java and C#. Six rows of the guide's own shape came out `Mary James James Mary
James Mary`: `Mary` and `James` are the heaviest lines of the two weighted files. 389 shipped
  pack files declare `weighted: true`, so any of them behind an interpolated address hit this.
  Nothing warned; `check` said valid; every run exited 0.

  The same file read by a FIXED address was exact to the row — 400 rows of a 100/50/25/10 pack
  gave 216/108/54/22 — which is what made the fault hard to see: the page's own showroom example
  (`common.vehicle.model.${{Brand}}`) reads UNWEIGHTED model lists, so all five agreed on it.

  Two different causes, one symptom. The four ports sent the resolved address through the generic
  build at a count of ONE, where the exact-quota layout planned a single slot and gave it to the
  largest share — the failure the router's own comment describes, still live on this path. The
  reference took a different route and simply dropped the shares.

  An address that is not known until the row is has no column to lay a quota over, but the
  shares are still the shares: all five now draw per row WITH them. Measured on the same 400
  rows: 217/102/60/21 against the quota's 216/108/54/22, identical in all five.

  **Byte change:** any config whose interpolated template address lands on a weighted pack.
  An unweighted one is unaffected.

- **The formula page's own headline example was refused by all four ports.**
  `expr="BMI > 25 ? over : normal"` ran in TypeScript and was refused with `TDC240: "normal" in
expr= is not a sequence declared above this one` in Python, Rust, Java and C# — on the English,
  Russian and Spanish copies of the page, and on any config that labels a row.

  A formula is arithmetic whose answer is printed, so a name in one is normally a column and a
  name that is not a column is a typo. Two places are the exception, and they are the same two
  `if=` has: the right-hand side of a COMPARISON may be a bare word (`Gender == Male`), and so
  may both branches of a TERNARY — which is how a formula writes a LABEL instead of a number, and
  how a training set gets its target column. The four ports collected every identifier in the
  tree, so the labels read as undeclared columns.

  Two more holes came out of the same walk in Python, in the other direction: it descended by
  guessed FIELD NAMES, and this parser's nodes are not the reference's — a unary holds `operand`
  and not `argument`, a dotted reference is a leaf with no child node at all. `-Typo` and
  `Person.Age * 2` therefore walked through a green `check` and died at run time with "the
  expression has no number as its answer", which names neither the column nor the typo. All five
  now match on node TYPE, which cannot drift out of step with the parser the way a list of
  attribute names did.

- **`local=` on a `<gen>` was ignored by Python, Java and C#, and the column came out a
  CONSTANT.** `<gen type="template" value="person.lastName" local="de"/>` gave
  Voigt/Riedel/Winkelmann in TypeScript and Rust, and `Smith Smith Smith` in the other three.
  Not merely the wrong language: `Smith` is the heaviest line of the weighted ENGLISH file, so
  a config that asked for German surnames got one English surname repeated down the column,
  exit 0, and `check` calling it valid.

  Those three read the run's locale where the address was resolved, never the generator's own.
  It showed on some locales and not others because the WEIGHTED path resolved the address for
  itself and was always right: every locale whose `person/lastName.txt` declares
  `weighted: true` (`ru`, `uk`, `nl`, `sv`, `ja`, `en`) worked, and every locale without one
  (`de`, `fr`, `es`, `it`, `pl`, `pt`, `ar`) fell back to English. All twelve now agree across
  the five.

  The same attribute was missing from the VALIDATOR in all four ports, which is why the failure
  was silent rather than loud: `check` asked about the env locale, so it validated a different
  config than the one about to run. `local="zh"` on a path `zh` does not ship passed `check`
  and the run then died with a raw "unknown template path" out of the pack reader — a message
  that reads as a typo for a path that is spelled correctly. All five now raise `TDC217` before
  a row is generated. A unique draw (`<uniq>`) over a `local=`-pinned list enumerated the wrong
  file in the same three, and is fixed with it.

  In Java the raw message also named a Java object identity
  (`PackSource$Layered@2812cbfa`) where the other four name a directory: the layered pack
  source had no `toString()`.

  **Byte change:** any config using `local=` on a `<gen>` whose target pack is not weighted now
  draws from the locale it names, in Python, Java and C#.

- **The five-way documentation audit refused to run for two reasons of its own making.** It
  compares each build against its sources, and for C# it compared the ENGINE's sources against
  the COMMAND LINE's assembly — a file that an engine edit never rebuilds, so an up-to-date C#
  build reported as stale (measured: CLI 13:59, engine 14:32, the edit 14:31). It also walked
  `bin/` and `obj/` as if they were sources, so running `dotnet test` — which builds Debug, and
  writes into `obj/` — left every later Release build looking older than its own "sources".
  Running the tests disabled the audit. It now compares against the engine assembly the CLI
  actually loads, and skips build output when reading source times.

### Changed

<!-- covers: TDC299 -->

- **`TDC299` no longer explains its warning with a mechanism that only fits one shape of
  `uniq`.** It said the whole column stays in memory and "the run cannot stream: the config
  runs on the in-memory engine whatever `mode=` asks for". That is true of a single drawn
  column, which is what it was written for. It is not true of the other two: the router sends
  a compound `uniq` and a `uniq` counter to the exact on-disk engine, measured.

  The number was never the problem, and the fix does not touch it. A `uniq` counter at
  4,000,000 rows measured 940 MB against the 954 MB the warning predicts, and a compound
  `uniq` at 2,400,000 rows measured 851 MB against 572 MB predicted — so if anything it
  UNDERSTATES. The warning now says what is true of all three: the memory follows `count` on
  every engine, because the cost belongs to the promise rather than to one engine, and a
  single drawn column pays twice by being pinned to memory as well. Five implementations,
  the error reference in three languages.

<!-- covers: uniq engines -->

- **Uniqueness at scale: the disk engines carry uniq tuples as fingerprints.** On runs
  of a million rows and up, engines 2 and 3 hunt duplicates through 13-byte hash
  records instead of tuple text: routed into piles by the hash (equal tuples always
  land together), sorted as packed integers, matching groups verified against the
  true tuples, and the sorted piles kept on disk to answer the repair's "is this
  tuple taken?" by binary search. No in-memory structure over the run — measured:
  20 GB and 194,011,420 rows, every one distinct, single-threaded, 84 minutes, with
  the heap CAPPED at 1 GB. Below a million rows the exact text path runs unchanged,
  so small configs keep their bytes.

  The repair's collision cap now grows with the run (a thousandth of the rows,
  floored at the old 20,000) — collisions grow as the square of the run, so a flat
  cap doomed every sufficiently large one. And past 20 million rows a tripped cap
  refuses with a sentence instead of falling back to the in-memory engine, which
  cannot hold such a table and used to die half an hour later with nothing written.

- **Engines agree per engine, not across engines.** The rule is now: one seed + one
  engine = the same bytes on every machine and in every language. BETWEEN engines
  equality is not required — the engine is chosen deterministically from the config,
  so two machines always pick the same one; requiring it only held the disk engines
  down to what the in-memory engine could do. Every entry in `engines.json` is now
  checked in all five: the `aheadOfPorts` marks that let the ports skip the ones the
  reference could do alone are gone, because there is nothing left for them to skip.

- **An env-level `<uniq>` streams — in all five.** The disk engines no longer refuse
  it: each member is its own seekable column, so the tuples are checked and the few
  colliding rows rearranged without holding the run. A `<switch>` member is arranged
  one block at a time, so a value only ever lands on a row that was allowed to hold
  it. Verified on a 1,200,000-row group through the fingerprint path: the five write
  the same bytes, and every row is distinct.

  A group too tight for the bounded repair says so in one sentence — the same
  sentence everywhere — instead of quietly holding the whole table. `uniq="true"` on
  a single sequence is still refused in stream mode: that rearranges the gens inside
  one compound column, which no per-row resolver reproduces.

- **A run can be asked what it is doing.** `--progress` writes `<output>.progress`
  beside the output: one small JSON object, rewritten in place about once a second,
  naming the phase (`uniq-scan`, `uniq-sort`, `render`), the rows done and the
  percent, and closing with `done` and the wall-clock seconds. Written atomically, so
  a poller never reads half a JSON; the file's mtime is the heartbeat — not moving
  for minutes means the process is gone, whatever the content says.

  The same channel is on the library in every implementation (`onProgress`,
  `on_progress`, `OnProgress`, `ProgressHook`).

  A run split across workers is counted whole: every worker reports the rows it has
  written and the coordinator adds them up, so the percent is the file's and not one
  worker's. That is the case that matters — above a hundred thousand rows TDC splits
  the run by itself, so a channel that only worked single-threaded would have been
  silent exactly when it was needed. Python's workers are separate PROCESSES, where a
  callback cannot reach: each shard keeps its count in one small file and the parent
  adds them up on a watcher thread, beside the pipe reading rather than instead of it
  — a parent that polled instead of draining would deadlock the moment a shard filled
  its stderr buffer.

  Parquet output reports too, once per row group of fifty thousand rows — coarser
  than the text path because a row group is the unit that writer works in. Watching
  that percent is what showed the Rust implementation walking every row twice for a
  Parquet file, and then holding both the whole run and the whole encoded file while
  it did. It now encodes straight off the engine and writes each page out as it is
  made: 60,000,000 rows and a 375 MB file finish inside 30 MB of memory, where the
  cost used to follow the size of the output.

  A phase's LAST report is always written, throttle or not. Forty-four piles can finish
  inside one second, and the once-a-second throttle then dropped every report after the
  first, leaving the file saying "1 of 44" long after the run had moved on.

<!-- covers: uniq arrangement -->

- **A `uniq` group arranges its rows differently — the same data, laid out another way.**
  A config with `uniq="true"` or an env-level `<uniq>` still produces the same values in
  the same proportions, every column still keeps the exact multiset it drew, and every
  row-tuple is still distinct. Which row gets which value changed. A run pinned to
  specific bytes from a given seed will see a different file; a run that asserts on the
  distribution, the uniqueness, or the set of values will not.

  The old arrangement was built by handing each group of rows values in proportion to
  what the column had left. That repeats a value inside a group as soon as one value
  dominates — and rows in a group already agree on every earlier column, so a repeat
  there is a duplicate row. The duplicates were then undone by a repair whose cost is
  quadratic in how many it is handed, while duplicates themselves grow as the square of
  the row count. The two together are cubic, which is why this was not a slow run but a
  stalled one: a 4,000,000-row config spent three and a half hours without writing a
  byte.

  Giving each group as many DISTINCT values as the column still has in stock costs
  nothing in exactness — the multiset is fixed either way, and this only chooses which
  row gets which value — and it hands the repair nothing to do. The same 4,000,000-row
  config now finishes in 67 seconds, and 1,600,000 rows went from 549 seconds to 39.

## [0.2.2] — 2026-08-15

### Added

<!-- covers: formula expr TDC294 TDC295 TDC296 -->

- **`<gen type="formula" expr="…">` — a column computed from the other columns of its
  own row.** The expression language was already there and already agreed bit for bit
  across five implementations; it could only ever answer a yes/no, and the value behind
  the answer was thrown away. A formula keeps it.

  ```xml
  <sequence name="BMI"><gen type="formula" expr="Weight / pow(Height / 100, 2)" decimals="1"/></sequence>
  ```

  It reads its OWN row and nothing else, which is why — unlike `running` and `stat` — it
  **streams**: row nine million is computed from row nine million. `decimals=` rounds the
  answer; without it the value prints in full, and a whole number stays whole. A source
  cell that is empty makes the answer empty, because a cell a `parent=` filter switched
  off is not a zero.

  A ternary makes a formula produce a LABEL rather than a number —
  `expr="Age > 65 ? senior : adult"` — which is how a training set gets its target column.

  `check` refuses what cannot mean anything: a formula without `expr=` (TDC294), a derived
  column carrying `if=` (TDC295, shared with `running`, `stat` and a date offset — all
  four are built once for the whole column, not chosen per row), and a derived column
  inside a `<uniq>` or `<distinct>` group (TDC296, because a group rearranges finished
  columns and a computed value moved to another row stops describing that row).

<!-- covers: read sample TDC297 -->

- **`read="quantile"` — a file of measurements read as a distribution rather than as a bag
  of values.** An ordinary read picks one of the file's values, which is right for
  something countable and wrong for a measurement: a thousand recorded amounts stretched
  to a million rows give back those thousand values with nothing between them — a comb the
  real data never had.

  ```xml
  <gen type="file" src="amounts.txt" read="quantile"/>
  ```

  The file is sorted once and treated as a ruler; a row lands anywhere on it and
  interpolates between two neighbours. The resolution follows the mass rather than the
  range, a repeated value keeps its share as an atom, and nothing outside the observed
  range is invented. The answer is written with as many decimal places as the source used.

  `sample="exact"` sweeps the distribution instead of drawing from it: row _i_ takes the
  point at `(permute(i) + 0.5) / count`, so over the run the column reproduces the sample
  with **no sampling noise at all** — measured across 99 quantiles, a worst deviation of
  0.0000%. Both forms cost one uniform per row and stream.

  TDC297 refuses the readings that ask for two things at once — `weight=`, `row=` or
  `order="sequential"` beside a quantile read, and a `sample=` with no distribution to
  sample.

<!-- covers: lengths -->

- **`lengths=` gives a `repeat` fan-out a declared shape.** Without it every length is
  equally likely — and exactly so, since the lengths are a whole-run quota — which is the
  wrong shape for every real one-to-many relationship.

  ```xml
  <gen type="number" value="1..9" repeat="1..6" lengths="40,25,15,10,7,3" separator=";"/>
  ```

  One share per possible length, `min` first, summing to 100. A count that does not match
  the range is refused rather than repaired: five shares for six lengths is a config whose
  author is thinking of a different range.

<!-- covers: TDC240 -->

- **A distribution parameter may be an expression over the columns beside it.**
  `lambda="Traffic * 0.1"` is an intensity driven by another column; `sd="0.1 + 0.5 *
_count"` is a sensor that grows noisier as the run goes on.

  This is allowed where a per-row `repeat=` is not, and the reason is exact: how many
  uniform draws a row spends depends on WHICH distribution, never on its parameters. The
  parameter changes the value the draws become, not their number — so the row stays
  computable without its predecessors, and the feature streams.

  A parameter that reads an empty cell spends its uniforms and writes an empty cell, so
  blanking one row cannot slide the rest of the column. TDC240 — already the complaint for
  `running`, `stat` and `of=` — now also catches a parameter or an `expr=` naming a column
  that is not there or is declared BELOW: a forward reference used to make the two engines
  disagree, and one config would have meant two datasets.

<!-- covers: read parquet -->

- **A quantile column is typed in Parquet instead of falling back to text.** `read="quantile"`
  refuses a file that is not numeric, so the column is a number **by construction** — the same
  kind of fact about the generator that types every other inferred column. `decimals="0"` gives
  an `INT64`; without it the precision comes from the source and may be fractional, so the
  answer is a `DOUBLE`, which holds every value such a column can produce.

<!-- covers: fit TDC300 -->

- **`fit="low..high"` on `<gen type="pattern">` — where a drawing read from `src=` lands
  on the value axis.** A file carries a shape and nothing else: not its units, not its
  origin, not even which way is up, and `viewBox` cannot rescue that because an editor
  crops it to the artwork on export. So the placement is declared in the config, where
  `check` can see it: the drawing's own lowest and highest point become the two numbers
  you write. Absent, the drawing fills `y_range`. Refused beside `points=`/`upper=`/
  `lower=` (`TDC300`), whose numbers already carry the 0..100 board. Under
  `mode="density"` it follows the axis `y_range` follows — the drawing's width — because
  it substitutes for `y_range` in the mapping and cannot drift from it.

  Two defects fell out of it, both in the vector path. A single-stroke SVG had been
  measured with the 0..100 board against another tool's raw user units, so a stroke at
  `y=20` in a 4000-unit drawing came out flat on the floor, and adding a second stroke
  moved it to the ceiling. And a typed corridor normalised against its own ink in all
  four ports while the reference used the board, so a band drawn low came out stretched
  across the whole range; every shared corridor case happened to touch 0 and 100, so
  nothing caught it. A case that does not now pins all five.

<!-- covers: TDC301 percent -->

- **`TDC301` — a share list that leaves a declared value at 0%.** A `percent=` shorter
  than `value=` is legal on purpose: what is left over goes to the positions nobody
  wrote, so `value="a,b,c" percent="30,40"` gives `c` the remaining 30. When the written
  shares already total 100 there is nothing left, and a value the config names can never
  be drawn — `percent="50,50"` over 300 rows came out 150 `a`, 150 `b`, no `c`, and
  `check` called it valid. A warning rather than a refusal, because the run is well
  defined and `percent="100"` is a fair way to say "only the first for now". A zero
  written out — `percent="50,0,50"` — is taken at its word and reported by nothing.

### Changed

<!-- covers: TDC299 TDC236 -->

- **The `uniq` memory warning is `TDC299`, not `TDC236`.** One code was doing two unrelated
  jobs: a pool that reads a pool declared below it (an **error**, since 0.1.x) and a `uniq`
  column past 100,000 rows (a **warning**, added later onto the same number). The errors
  reference carried two rows under one code, and a CI rule filtering on `TDC236` could not
  tell "this config is refused" from "this run will hold the column in RAM" — nor could it
  silence the second without silencing the first. The warning moved, because the pool error
  had the number first. A filter that named `TDC236` for the memory note needs updating; a
  filter that named it for the pool error is unaffected.

### Fixed

<!-- covers: TDC021 inject -->

- **`inject=` with two holes substituted nothing, and said nothing.** `<env
inject="[%]-[%]">` with `<data>[Id]-[Id]</data>` printed `[Id]-[Id]` — accepted by five
  implementations, substituted by none. A `%` is a hole only where it has text on BOTH
  sides, which is what the renderer's own `(.+)%(.+)` asks for; there is one of them, and
  `TDC021` now counts. Several, and the renderer reads the rightmost while the others
  survive as a literal `%` the text does not contain. `inject="%{%}%"` stays legal, and
  that is the point of counting holes rather than per-cent signs: three `%`, one hole.

- **Only one of the expression language's four homes was checked.** The expressions page opens
  with "four homes, all reading the same way" — `if=`, `filter=`, `expr=` and a distribution
  parameter — and promises that a written-out mistake is caught by `tdcv2 check` before a row
  exists. Only `if=` was ever handed to the checker. The same misspelled function passed a
  green `check` in the other three and killed the run with a bare `unknown function "…"`: no
  code, no line, the exact string the function list exists to prevent.

  All four now go through one checker, which names the site it is complaining about — `in an
expr= expression`, `in a mean= parameter`. The `if=` wording is untouched, because the docs
  quote it. Fixed in all five, with three shared diagnostic cases.

- **Pinning a pack parameter a `<valid>` guard reads threw the pin away.** A caller parameter
  replaces a local sequence with a constant — the documented way to drive a pack — but the
  reject-and-retry loop redrew it anyway in Python, Rust, C# and Java. A config asking for a
  particular base got values with nothing to do with it and no word of complaint: the pinned
  run and the unpinned run produced the same numbers. The pin is now honoured everywhere.

  With the pin honoured, a value the guard rejects can never be redrawn into a valid one, so
  the answer is fixed before the first attempt. Where it used to be 100 futile redraws per row
  followed by an error naming no parameter and no value, it is now immediate and says which
  parameter, which value, and what to do about it.

- **`plus=` on a date with no `of=` was accepted and dropped.** `plus=` belongs to the offset
  and nothing else reads it, so `<gen type="date" from="…" to="…" plus="3d"/>` passed `check`
  and produced ordinary drawn dates. "Shift this column by three days" is the natural
  misreading of it, and the date generator already refuses `step=` and `weekdays=` on a drawn
  date for exactly that reason. It is now TDC264, the mirror of the `of=` without `plus=`
  refusal, in all five.

- **A fractional counter worked only in the reference, and even there it could not be written
  as Parquet.** `<gen type="decrement" value="9.99" step="0.50"/>` — the example on the
  counters page — printed `9.99 / 9.49 / 8.99` from TypeScript and was refused outright by all
  four ports, each insisting on a whole number. And in the reference the column was still
  inferred `int64`, so the same config that printed perfectly as text died on the first row
  with `"9.99" is not an integer (int64)`.

  A whole counter still runs on integer arithmetic, exact however far it goes; a fractional
  one now uses the floating point the reference uses and is written the same way, so all five
  agree digit for digit — including `0.30000000000000004`, which the new shared case pins
  deliberately. The value is the start plus `step * i` rather than `i` additions, so the error
  cannot accumulate down the column. Parquet infers `double` when either `value=` or `step=`
  is fractional.

- **An inline generator's `anomaly_flag` column did not exist on the streaming engines in any
  of the four ports.** `<gen type="timeseries" … anomaly_flag="IsOut"/>` on engine 2 or 3 left
  `${{IsOut}}` in the output as its own literal text: the column was never built. The types
  built inline — a counter, a timeseries, a drawn pattern, a sequential list or date — never
  route through the per-row builder, so the flag they would otherwise inherit from it has to
  be attached explicitly, and four implementations attached nothing.

  Found while fixing the blanked-cell rule below, not by either audit: no shared case had ever
  put `anomaly_flag` on an inline type and run it through a streaming engine. The flag now
  also answers what the reference answers — a spike replaces a NUMBER, so a selected word is
  left as it was and its label is `false`.

- **`anomaly_flag` said `true` beside cells `missing=` had blanked.** The flag is the ground
  truth an outlier detector is scored against, and the anomalies page promises the flag and
  the spike "can never disagree" — while recommending exactly this pairing. A blanked cell
  has no spike to agree with, so on a `0.5`/`0.5` config a third of the rows carried
  "outlier" next to nothing at all: a silently mislabelled training set. The flag now
  follows the outcome, in all five and on all three engines.

  The identity test the in-memory builder used to notice a blanked row could never fire —
  `applyMissing` blanks in place and hands back the same array — so the neighbouring rule
  that clears a blanked date's instant was inert too. Both now compare against a snapshot.

- **`--data-path` was the LOWEST-priority root for `@data/…` files, not the highest.** Its
  own `--help` and the installing-packs page both promise the opposite. The list is
  assembled low to high because the pack loader needs it that way — a later root shadows an
  earlier one — but a file lookup takes the first readable candidate, so the flag lost to
  the project config every time. `--data-path ./private-data` to shadow a checked-in fixture
  exited 0 and generated from the checked-in file, silently. Fixed in all five; the pack
  loader's order is untouched.

- **A bare `parent="Name"` wrote a zero-byte file at exactly 100,000 rows.** At that count a
  run parallelises itself, and each worker carries a FORCED streaming engine. The streaming
  builder refuses a valueless `parent=` — it narrows a column to the rows where the parent
  produced anything, which needs the parent's finished column — and a refusal is only a
  fallback on the single-threaded path. So the hierarchical-dependencies page's own example
  wrote 99,999 rows and exited 0, then wrote nothing and exited 1 at 100,000. `check` called
  it valid at both sizes.

  The shape is now decided in the static router, beside the switch-percent rule that was
  fixed for exactly this reason, so the serial and the parallel path see one answer.
  `--jobs` is again what the documentation promises: only about speed. TypeScript-only —
  it is the one implementation that parallelises without being asked.

- **Four ports wrote `pattern`, `running`, `stat` and `formula` columns as TEXT in Parquet.**
  The reference inferred all four from the generator; Python, Rust, C# and Java did not, so the
  same config gave a `DOUBLE` from one implementation and the string `29.2` from another —
  exactly the loss typed output exists to prevent. The six pinned Parquet fixtures never
  exercised an inferred derived type, which is why it went unseen; two new shared cases pin
  these types and the quantile rule, so all five now write byte-identical files.

- **C#: `decimals=` rounded a tie to the even digit instead of away from zero.** The
  helper was .NET's `"F"` format, whose comment claimed it rounded away from zero. It does
  not. Rare on a drawn column and common on a swept one, where it put a wrong number in
  one cell in twenty. The digits of the double are now expanded exactly before the
  rounding decision, so a value that merely prints like a tie is told apart from one that
  is one.

## [0.2.1] — 2026-08-11

### Added

<!-- covers: distinct -->

- **`distinct="true"` on a repeating generator draws the row's values without
  replacement, so one cell cannot hold the same value twice.** A double first name was
  the case that asked for it: `Jesus Jesus Gonzales` is not a name.

  ```xml
  <gen name="First" type="template" value="person.male.firstName"
       repeat="2" separator=" " distinct="true"/>
  ```

  Duplicates inside a cell remain the default and are usually right — two readings of
  `40`, two of the same item in a cart. This is the opt-out, and it works on every
  generator type that can carry `repeat`: a listed column draws its pool down, while a
  number, a date or a regex has no pool and redraws on a fresh sub-stream instead.

  It has a price, and the price is why `percent` is refused beside it. Ordinarily a
  listed column lays its values out across the whole run as an exact quota, which is
  what makes `percent` land on the nose; a row that must not repeat itself has to
  **choose** instead, so under `distinct` the column's overall frequencies become
  approximate. A weighted data pack still leans on its frequent values — common names
  stay common — it simply no longer lands on an exact count. For proportions over list
  LENGTHS, put them on a `<mix>` or `<switch>` outside, with `repeat` on the generator
  inside.

  Rows stay independent, so streaming and `--jobs` are unaffected: `--jobs 1` and
  `--jobs 7` produce byte-identical files.

  Four refusals, each provable rather than guessed: `TDC289` (a value that is neither
  `true` nor `false`), `TDC290` (`distinct` with no `repeat` — one value cannot repeat
  itself), `TDC291` (`percent` and `distinct` together), `TDC292` (more different values
  asked for than the list can offer). The last is reported before the run where the pool
  is in the config — `type="text"`, a whole-number range, a one-character `symbol` set —
  and at run time where it is not, since a pack file or a CSV column is only read while
  generating. Either way it is a refusal, never a quietly shorter cell.

<!-- covers: secret -->

- **`secret=` on a `<gen type="http">` signs each request, so a service can tell TDC from
  anyone else who can reach the port.** The secret is the key, never the message: two
  headers travel with the request and the key itself does not.

  ```
  X-TDC-Timestamp: 1786000000
  X-TDC-Signature: hex(HMAC-SHA256(secret, timestamp \n seed \n count \n body))
  ```

  Everything that decides the answer is inside the signature, so a changed body, count,
  seed or minute produces a different one, and the timestamp is what makes a captured
  request useless tomorrow — how strict that window is stays the service's decision. All
  five implementations produce the same 64 hex digits for the same request, so one service
  accepts requests from any of them. Three spellings, and only the literal is remarked on:
  `env:NAME` and `file:PATH` keep the key out of the config, a literal works and warns
  (TDC284), and `secret=""` is an error because signing with nothing produces a signature
  anyone could forge. The engine sends its REAL clock rather than the run's `--now`, or a
  config pinned to a past date would be refused by every service that checks.

- **`X-TDC-Input: N` travels with every `http` request that carries `in=`, and says how many
  input lines the body holds.** It closes an ambiguity that reached services as a wrong
  answer: `in=` naming a column of one empty value sends an empty body, which is byte for
  byte what a pure source sends, so the service invented a value where it had been asked
  to process one — measured `city=[] handled=[68784219]`. A service that ignores the
  header reads the body exactly as before, which is what makes the addition safe for
  services already written.

### Changed

<!-- covers: TDC293 -->

- **BREAKING — `<gen type="pattern">` now requires `y_range`, and it scales the drawing's
  CANVAS rather than its ink.** A drawing carries no units of its own: the same curve
  leaves one tool running 0..100, another 0..480, a third 0..10002345345. Without a
  declared axis every answer was a guess about somebody's export settings, so a config
  without `y_range` is refused before the run with **TDC293** rather than quietly given
  the raw coordinates.

  What it scales changed with it. The old rule measured the drawn ink — the lowest point
  became the minimum, the highest the maximum — which threw the drawing's amplitude away:
  a ripple of ten units and a mountain across the whole board produced **identical**
  numbers, and a flat line, having nothing to divide by, collapsed to the floor. A
  horizontal line drawn halfway up came out as zeros.

  The canvas is now the scale: the image frame for a PNG or SVG, and for a typed-in
  drawing a percentage board of 0..100 that only ever GROWS to hold what was drawn
  outside it. A flat line at 50 is therefore the middle of whatever range it is asked in,
  and a drawing exported at 0..10002345345 is measured against itself and still lands
  inside the range with its proportions intact.

  ```
  points="0,50 100,50"   y_range="0..100"  ->   50
                         y_range="0..200"  ->  100
                         y_range="-5..5"   ->    0
  ```

  **To upgrade:** add `y_range` wherever it is missing, and redraw typed-in points on a
  0..100 board. `check` names every place that needs it.

- **BREAKING — a row reads where its line CROSSES the drawing, never an average of the
  slice around it.** A row used to own a window, and whenever a drawn vertex fell inside
  that window the row returned the window's mean instead of the crossing. Which rule a row
  used depended on where the vertices happened to land, so neighbouring rows of one
  drawing were computed by different laws and nothing in the picture said which was which.
  A row standing on a stretch running 49.58 → 49.68 — flat to the eye, 50 by the ruler —
  came out as 52, because its window reached back into a slope it was not standing on.

  Ten rows are ten readings. A peak that falls between two of them is the consequence of
  asking for ten, not a lost measurement: draw in more detail, or ask for more rows. What
  is gained is that you can look at your own drawing beforehand and say what will come
  out.

- **`interp="step"` reaches its last drawn point.** A staircase holds each point's value in
  the band to its RIGHT, and the last point has no band — the drawing ends there — so it
  was written in the config and absent from every row, while `linear` and `smooth` both
  reported it at the right edge. All three modes now agree there, on the last thing you
  drew. Exactly one row moves: the last.

<!-- covers: === !== -->

- **`===` and `!==` now ask whether both sides print the same CHARACTERS.** They used to be the
  host language's identity test — "same type and same value" — which is a fine question in
  a language with types and a meaningless one here, because every column TDC produces is
  text and the only things that are not are the literals you write. Measured with `N` a
  column holding `1`, `N === 1` was false for every number on every row, and `N !== 1` true
  for the same reason. `check` passed, the run finished, the tagged rows were simply
  absent. Between two columns the operator already compared text, so this changes nothing
  there; against a number it now answers. `==` is unchanged and still asks whether both
  sides are the same NUMBER.

### Fixed

- **Rust handed out `_item_id` lanes in alphabetical order instead of declaration order.**
  Two repeating sequences share one child table, so each gets its own slice of every card's
  key block; Rust walked a map sorted by NAME while the other four walk the config. With
  `zebra` written first and `alpha` second, the reference produced `Z 1 Z 2 A 3 A 4 A 5` and
  Rust produced `Z 4 Z 5 A 1 A 2 A 3`. Renaming a sequence moved every id in the child
  table — the kind of thing found downstream, in a foreign key that no longer joins. Present
  since 0.2.0. A shared fixture now pins it, named so that alphabetical and declaration
  order disagree.

<!-- covers: secret anomaly_flag group filter parent value mode interp spread decimals percent inject member -->

- **`<member name="…"/>` is gone.** It sat in the allowed-children list of an env-level `<uniq>` /
  `<distinct>` in all five implementations and was read by none of them: the name let it past
  the unknown-child check, the group then wrapped no sequences, and the author was handed
  TDC221 — a warning about the symptom, for a tag that does nothing. It was never designed,
  appears in no page of the documentation and in no fixture. It is now refused as TDC010, like
  any other invented tag.

- **Removing it exposed a wider hole.** The children of an env-level group were checked by the
  REFERENCE alone: the four ports each declared the list and never read it, so any invented tag
  inside `<uniq>` or `<distinct>` was accepted in silence. Measured with `<banana/>`: TDC010 in
  TypeScript, nothing at all in Python, Rust, Java and C#. All five now report the same code at
  the same position, and two shared cases hold both.

- **Rust left an `inject` marker unsubstituted where the other four implementations replaced it —
  the same config, different data, and nothing said.** `inject="%{%}%"` holds three `%` and the
  slot is the MIDDLE one, the rightmost that still leaves text on both sides. The reference
  finds it by backtracking inside `(.+)%(.+)`; Rust took the last `%` with `rfind`, found
  nothing after it, and gave up, so every `%{Name}%` reached the output verbatim. Measured
  before the fix: four printed `1`, Rust printed `%{Id}%`. A shared case pins it, and it fails
  in Rust with the fix reverted.

- **The reference counted a `text` option list one way and drew from it another, so a legal
  config could not be written.** `value="a,,b"` is three options — measured over 300 rows, 100
  `a`, 100 `b` and 100 empty — but the validator dropped the empty one before counting and
  refused the documented `percent="30,40,30"` beside it as _"3 entries but value has 2"_. The
  four ports accepted it all along; only TypeScript refused. It now splits exactly as the
  generator does, the shares come out 90/120/90, and a genuine mismatch (two options, three
  shares) is still TDC051.

- **Documentation that measurement contradicted, in all three languages.** Nothing here changes what
  the engine does; each entry is a page that described it wrongly.
  - The expression reference showed a refusal for an out-of-range integer LITERAL. There is
    none, and there must not be: `1 / 0 > 100000000000000000000` is how a config says "bigger
    than any whole number we hold", and a shared case has pinned it since the maths layer was
    written. What IS refused is an arithmetic RESULT past the domain, and only at run time —
    both operands sit inside it, so `check` has nothing to prove. Three new shared cases record
    the boundary from both sides, including that
    `10000000000000000000 == 10000000000000000001` is **true**, both literals having rounded to
    the same double.
  - `errors.mdx` counted **nine** warnings and listed nine; there are eleven — TDC272 and
    TDC284 were missing, and the same page already labels TDC272 a warning further down.
  - `pools/filter.mdx` said the empty-filter refusal is a run-time one "and it cannot be
    otherwise". Where the contradiction is provable from the config, `check` refuses it as
    TDC225 without running anything, which `errors.mdx` states correctly.
  - `mix.mdx` and `switch.mdx` still taught that a share below one row fails invisibly. TDC251
    warns on exactly that, twice on `mix.mdx`'s own example, naming the arithmetic.

- **`check` answered "would this run?" everywhere except one generator.** A drawing's `mode=`,
  `interp=`, `spread=` and `decimals=` were read only at render time, so `check` called
  `mode="banana"` valid and exited 0, and the run then refused it with a bare sentence
  carrying no TDC code — in the one command the docs sell for CI. TDC285 now checks all four
  before the run in all five implementations, and the validator calls the GENERATOR's own
  parsers rather than repeating their rules: a second copy of "linear, smooth or step" is a
  second thing to keep in step, and drifting apart is the failure being closed.

- **The two numbers a service recomputes were pinned by value in one or two implementations
  and nowhere else.** The signature lived in Rust and C#; the derived `X-TDC-Seed` lived in
  Rust alone; Python's http generator had no tests at all. A port could have computed
  something entirely different and four suites would still have been green — the failure
  would have surfaced as 401s in a user's own service rather than as a red test here.
  `fixtures/cross-language/http-vectors.json` now holds eight signature vectors and six
  derived seeds, and all five read it. The vectors differ from the canonical request in one
  field each, so an implementation that dropped a field from the signed message matches the
  first and fails the rest.

- **`timeout=` on a `<gen type="http">` was seconds in four implementations and milliseconds
  in the fifth.** The generator's page says seconds, and TypeScript, Java, C# and Rust all
  multiply by 1000; Python did not. So the documented default, written out:

  ```
  timeout="30"   ->  four: gives up after 30s
                     Python: "did not answer within 30ms", in 0.185s
  ```

  Python's own default was 10s where the other four use 30s, so a config that set nothing
  disagreed as well. Underneath sat a second divergence: nobody validated the attribute at
  all — four fell back to the default in silence, Python threw at run time with no code and
  no source line. `TDC069` now refuses a `timeout=` that is not a positive number of seconds
  in all five, before the run, which closes the silence and the divergence together.

- **A blank `value=""` meant six different things across the five implementations, and one of
  them invented data.** Every per-type check asked only whether the attribute NODE was there,
  so blank text walked past a guard meant to catch a missing list and each generator then
  improvised its own answer:

  ```
  <gen type="number" value=""/>      reference refused, four ports printed 4 2 8
  <gen type="text" value=""/>        reference printed empty cells, four ports refused
  <gen type="increment" value=""/>   reference counted 0 1 2, four ports refused
  ```

  A written attribute is written, not absent. All five now refuse a blank one with the code
  that type already had — TDC050, TDC070, TDC081, TDC090, TDC095, TDC098, TDC128, TDC244 —
  and the reference's template case moved from TDC071 to TDC070, since a blank address is no
  address rather than an unknown one. The line is drawn where the engines already agreed:
  `value=","` is two options that both happen to be empty and `value="()"` is a pattern that
  matches the empty string; both name something to draw from, both stay legal, and two shared
  cases pin that they do.

- **`anomaly_flag=` on a `<gen>` that is only one PART of its sequence minted no column at
  all, while `check` called the config valid and the anomaly fired.** A second `<gen>`, a
  `<data>` literal, or a `name=` that turns the gen into a field is enough — the values
  came out perturbed and `${{NAME}}` reached the output as its own literal text on every
  row, so the ground truth the author asked for was simply absent. The boundary was
  measured across five shapes: a lone gen and `<gen if=…>` branches mint the column, the
  other three do not. TDC283 now refuses exactly those three, with the same reasoning
  TDC246 already applies to a `<gen>` inside a `<case>`.

- **`group:` put the separator inside the fraction of a decimal number.** Chunking ran over
  the whole string from the right, blind to the decimal point, so a money column came out
  `1 970 .30` — a number in no locale, from a config `check` called valid. The integer
  part is now grouped and the fraction left alone (`1234567.89` → `1 234 567.89`, the sign
  outside), and everything that is not exactly a decimal keeps the plain right-to-left
  chunking `group:4` was written for: a card number is still `4111 1111 1111 1111`. One
  function serves both the `group:` filter and the `<group>` compute tag, so both are
  fixed.

- **A `<pool>` member's `if=` was checked against the RUN's names rather than the pool's, in
  the four ports.** Naming an env column passed `check` and was then constant-false on every
  member — the table is built before any row exists — so the guarded column came out empty
  on every row. TDC215 now refuses it in all five; reading a SIBLING field of the same pool
  stays valid, which is the other direction of the same scope.

- **`order="sequential"` on only some members of a `row=` link had a refusal in all five and
  no shared case behind it.** TDC282 has one now, and the diagnostic surface is fully
  covered again.

- **A pool `filter=` that matched nobody named the failing filter and the row number, and —
  on the general expression path — nothing about the row itself, leaving the author unable
  to tell a pool missing a member from a filter comparing against the wrong thing.** The
  bucketed `field == Column` path had named the value all along. Both now say it:
  `no member satisfies filter="price < Budget" for row 1 (Budget="1")`. The names are
  recorded during the scan rather than parsed back out of the expression, so what the
  message reports is exactly what the filter read.

- **The qualified spelling of a pool filter fell off the bucketed fast path and scanned every
  member.** `Doctors.clinic == Clinic` is what TDC232 tells the author to write when a name
  is both a member field and a row column — and following that advice cost, measured on
  40,000 rows over a pool of 2,000:

  ```
  Doctors.clinic == Clinic    108.08 s
  clinic == Clinic             0.05 s
  ```

  A name may now carry dots on either side and the pool's own prefix is stripped before
  the field lookup, so both spellings reach the same bucket. A bare word on the right still
  declines the fast path, which is what keeps `filter="clinic == North"` working.

<!-- covers: range -->

- **Two spellings of the same date range on one `<gen>`: one silently won and the rest were
  discarded.** `value=`, the `from`/`to` pair and `range=` are three ways to say one thing, and
  the generator read them in that order and stopped:

  ```
  value="2020-05-05" from="1990-01-01" to="1990-12-31"   ->  1990-05-11
  value="today" from="1990-01-01" to="1990-12-31"        ->  2026-08-08
  ```

  The page already said to use only one; nothing enforced it. TDC280 now does.

- **A reversed range was quietly swapped.** The draw took the min and max of the two ends, so
  `from="2020-01-01" to="2010-01-01"` produced perfectly plausible dates from a range nobody
  wrote. `plus="10..3d"` has been refused as a typo rather than swapped since it was written;
  this is the same typo, and TDC281 refuses it the same way.

<!-- covers: column weight -->

- **A blank cell in a file column silently deleted its row from the values.** The row left the
  pool entirely, so the file's own proportions stopped being the run's — measured on a
  three-person CSV with one empty email, 60 rows came out 28 / 32 between the other two and
  no sign of the third at all. It is now refused, and the message names the value row. The
  weighted path already refused the same shape one column over, with the reason written
  out: a value that vanished because one cell in an export was blank is discovered far too
  late. It was doing exactly that to the value itself.

<!-- covers: anomaly anomaly_factor -->

- **An `anomaly=` spike broke the shape of the column it was in.** The value had already been
  rendered — zero-padded to `length=`, or fixed to `decimals=` places — and the spike
  multiplied the raw number and re-stringified it, discarding both:

  ```
  length="5"    00014 00046 00053 …   and then   117
  decimals="2"  85.66 40.97 11.52 …   and then   6.445
  ```

  So a column of fixed-width identifiers stopped being fixed width on exactly the rows a
  test is about to exercise, and a column declared with `decimals` — typed a float in
  Parquet — carried a value with a place the declared type never promised. A spike now
  keeps the same decimal places and the same padded width. The padding only ever adds, so
  an outlier that genuinely outgrew the width keeps its extra digits.

<!-- covers: decimals first_zero -->

- **Three number attributes were accepted and then discarded inside the generator**, each
  leaving a column that looks right:

  ```
  <gen type="number" length="4" decimals="2"/>               ->  4566
  <gen type="number" value="1..9" length="3" decimals="2"/>  ->  3.78
  <gen type="number" value="0..5" length="3" first_zero="false"/>  ->  005 002 003
  ```

  Without a range there is nothing to round — the generator makes a digit string, an
  identifier (TDC277). Beside a range, `decimals` wins and `length` is the one dropped,
  because a fractional value has no integer width to pad to (TDC278). And
  `first_zero="false"` over a range whose largest value is one digit redrew a hundred times
  per row and then emitted the leading zero anyway (TDC279) — the attribute honoured on no
  row at all. All three are now refused, and only where the range and the width prove it.

<!-- covers: from to format precision oldest youngest length include exclude decimals distribution regex_max_length mode -->

- **Thirteen real attributes were accepted on generator types that never read them, and the
  column came out wrong without a word.** `from`/`to` were the worst of them — they are the
  natural way to write a numeric range, they are real attributes, and a number generator has
  never read either:

  ```
  <gen type="number" from="1000" to="9999"/>   ->  3 4 4 6
  ```

  Four-digit ids asked for, single digits produced, `check` calling the config valid. The same
  silence covered `format`, `precision`, `oldest` and `youngest` outside a date; `length`,
  `include` and `exclude` outside a number or a symbol; `decimals` outside the four generators
  that produce a number; `distribution` outside a number; `regex_max_length` outside the two
  regex generators; and `mode` outside a pattern. TDC015 now names the owner for every one of
  them.

  The ownership table was measured, not read off the switch: every (type, attribute) pair was
  rendered with and without the attribute and the outputs compared, then confirmed against the
  generator sources. `percent` is deliberately still unowned — only `text` and `number` read it
  as a share of their own values, but the engine routes any generator carrying it through the
  share machinery, so owning the name would refuse configs that work today.

<!-- covers: == != -->

- **A column of amounts failed its own equality test.** `Total == 100` was false while
  `Total > 99` was true, because 100 is a whole number and `100.00` is not, so the two
  never met. The ordering operators had always read the column as a hundred; only equality
  disagreed, and said nothing.

<!-- covers: if -->

- **A whole number written in a condition was false at zero in three implementations and true
  in two, so `if="1 - 1"` answered differently depending on which one ran it.** It is false
  everywhere now, like the double beside it. Text is unaffected: `""` and `"false"` are
  false, and every other text — `"0"` included — is true.

<!-- covers: filter -->

- **A pool filter refused a config its own twin accepted.** `field == Column` is bucketed
  rather than evaluated, and the bucket was keyed by raw text where `==` compares whole
  numbers. On a pool holding `01,02,03` against a column producing `1,2,3`,
  `filter="code == Want"` was refused by TDC225 as unmatchable, while
  `filter="code == Want && 1 == 1"` — the same question with one term that changes nothing
  — matched every row.

<!-- covers: --jobs -->

- **A parallel run silently disagreed with a single-threaded one.** The coordinator built its
  workers from the COMMAND LINE rather than from the resolved config, so three things were
  dropped on the way in: the config's own `local=` (the locale flag's default `en` won
  instead), every installed data pack (the worker fell back to the bundled set), and the
  config file's directory (a relative `src=` and the project config's `dataPaths` stopped
  resolving). No diagnostic, and no flag needed to trigger it — parallelism turns itself on
  above 100,000 rows, so the same file came out in a different language one row past the
  threshold. Both the text and the Parquet parallel paths carried the defect; the four ports
  build their workers from the config and never had it.

<!-- covers: TDC267 -->

- **`uniq="true"` on a simple sequence silently discarded `mask=`, `case=`, `missing=`,
  `missing_as=`, `repeat=`, `separator=` and `anomaly=` on its `<gen>`.** A draw without
  replacement produces the column directly and never reaches the layer that rewrites
  values, so a masked column came out unmasked and a `missing="1"` column came out
  complete — with `check` reporting the config valid. The combination is now refused by
  TDC267, which names the attribute. Applying them instead would have broken the promise
  from the other side: a mask maps two distinct draws onto the same characters.

- **`uniq="True"` was a silent no-op.** The engine compared the raw attribute against the
  lowercase literal while the validator lowercased it first, so a capitalised value passed
  validation as a uniqueness promise and then drew with replacement. Every other boolean
  attribute in the DSL is read case-insensitively; `uniq` now is too, in all five.

<!-- covers: distinct -->

- **A `<switch>` member of an env-level `<distinct>` came out blank on the rows where it
  collided, on every engine and with no diagnostic.** The redraw was given no row, so it could
  not tell which branch the subject had selected and returned the empty string — which the
  caller then accepted as a value different from all the others and wrote into the cell. It
  now redraws inside the branch the row belongs to: a `<case is="p">` row comes back with
  another p value. The function's own comment had claimed the switch case was handled.

<!-- covers: TDC268 -->

- **`if=` on a `<gen type="pool">` is refused by TDC268 instead of leaking.** A `<gen>` carrying
  `if=` becomes a conditional branch, and the pool resolver only recognises a plain
  `<gen type="pool">` — so the reference registered no `Ref.field` column at all and
  `${{Ref.name}}` reached the output as its own literal text, on EVERY row including the ones
  the condition selected, from a config `check` had called valid. Refused rather than
  implemented: leaving a row without a member is what `parent=` already does, and a
  conditional reference would have to answer what `${{Ref.field}}` means on a row that took
  the other branch. The pool pages now document `parent=` for that job.

<!-- covers: anomaly_flag -->

- **`anomaly_flag` recorded the per-row SELECTION rather than the outcome.** `anomaly=`
  multiplies a NUMBER and leaves anything else alone, so a `type="template"` column of
  surnames was selected like any other and then left untouched — and came out flagged
  `true` beside an ordinary name, while the page promised the flag and the spike "can never
  disagree". Worse than a wrong number: the flag is training data for an anomaly detector,
  and every such row teaches it something false. It now records what happened.

- **On the streaming and exact-on-disk engines of Python, Rust, C# and Java, a column whose
  values are apportioned exactly — `type="text"`, a weighted file column, a weighted pack —
  published NO `anomaly_flag` column at all, so `${{Flag}}` reached the output as its own
  literal text while the in-memory engine rendered it correctly.** Found by the shared case
  written for the entry above. The value and the anomaly draw are both functions of the row
  on that path, so the flag is now computed there like everything else.

<!-- covers: TDC269 -->

- **`if=` on a `<gen>` inside a `<case>` is refused by TDC269.** A case body is several parts
  JOINED into one value, so a condition on one part has no answer to give: if it were false,
  the part would have to become something, and there is no honest candidate. It used to be
  accepted and ignored, so `<gen if="K == p">` inside a case put its value on EVERY row —
  including the ones the condition excluded — from a config `check` had called valid. The
  branch already carries its own condition, `<case if="…">`, which is the question the shape
  does raise; the same reasoning as TDC246 beside it.

<!-- covers: TDC270 -->

- **A second `<env>` or a second `<block>` under `<tdc>` is refused by TDC270.** Both are read
  by taking the FIRST of their kind, so a second one was dropped whole — every sequence it
  declared, every line it laid out — and the run finished looking healthy while half the
  config had produced nothing. `check` called such a document valid. The same silent discard
  TDC014 already refuses for the self-closing spelling, one level up.

<!-- covers: TDC271 -->

- **`percent=` beside `order="sequential"` is refused by TDC271.** Walking the list in order
  gives row `r` element `r mod N` — a rule about POSITION, which leaves no room for a rule
  about SHARE. The engine ignored the percentage outright and said nothing:
  `percent="98,1,1"` over a hundred rows came out 34 / 33 / 33 from a config `check` had
  called valid. Both `type="text"` and `type="file"` walk a list, and both dropped it.

<!-- covers: TDC272 -->

- **`<env local="af">` with a date now warns (TDC272) instead of quietly rendering it in
  English.** The same value is an ERROR on `<gen type="date" local="af">` (TDC153) and was a
  silent downgrade here — an asymmetry the user could not see. Refusing it on `<env>` would
  be wrong: a locale can be a perfectly good source of names and still ship no month names,
  and refusing would forbid the Afrikaans name pack because Afrikaans dates are missing. The
  warning fires only when the format actually reads the locale, so `format="YYYY-MM-DD"`
  stays silent while a missing `format=` does not — the default `L` is a layout the locale
  chooses.

<!-- covers: TDC273, TDC274, TDC275 -->

- **The ARGUMENT of an interpolation filter is checked.** The filter NAME has been checked
  since TDC192 and a mask pattern since TDC199/TDC256; everything after the colon reached
  the renderer unread. The renderer is lenient by design — one bad row must not abort a
  million-row run — so `group:abc`, `group:0`, `compact:1`, `compact:99` and `slice:abc`
  all passed the value through untouched, `slice:5,2` emptied the column, and `trim:junk`
  ignored the argument. Every one of them said nothing. TDC273 names an argument the filter
  cannot use, TDC274 an argument on a filter that reads none, TDC275 a `replace` with
  nothing to look for. Not refused, deliberately: `group` and `compact` with no argument at
  all (both have a documented default), `csv:;` (the delimiter is accepted and ignored on
  purpose), and a negative `slice` index — only a from/to pair of the SAME sign can be
  proven empty, and a refusal has to be a proof.

<!-- covers: TDC276 -->

- **A pinned pack parameter of the wrong width is refused (TDC276) instead of breaking the
  run or the data.** `<gen type="template" value="usa.finance.aba_routing" prefix="12345"/>`
  passed `check` and then aborted with `<at>: index 8 is out of range and no default is
set` — a message naming no file, no line and no code. `tail="678"` passed `check`, said
  nothing at all, and wrote `326784`: six digits, and not a routing number. These packs
  compute a check digit over a FIXED layout, so a wider or narrower part does not shift
  the layout, it breaks it.

  Only reported where the width is a fact read off the pack's own body — an alternation
  whose items are all the same length, a regex with an exact count, a zero-padded range —
  which covers 305 parameters across 173 bundled packs, the whole check-digit family. A
  parameter whose own generator varies in width (a name, a word list) has no proven width
  and stays silent, because a refusal has to be a proof. The reference reads the width off
  the parsed spec and the four ports scan the body; the two were diffed across every
  bundled pack and agree on all 173.

- **A pack parameter that shares a name with another generator's attribute is no longer
  refused.** `<gen type="template" value="common.payment.card.pan" base="4111111111111"/>`
  was answered with `TDC015: <gen> does not read "base" — it belongs to type="running",
type="timeseries"`. The pack declares `<sequence name="base">`, the ENGINE was already
  handing `base=` to it, and only the validator objected — on 39 packs, every one that
  builds a value around a pinned prefix, which is the whole check-digit family (ISBN13,
  IMEI, ICCID, IBAN, EAN13, card PANs…).

  The line between "an attribute the engine reads" and "a parameter the pack may claim"
  is now taken from the engine's own `RESERVED_TEMPLATE_ATTRS` rather than restated in
  the validator, so the two cannot drift apart again. `order=` and `cycle=` are reserved
  and stay refused; everything else goes to the pack-parameter check, which has the
  registry in hand.

  The same mistake printed TWO errors for a name the pack does NOT declare — the
  ownership one, naming the wrong reason, beside the TDC072 that names the right one.
  Now one. Fixing that exposed a second divergence the shared cases had not covered: the
  four ports were skipping the pack-parameter check for the union of EVERY generator's
  attributes, so `points=` on a pack that does not declare it went unreported once the
  ownership check stopped guessing. All five now skip the same twenty wrapper names, and
  three shared cases pin it.

- **A data pack can no longer ship a parameter nobody can set.** A pack's parameters ARE its
  sequence names, and a handful of names are read by the ENGINE off the calling `<gen>`
  first — `local=` is the locale override, `order=`/`case=`/`mask=` are wrappers around
  whatever the pack produces. A `<sequence>` called one of those works fine inside the
  pack and can never be set from outside, so the reference table generated from the pack
  bodies listed a parameter that does not exist.

  34 shipped packs were in that state. `common.internet.email` declared `local`, so the
  documented `local="bob"` chose a LOCALE instead of the address's local part; 32
  street-name packs declared `type`, which cannot even be written twice on one tag; and
  `france.docs.nir` declared `order`. All three were renamed — `user`, `kind`, `serial` —
  and the output of every one of the 34 is byte-identical, because a pack's internal
  sequence name reaches nothing outside the pack. The rename was verified that way before
  it was kept.

  Loading such a pack is now an error in all five implementations, with a shared CLI case
  pinning it, so the state cannot come back.

### Documentation

- **The Python binding page's first example did not run.** It called `to_string()`,
  `iterate()`, `to_array()` and `get_at()` — four names Python does not have, because
  Python spells them `str(data)`, `for row in data`, `data.to_list()` and `data[3]`. The
  capabilities were never missing, only the page. It survived because the documentation
  checker runs the `.tdc` configs in the docs and not the language snippets; a Python test
  now runs every call the page shows, so a rename fails the build. The other four binding
  pages were checked the same way and were already correct.

- **`ink_threshold` was documented backwards, which made the value the page prescribed a
  no-op.** A pixel is ink when it is at or DARKER than the cutoff, so raising it takes in
  faint gray and lowering it keeps only near-black. Measured on the page's own figure:
  `0.3` produces exactly the default's output, `0.8` picks up the gray stroke. The figure
  caption underneath had been right all along.

- **Six behaviours the engine had never written down: the 64-level nesting cap behind
  TDC001; `distribution="zipf"` refusing an `n` above 10 000 000; `missing_as=` being
  reshaped by `mask=` and `case=` like any other value; `local=` working per generator as
  well as per run; the `csv` filter accepting a delimiter it deliberately ignores; and
  what the object API costs — `getAt(index)` is one row's work at any index (2 ms against
  `toArray()`'s 210 ms on 200 000 rows).**

### Fixed

- **`mask=`, `case=`, `missing=`, `repeat=` and `anomaly=` on `<gen type="running">` and
  `<gen type="stat">` are refused (TDC015) instead of accepted and ignored.** Both resolve
  before the formatting layer — they read a column that already exists and publish the
  number as it stands — so all five sat there doing nothing while `check` called the
  config valid. Measured: `mask="x"` turns `33` into `3` on a `number` and leaves `77`
  alone on a `running`.

  Refused rather than implemented, because the answer already exists one step later and
  is better: the interpolation filter runs where the value is PRINTED, so
  `${{Total|mask:x}}` gives `7` today. Implementing the attributes would also have to
  invent a meaning for `repeat=` on a value that is one per row by definition, and for
  `anomaly=` on a running total, which stops being the total the moment it is multiplied.
  Three shared cases pin it, including one that checks the same wrappers still work on a
  plain `number`.

- **`order=` and `cycle=` were presented as attributes of any generator.** They are read by
  the three that have an order to walk — `text`, `file` and `date` — and refused (TDC015)
  everywhere else, which is what the engine has done all along. Checked against ten
  generator types; the pages now say which three.

- **A predicate written where a value belongs — `<result><greater_than>…</greater_than>` —
  passed `check` and then died mid-run with `unknown compute tag <greater_than>`: no code,
  no line, no file.** The four predicates are compute tags, so the unknown-tag check waved
  them through wherever they appeared, and the errors reference had been claiming TDC180
  caught this all along. It does now, in all five, with a hint that shows the `<choose>`
  wrapper. Pinned by a shared case.

- **Four claims in the reference that the engine does not make.** `TDC183` said `<add>` and
  `<subtract>` "take exactly two operands" — only `<divide>` and `<mod>` are binary; the
  other three are variadic, and `<add>` over nothing is `0`. `TDC125` listed three allowed
  children of `<case>`; there are four, and the fourth, `<switch>`, has its own error code
  next to it. The same `row` key across files of different lengths does link them, and
  proportionally — an 8-line file's line 8 pairs with a 4-line file's line 4 — where the
  page said it does not link them at all. And the pool "declare the reference above the
  one that filters" rule is a readability habit, not something the engine enforces:
  swapping the two produces identical output and passes `check`, because the pool tables
  are built before any row is drawn.

- **The error transcripts are checked now.** `docs:examples` runs the examples that pair a
  complete `<tdc>…</tdc>` with their output; a transcript showing an ERROR almost never
  has that shape — the config above it is a fragment, or the block is a terminal session
  — so the error transcripts were the one part of the site nothing checked, and they
  rotted quietly. `docs:diagnostics` reads every diagnostic the documentation quotes and
  matches it, by code and by wording, against messages the engine actually emits: the
  corpus comes from RUNNING all 287 shared diagnostic cases, with the message templates
  read out of the source as a fallback for codes no case covers.

  It found six stale transcripts across the three languages. `TDC014` printed a sentence
  the engine had replaced (`<env> must not be self-closing` for `<env/> cannot be
self-closing — its attributes and children would be ignored`); `TDC101` still showed
  `%` being refused, which stopped being true when `%` became the Euclidean remainder;
  `TDC207` and both `TDC062` lines were a rewrite behind; and one page printed
  `suggestion:` where the engine writes `help:`. It also found a message quoted on the
  pools page with no shared case behind it, so `TDC236` now has one.

- **The catalogue counts are generated, not written.** "108 sets today: `common`, ten
  languages, and 97 countries" was a release behind — the answer had become 109 and 98,
  and it is a sentence nobody thinks to revisit when a country pack lands, because the
  pack does not live anywhere near the page. The build already substituted the version
  this way, for exactly this reason; it now substitutes the counts too, read from
  `data/bundles.json`. The page states no number, it asks for one.

- **The postal-code count on the template page said 48; counting the country packs that
  ship a postal-code address gives 46.** The sentence now names the address names it
  counted (`zip`, `postalCode`, `eircode`, `cep`, `cap`, `cpa`), so the number can be
  reproduced instead of trusted.

- **The performance page said "the figures stand for 0.1.5" while the engine shipped 0.2.0.**
  It now says plainly that the numbers were measured on 0.1.4/0.1.5 and have not been
  re-measured since, and which part of them — the shape, not the absolute seconds — is
  the part to trust.

- **Nine more transcripts re-run and replaced with what the engine prints.** The two `uniq`
  infeasibility messages and the parent-declaration-order error were in retired formats
  (`uniq: …`, `tdc: …`, `Error: …`) that no version prints any more; the
  `--count 5 --seed alt` run on the first-run page, both name runs on the configuration
  page (English and Russian), the seeded Russian surname on the quick-API page and the
  TypeScript object-output block had all drifted with the data packs. The walked date
  axis was documented as ending at `start + count × step`, one step past its last row —
  the line above it, `row i is start + i × step`, had been right all along.

  Each was verified by running its own config, not by editing to taste: a blanket
  substitution of the quick-API surname reached two blocks it should not have, and
  `docs:examples` failed on one of them, which is the whole reason that check exists.

- **The `accumulate=` transcript paired two different draws, so the arithmetic it invited
  you to check did not hold: `792.47` on the left against `459.93` on the right, and
  `792.47 + 325.07` nowhere near the `1277.62` beside it.** A reader who checked it would
  conclude `accumulate` was broken; the engine was fine, the transcript was two runs
  spliced. Re-run as one pair, every subtotal now verifies.

- **The regex page promised that `seed="demo"` alone reproduces its strings.** Two things
  decide a draw — the seed **and the sequence's name** — because each column draws from
  its own derived stream, which is what keeps adding a column from shifting the ones
  beside it. The same pattern under `<sequence name="Phone">` and under
  `<sequence name="V">` gives different values on one seed, so a reader copying a pattern
  off the page and getting different strings was seeing the design, not a bug. The page
  says so now.

- **Parquet: the footer now declares `column_orders`, so the column statistics can actually
  be used.** The min/max bounds were written and correct; the format says a reader must
  ignore them until `FileMetaData.column_orders` declares the sort order, and parquet-mr
  (Spark, Hive, Impala) drops BYTE_ARRAY bounds outright without it. So every row group
  was decoded in full — exactly what the statistics exist to avoid. Nine bytes of footer
  per column, and all five implementations write the same ones: verified byte-identical
  across TypeScript, Python, Rust, C# and Java, and the golden file re-read in pyarrow
  (an independent reader) to confirm the rows, the NULL, the anomaly flags, the decimals
  and the dates all survive.

- **Parquet: `<gen type="http">` with `-o out.parquet` wrote the TEXT rendering under a
  `.parquet` name and exited 0.** An http config can only be prepared asynchronously — the
  service call IS the preparation — and the CLI's async path ignored the file extension
  entirely. The extension now chooses the container on both paths. TypeScript only: the
  four ports call their services synchronously and were already writing Parquet here.
  Checked by generating the same config in all five and comparing bytes.

### Documentation

- **The exact-shares promise now carries the one thing that breaks it: `missing=` on the same
  generator.** The quota is laid over the whole column first and blanks are applied without
  regard to which value a cell holds, so `percent="90,10" missing="0.5"` gives about
  450 / 50 / 500 blank — the RATIO survives, the absolute counts do not. No ordering could
  fix it: exactly 100 `fail` rows AND half the file blank would make `fail` 20% of the
  surviving values, not the 10% asked for. The two requests are inconsistent, so the page
  says which one `missing=` wins.

<!-- covers: abs, round, floor, ceil, trunc, min, max -->

- **`abs`, `round`, `floor`, `ceil`, `trunc`, `min` and `max` in `if=` and `filter=` kept
  the exact answer only up to 2^53.** Arithmetic already carried a whole number as one, so
  `9007199254740993 - 1` was right, but handing that number to `round` — which for a whole
  number is the number itself — pushed it through a double and gave back
  `9007199254740992`. All five implementations agreed on the wrong answer, so no test
  caught it; a shared case now pins the exact one.

### Documentation

- **The whole-number table in the expression reference now lists the rounding and selection
  functions, which stay whole like `+ - *` do, and the `%` caution names the negative
  DIVISOR — `7 % -3` is 1 here and −2 in Python, the one place Euclidean and floored
  disagree that the old text did not cover.**

## [0.2.0] — 2026-08-07

The first release since the expression language, the walked date axis and four new
constructs. One version across npm, PyPI, crates.io, Maven Central and NuGet, and every
item below holds in all five implementations.

### Added

- **The expression language grew from comparisons to a language.** `if=` now takes `%`,
arithmetic on the row counters (`_count` and `_total` are numbers, not text), function
calls — `abs`, `ceil`, `floor`, `max`, `min`, `round`, `trunc` — membership (`Country in
[US, CA, MX]`), string predicates and the ternary. `TDC101` shows what is available when
a name is not.
  <!-- covers: TDC257-TDC261, contains, starts_with, ends_with, lower, is_empty, pow, cbrt, log10 -->

- **`TdcMath` — the transcendentals are computed by TDC rather than by the host.** `sqrt`,
  `exp`, `log`, the trigonometric and hyperbolic functions and their inverses, `erf`,
  `erfc`, `gamma`, `lgamma`, `expm1`, `log1p`, `log2`, `hypot`, `sign`. Every host language
  rounds these slightly differently, and one last-bit difference turns a comparison into a
  different row, so TDC computes them itself and all five agree bit for bit.
  <!-- covers: acos, acosh, asin, asinh, atan, atan2, atanh, cos, cosh, sin, sinh, tan, tanh, degrees, radians, beta, digamma, zeta -->

- **Whole numbers stay whole past 2^53.** The expression language works in a signed 64-bit
  integer domain, so `9007199254740993 == 9007199254740992` is false and their difference
  is 1. On doubles both answers were wrong, and wrong in silence.

- **`<gen type="stat">` — one number for the whole run, on every row.** `op=` is `sum`,
  `mean`, `median`, `min`, `max`, `count` or `stddev`, over a column declared above it.
  "Is this row above average" cannot be asked any other way: the average is not knowable
  until the last row exists, so the statistic has to be a column of its own. It draws
  nothing, so adding one leaves every other column exactly where it was.
  <!-- covers: TDC262 -->

- **A date measured from another date — `of=` and `plus=`.** The interval in almost every
  real record: admitted and discharged, ordered and shipped, issued and expires.
  `plus="3..10d"` draws a fresh gap per row, `plus="7d"` is the same distance every row,
  and both bounds may be negative to measure backwards. The offset reads the source
  column's VALUE, not the text in the cell, so a source rendered as `MMMM D` — which throws
  the year away — still offsets correctly, and a month lands on the last day of February
  rather than 30 days later.
  <!-- covers: TDC264 -->

- **A date range can be WALKED, not only drawn.** `order="sequential"` marches down the
  calendar; `step=` takes one notation (`15m`, `1h30m`, `3mo`); `weekdays="mon..fri"` keeps
  only some days; and with no upper bound the axis grows with the run.
  <!-- covers: TDC247-TDC250 -->

- **`<split>` in the compute layer — a string to a list.** The inverse of `<join>`, and the
  fourth way to get a list. A `repeat=` column arrives at an expression as its joined text;
  until now there was no way to read it back apart, so "sum quantity × price over the items
  of this order" was unwritable.

- **`at()` and lists inside one row.** An expression can reach the n-th element of a list a
  row carries, and the mistakes it used to answer with an empty column — a non-list, a
  negative or fractional index — are now named.

- **`<assert that="…" says="…"/>` — a config that checks its own output.** A statement about
  the whole run, in `<env>` beside `<uniq>` and `<distinct>`. What is worth asserting is the
  property the config does NOT state: you write `percent="70"`, a `parent=` filter and a
  condition stack up, and the share that reaches the file is 42 percent with nothing to say
  so. If the condition holds nothing happens; if not, the run stops with the author's own
  sentence and exit code 1, before a line is written. Every name it reads must be the same
  on every row, or a per-row column would be read at row 0 and the run called verified.
  <!-- covers: TDC265, TDC266 -->

- **`peak_at` on `timeseries` — which row the wave is highest on.** "Warmer in July" is now
  writable; before, the peak sat a quarter period in and could not be moved.
  <!-- covers: TDC252, TDC253 -->

- **Fixtures interpolate.** `${{Name}}` in `<before>`, `<after>` and their siblings expands,
  in the reference as it already did in the four ports.
  <!-- covers: TDC263 -->

- **`check --brief` — one line per diagnostic**, for a tool rather than a person. It also
  made three faults visible that the full report had been hiding.

### Fixed

- **A `uniq` group asked for more rows than its values can make now says so before
  allocating.** The check existed and its message was right, but it ran over the finished
  columns — so two lists of ten values and `count="1000000000"` died in the allocator with a
  heap dump, and `count="5000000000"` with `Invalid array length`. Exactly where the warning
  is worth most, since the alternative is an eight-hour run that was never going to succeed.
  The ceiling is now computed from the specs, before a single column is built, and it only
  ever answers "definitely impossible".

- **An offset from a WALKED source (`order="sequential"`) came out empty, in silence.** A
  walked date returns from a different branch of the builder than a drawn one, and that
  branch was not filling the instant the column keeps beside its text. The safety net closes
  the whole class: the instants are attached only when every applicable row filled one.

- **A conditional `<gen>` drew off the wrong stream and lost its `anomaly_flag` column.**
  TDC246 refuses the flag inside a `<case>`, where it never meant anything.

- **Five silent answers became refusals**, each of which used to produce a column that
  looked fine: a `<mask>` with no pattern (TDC256), `decimals=` alongside
  `include=`/`exclude=`, `repeat=` with `order="sequential"` (where the three engines
  disagreed), a `<gen>` attribute nothing reads (TDC015 now catches it per generator type),
  and a closing tag that does not name the element it opened.
  <!-- covers: TDC254, TDC255, TDC256 -->

- **TDC251 — a `percent` share that asks for less than one whole row.** Ten percent of five
  rows is half a record, the engine rounded it away, and the column read like one nobody had
  written.

- **An invented tag is refused wherever it appears, in one wording**, and `<gen></gen>` is
  the same generator as `<gen/>`.

- **TDC071 names the paths that exist** instead of only saying the one you wrote does not,
  and TDC250 no longer claims a calendar step fixes the weekday — it does not.

- **Three misleading answers found by the Studio agent**: a fixture body that renders
  nothing now says so, `<delimiter_line>` sits between the lines an `each=` produced rather
  than between the elements, and a name that fails to interpolate is reported as the cause
  rather than as a range.

- **The npm package told CommonJS callers a lie the runtime then refused.** `exports` and
  `types` promised type definitions for `require()`, while the module is ESM-only. `attw
--pack` is green on all four resolutions now, and the CJS type IS the message.

### Data

- **The Chinese pack was on the wrong axis** — filed as a locale when its content is a
  country — so nobody could reach it. Now `countries/china` (15 files) and `zh-cn` (4).
- **`uk` (Ukrainian) gains its person and date core**, with masculine and feminine surnames
  and patronymics parallel line for line.
- The person paths ship in ten locales rather than two.

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
