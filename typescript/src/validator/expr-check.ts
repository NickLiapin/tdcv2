/**
 * Validate an `if="…"` expression: compile it with jsep and walk the AST,
 * flagging any operator or construct outside TDC's supported subset. Shared by
 * every `if`-bearing tag (<line>, <data>, conditional <gen>).
 */

import jsep from 'jsep';

// Registers `in` on jsep's shared operator table. Without this the validator
// reads `Country in [US, CA]` as a syntax error while a run accepts it.
import '../expr/operators.js';

import { type Diagnostic, attrValueRange, closestMatch, type Range } from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';

import {
  BUILTIN_SEQUENCES,
  EXPR_FUNCTION_NAMES,
  EXPR_FUNCTIONS,
  PLANNED_EXPR_FUNCTIONS,
  SUPPORTED_BINARY_OPERATORS,
  SUPPORTED_UNARY_OPERATORS,
} from './known.js';

/**
 * The most of an attribute value a message will quote. The full text is in
 * the config the position already points at; a message quoting 100 KB of it
 * buries every other diagnostic in the report. The same limit lives in the
 * other four implementations; change them together.
 */
const MESSAGE_ECHO_LIMIT = 120;

/** An attribute value, cut to fit inside a one-line message. */
function clip(value: string): string {
  if (value.length <= MESSAGE_ECHO_LIMIT) return value;
  const hidden = value.length - MESSAGE_ECHO_LIMIT;
  return `${value.slice(0, MESSAGE_ECHO_LIMIT)}… (${String(hidden)} more chars)`;
}

/**
 * A hard ceiling on parenthesis nesting inside an expression. Expression
 * parsers recurse per `(` — here and in every port — so a generated
 * `((((…))))` is a stack overflow waiting for the deepest parser to find it
 * (and two of the five abort on overflow). Real expressions nest a handful.
 * The scan is linear and quote-aware, so a paren inside a string literal does
 * not count. The same scan lives in the other four implementations.
 */
const MAX_EXPR_NESTING = 32;

function parenDepth(expr: string): number {
  let depth = 0;
  let deepest = 0;
  let inString: string | undefined;
  let escaped = false;
  for (const ch of expr) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString !== undefined) {
      if (ch === '\\') escaped = true;
      else if (ch === inString) inString = undefined;
      continue;
    }
    if (ch === "'" || ch === '"') inString = ch;
    else if (ch === '(' || ch === '[') {
      depth += 1;
      deepest = Math.max(deepest, depth);
    } else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
  }
  return deepest;
}

/**
 * The XML entities somebody writes in an expression, and what they meant.
 *
 * The config LOOKS like XML, so `filter="price &lt;= Budget"` is what a careful
 * person writes — it is what XML requires, and what every editor autocompletes.
 * TDC does not expand entities, so the parser sees nine characters where a `<`
 * was meant and reports `Unexpected "=" at character 10`, which is true and tells
 * the reader nothing about what to change.
 *
 * `&lt;` and `&gt;` are the ones that matter, since comparison is where an
 * expression needs them; the rest are here because a reader who has learnt to
 * escape one will escape the others too.
 */
const XML_ENTITIES: readonly (readonly [string, string])[] = [
  ['&lt;', '<'],
  ['&gt;', '>'],
  ['&amp;', '&'],
  ['&quot;', '"'],
  ['&apos;', "'"],
];

function xmlEntity(expr: string): { found: string; means: string } | undefined {
  for (const [found, means] of XML_ENTITIES) {
    if (expr.includes(found)) return { found, means };
  }
  return undefined;
}

