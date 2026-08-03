/**
 * Structural checks for `<pool>` — the small table computed before the rows.
 *
 * A pool is a miniature `<env>`, so everything INSIDE it (a sequence with no
 * `<gen>`, a mix whose percentages don't add up, a group of one) is checked by
 * the ordinary env machinery, called on the pool node. Only three things are
 * specific to the tag itself, and they are here:
 *
 *   - it must have a name, because a reference names it (TDC222);
 *   - it must have a member count, and the count must mean something (TDC223);
 *   - some tags cannot live inside it (TDC230).
 *
 * The last one deserves its reason written down. `<block>` and the fixtures
 * describe a FILE — where records start, what goes between them. A pool has no
 * file; it is a table read by other columns. And a `<pool>` inside a `<pool>`
 * is refused rather than supported because the honest way to express "doctors
 * belong to clinics" is a reference from one pool to another, which keeps every
 * pool a flat table you can print. Nesting would make a pool a tree and every
 * later feature — uniqueness, filtering, the memory ceiling — would have to ask
 * "at which depth?".
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';

import { nodeRange } from '../errors/source-map.js';
import { closestMatch } from '../errors/suggestions.js';

/**
 * The field names each pool declares, collected before the members are walked.
 *
 * A pre-pass rather than a running tally, so a reference is understood wherever
 * it stands. The engine does need a pool declared above its references (it is
 * computed first), but a validator that only reported "unknown field" for a
 * pool written at the bottom of the file would be reporting the wrong problem.
 */
export function collectPoolFields(env: OpenCloseElementContext | undefined): Map<string, string[]> {
  const byPool = new Map<string, string[]>();
  if (!env) return byPool;
  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open' || elementName(k.node) !== 'pool') continue;
    const poolName = extractAttrs(k.node.attr())['name'];
    if (!poolName) continue;
    const fields: string[] = [];
    for (const member of contentElements(k.node.content())) {
      const mk = elementKind(member);
      if (mk?.kind !== 'open') continue;
      const tag = elementName(mk.node);
      if (tag === 'sequence' || tag === 'mix' || tag === 'switch') {
        addMemberFields(fields, mk.node, byPool);
        continue;
      }
      // A member wrapped in a group is still a member.
      if (tag !== 'uniq' && tag !== 'distinct') continue;
      for (const inner of contentElements(mk.node.content())) {
        const ik = elementKind(inner);
        if (ik?.kind !== 'open') continue;
        addMemberFields(fields, ik.node, byPool);
      }
    }
    byPool.set(poolName, fields);
  }
  return byPool;
}

/**
 * What one member contributes to its pool's field list.
 *
 * Usually its own name. A member that is itself a reference to another pool
 * contributes that pool's fields under its name instead — `at` pointing at
 * `Clinics` gives `at.city`, `at.phone`, and no bare `at`, because a record has
 * no value to print. That mirrors exactly what the engine registers, so a
 * reader of `${{Seen.at.city}}` and the run agree.
 *
 * Only pools declared ABOVE are visible, which is what the engine can compute
 * and therefore what the reader is allowed to write.
 */
function addMemberFields(
  fields: string[],
  node: OpenCloseElementContext,
  byPool: Map<string, string[]>,
): void {
  const name = extractAttrs(node.attr())['name'];
  if (!name) return;
  const inner = memberPoolRef(node);
  const nested = inner === undefined ? undefined : byPool.get(inner);
  if (nested === undefined) {
    fields.push(name);
    return;
  }
  for (const field of nested) fields.push(`${name}.${field}`);
}

/**
 * The values each pool field can hold, where the config says them outright.
 *
 * A member whose body is one unnamed `<gen type="text" value="A,B">` produces
 * nothing but `A` and `B` — the list is literal, never a file or a pack — so the
 * set recorded here is a SUPERSET of what the built pool will actually contain
 * (a pool of two members drawn from three values holds at most two of them).
 * That direction is what TDC225 needs: a value outside the superset can match no
 * member, whatever the draw turns out to be.
 *
 * `case=`/`mask=` rewrite the value on the way out and `repeat=` makes it a
 * list, so any of the three and the values stop being knowable — the same rule
 * the top-level `finiteTextValues` follows, for the same reason.
 */
