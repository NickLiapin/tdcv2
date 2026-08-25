/**
 * Centralised lists of "known" names the validator compares against.
 *
 * These are the single source of truth the validator uses for typo
 * suggestions. Keep them in sync with the actual implementation:
 *   - Gen types — src/sequence/build.ts buildGenValues switch
 *   - Template paths — src/templates/resolver.ts REGISTRY + date.ts
 *   - Operators — src/expr/evaluate.ts applyBinary / applyUnary switches
 *   - Builtin sequences — src/sequence/build.ts buildSequences
 *   - Fixture tags — src/processor/render.ts extractEnvConfig
 */

export const KNOWN_GEN_TYPES: readonly string[] = [
  'text',
  'file',
  'template',
  'number',
  'regex',
  'advanced_regex',
  'symbol',
  'date',
  'increment',
  'decrement',
  'timeseries',
  'pattern',
  'http',
  'pool',
  'running',
  'stat',
  'formula',
] as const;

/**
 * Template paths baked into the registry. `person.b_day` and `date.range`
 * are registered dynamically by generators/date.ts at module-load time;
 * listing them here keeps the validator's view of "known paths" complete
 * without having to run the registry's side effects.
 */
export const KNOWN_TEMPLATE_PATHS: readonly string[] = [
  'person.male.firstName',
  'person.female.firstName',
  'person.lastName',
  'person.male.diagnosis',
  'person.female.diagnosis',
  'person.gender',
  'person.b_day',
  'location.country',
  'date.range',
] as const;

/** Template paths that are builtin generators (not per-locale pack data). */
export const BUILTIN_TEMPLATE_PATHS: readonly string[] = ['person.b_day', 'date.range'];

/**
 * A template `value` that interpolates a field — `value="common.vehicle.model.${{Brand}}"`.
 * The concrete address is only known per row at render time (it depends on the
 * parent value drawn), so it can't be checked against the static pack list.
 */
export function isDynamicTemplateValue(value: string): boolean {
  return value.includes('${{');
}

/**
 * A `type="template"` value is "known" if it is a builtin generator, a hard
 * pack address (exact), or a soft shape — some `<locale>.<path>` exists in the
 * loaded packs (the concrete locale is resolved against the env at render time).
 */
export function templatePathKnown(path: string, packAddresses: readonly string[]): boolean {
  if (BUILTIN_TEMPLATE_PATHS.includes(path)) return true;
  // Canonical shapes the bundled packs always ship (valid even when the
  // caller has not loaded packs, e.g. isolated validator unit tests).
  if (KNOWN_TEMPLATE_PATHS.includes(path)) return true;
  if (packAddresses.includes(path)) return true; // hard, exact
  return packAddresses.some((a) => {
    // soft shape: some `<locale>.<path>` was loaded.
    const dot = a.indexOf('.');
    return dot > 0 && a.slice(dot + 1) === path;
  });
}

/**
 * The locales that ship a soft template path, e.g. `person.lastName` → `en`,
 * `ru`, … Empty when the path is a builtin, an absolute address, or nowhere.
 *
 * A path is validated against the locale the run will actually use, not
 * against "some locale has it": `check` used to pass a config the run then
 * refused with "unknown template path", which is the one thing a validator
 * exists to prevent.
 */
export function localesHavingPath(
  path: string,
  packAddresses: readonly string[],
): readonly string[] {
  const out: string[] = [];
  for (const address of packAddresses) {
    const dot = address.indexOf('.');
    if (dot > 0 && address.slice(dot + 1) === path) out.push(address.slice(0, dot));
  }
  return [...new Set(out)].sort();
}

/**
 * Every path a config may legally write, given the packs that were loaded: the
 * addresses themselves (`usa.geo.city`) and their locale-free shapes
 * (`geo.city`, which resolves against the env locale at render time).
 *
 * TDC071's hint used to list the nine canonical shapes and call them "known
 * paths", which is what a reader who wrote `usa.geo.province` sees — while
 * `usa.geo.city`, absent from that list, works. The list was not a list of
 * known paths at all; it was a list of paths every locale happens to ship.
 */
