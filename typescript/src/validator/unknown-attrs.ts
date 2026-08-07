/**
 * An attribute the engine does not read is a silent no-op. Say so.
 *
 * This is the same defect `pack-params.ts` already reports for pack parameters,
 * left unreported everywhere else. `<sequence name="Ticket" if="…">` looks like
 * it guards the sequence; `<sequence>` accepts name, parent and uniq, so the
 * `if` does nothing and the engine says nothing — a page of the documentation
 * taught that spelling for as long as it existed, and the output it promised
 * was unreachable.
 *
 * The damage is worse when the name is a near miss, because the run succeeds
 * and the data looks right:
 *
 *     <gen type="text" value="ok,fail" persent="90,10">   ->  50 / 50
 *     <gen type="text" value="ok,fail" percent="90,10">   ->  90 / 10
 *
 * One letter, no warning, plausible output. For a test-data generator that is
 * the worst failure mode there is — not a crash, but quietly wrong data that
 * looks correct.
 *
 * SCOPE. Only tags whose attribute set is CLOSED and small are checked here:
 * `<env>`, `<sequence>`, `<line>`, `<tdc>`, `<mix>`, `<switch>`, `<case>`,
 * `<map>`, `<default>`. `<gen>` is deliberately excluded — its attributes vary
 * by `type=`, and a `type="template"` generator additionally accepts whatever
 * parameters its pack declares, which is exactly what `pack-params.ts` handles
 * with the registry in hand. Guessing here would produce the false errors that
 * check was careful to avoid.
 *
 * SEVERITY. An error, and the run stops. There is no backward compatibility to
 * protect — the library has not shipped — and the whole point is that the
 * config asked for something it did not get. Letting generation continue would
 * hand back the wrong data with a note attached, which is the failure being
 * fixed, not a softer version of it. A misspelled attribute is a bug in the
 * config; the run should not proceed on a guess about what was meant.
 *
 * Each list is deliberately generous: a name missing from one of these sets
 * becomes a false warning on a working config, which is worse than the silent
 * no-op being fixed.
 */

import {
  type Diagnostic,
  attrValueRange,
  closestMatch,
  formatCandidates,
} from '../errors/index.js';
import type { AttrContext, ElementContext } from '../generated/TDCParser.js';
import {
  asDataSelfClosed,
  asDataWithBody,
  contentElements,
  elementKind,
  elementName,
} from '../processor/walk.js';

/**
 * What each closed tag actually reads, taken from the engine rather than from
 * the LSP completion map — that map exists for autocomplete, is missing `mode`,
 * `engine` and every compute tag, and would have produced hundreds of false
 * warnings if trusted here.
 *
 * `comment` is accepted everywhere: it is documented as a note that never
 * renders, and refusing it on a tag that happens not to list it would be a
 * pointless trap.
 */
export const CLOSED_TAG_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // `count`, `seed`, `local`, `inject` from extractEnvConfig; `mode`/`engine`
  // are read later, by the engine chooser.
  ['env', new Set(['count', 'seed', 'local', 'inject', 'mode', 'engine', 'comment'])],
  ['sequence', new Set(['name', 'parent', 'uniq', 'comment'])],
  ['line', new Set(['if', 'each', 'comment'])],
  ['tdc', new Set(['version', 'v', 'regex_max_length', 'comment'])],
  ['mix', new Set(['name', 'percent', 'parent', 'flag', 'comment'])],
  // `percent` is NOT here: a <switch> picks its case from `on=`, and <case>
  // requires `is=` (TDC137). The percentage short-form belongs to <mix>.
  ['switch', new Set(['name', 'on', 'comment'])],
  ['case', new Set(['is', 'if', 'anomaly', 'default', 'comment'])],
  ['map', new Set(['comment'])],
  ['default', new Set(['comment'])],
  // `<data>` takes `name`/`type` for typed output as well as `if`/`pair`.
  ['data', new Set(['if', 'pair', 'name', 'type', 'comment'])],
  ['pool', new Set(['name', 'count', 'comment'])],
  // A group wrapper says what must hold BETWEEN the sequences inside it; it has
  // no settings of its own. `uniq="true"` is an attribute of <sequence>, not of
  // <uniq> — writing it on the wrapper is a common slip and now says so.
  ['uniq', new Set(['comment'])],
  ['distinct', new Set(['comment'])],
]);