export function collectPoolFieldValues(
  env: OpenCloseElementContext | undefined,
): Map<string, Map<string, readonly string[]>> {
  const byPool = new Map<string, Map<string, readonly string[]>>();
  if (!env) return byPool;
  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open' || elementName(k.node) !== 'pool') continue;
    const poolName = extractAttrs(k.node.attr())['name'];
    if (!poolName) continue;
    const fields = new Map<string, readonly string[]>();
    for (const member of poolMemberNodes(k.node)) {
      const field = extractAttrs(member.attr())['name'];
      if (!field) continue;
      const values = literalTextValues(member);
      if (values) fields.set(field, values);
    }
    byPool.set(poolName, fields);
  }
  return byPool;
}

/** The literal `value=` list of a member whose body is a single plain text gen. */
function literalTextValues(member: OpenCloseElementContext): readonly string[] | undefined {
  const gens: Record<string, string | undefined>[] = [];
  for (const child of contentElements(member.content())) {
    const k = elementKind(child);
    if ((k?.kind === 'open' || k?.kind === 'self') && elementName(k.node) === 'gen') {
      gens.push(extractAttrs(k.node.attr()));
    }
  }
  const attrs = gens.length === 1 ? gens[0] : undefined;
  if (!attrs) return undefined;
  if (attrs['type'] !== 'text' || attrs['name'] !== undefined) return undefined;
  if (attrs['case'] !== undefined || attrs['mask'] !== undefined) return undefined;
  if (attrs['repeat'] !== undefined) return undefined;
  const raw = attrs['value'];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.split(',').map((v) => v.trim());
}

/**
 * Every pool named by a `<gen type="pool" value="…">`, anywhere under `<env>`.
 *
 * Collected in one descent rather than tallied during the walk because a
 * reference may stand above the pool it names, and TDC231 has to know about it
 * by the time that pool is reached.
 */
export function collectPoolReferences(env: OpenCloseElementContext | undefined): Set<string> {
  const named = new Set<string>();
  if (!env) return named;
  const descend = (node: OpenCloseElementContext): void => {
    for (const child of contentElements(node.content())) {
      const k = elementKind(child);
      if (k?.kind !== 'open' && k?.kind !== 'self') continue;
      if (elementName(k.node) === 'gen') {
        const attrs = extractAttrs(k.node.attr());
        if (attrs['type'] === 'pool') named.add((attrs['value'] ?? '').trim());
        continue;
      }
      if (k.kind === 'open') descend(k.node);
    }
  };
  descend(env);
  return named;
}

/**
 * A pool nobody draws from.
 *
 * A warning rather than an error, on the same reasoning as TDC234: the config
 * runs, and every row is exactly what it would have been. What it costs is the
 * build — a pool is computed in full before the first row and held in memory for
 * the whole run — so an unread `count="50000"` is paid for and thrown away. It is
 * also the shape a rename leaves behind, where the reference now points at a new
 * pool and the old one sits there looking deliberate.
 */
export function checkPoolIsRead(
  pool: OpenCloseElementContext,
  referenced: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): void {
  const name = extractAttrs(pool.attr())['name'];
  if (name === undefined || name.trim() === '' || referenced.has(name)) return;
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...nodeRange(pool),
    message: `pool "${name}" is never drawn from`,
    hint: `A pool is built in full before the first row and kept in memory for the whole run, so an unread one costs its members for nothing. Read it with <gen type="pool" value="${name}"/>, or remove it.`,
    code: 'TDC231',
  });
}

/**
 * A member that draws from another pool may only name a pool declared ABOVE.
 *
 * The engine builds pools in declaration order, so that is not a style rule: a
 * pool named below has no table yet when this one is computed, and a pool naming
 * itself never would. Both used to pass validation and produce a member with no
 * fields, which surfaced far away as "not a field of Seen" — a message that
 * blames the line doing the reading for a mistake made in the declaration.
 *
 * Declaration order is also the entire cycle check. There is nothing to detect:
 * a cycle cannot be written down.
 */