export function candidateTemplatePaths(packAddresses: readonly string[]): readonly string[] {
  const out = new Set<string>(KNOWN_TEMPLATE_PATHS);
  for (const address of packAddresses) {
    out.add(address);
    const dot = address.indexOf('.');
    if (dot > 0) out.add(address.slice(dot + 1));
  }
  return [...out];
}

/**
 * The paths that sit beside `path` under the same namespace — what the author
 * most likely meant when they invented a leaf name their country does not use.
 * `usa.geo.province` → `usa.geo.city`, `usa.geo.county`, `usa.geo.state`, …
 */
export function siblingTemplatePaths(
  path: string,
  packAddresses: readonly string[],
): readonly string[] {
  const dot = path.lastIndexOf('.');
  if (dot <= 0) return [];
  const namespace = path.slice(0, dot + 1);
  const out = candidateTemplatePaths(packAddresses).filter(
    (candidate) => candidate !== path && candidate.startsWith(namespace),
  );
  return [...out].sort();
}

export const SUPPORTED_BINARY_OPERATORS: readonly string[] = [
  '==',
  '!=',
  '===',
  '!==',
  '<',
  '>',
  '<=',
  '>=',
  '&&',
  '||',
  '+',
  '-',
  '*',
  '/',
  // Euclidean, matching <mod> — see expr/evaluate.ts. `-3 % 2` is 1 here and
  // −1 in JavaScript, Java, C# and Rust; the engine answers one way in both of
  // its layers rather than borrowing whatever the host language does.
  '%',
  // Set membership: `Country in [US, CA, MX]`. Spelling that out as three
  // comparisons says the column name three times and grows a term per value.
  'in',
] as const;

export const SUPPORTED_UNARY_OPERATORS: readonly string[] = ['!', '-', '+'] as const;

/**
 * The functions an `if=` expression may call, and how many arguments each takes.
 *
 * `max` is the top of an INCLUSIVE range and `undefined` means variadic. The
 * implementations live in `expr/evaluate.ts`; a unit test pins that the two
 * lists name exactly the same functions, because a name that validates and does
 * not evaluate is the worst of both.
 *
 * Everything here is EXACT — it is built from arithmetic the IEEE-754 standard
 * pins down, so five implementations cannot disagree about it. Transcendental
 * functions (sin, cos, exp, log …) are deliberately absent: measured on one
 * machine, `tan(1)` already differs in its last bit between Node and Python,
 * and a comparison turns that bit into a different row. They arrive when TDC
 * ships its own implementations, the way it ships its own PRNG.
 */
export const EXPR_FUNCTIONS: Readonly<Record<string, { min: number; max: number | undefined }>> = {
  abs: { min: 1, max: 1 },
  acos: { min: 1, max: 1 },
  acosh: { min: 1, max: 1 },
  asin: { min: 1, max: 1 },
  asinh: { min: 1, max: 1 },
  atan: { min: 1, max: 1 },
  atan2: { min: 2, max: 2 },
  at: { min: 2, max: 2 },
  atanh: { min: 1, max: 1 },
  beta: { min: 2, max: 2 },
  cbrt: { min: 1, max: 1 },
  ceil: { min: 1, max: 1 },
  clamp: { min: 3, max: 3 },
  contains: { min: 2, max: 2 },
  count: { min: 1, max: 1 },
  cos: { min: 1, max: 1 },
  degrees: { min: 1, max: 1 },
  digamma: { min: 1, max: 1 },
  cosh: { min: 1, max: 1 },
  ends_with: { min: 2, max: 2 },
  erf: { min: 1, max: 1 },
  erfc: { min: 1, max: 1 },
  exp: { min: 1, max: 1 },
  expm1: { min: 1, max: 1 },
  floor: { min: 1, max: 1 },
  gamma: { min: 1, max: 1 },
  gauss: { min: 3, max: 3 },
  hash: { min: 2, max: 2 },
  noise: { min: 3, max: 3 },
  prev: { min: 2, max: 2 },
  hypot: { min: 2, max: 2 },
  is_empty: { min: 1, max: 1 },
  join: { min: 2, max: 2 },
  len: { min: 1, max: 1 },
  lerp: { min: 3, max: 3 },
  lgamma: { min: 1, max: 1 },
  log: { min: 1, max: 1 },
  log10: { min: 1, max: 1 },
  log1p: { min: 1, max: 1 },
  log2: { min: 1, max: 1 },
  lower: { min: 1, max: 1 },
  max: { min: 1, max: undefined },
  mean: { min: 1, max: 1 },
  median: { min: 1, max: 1 },
  min: { min: 1, max: undefined },
  pow: { min: 2, max: 2 },
  radians: { min: 1, max: 1 },
  round: { min: 1, max: 1 },
  sign: { min: 1, max: 1 },
  sin: { min: 1, max: 1 },
  sinh: { min: 1, max: 1 },
  split: { min: 2, max: 2 },
  sqrt: { min: 1, max: 1 },
  starts_with: { min: 2, max: 2 },
  stddev: { min: 1, max: 1 },
  sum: { min: 1, max: 1 },
  tan: { min: 1, max: 1 },
  tanh: { min: 1, max: 1 },
  trunc: { min: 1, max: 1 },
  upper: { min: 1, max: 1 },
  zeta: { min: 1, max: 1 },
};