/**
 * What `<gen>` accepts, as ONE generous union rather than a set per `type=`.
 *
 * Splitting by type would catch more — `format=` on a number generator does
 * nothing — but it would also mean a per-type list that is wrong somewhere,
 * and a false warning on a working config is the outcome this whole check must
 * never produce. The union still catches the case that matters, a misspelling:
 * `persent` is in nobody's list.
 *
 * Three groups make it up: the wrappers the engine applies to any generator,
 * the attributes some generator type reads, and the parameters of the named
 * distributions. Measured against every config in the tests, the docs and the
 * data packs before being switched on: zero would-be warnings.
 */
export const GEN_ATTRIBUTES: ReadonlySet<string> = new Set([
  // engine-level wrappers, applied whatever the type
  'name',
  'type',
  'value',
  'if',
  'comment',
  'case',
  'mask',
  'order',
  'cycle',
  'repeat',
  'separator',
  'accumulate',
  'of',
  'reset',
  'op',
  'plus',
  'missing',
  'missing_as',
  'anomaly',
  'anomaly_factor',
  'anomaly_flag',
  'local',
  'weight',
  // read by one generator type or another
  'filter',
  'percent',
  'first_zero',
  'include',
  'exclude',
  'length',
  'decimals',
  'distribution',
  'regex_max_length',
  'alphabet',
  'format',
  'from',
  'to',
  'oldest',
  'youngest',
  'precision',
  'range',
  'step',
  'weekdays',
  'src',
  'column',
  'header',
  'delimiter',
  'row',
  'base',
  'trend',
  'period',
  'amplitude',
  'peak_at',
  'noise',
  'points',
  'upper',
  'lower',
  'y_range',
  'interp',
  'spread',
  'ink_threshold',
  'mode',
  'in',
  'on_error',
  'timeout',
  // parameters of the named distributions
  'mean',
  'sd',
  'meanlog',
  'sdlog',
  'rate',
  'alpha',
  'xmin',
  'shape',
  'scale',
  'min',
  'max',
  'lambda',
  'beta',
  's',
  'n',
]);

/**
 * Attributes that belong to one FAMILY of generators, and to which.
 *
 * The union above catches a misspelling; it cannot catch a real attribute on
 * the wrong generator, which is the likelier mistake and just as silent:
 *
 *     <gen type="number" value="1..100"/>          ->  65 32 24 44
 *     <gen type="number" min="10" max="20"/>       ->  6 3 2 4
 *     <gen type="number" range="1..100"/>          ->  6 3 2 4
 *
 * `min`/`max` are real (distribution parameters) and `range` is real (dates),
 * so nothing complained and the column quietly became single digits.
 *
 * Only attributes with an UNAMBIGUOUS owner are listed. An exhaustive
 * per-type allowlist would catch more and would also be wrong somewhere, and
 * a false error on a working config is the one outcome this check must never
 * produce. Anything absent from this map keeps the old, permissive treatment.
 *
 * Measured rather than read off the switch: each pair was probed by rendering
 * with and without the attribute and comparing the output, so "owner" means
 * the engine demonstrably behaves differently, not that a `case` label
 * mentions it.
 */