export function checkPoolMemberRefs(
  pool: OpenCloseElementContext,
  above: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const poolName = extractAttrs(pool.attr())['name'] ?? '';
  for (const member of poolMemberNodes(pool)) {
    const target = memberPoolRef(member);
    if (target === undefined || above.includes(target)) continue;
    const self = target === poolName;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(member),
      message: self
        ? `pool "${poolName}" draws from itself`
        : `pool "${poolName}" draws from "${target}", which is not declared above it`,
      hint:
        (self
          ? 'A pool is built before its own members exist, so there is nothing to draw. '
          : 'Pools are built in declaration order, so a pool can only read the pools above it. ' +
            `Move "${target}" above "${poolName}". `) +
        'That order is also why a cycle between pools cannot be written down.',
      code: 'TDC236',
    });
  }
}

/** Every declaration inside a pool, flattened out of any group wrapper. */
function poolMemberNodes(pool: OpenCloseElementContext): OpenCloseElementContext[] {
  const out: OpenCloseElementContext[] = [];
  for (const member of contentElements(pool.content())) {
    const mk = elementKind(member);
    if (mk?.kind !== 'open') continue;
    const tag = elementName(mk.node);
    if (tag === 'sequence' || tag === 'mix' || tag === 'switch') {
      out.push(mk.node);
      continue;
    }
    if (tag !== 'uniq' && tag !== 'distinct') continue;
    for (const inner of contentElements(mk.node.content())) {
      const ik = elementKind(inner);
      if (ik?.kind === 'open') out.push(ik.node);
    }
  }
  return out;
}

/** The pool a member draws from, when the member is a `<gen type="pool">`. */
function memberPoolRef(node: OpenCloseElementContext): string | undefined {
  for (const child of contentElements(node.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open' && k?.kind !== 'self') continue;
    if (elementName(k.node) !== 'gen') continue;
    const attrs = extractAttrs(k.node.attr());
    if (attrs['type'] !== 'pool') continue;
    return (attrs['value'] ?? '').trim();
  }
  return undefined;
}

/**
 * A name in `filter=` that means two things at once.
 *
 * The expression is evaluated in two scopes — a candidate member's fields and
 * the current row's columns — and a bare name resolves to the member's field
 * first. When a name exists in both, picking a winner silently would make the
 * config say something the author cannot see. It is refused instead, and the
 * fix is spelled out: qualify with the pool's name.
 *
 * Identifiers are pulled out with a regexp rather than the expression parser.
 * A diagnostic that over-reports a name appearing inside a string literal
 * would be wrong, but the parser cannot be reached from here without dragging
 * the evaluator into the validator, and the shape of the mistake — the same
 * word declared twice — is visible in the text either way.
 */
export function checkFilterAmbiguity(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  poolFields: readonly string[],
  declaredColumns: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const attrs = extractAttrs(gen.attr());
  const expr = attrs['filter'];
  if (expr === undefined || expr.trim() === '') return;
  const poolName = (attrs['value'] ?? '').trim();
  const columns = new Set(declaredColumns);
  const seen = new Set<string>();

  // A name written `Pool.field` says exactly what it means, so a field the pool
  // does not have is a certain mistake. An UNQUALIFIED unknown name is not:
  // the expression language has always read a bare word as a string literal,
  // which is how `filter="clinic == North"` says "northern only". Reporting
  // those would put an error on a working config, so they are left alone — a
  // genuine typo there surfaces at run time, naming the value that matched
  // nobody.
  for (const match of expr.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (match[1] !== poolName || poolFields.includes(match[2] ?? '')) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: `filter= reads "${match[0]}", but pool "${poolName}" has no field "${match[2] ?? ''}"`,
      hint:
        poolFields.length === 0
          ? `Pool "${poolName}" declares no fields.`
          : `Fields of "${poolName}": ${poolFields.join(', ')}.`,
      code: 'TDC226',
    });
  }

  for (const match of expr.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const name = match[0];
    if (seen.has(name)) continue;
    seen.add(name);
    if (!poolFields.includes(name) || !columns.has(name)) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: `"${name}" in filter= is both a field of pool "${poolName}" and a sequence — which one is meant is not decidable`,
      // Qualifying is NOT offered as the fix. `${poolName}.${name}` does name the
      // member's field, but the other side of the comparison is still a bare
      // `${name}` that reads as the field too, so the expression would compare a
      // value with itself and always hold. Renaming is the only repair that
      // leaves the config saying what it looks like it says.
      hint: `Rename one of them. Qualifying one side ("${poolName}.${name}") does not help: the other "${name}" still reads as the member's field, so the test would compare a value with itself.`,
      code: 'TDC232',
    });
  }
}

