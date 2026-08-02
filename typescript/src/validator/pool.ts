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
}

export function registerPoolReference(
  name: string,
  gens: readonly (OpenCloseElementContext | SelfClosingElementContext)[],
  ctx: PoolRefContext,
): void {
  const { poolFields, declaredSequences, valuelessSequences, diagnostics, poolReferences } = ctx;
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