export function checkIfExpression(
  attr: AttrContext,
  expr: string,
  sink: { diagnostics: Diagnostic[] },
): void {
  const valRange: Range = attrValueRange(attr);
  if (parenDepth(expr) > MAX_EXPR_NESTING) {
    sink.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...valRange,
      message:
        `invalid if expression "${clip(expr)}": nests deeper than ` +
        `${String(MAX_EXPR_NESTING)} levels`,
      hint: 'A real condition nests a handful of parentheses; this looks generated.',
      code: 'TDC100',
    });
    return;
  }
  const entity = xmlEntity(expr);
  let ast: jsep.Expression;
  try {
    ast = jsep(expr);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    sink.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...valRange,
      // An entity is the likelier explanation than whatever the parser tripped
      // over, so it replaces the parser's own message rather than sitting beside
      // it: "Unexpected = at character 10" is true and useless.
      message:
        entity === undefined
          ? `invalid if expression "${clip(expr)}": ${msg}`
          : `invalid if expression "${clip(expr)}": TDC does not expand XML entities, ` +
            `so "${entity.found}" is ${String(entity.found.length)} literal characters, not "${entity.means}"`,
      hint:
        entity === undefined
          ? 'See the operator table: https://nickliapin.github.io/tdcv2/docs/core-concepts/output-formatting'
          : `write ${entity.means} directly — the config is XML-shaped but it is not XML, and ` +
            'the raw character is what the expression parser reads',
      code: 'TDC100',
    });
    return;
  }

  // The arrays that sit where an array belongs — the right side of `in`. Every
  // other one is flagged, so `if="[1,2]"` cannot reach the evaluator.
  const inMembership = new Set<jsep.Expression>();

  // Walk AST and collect unsupported operators.
  const walk = (node: jsep.Expression): void => {
    switch (node.type) {
      case 'BinaryExpression':
      case 'LogicalExpression': {
        const bin = node as jsep.BinaryExpression;
        if (bin.operator === 'in') inMembership.add(bin.right);
        if (!SUPPORTED_BINARY_OPERATORS.includes(bin.operator)) {
          const suggestion = closestMatch(bin.operator, SUPPORTED_BINARY_OPERATORS);
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: `unsupported operator "${bin.operator}" in if expression`,
            ...(suggestion && suggestion !== bin.operator
              ? { suggestion: `did you mean "${suggestion}"?` }
              : {}),
            hint:
              `Supported binary operators: ${SUPPORTED_BINARY_OPERATORS.join(' ')}. ` +
              `Functions: ${EXPR_FUNCTION_NAMES.join(', ')}. ` +
              'Anything an expression cannot say, a <compute> sequence can — it has integer ' +
              'division, remainders, string surgery and checksums — and the sequence it produces ' +
              'is what if= then compares.',
            code: 'TDC101',
          });
        }
        walk(bin.left);
        walk(bin.right);
        return;
      }
      case 'UnaryExpression': {
        const un = node as jsep.UnaryExpression;
        if (!SUPPORTED_UNARY_OPERATORS.includes(un.operator)) {
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: `unsupported unary operator "${un.operator}" in if expression`,
            hint: `Supported unary operators: ${SUPPORTED_UNARY_OPERATORS.join(' ')}.`,
            code: 'TDC102',
          });
        }
        walk(un.argument);
        return;
      }
      case 'Literal':
      case 'Identifier':
        return;
      case 'ArrayExpression': {
        // A list is only meaningful as the right side of `in`. Anywhere else it
        // is not an error the evaluator can survive, so it is one here.
        const array = node as jsep.ArrayExpression;
        if (!inMembership.has(node)) {
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: 'a [list] is only allowed on the right of "in"',
            hint: 'Write Country in [US, CA, MX]. A list has no meaning on its own.',
            code: 'TDC259',
          });
        }
        for (const element of array.elements) if (element) walk(element);
        return;
      }
      case 'ConditionalExpression': {
        const cond = node as jsep.ConditionalExpression;
        walk(cond.test);
        walk(cond.consequent);
        walk(cond.alternate);
        return;
      }
      case 'MemberExpression': {
        // Dotted access: a compound field `Person.Field`, or the value-check
        // sugar `Gender.Male` (≡ Gender == Male). Only plain identifier chains
        // are supported — computed access like `x[0]` is not.
        const m = node as jsep.MemberExpression;
        if (m.computed) {
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: 'computed member access is not supported in if expression',
            hint: 'Use plain dotted access like Gender.Male or Person.FirstName.',
            code: 'TDC103',
          });
          return;
        }
        walk(m.object);
        return;
      }
      case 'CallExpression': {
        const call = node as jsep.CallExpression;
        if (call.callee.type !== 'Identifier') {
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: 'only a plain function name can be called in an if expression',
            hint: `Write abs(x), not an expression that produces a function. Available: ${EXPR_FUNCTION_NAMES.join(', ')}.`,
            code: 'TDC257',
          });
          return;
        }
        const name = (call.callee as jsep.Identifier).name;
        const spec = EXPR_FUNCTIONS[name];
        if (!spec) {
          const planned = PLANNED_EXPR_FUNCTIONS.includes(name);
          const suggestion = planned ? undefined : closestMatch(name, EXPR_FUNCTION_NAMES);
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: planned
              ? `${name}() is not available yet in an if expression`
              : `unknown function "${name}" in if expression`,
            ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
            hint: planned
              ? `TDC computes its own mathematics rather than calling each language's, because the libms disagree in the last bit and a comparison turns that bit into a different row. So ${name} arrives once it has been built and pinned to its bits in all five implementations, not before. Available today: ${EXPR_FUNCTION_NAMES.join(', ')}.`
              : `Available: ${EXPR_FUNCTION_NAMES.join(', ')}.`,
            code: 'TDC257',
          });
          return;
        }
        const n = call.arguments.length;
        if (n < spec.min || (spec.max !== undefined && n > spec.max)) {
          const wants =
            spec.max === undefined
              ? `at least ${String(spec.min)}`
              : spec.min === spec.max
                ? `exactly ${String(spec.min)}`
                : `${String(spec.min)} to ${String(spec.max)}`;
          sink.diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...valRange,
            message: `${name}() takes ${wants} argument${spec.max === 1 ? '' : 's'}, got ${String(n)}`,
            code: 'TDC258',
          });
        }
        if (name === 'at') checkAtCall(call, valRange, sink);
        for (const arg of call.arguments) walk(arg);
        return;
      }
      default: {
        sink.diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...valRange,
          message: `unsupported expression construct "${node.type}" in if expression`,
          hint: 'Only comparisons, logical connectives, arithmetic, function calls, member access, identifiers and literals are allowed.',
          code: 'TDC103',
        });
      }
    }
  };
  walk(ast);
}