/**
 * A `filter=` put aside, and where its complaint belongs in the report.
 *
 * Held back for the same reason an `if=` is: the column a filter compares
 * against may be declared BELOW the reference, and the run resolves that
 * happily. Deciding mid-walk would report a problem the author does not have.
 */
export interface PendingPoolFilter {
  readonly at: number;
  readonly gen: OpenCloseElementContext | SelfClosingElementContext;
  readonly expr: string;
  readonly pool: string;
  readonly field: string;
  /** The other side of the `==`: a column name, or a bare word read as a literal. */
  readonly other: string;
}

function isPlainName(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

/**
 * Recognise `field == Something`, the one filter shape a check can decide.
 *
 * The same shape the engine gives a fast path to, and recognised the same way —
 * by looking at the text rather than at a parsed tree — so that what the reader
 * sees and what is checked are the same thing. Anything richer (`price <=
 * Budget`) compares against a value that only exists once the row is being
 * built, and stays a run-time refusal.
 */
export function pendingFilterFor(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  poolFields: readonly string[],
  at: number,
): PendingPoolFilter | undefined {
  const attrs = extractAttrs(gen.attr());
  const expr = (attrs['filter'] ?? '').trim();
  if (expr === '') return undefined;
  const parts = expr.split('==');
  if (parts.length !== 2) return undefined;
  const left = (parts[0] ?? '').trim();
  const right = (parts[1] ?? '').trim();
  if (!isPlainName(left) || !isPlainName(right)) return undefined;
  const pool = (attrs['value'] ?? '').trim();
  const leftIsField = poolFields.includes(left);
  const rightIsField = poolFields.includes(right);
  // Both sides a field compares the candidate with itself, which is a different
  // mistake and not one this check can speak to.
  if (leftIsField === rightIsField) return undefined;
  return leftIsField
    ? { at, gen, expr, pool, field: left, other: right }
    : { at, gen, expr, pool, field: right, other: left };
}

/**
 * The put-aside filters, decided now that every column is known.
 *
 * What can be said before a single value exists: the member's field and the
 * other side of the `==` each draw from a set the config writes down, and when
 * those two sets do not overlap the filter can never match — not on some row, on
 * every row. The run already refuses that, on row one, after building the pool;
 * saying it at check time costs nothing and names both lists.
 *
 * Only DISJOINT sets are reported. A value that is merely rare (`Want` produces
 * `A` and `Z`, members hold `A`) is a refusal waiting for the row that draws
 * `Z`, and reporting it here would also refuse `percent="100,0"`, which never
 * draws that value at all. The run-time message names the value that matched
 * nobody, which is the honest place to say it.
 */
export function runPendingPoolFilters(
  pending: readonly PendingPoolFilter[],
  diagnostics: Diagnostic[],
  declared: readonly string[],
  finiteValues: ReadonlyMap<string, readonly string[]>,
  poolFieldValues: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
): void {
  let shift = 0;
  for (const item of pending) {
    const fieldValues = poolFieldValues.get(item.pool)?.get(item.field);
    if (!fieldValues || fieldValues.length === 0) continue;
    // A name no sequence has is a bare word, and the expression language reads a
    // bare word as its own text — that is how `filter="clinic == North"` says
    // "northern only". So it is a set of exactly one value.
    const isColumn = declared.includes(item.other);
    const otherValues = isColumn ? finiteValues.get(item.other) : [item.other];
    if (!otherValues || otherValues.length === 0) continue;
    if (otherValues.some((v) => fieldValues.includes(v))) continue;

    const found: Diagnostic = {
      severity: 'error',
      source: 'validator',
      ...nodeRange(item.gen),
      message: isColumn
        ? `filter="${item.expr}" can never match — no value "${item.other}" produces is a "${item.field}" any member of pool "${item.pool}" could hold`
        : `filter="${item.expr}" can never match — no member of pool "${item.pool}" holds "${item.field}" = "${item.other}"`,
      hint:
        `"${item.field}" is drawn from: ${fieldValues.join(', ')}. ` +
        (isColumn ? `"${item.other}" produces: ${otherValues.join(', ')}. ` : '') +
        'A filter narrows the members a row may draw from, and every row would be left with none.',
      code: 'TDC225',
    };
    diagnostics.splice(item.at + shift, 0, found);
    shift += 1;
  }
}

/** Tags refused inside `<pool>`, with the reason each one is refused. */
const FORBIDDEN_IN_POOL: Readonly<Record<string, string>> = {
  block: 'a pool has no output of its own — it is a table other columns read',
  before: 'fixtures describe a file, and a pool is not written to one',
  after: 'fixtures describe a file, and a pool is not written to one',
  before_block: 'fixtures describe a file, and a pool is not written to one',
  after_block: 'fixtures describe a file, and a pool is not written to one',
  delimiter_block: 'fixtures describe a file, and a pool is not written to one',
  before_line: 'fixtures describe a file, and a pool is not written to one',
  after_line: 'fixtures describe a file, and a pool is not written to one',
  delimiter_line: 'fixtures describe a file, and a pool is not written to one',
  pool: 'a pool stays a flat table — point one pool at another instead of nesting them',
};

/**
 * Check one `<pool>` tag: its own attributes and the tags it may hold.
 *
 * What is inside a legal child is NOT checked here — the caller walks the pool
 * body with the same checks it uses on `<env>`, which is the whole point of the
 * construct.
 */
export function checkPool(pool: OpenCloseElementContext, diagnostics: Diagnostic[]): void {
  const attrs = extractAttrs(pool.attr());

  const name = attrs['name'];
  if (name === undefined || name.trim() === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(pool),
      message: '<pool> has no name',
      hint: 'A pool is read by name: <pool name="Doctors" count="30">, then <gen type="pool" value="Doctors"/>.',
      code: 'TDC222',
    });
  }

  const rawCount = attrs['count'];
  if (rawCount === undefined || rawCount.trim() === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(pool),
      message: `<pool${name ? ` name="${name}"` : ''}> has no count`,
      hint: 'count is how many members the table holds — thirty doctors for two thousand patients: count="30".',
      code: 'TDC222',
    });
  } else {
    const count = Number(rawCount);
    if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(pool),
        message: `<pool> count "${rawCount}" is not a whole number of members`,
        hint: 'Use a whole number of at least 1 — a pool of nothing has no member to hand out.',
        code: 'TDC223',
      });
    } else {
      checkPoolSize(pool, count, diagnostics);
    }
  }

  for (const child of contentElements(pool.content())) {
    const k = elementKind(child);
    if (!k || k.kind === 'data') continue;
    const childName = elementName(k.node);
    if (!childName) continue;
    const reason = FORBIDDEN_IN_POOL[childName];
    if (!reason) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(k.node),
      message: `<${childName}> cannot live inside a <pool>`,
      hint: `${reason}.`,
      code: 'TDC230',
    });
  }
}