export const EXPR_FUNCTION_NAMES: readonly string[] = Object.keys(EXPR_FUNCTIONS).sort();

/**
 * Names that are not available and are not typos either.
 *
 * Someone who writes `besselj(_count)` knows exactly what they meant, and
 * telling them "did you mean beta?" is worse than saying nothing — edit
 * distance has no idea these name entirely different functions. They are
 * answered with the real reason instead.
 *
 * What is left here is the mathematics a data generator has no business
 * carrying: each of these is a project rather than a function, and none has
 * ever plausibly belonged in a row predicate. They stay so that a person who
 * reaches for one gets an answer rather than "unknown function".
 */
export const PLANNED_EXPR_FUNCTIONS: readonly string[] = [
  'airy',
  'besselj',
  'bessely',
  'elliptic_e',
  'elliptic_k',
  'polygamma',
] as const;

export const BUILTIN_SEQUENCES: readonly string[] = [
  '_count',
  '_first',
  '_last',
  '_total',
] as const;

/**
 * Tag names valid as direct children of `<env>`.
 *
 * `switch`, `uniq` and `distinct` are handled by their own branches before the
 * fallback that consults this list, so leaving them out never produced a false
 * error — it produced a WRONG error: a typo like `<swich>` printed an
 * "Allowed:" list missing three legal tags, and the suggestion machinery,
 * comparing against the same list, stayed silent on the obvious fix.
 */
export const KNOWN_ENV_CHILDREN: readonly string[] = [
  'sequence',
  'mix',
  'switch',
  'pool',
  'uniq',
  'distinct',
  'assert',
  'before',
  'after',
  'before_block',
  'after_block',
  'delimiter_block',
  'before_line',
  'after_line',
  'delimiter_line',
] as const;

/** Tag names valid as direct children of `<tdc>`. */
export const KNOWN_TDC_CHILDREN: readonly string[] = ['env', 'block'] as const;

/** Tag names valid as direct children of `<mix>`. */
export const KNOWN_MIX_CHILDREN: readonly string[] = ['case'] as const;

/** Tag names valid as direct children of `<switch>`. */
export const KNOWN_SWITCH_CHILDREN: readonly string[] = ['map', 'case', 'default'] as const;

/** Tag names valid as direct children of `<case>`. */
export const KNOWN_CASE_CHILDREN: readonly string[] = ['data', 'gen', 'mix', 'switch'] as const;

/**
 * Tag names valid as direct children of `<sequence>`.
 *
 * The last container to get a list, and the reason is worth recording: an
 * invented tag here was accepted in silence — `check` said `is valid`, exit 0,
 * the run went ahead — while the identical mistake one level up, inside
 * `<env>`, got TDC010 with the allowed names spelled out. A model reading the
 * second fixes it on the first try; reading nothing, it concludes the tag
 * exists and carries it from attempt to attempt.
 *
 * The list is short because a sequence body is: the generator(s), literal text
 * between them, a `<distinct>` wrapper grouping fields, or a `<compute>` that
 * derives the column from others.
 */
export const KNOWN_SEQUENCE_CHILDREN: readonly string[] = [
  'gen',
  'data',
  'distinct',
  'compute',
] as const;

