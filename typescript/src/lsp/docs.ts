/**
 * Short human docs for hover tooltips.
 *
 * English, like the rest of the project's source and `docs/`. Translations
 * belong beside the other translations (`docs/ru`, `docs/es`) once there is a
 * mechanism for them; a hover that answers in a different language from the
 * documentation it summarises is worse than no hover.
 *
 * Keyed by tag name / attribute name. Missing keys simply produce no hover,
 * so it is safe to cover only the common surface. Kept as plain markdown
 * strings; the hover layer wraps them with the identifier being hovered.
 */

export const TAG_DOCS: Record<string, string> = {
  // ── the compute sub-language ──────────────────────────────────────────────
  // A declarative tag tree, not an expression string: every step is a tag, and
  // values arrive through attributes because the grammar has no text content.
  int: 'An integer literal.',
  str: 'A string literal.',
  list: 'A literal list of values.',
  field:
    'Reads another field of this row. It must be declared ABOVE this one — a `<field>` pointing further down the file is `TDC182`, because the row is built in order.',
  let: 'Names a value once so `<use>` can read it back, instead of computing it twice.',
  use: 'Reads back a value that `<let>` named.',
  each: 'Maps over a list, running its body once per element.',
  reduce: 'Folds a list to a single value, carrying `<acc>` from step to step.',
  current: 'Inside `<each>` or `<reduce>`: the element at this step.',
  current_index: 'Inside `<each>` or `<reduce>`: which step this is, counting from zero.',
  acc: 'Inside `<reduce>`: what the fold has accumulated so far — the value `<do>` produced last time.',
  init: 'Inside `<reduce>`: what `<acc>` holds before the first step.',
  do: 'Inside `<reduce>`: the body run at each step, whose result becomes the next `<acc>`.',
  over: 'Inside `<each>` or `<reduce>`: the list being walked.',
  index: 'Inside `<at>`: which position to take, counting from zero.',
  in: 'The list slot of `<join>`, `<at>` and `<length>` — the collection the operation reads. (Not the `in=` attribute of `<gen type="http">`, which names a sequence to send.)',
  join: 'A list to a string.',
  split: 'A string to a list, cut on `sep=`.',
  at: 'Indexes into a list.',
  length: 'Measures a string or a list.',
  add: 'Adds its parts together.',
  subtract: 'Subtracts the rest from the first.',
  multiply: 'Multiplies its parts together.',
  divide: 'Integer division — the remainder is thrown away.',
  mod: 'The remainder of a division.',
  to_number: 'Reads a string as a number.',
  encode: 'Re-encodes a value in another base or alphabet.',
  pad: 'Pads on the left to a fixed width.',
  concat: 'Glues parts into one string.',
  upper: 'Upper-cases a string.',
  lower: 'Lower-cases a string.',
  capitalize: 'Upper-cases the first letter, leaves the rest.',
  title: 'Upper-cases the first letter of every word.',
  mask: 'Splits and rearranges by a pattern.',
  slice: 'A substring by index.',
  replace: 'Replaces every occurrence — the needle is a literal, not a pattern.',
  trim: 'Strips the outer whitespace.',
  group: 'Groups characters from the RIGHT, the way a card number or a thousands separator does.',
  choose:
    'Picks the first `<when>` whose `<test>` holds. `<otherwise>` is required — a `<choose>` without one is `TDC184`.',
  when: 'One branch of a `<choose>`: a `<test>` and the `<result>` to use when it holds.',
  otherwise: 'The branch of a `<choose>` taken when no `<when>` matched. Required.',
  test: 'The condition slot of a `<when>`.',
  then: 'The value slot of a `<when>`.',
  result: 'What this branch evaluates to.',
  equals: 'True when two integers are equal.',
  greater_than: 'Strict `A > B`.',
  less_than: 'Strict `A < B`.',
  is_digit: 'True when a character is `0`–`9`.',

  tdc: 'The root of a TDC configuration.',
  env: 'The generation environment: `count` — how many records, `seed` — the RNG seed, `inject` — the interpolation marker, plus the `<sequence>` / `<mix>` / `<switch>` declarations.',
  sequence:
    'A named sequence of values, one per record. Referenced in the output as `${{Name}}`. With `parent=` it is built only where the parent has that value.',
  gen: 'A value generator. `type` picks which one (`text`, `number`, `regex`, `date`, `template`, `symbol`…). Lives inside a `<sequence>` or a `<case>`.',
  mix: 'A distribution: a named sequence that spreads its `<case>` branches across the records by `percent` — exact counts, not approximate.',
  switch:
    'A lookup table: reads the subject sequence named by `on` and substitutes the value from `<map>` or `<case is="…">`. Deterministic.',
  map: 'A compact `KEY:VALUE` table inside `<switch>`. Several keys share a value with `|`.',
  case: 'One branch. Inside `<mix>` it is chosen by percentage; inside `<switch>`, by its `is` key.',
  default: 'The "else" branch of a `<switch>` — used when no key matched.',
  distinct:
    'The values inside must all **differ from each other within one record** — birth city ≠ current city.',
  uniq: 'The combination of the sequences inside is **unique across every record** — no two records share the same tuple.',
  block: 'The layout of one output record — which lines it is made of.',
  line: 'One line of a record. With `if=` it is printed only when the condition is true.',
  compute:
    'A **processor**, not a generator: it derives a value from other sequences with `<field name="…"/>`. It has no randomness of its own — the same inputs always give the same answer — which is why `uniq=` is not allowed on a sequence whose only child is a `<compute>`.',
  data: 'Literal output text. The body is raw — spaces included — with `${{…}}` interpolated into it.',
  before: 'Printed once, before everything else — a header.',
  after: 'Printed once, after everything else — a footer.',
  before_block: 'Printed before every record.',
  after_block: 'Printed after every record.',
  delimiter_block: 'Printed between records, never after the last one.',
  before_line: 'Printed before every line of a record.',
  after_line: 'Printed after every line of a record.',
  delimiter_line: 'Printed between the lines of a record.',
};