/**
 * Teach the rest of the validator about a `<gen type="pool">` reference.
 *
 * It publishes the pool's fields under the sequence's own name, so
 * `${{Doctor.lastName}}` is a field of `Doctor` exactly as it would be for a
 * compound. That one registration is what lets TDC134, TDC193 and every other
 * name check work on a pool while knowing nothing about pools.
 */
export interface PoolRefContext {
  readonly poolFields: ReadonlyMap<string, readonly string[]>;
  readonly declaredSequences: string[];
  readonly valuelessSequences: string[];
  readonly diagnostics: Diagnostic[];
  readonly poolReferences: string[];
  readonly pendingPoolFilters: PendingPoolFilter[];
}

export function registerPoolReference(
  name: string,
  gens: readonly (OpenCloseElementContext | SelfClosingElementContext)[],
  ctx: PoolRefContext,
): void {
  const { poolFields, declaredSequences, valuelessSequences, diagnostics, poolReferences } = ctx;
  const { pendingPoolFilters } = ctx;
  for (const gen of gens) {
    const attrs = extractAttrs(gen.attr());
    if (attrs['type'] !== 'pool') continue;
    const poolName = (attrs['value'] ?? '').trim();
    if (!poolFields.has(poolName)) {
      const suggestion = closestMatch(poolName, [...poolFields.keys()]);
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(gen),
        message: `<gen type="pool"> draws from "${poolName}", which is not a declared pool`,
        ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
        hint:
          poolFields.size === 0
            ? 'Declare it first: <pool name="…" count="…"> inside the same <env>.'
            : `Declared pools: ${[...poolFields.keys()].join(', ')}.`,
        code: 'TDC224',
      });
      continue;
    }
    const fields = poolFields.get(poolName) ?? [];
    checkFilterAmbiguity(gen, fields, declaredSequences, diagnostics);
    const pendingFilter = pendingFilterFor(gen, fields, diagnostics.length);
    if (pendingFilter) pendingPoolFilters.push(pendingFilter);
    for (const field of fields) declaredSequences.push(`${name}.${field}`);
    // The reference itself is a record, not a value: `${{Doctor}}` alone has
    // nothing to print, and TDC229 says so rather than letting it through.
    valuelessSequences.push(name);
    poolReferences.push(name);
  }
}

