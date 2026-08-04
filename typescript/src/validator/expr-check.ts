/**
 * Validate an `if="…"` expression: compile it with jsep and walk the AST,
 * flagging any operator or construct outside TDC's supported subset. Shared by
 * every `if`-bearing tag (<line>, <data>, conditional <gen>).
 */

import jsep from 'jsep';

import { type Diagnostic, attrValueRange, closestMatch, type Range } from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';

import {
  BUILTIN_SEQUENCES,
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

  // Walk AST and collect unsupported operators.
  const walk = (node: jsep.Expression): void => {
    switch (node.type) {
      case 'BinaryExpression':
      case 'LogicalExpression': {
        const bin = node as jsep.BinaryExpression;
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
            hint: `Supported binary operators: ${SUPPORTED_BINARY_OPERATORS.join(' ')}.`,
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
      default: {
        sink.diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...valRange,
          message: `unsupported expression construct "${node.type}" in if expression`,
          hint: 'Only comparisons, logical connectives, arithmetic, member access, identifiers and literals are allowed.',
          code: 'TDC103',
        });
      }
    }
  };
  walk(ast);
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
      known,
      compounds,
      item.eachBuiltins,
      finiteValues,
    );
    diagnostics.splice(item.at + shift, 0, ...found);
    shift += found.length;
  }
}
