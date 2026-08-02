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
] as const;

export const SUPPORTED_UNARY_OPERATORS: readonly string[] = ['!', '-', '+'] as const;

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
export const KNOWN_CASE_CHILDREN: readonly string[] = ['data', 'gen', 'mix'] as const;