/**
 * How many members are too many.
 *
 * A pool lives in memory for the whole run — that is what lets a row read any
 * member in O(1), and it is fine at the sizes the construct is for: thirty
 * doctors, ten departments, fifty shops. It stops being fine somewhere, and the
 * numbers below are measured rather than guessed. A four-field pool on this
 * machine, peak RSS above a 117 MB empty run:
 *
 *     1 000 members      +0 MB      (below the noise)
 *     10 000             +4 MB
 *     100 000            +29 MB
 *     500 000            +160 MB
 *
 * That is roughly 320 bytes a member with four fields, and it scales with the
 * field count. So a million members is a third of a gigabyte before the run has
 * produced a single row, and ten million is past three gigabytes — at which
 * point the streaming engines' bounded-memory promise is not true in any useful
 * sense, whatever the row count.
 *
 * The warning starts where the cost becomes visible; the refusal starts where
 * the promise breaks. A pool that large is also, nearly always, a `count` typed
 * onto the wrong tag — so both messages say so.
 */
const POOL_WARN_MEMBERS = 100_000;
const POOL_MAX_MEMBERS = 1_000_000;

function checkPoolSize(
  pool: OpenCloseElementContext,
  count: number,
  diagnostics: Diagnostic[],
): void {
  if (count > POOL_MAX_MEMBERS) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(pool),
      message: `<pool> holds ${count.toLocaleString('en-US')} members — more than the ${POOL_MAX_MEMBERS.toLocaleString('en-US')} a pool may hold`,
      hint: 'A pool is kept in memory for the whole run (measured: ~320 bytes a member with four fields), so this would cost hundreds of megabytes before the first row. If you meant the number of ROWS, that is count on <env>.',
      code: 'TDC235',
    });
    return;
  }
  if (count > POOL_WARN_MEMBERS) {
    diagnostics.push({
      severity: 'warning',
      source: 'validator',
      ...nodeRange(pool),
      message: `<pool> holds ${count.toLocaleString('en-US')} members and stays in memory for the whole run`,
      hint: 'Measured at ~320 bytes a member with four fields — 100,000 members cost about 29 MB. It works; it is worth being deliberate about. If you meant the number of ROWS, that is count on <env>.',
      code: 'TDC234',
    });
  }
}