/**
 * The functions that hand back a list. `at` reads one, and nothing else does
 * today; when a second joins, it goes here and the check below stays put.
 */
const LIST_RETURNING_FUNCTIONS: readonly string[] = ['split'];

/**
 * `at(subject, index)`, checked before the run rather than during it.
 *
 * Both halves are provable from the text alone. A name always resolves to a
 * STRING — a `repeat` list arrives joined, never as a list — so `at(Items, 1)`
 * can only ever answer with nothing, and that nothing is indistinguishable from
 * a legitimately short row. An index written out as `-1`, `1.5` or `"one"` is
 * the same kind of mistake one level down.
 *
 * The engine refuses both at run time as well; this is the earlier, better-placed
 * half of the same rule, because `check` can point at the character.
 */
function checkAtCall(
  call: jsep.CallExpression,
  valRange: Range,
  sink: { diagnostics: Diagnostic[] },
): void {
  const subject = call.arguments[0];
  if (subject && provablyNotAList(subject)) {
    sink.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...valRange,
      message: 'at() needs a list, and this argument is a single value',
      hint: 'A repeat list reaches an expression as its joined text, so cut it first: at(split(Items, ","), 1).',
      code: 'TDC260',
    });
  }
  const index = call.arguments[1];
  const bad = index ? badIndexLiteral(index) : undefined;
  if (bad !== undefined) {
    sink.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...valRange,
      message: `at() index must be a whole number of zero or more, not ${bad}`,
      hint: 'Elements count from zero: at(list, 0) is the first. Past the end is empty text — ask count(list) first.',
      code: 'TDC261',
    });
  }
}

/** Whether a subexpression can be shown, from the text alone, never to be a list. */
function provablyNotAList(node: jsep.Expression): boolean {
  if (node.type === 'Identifier' || node.type === 'MemberExpression') return true;
  if (node.type === 'Literal') return true;
  if (node.type === 'CallExpression') {
    const callee = (node as jsep.CallExpression).callee;
    if (callee.type !== 'Identifier') return false;
    return !LIST_RETURNING_FUNCTIONS.includes((callee as jsep.Identifier).name);
  }
  return false;
}

/** A written-out index that is not one, as it should read back in the message. */
function badIndexLiteral(node: jsep.Expression): string | undefined {
  if (node.type === 'Literal') {
    const value = (node as jsep.Literal).value;
    if (typeof value === 'string') return `"${value}"`;
    if (typeof value === 'number') {
      return Number.isInteger(value) && value >= 0 ? undefined : String(value);
    }
    return (node as jsep.Literal).raw;
  }
  // jsep reads `-1` as a minus applied to 1, so a negative index is never a
  // Literal and the check above would never see one.
  if (node.type === 'UnaryExpression') {
    const un = node as jsep.UnaryExpression;
    if (un.operator === '-' && un.argument.type === 'Literal') {
      return `-${(un.argument as jsep.Literal).raw}`;
    }
  }
  return undefined;
}