export const ATTRIBUTE_OWNERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // A list to walk. A range-based generator draws instead of stepping.
  // `date` joined these when a range became walkable: the same word, the same
  // looping, the same `cycle="false"` refusal — see `dateAxis`.
  ['order', new Set(['text', 'file', 'date'])],
  ['cycle', new Set(['text', 'file', 'date'])],
  // `step` predates this: on a counter it is how much each row ADDS. A walked
  // date range means the same thing in its own units, which is why it borrows
  // the word rather than inventing one — but the counter must keep it.
  ['step', new Set(['date', 'increment', 'decrement'])],
  ['weekdays', new Set(['date'])],
  // Where the characters come from.
  ['alphabet', new Set(['symbol'])],
  // The external source and how to read it. `pattern` is in the list because a
  // drawn curve is loaded the same way — `src="curve.svg"`, `src="curve.png"`.
  // Measuring said otherwise only because the probe file did not exist and the
  // load threw; the corpus sweep caught the false error before it shipped.
  ['of', new Set(['running', 'stat', 'date'])],
  ['reset', new Set(['running'])],
  ['op', new Set(['stat'])],
  // How far a date sits from the one `of=` names.
  ['plus', new Set(['date'])],
  ['src', new Set(['file', 'http', 'pattern'])],
  ['column', new Set(['file'])],
  ['header', new Set(['file'])],
  ['delimiter', new Set(['file'])],
  ['row', new Set(['file'])],
  // Which members of a pool this row may draw from. Only `pool` takes it:
  // everywhere else there are no candidates to narrow, and the row-level
  // question ("should this cell be produced at all?") is `if=`.
  ['filter', new Set(['pool'])],
  // The network generator's own knobs.
  ['in', new Set(['http'])],
  ['on_error', new Set(['http'])],
  ['timeout', new Set(['http'])],
  // The drawn curve.
  ['points', new Set(['pattern'])],
  ['upper', new Set(['pattern'])],
  ['lower', new Set(['pattern'])],
  ['y_range', new Set(['pattern'])],
  ['interp', new Set(['pattern'])],
  ['spread', new Set(['pattern'])],
  ['ink_threshold', new Set(['pattern'])],
  // The synthetic series.
  ['base', new Set(['timeseries', 'running'])],
  ['trend', new Set(['timeseries'])],
  ['period', new Set(['timeseries'])],
  ['amplitude', new Set(['timeseries'])],
  ['peak_at', new Set(['timeseries'])],
  ['noise', new Set(['timeseries'])],
  // Zero-padding a numeric range.
  ['first_zero', new Set(['number'])],
  // The legacy two-date span, read by the date generator and by the
  // `date.range` builtin template. On a number it is the wrong word for
  // `value="10..99"` — and silently gave single digits.
  ['range', new Set(['date', 'template'])],
]);

/**
 * Parameters of the named distributions. They shape the DRAW, so they mean
 * nothing unless `distribution=` asked for one — `min="10" max="20"` on a
 * plain number is the trap this catches. Gated on the attribute rather than
 * on the type, because that is how the engine reads them.
 */
const DISTRIBUTION_PARAMS: ReadonlySet<string> = new Set([
  'mean',
  'sd',
  'meanlog',
  'sdlog',
  'rate',
  'alpha',
  'xmin',
  'shape',
  'scale',
  'min',
  'max',
  'lambda',
  'beta',
  's',
  'n',
]);

/**
 * Builtin template paths and the parameters each one reads.
 *
 * `type="template"` as a whole stays out of the union check — a pack declares
 * its own parameters and `pack-params.ts` judges those with the registry in
 * hand. But these two paths are not backed by any pack, so until now nothing
 * checked them at all:
 *
 *     <gen type="template" value="person.b_day" oldest="30" youngest="20"/>  ->  ages 20–30
 *     <gen type="template" value="person.b_day" oldst="30"  youngest="20"/>  ->  ages 20–80
 *
 * One letter, no message, plausible dates — the same failure `persent` used
 * to be. Their parameter sets are small and closed, so checking them carries
 * no risk of a false error.
 */
const BUILTIN_TEMPLATE_PARAMS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['person.b_day', new Set(['oldest', 'youngest', 'format', 'precision'])],
  ['date.range', new Set(['range', 'format', 'precision'])],
]);

/**
 * Attributes that exist in the language but on a DIFFERENT tag.
 *
 * Both of these were on their tag's accepted list and read by nobody, which is
 * the worst of the three possible states: refused is honest, read is useful,
 * accepted-and-ignored looks like it works. `parent=` on a `<gen>` filtered
 * nothing while the config claimed it did; `percent=` on a `<switch>` sat there
 * while the switch went on picking by `on=`.
 *
 * They get their own hint because the generic one — a spelling suggestion drawn
 * from the accepted list — sends the reader looking for a typo in a word that is
 * spelled correctly.
 */
const MISPLACED: ReadonlyMap<string, string> = new Map([
  [
    'gen:parent',
    'parent= selects which rows a whole <sequence> or <mix> builds on; ' +
      'move it there. A <gen> inside one is already filtered by it.',
  ],
  [
    // Not a misplacement but the same failure: a word readers reach for that the
    // language spells differently. The nearest accepted string to `phase` is
    // `case`, which sends someone shifting a seasonal wave to look at branching.
    'gen:phase',
    'A seasonal wave is shifted with peak_at=, which names the ROW the wave ' +
      'peaks on rather than an angle: peak_at="182" over period="365" puts the ' +
      'peak at the first of July.',
  ],
  [
    // `count` belongs to <env> (rows in the run) and to <pool> (members in the
    // table). On a <gen> nothing reads it, and it looks exactly like a way to
    // ask for several values — which is `repeat=`.
    'gen:count',
    'count= is the size of the run on <env> and the size of the table on ' +
      '<pool>. For several values in ONE row use repeat=.',
  ],
  [
    // `flag` names the ground-truth column of a <mix>. The nearest thing on a
    // <gen> is anomaly_flag=, and someone reaching for `flag` there wants it.
    'gen:flag',
    'flag= names the branch-recording column of a <mix>. The <gen> equivalent ' +
      'is anomaly_flag=, which records which rows were made outliers.',
  ],
  [
    'switch:percent',
    'percent= splits rows between the branches of a <mix>. A <switch> chooses ' +
      'its case from the value of on=, so there is nothing here to split.',
  ],
]);

