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
  type: 'Which generator: `text`, `number`, `regex`, `advanced_regex`, `date`, `template`, `symbol`, `increment`, `decrement`, `file`, `timeseries`, `pattern`, `http`.',
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