/**
 * The names an `if=` expression uses, checked against what exists.
 *
 * An identifier that names no sequence is not an error by itself — it is how a
 * bare word works: `if="Gender == Male"` compares against the literal `Male`,
 * and the documentation is written that way throughout. What decides is WHERE
 * the identifier sits:
 *
 *   - the whole condition (`if="Ready"`, `if="!Ready"`) — a name. An unknown one
 *     is its own name as a string, which is never empty, so the branch fires on
 *     every row.
 *   - the left of a comparison, and anything arithmetic — a name. An unknown one
 *     equals nothing, so the branch fires on no row.
 *   - the right of a comparison — left alone. `A == B` is a value comparison
 *     when B is declared and a bare word when it is not, and both are meant.
 *
 * A dot is read the same two ways the engine reads it: `Person.FirstName` is a
 * field of a compound, `Gender.Male` asks whether Gender came out `Male`. So the
 * root must always exist, and the tail is checked only where the root is a
 * compound — on a plain sequence the tail is a value, and a value cannot be
 * known from the config alone.
 */
export function checkExpressionNames(
  attr: AttrContext,
  expr: string,
  sink: { diagnostics: Diagnostic[] },
  known: readonly string[],
  compounds: readonly string[],
  eachBuiltins: readonly string[] = [],
  finiteValues: ReadonlyMap<string, readonly string[]> = new Map(),
): void {
  let ast: jsep.Expression;
  try {
    ast = jsep(expr);
  } catch {
    return; // Already reported as TDC100; there is no tree to walk.
  }

  const valRange: Range = attrValueRange(attr);
  const everything = [...known, ...BUILTIN_SEQUENCES, ...eachBuiltins];
  const declared = (name: string): boolean => everything.includes(name);

  const complain = (
    message: string,
    hint: string,
    suggestion?: string,
    code: 'TDC215' | 'TDC216' = 'TDC215',
  ): void => {
    sink.diagnostics.push({
      // TDC216 is a warning, and deliberately: a value outside today's list makes
      // a branch nothing can take, which is worth saying and not worth stopping
      // for. A config may narrow a list on purpose — `value="Man" percent="100"`
      // to pin a test — and keep every branch it will need when the list opens
      // back up. Refusing that would be refusing a config that works.
      severity: code === 'TDC216' ? 'warning' : 'error',
      source: 'validator',
      ...valRange,
      message,
      ...(suggestion ? { suggestion } : {}),
      hint,
      code,
    });
  };

  /** The dotted chain under a member expression, or undefined if it is computed. */
  const chain = (node: jsep.Expression): string[] | undefined => {
    if (node.type === 'Identifier') return [(node as jsep.Identifier).name];
    if (node.type !== 'MemberExpression') return undefined;
    const m = node as jsep.MemberExpression;
    if (m.computed || m.property.type !== 'Identifier') return undefined;
    const head = chain(m.object);
    return head ? [...head, (m.property as jsep.Identifier).name] : undefined;
  };

  const checkName = (node: jsep.Expression): void => {
    const parts = chain(node);
    if (!parts || parts.length === 0) return;
    const [root, ...tail] = parts as [string, ...string[]];

    if (!declared(root)) {
      const suggestion = closestMatch(root, everything);
      const whole = parts.join('.');
      complain(
        `"${whole}" is not a declared sequence — the condition reads it as the literal text "${whole}"`,
        tail.length === 0
          ? 'A condition that is a bare word is always true. Name a sequence declared in <env>, or compare against the word: Gender == Male.'
          : 'Name a sequence declared in <env>. A word on the RIGHT of a comparison is a literal and needs no declaration.',
        suggestion ? `did you mean "${suggestion}"?` : undefined,
      );
      return;
    }

    if (tail.length === 0) return;

    // On a plain sequence the tail is a VALUE — `Gender.Male` asks whether Gender
    // came out Male — and where the config says outright what it produces, a
    // value that is not among them makes a condition nothing can satisfy.
    const values = finiteValues.get(root);
    if (values && !compounds.includes(root)) {
      const wanted = tail.join('.');
      if (!values.includes(wanted)) {
        const suggestion = closestMatch(wanted, values);
        complain(
          `"${parts.join('.')}" — "${root}" never produces "${wanted}", so this branch can never be taken`,
          `"${root}" produces: ${values.join(', ')}.`,
          suggestion ? `did you mean "${root}.${suggestion}"?` : undefined,
          'TDC216',
        );
      }
      return;
    }

    // A tail on a compound is a field, and a field either exists or is a typo.
    // Anywhere else the tail is a value the config cannot be asked about.
    if (compounds.includes(root)) {
      const full = `${root}.${tail[0] ?? ''}`;
      if (!declared(full)) {
        const fields = everything
          .filter((n) => n.startsWith(`${root}.`))
          .map((n) => n.slice(root.length + 1));
        const suggestion = closestMatch(tail[0] ?? '', fields);
        complain(
          `"${parts.join('.')}" is not a field of "${root}" — the condition can never be true`,
          fields.length === 0
            ? `"${root}" has no fields.`
            : `Fields of "${root}": ${fields.join(', ')}.`,
          suggestion ? `did you mean "${root}.${suggestion}"?` : undefined,
        );
      }
    }
  };

  /** `asName` says whether an identifier here is a reference or a bare word. */
  const walk = (node: jsep.Expression, asName: boolean): void => {
    switch (node.type) {
      case 'Identifier':
      case 'MemberExpression':
        if (asName) checkName(node);
        return;
      case 'UnaryExpression':
        walk((node as jsep.UnaryExpression).argument, asName);
        return;
      case 'LogicalExpression': {
        // Each side of && or || is a condition in its own right.
        const bin = node as jsep.BinaryExpression;
        walk(bin.left, true);
        walk(bin.right, true);
        return;
      }
      case 'BinaryExpression': {
        const bin = node as jsep.BinaryExpression;
        const comparison = COMPARISONS.includes(bin.operator);
        walk(bin.left, true);
        // Arithmetic on a bare word is meaningless, so both sides are names
        // there; on a comparison the right side may be the word to match.
        walk(bin.right, !comparison);
        return;
      }
      default:
        return;
    }
  };

  walk(ast, true);
}