/** Report `name` as an attribute this `<gen>` will not read. */
function reportIgnored(
  attr: AttrContext,
  name: string,
  why: string,
  candidates: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const misplaced = MISPLACED.get(`gen:${name}`);
  const suggestion = misplaced ? undefined : closestMatch(name, candidates);
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message: `<gen> does not read "${name}" — it is ignored`,
    ...(suggestion && suggestion !== name ? { suggestion: `did you mean "${suggestion}"?` } : {}),
    hint: misplaced ?? why,
    code: 'TDC015',
  });
}

/**
 * A `type="template"` generator is not put through the union: it accepts
 * whatever parameters its pack declares, and `pack-params.ts` judges those
 * with the registry in hand. Guessing without it is how false errors get
 * invented. The two BUILTIN paths have no pack behind them, so they are
 * checked here against their own closed sets.
 */
export function checkGenAttrs(attrs: readonly AttrContext[], diagnostics: Diagnostic[]): void {
  let type: string | undefined;
  let value: string | undefined;
  let hasDistribution = false;
  let order: string | undefined;
  for (const a of attrs) {
    const n = a._attrName?.text;
    if (n === 'type') type = attrValueText(a);
    else if (n === 'value') value = attrValueText(a);
    else if (n === 'distribution' && attrValueText(a).trim() !== '') hasDistribution = true;
    else if (n === 'order') order = attrValueText(a).trim();
  }

  if (type === 'template') {
    checkBuiltinTemplateAttrs(attrs, value, diagnostics);
    // A pack's parameters are open-ended, so the "is this a known name" half
    // cannot run here — but the two halves that do not depend on the pack still
    // can, and they were the reason `order=` and `parent=` sat on a template
    // generator doing nothing while `check` said the document was valid.
    checkOwnershipOnly(attrs, 'template', diagnostics);
    return;
  }

  for (const attr of attrs) {
    const name = attr._attrName?.text;
    if (name === undefined) continue;

    if (!GEN_ATTRIBUTES.has(name)) {
      reportIgnored(
        attr,
        name,
        'Check the spelling, or see the attributes reference for what a generator takes.',
        [...GEN_ATTRIBUTES],
        diagnostics,
      );
      continue;
    }

    // A distribution parameter with no distribution asked for shapes nothing.
    if (DISTRIBUTION_PARAMS.has(name) && !hasDistribution) {
      reportIgnored(
        attr,
        name,
        `"${name}" is a parameter of a named distribution — add distribution="…" for it to mean anything. ` +
          'To bound a plain number, put the range in value="10..20".',
        [...GEN_ATTRIBUTES],
        diagnostics,
      );
      continue;
    }

    // `cycle` says what happens when a WALK runs out. Without a walk there is
    // nothing to run out of: the generator draws, and a draw never ends.
    if (name === 'cycle' && order !== 'sequential') {
      reportIgnored(
        attr,
        name,
        'cycle= says what happens when order="sequential" reaches the end of its source. ' +
          'Without order="sequential" the generator draws, and a draw never runs out.',
        [...GEN_ATTRIBUTES],
        diagnostics,
      );
      continue;
    }

    const owners = ATTRIBUTE_OWNERS.get(name);
    if (owners !== undefined && type !== undefined && !owners.has(type)) {
      reportIgnored(
        attr,
        name,
        `"${name}" belongs to ${formatCandidates([...owners].sort().map((t) => `type="${t}"`))} — ` +
          `a type="${type}" generator ignores it.`,
        [...GEN_ATTRIBUTES],
        diagnostics,
      );
    }
  }
}

/**
 * The type-ownership half of the gen check, for a generator whose OTHER
 * attributes cannot be validated against a closed list.
 *
 * `type="template"` takes whatever parameters its pack declares, so an unknown
 * name there is not a mistake. Which type reads `order=` is a different
 * question, and it has an answer regardless of the pack.
 */