export const ATTR_DOCS: Record<string, string> = {
  // ── columns that read other columns ───────────────────────────────────────
  of: 'The column this one is computed from. On `running` the column to accumulate, on `stat` the column to summarise, on `date` the column to measure from.',
  accumulate:
    'How a `running` column adds up — or, beside `repeat`, replaces the list with its running total.',
  reset:
    'On `running`: a column whose change restarts the total. A new customer, a new month, a new order.',
  op: 'On `stat`: which statistic — `sum`, `mean`, `median`, `min`, `max`, `count` or `stddev`.',
  plus: 'On `<gen type="date" of="…">`: how far from that column — `7d`, `3..10d`, `1..3mo`, `-10..-3d`. A bare number means days.',
  expr: 'On `formula`: the arithmetic this column is, written the way an `if=` condition is.',
  filter: 'On `pool`: which members of the pool this row may draw from.',

  // ── file and repeat ───────────────────────────────────────────────────────
  read: '`"quantile"` — read the file as a sorted sample and land anywhere along it, not only on the values in it.',
  sample:
    '`"exact"` — sweep the distribution evenly instead of drawing from it, so the shape comes out exact rather than approximate.',
  lengths:
    'Beside `repeat="A..B"`: the share of rows that get each length, shortest first. An exact quota, not an approximation.',

  // ── dates and waves ───────────────────────────────────────────────────────
  weekdays: 'Which weekdays a walked date axis keeps: `mon..fri`, `sun,wed`.',
  peak_at: 'Which row the seasonal wave peaks on.',

  // ── http ──────────────────────────────────────────────────────────────────
  in: 'On `http`: a sequence whose value is sent with each row.',
  on_error: 'On `http`: `fail` (default) or `empty` when a request does not come back.',
  timeout: 'On `http`: seconds to wait for a response. 30 by default.',
  secret: 'On `http`: the key each request is signed with — `env:NAME`, `file:path`, or a literal.',

  // ── statistical distributions ─────────────────────────────────────────────
  // Which parameters a distribution takes is part of what it IS, so each one
  // names its own rather than describing the letter in the abstract.
  distribution:
    'The shape the numbers take: `normal`, `lognormal`, `exponential`, `pareto`, `weibull`, `poisson`, `zipf`, `gamma`, `beta`, `uniform`.',
  mean: 'On `normal`: the centre of the bell.',
  sd: 'On `normal`: the spread — about two thirds of the values land within one of these of the mean.',
  meanlog:
    'On `lognormal`: the mean of the LOGARITHM, not of the values. 10.8 is roughly a median of 49,000.',
  sdlog:
    'On `lognormal`: the spread of the logarithm. The larger it is, the longer the right tail.',
  rate: 'On `exponential`: events per unit of time. The mean gap is `1 / rate`.',
  alpha:
    'On `pareto`: how fast the tail falls away — smaller is heavier. On `beta`: the first shape parameter.',
  xmin: 'On `pareto`: the smallest value, where the tail starts.',
  shape:
    'On `weibull` and `gamma`: below 1 the risk falls with age, at 1 it is constant, above 1 it is wear-out.',
  scale:
    'On `weibull` and `gamma`: the characteristic size — where the distribution sits on the number line.',
  lambda: 'On `poisson`: the average number of events per interval.',
  beta: 'On `beta`: the second shape parameter. With `alpha`, it bends the 0..1 range toward one end or the middle.',
  s: 'On `zipf`: the steepness. Larger skews harder toward the first ranks.',
  n: 'On `zipf`: how many ranks there are — a hundred products, a thousand pages.',
  min: 'A floor the drawn value is held to, after the distribution has spoken.',
  max: 'A ceiling the drawn value is held to, after the distribution has spoken.',

  count: 'How many records to generate.',
  seed: 'The random-number seed. The same seed and config give the same output, byte for byte.',
  inject: 'The interpolation marker, `${{%}}` by default. Change it to print a literal `${{…}}`.',
  local: 'Locale (`en`, `ru`, `es`…) — selects the data packs and date formats.',
  name: 'The name of a sequence, `<mix>`, `<switch>` — or of a field inside a compound sequence.',
  parent:
    'A parent filter: `Name` or `Name.Value`. The sequence is built only on the records where the parent produced that value.',
  on: 'The subject of a `<switch>` — the sequence whose value is looked up among the keys.',
  is: 'The key or keys of a `<case>` inside a `<switch>`. Several share a branch with `|`, e.g. `US|CA`.',
  uniq: '`uniq="true"` — nothing repeats across records: on a compound sequence the TUPLE of fields, on a simple one the value itself (drawn without replacement; refused when the pool is smaller than the count).',
  type: 'Which generator: `text`, `number`, `regex`, `advanced_regex`, `date`, `template`, `symbol`, `increment`, `decrement`, `file`, `timeseries`, `pattern`, `http`, `pool`, `running`, `stat`, `formula`.',
  value:
    'The main value — what it means depends on `type`: a list for `text`, a range like `1..9` for `number`, a pack address for `template`.',
  percent:
    'The share of records per branch or per value, e.g. `70,30`. Exact counts, not approximate. A blank slot takes an equal cut of what is left.',
  length: 'How long the result is, in characters or digits.',
  include: 'Add values or ranges to the pool.',
  exclude: 'Remove values or ranges from the pool.',
  alphabet: 'A named character set for `type="symbol"`.',
  first_zero: 'Whether a number may start with a zero (`true` / `false`).',
  from: 'The start of a date range.',
  to: 'The end of a date range.',
  range: 'A range of dates, absolute or relative.',
  format: 'How a date is written out.',
  step: 'The step for `increment` / `decrement`.',
  src: 'Path to the source file for `type="file"`, or the service URL for `type="http"`.',
  column: 'Which CSV column — by name or by number.',
  header: 'Skip the first row of the CSV when addressing columns by number.',
  delimiter: 'The CSV separator for `type="file"`, a comma by default.',
  row: 'A linked-row key: fields sharing one `row` all read the same CSV line, so a record stays coherent.',
  oldest: 'The oldest age, in years, for `person.b_day`.',
  youngest: 'The youngest age, in years, for `person.b_day`.',
  precision: 'The step of a date-time range (`day` / `hour` / `minute` / `second`).',
  missing: 'The share of records left empty, `0..1`. Real data has gaps.',
  missing_as: 'What an empty value is written as — blank by default, e.g. `NULL`.',
  anomaly: 'The share of values pushed out of range, `0..1`. Needs a numeric generator.',
  anomaly_factor: 'How far an outlier is pushed — the value is multiplied by it. 10 by default.',
  anomaly_flag: 'An extra column naming the records that got an outlier — the ground truth.',
  base: 'The starting level of the series (`type="timeseries"`).',
  trend: 'How much the series drifts per record (`type="timeseries"`).',
  period: 'The length of one seasonal cycle, in records (`type="timeseries"`).',
  amplitude: 'The height of the seasonal swing (`type="timeseries"`).',
  noise: 'The standard deviation of the gaussian jitter added on top (`type="timeseries"`).',
  decimals: 'How many digits after the decimal point.',
  points: 'The points of the curve for `type="pattern"`, e.g. `0,0 50,100 100,0`.',
  mode: 'How to read the drawing (`type="pattern"`): `signal` — a trajectory across records (default), `density` — a distribution, where height is how often a value occurs.',
  upper: 'The upper boundary curve of a corridor (`type="pattern"`).',
  lower: 'The lower boundary curve of a corridor (`type="pattern"`).',
  y_range: 'The vertical scale, `min..max` (`type="pattern"`).',
  fit: 'Where a drawing read from `src=` lands on the value axis (`type="pattern"`): `low..high`, the values its own lowest and highest point become. Omit it and the drawing fills `y_range`. Not read beside `points=`/`upper=`/`lower=`, which already carry the 0..100 board.',
  interp:
    'How the line behaves between points (`type="pattern"`): `linear` (default), `smooth` or `step`.',
  spread:
    'Widen the drawn line into a band of ±N, in `y_range` units (`type="pattern"`, `0` by default).',
  ink_threshold: 'How dark a pixel has to be to count as ink when reading a picture.',
  regex_max_length: 'A length cap for the regex generators — a safety valve.',
  version: 'The DSL version this file requires.',
  comment: 'A free-form note. The engine ignores it.',
  if: 'A condition: the element applies only where the expression is true.',
  pair: 'A marker that pairs an opening and closing `<data>`, so a literal closing tag can appear inside.',
  repeat: 'Several values in one cell: `3`, or a range like `1..5`. The cap is 64.',
  separator: 'What the values of a `repeat` are joined with — a comma by default.',
  distinct:
    "With `repeat`, draw the row's values WITHOUT replacement, so one cell cannot hold the same value twice. Needs `repeat`, and cannot sit beside `percent` — exact whole-run proportions and a per-row guarantee cannot both hold.",
  each: 'Repeat this line once per element of a list value.',
  flag: 'An extra column marking the records that took a branch marked `anomaly="true"`.',
  mask: 'A positional template that rebuilds the printed value: `x` — one character, `w` — one word, `*` — everything left over, anything else a literal. `x[i]` / `w[i]` address the original, so `w[1] w[0]` turns `John Smith` into `Smith John`, and `x[0].` into `J.`',
  case: 'The letter case of the printed value (`upper`, `lower`, `capitalize`, `title`).',
  order: 'The order values come out in: `random` (default) or `sequential`.',
  cycle: 'With `order="sequential"`: start the list again instead of failing when it runs out.',
  weight: "The column holding a row's frequency, for weighted file rows.",
};