/** Operators whose right side may be a bare word rather than a name. */
const COMPARISONS: readonly string[] = ['==', '!=', '===', '!==', '<', '>', '<=', '>='];

/** One `if=` put aside, and where its complaint belongs in the report. */
export interface PendingExpression {
  readonly at: number;
  readonly attr: AttrContext;
  readonly expr: string;
  readonly eachBuiltins: readonly string[];
  /**
   * The names visible where this expression was WRITTEN, when that is narrower
   * than the run's.
   *
   * A `<pool>` member sees the pool's own fields and nothing else — the pool is
   * built before any row exists, so an env column has no value to read. Deferring
   * the check to the end and resolving against the run's names got this wrong in
   * both directions at once: a sibling field was refused with TDC215 though the
   * engine resolves it correctly, and an env column was ACCEPTED though the
   * condition is then constant-false on every member. Measured, six rows:
   *
   *     if="role == surgeon"   TDC215        engine: yes/yes/yes/no/no/no
   *     if="Age >= 18"         is valid      engine: badge=[] on every row
   */
  readonly scope?: readonly string[] | undefined;
}

/**
 * The put-aside expressions, checked now that every name is known.
 *
 * Held back rather than checked as the walk passed: an expression may name a
 * sequence declared BELOW it, and the run resolves that happily, so checking
 * mid-walk would invent errors on configs that work. Each complaint is spliced
 * back at the position its attribute was found, so the report still reads top to
 * bottom.
 */
/**
 * Narrow the expressions put aside since `from` to the names they could actually
 * see. Used for a `<pool>`, whose members read each other and nothing from the
 * run — see `PendingExpression.scope` for what went wrong without it.
 */
export function scopePending(
  pending: PendingExpression[],
  from: number,
  names: readonly string[],
): void {
  const scope = [...names];
  for (let i = from; i < pending.length; i++) {
    const item = pending[i];
    if (item && item.scope === undefined) pending[i] = { ...item, scope };
  }
}

export function runPendingExpressions(
  pending: readonly PendingExpression[],
  diagnostics: Diagnostic[],
  known: readonly string[],
  compounds: readonly string[],
  finiteValues: ReadonlyMap<string, readonly string[]>,
): void {
  let shift = 0;
  for (const item of pending) {
    const found: Diagnostic[] = [];
    checkExpressionNames(
      item.attr,
      item.expr,
      { diagnostics: found },
      item.scope ?? known,
      item.scope ? [] : compounds,
      item.eachBuiltins,
      item.scope ? new Map() : finiteValues,
    );
    diagnostics.splice(item.at + shift, 0, ...found);
    shift += found.length;
  }
}