/** Tag names valid as direct children of `<block>`. */
export const KNOWN_BLOCK_CHILDREN: readonly string[] = ['line', 'data'] as const;

/**
 * `<distinct>` and `<uniq>` mean two different things depending on where they
 * sit, and so hold two different sets of children.
 *
 * Inside a `<sequence>` they group the FIELDS of one record — `<gen>`s. At
 * `<env>` level they group whole COLUMNS, so their members are declarations:
 * sequences, mixes and switches. One list for both refused half the working
 * configs in the suite, which is how this comment came to be written.
 *
 * A `<member name="…"/>` used to be listed here too. Nothing ever read it: the
 * name let it past the unknown-child check, the group then wrapped no
 * sequences, and the author got TDC221 — a warning about a symptom, for a tag
 * that does nothing. It was never designed, documented or used by a fixture, so
 * it is gone rather than implemented.
 */
export const KNOWN_DISTINCT_CHILDREN: readonly string[] = ['gen'] as const;

/** Members of an `<env>`-level `<distinct>` / `<uniq>` group. */
export const KNOWN_ENV_GROUP_CHILDREN: readonly string[] = ['sequence', 'mix', 'switch'] as const;

/**
 * Tag names valid as direct children of `<pool>`.
 *
 * Deliberately generous. A pool is a miniature `<env>`, and the risk here is
 * lopsided: too SHORT a list refuses configs that work today, while too long a
 * one merely leaves a little of the old silence in place. Anything on this list
 * that a pool cannot really hold already has a diagnostic of its own.
 */
export const KNOWN_POOL_CHILDREN: readonly string[] = [
  'sequence',
  'mix',
  'switch',
  'uniq',
  'distinct',
  // A `<data>` inside a `<pool>` is accepted — by this implementation and by all four ports —
  // and was named by no list here, so the refusal for a WRONG child of a pool printed a set of
  // allowed names that left out one of them. The ports carried it and this list did not.
  'data',
] as const;

/** Tag names valid inside a fixture (`<before>`, `<after>`, the delimiters…). */
/**
 * A fixture body is made of `<line>`s and nothing else.
 *
 * `data` used to be on this list, and the renderer only ever walked `<line>` —
 * so `<before><data>x</data></before>` validated and emitted nothing at all.
 * The list is what the "Allowed inside" note prints, so it has to say what the
 * renderer actually does.
 */
export const KNOWN_FIXTURE_CHILDREN: readonly string[] = ['line'] as const;

/** Tag names valid inside the open/close form of `<gen>`. */
export const KNOWN_GEN_CHILDREN: readonly string[] = ['data'] as const;

/**
 * What each container allows, for the "Allowed: …" note.
 *
 * TDC010 printed this list and TDC013 did not — it said "Move <row> to a valid
 * location", which does not say where. The list is the part a reader acts on,
 * so both codes carry it now.
 */
export const ALLOWED_CHILDREN: Readonly<Record<string, readonly string[]>> = {
  tdc: KNOWN_TDC_CHILDREN,
  env: KNOWN_ENV_CHILDREN,
  sequence: KNOWN_SEQUENCE_CHILDREN,
  mix: KNOWN_MIX_CHILDREN,
  switch: KNOWN_SWITCH_CHILDREN,
  case: KNOWN_CASE_CHILDREN,
  block: KNOWN_BLOCK_CHILDREN,
  distinct: KNOWN_DISTINCT_CHILDREN,
  uniq: KNOWN_DISTINCT_CHILDREN,
  pool: KNOWN_POOL_CHILDREN,
  gen: KNOWN_GEN_CHILDREN,
  line: ['data', 'gen', 'mix', 'switch'],
  before: KNOWN_FIXTURE_CHILDREN,
  after: KNOWN_FIXTURE_CHILDREN,
  before_block: KNOWN_FIXTURE_CHILDREN,
  after_block: KNOWN_FIXTURE_CHILDREN,
  delimiter_block: KNOWN_FIXTURE_CHILDREN,
  before_line: KNOWN_FIXTURE_CHILDREN,
  after_line: KNOWN_FIXTURE_CHILDREN,
  delimiter_line: KNOWN_FIXTURE_CHILDREN,
};