function checkOwnershipOnly(
  attrs: readonly AttrContext[],
  type: string,
  diagnostics: Diagnostic[],
): void {
  for (const attr of attrs) {
    const name = attr._attrName?.text;
    if (name === undefined) continue;
    if (MISPLACED.has(`gen:${name}`)) {
      reportIgnored(attr, name, '', [...GEN_ATTRIBUTES], diagnostics);
      continue;
    }
    const owners = ATTRIBUTE_OWNERS.get(name);
    if (owners !== undefined && !owners.has(type)) {
      reportIgnored(
        attr,
        name,
        `"${name}" belongs to ${formatCandidates([...owners].sort().map((t) => `type="${t}"`))} — ` +
          `a type="${type}" generator ignores it.`,
        [...GEN_ATTRIBUTES],
        diagnostics,
      );
    }
  }
}

/** Check the two pack-less template paths against their own parameter sets. */
function checkBuiltinTemplateAttrs(
  attrs: readonly AttrContext[],
  value: string | undefined,
  diagnostics: Diagnostic[],
): void {
  if (value === undefined) return; // no value= at all: TDC070 reports that
  const params = BUILTIN_TEMPLATE_PARAMS.get(value);
  if (params === undefined) return; // a pack address: pack-params.ts judges it
  const allowed = new Set([...params, ...TEMPLATE_WRAPPERS]);
  for (const attr of attrs) {
    const name = attr._attrName?.text;
    if (name === undefined || allowed.has(name)) continue;
    reportIgnored(
      attr,
      name,
      `Parameters of "${value}": ${formatCandidates([...params].sort())}.`,
      [...allowed],
      diagnostics,
    );
  }
}

/**
 * What any `<gen>` takes regardless of what it generates — the wrappers the
 * engine applies around the produced value. Measured the same way: `case`,
 * `mask`, `missing` and `repeat` change the output of every type.
 */
const TEMPLATE_WRAPPERS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'value',
  'if',
  'comment',
  'case',
  'mask',
  'repeat',
  'separator',
  'accumulate',
  'missing',
  'missing_as',
  'anomaly',
  'anomaly_factor',
  'anomaly_flag',
  'flag',
  'local',
  'count',
]);

/** The literal text of an attribute value, without its quotes. */
function attrValueText(a: AttrContext): string {
  return (a._attrValue?.text ?? '').replace(/^"|"$/g, '');
}

/** Report every attribute on `tag` that the engine will not read. */
export function checkUnknownAttrs(
  tag: string,
  attrs: readonly AttrContext[],
  diagnostics: Diagnostic[],
): void {
  const known = CLOSED_TAG_ATTRIBUTES.get(tag);
  if (known === undefined) return; // open-ended tag: not ours to judge

  for (const attr of attrs) {
    const name = attr._attrName?.text;
    if (name === undefined || known.has(name)) continue;

    const misplaced = MISPLACED.get(`${tag}:${name}`);
    const suggestion = misplaced ? undefined : closestMatch(name, [...known]);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `<${tag}> does not read "${name}" — it is ignored`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint: misplaced ?? `Attributes of <${tag}>: ${formatCandidates([...known].sort())}.`,
      code: 'TDC015',
    });
  }
}

/**
 * Walk the whole document once and check every closed tag it contains.
 *
 * A single pass rather than a call at each site the validator already visits:
 * the existing walker has a dozen entry points, and a tag reached by a path
 * nobody thought to hook would keep its silence — which is the very failure
 * being fixed.
 */
export function checkAllUnknownAttrs(root: ElementContext[], diagnostics: Diagnostic[]): void {
  for (const el of root) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data') {
      // `<data>` is its own node type, in two spellings, and carries attributes
      // in both.
      const body = asDataWithBody(k.node);
      const self = asDataSelfClosed(k.node);
      const attrs = body ? body.attr() : self ? self.attr() : [];
      checkUnknownAttrs('data', attrs, diagnostics);
      continue;
    }
    const tag = elementName(k.node);
    if (tag === 'gen') checkGenAttrs(k.node.attr(), diagnostics);
    else checkUnknownAttrs(tag, k.node.attr(), diagnostics);
    if (k.kind === 'open') checkAllUnknownAttrs(contentElements(k.node.content()), diagnostics);
  }
}
