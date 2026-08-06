/**
 * Evaluate `if`-attribute expressions against the sequence registry.
 *
 * Supports the operators listed in docs/vision/03-dsl.md:
 *   comparison: == != < > <= >=
 *   logical:    && || !
 *   arithmetic: + - * /
 *
 * Identifiers resolve to the current-iteration value of the named
 * sequence (string) or to the special `_count` (1-based iteration
 * number). Numeric literals and quoted string literals are supported.
 * Unquoted bare identifiers that happen to look like plain English
 * words (e.g. `Male`, `Female`) also work and compare equal to the
 * string of the same name — this mirrors the prototype's "if gender ==
 * Male" style where "Male" is just a word, not a quoted string.
 *
 * Implementation: `jsep` handles parsing; evaluation is a small
 * recursive walk over the AST. Expression compilation is cached per
 * source string since the same `if` attribute is evaluated per
 * iteration of the main loop.
 */

import jsep from 'jsep';

import * as TdcMath from '../math/tdc-math.js';
import { sequenceValueAt } from '../sequence/types.js';
// Registers `in`. jsep's operator table is module state, so both the evaluator
// and the validator must import this before they parse anything.
import './operators.js';
import type { SequenceRegistry } from '../sequence/types.js';

type JsepNode = jsep.Expression;

const COMPILE_CACHE = new Map<string, JsepNode>();

function compile(expr: string): JsepNode {
  let cached = COMPILE_CACHE.get(expr);
  if (!cached) {
    cached = jsep(expr);
    COMPILE_CACHE.set(expr, cached);
  }
  return cached;
}

/**
 * Evaluate `expr` against the given registry at `iteration` (0-based).
 * Returns a boolean. Coercion to truthy/falsy uses `toBoolean` (below),
 * which differs from raw JS `Boolean(...)` in one place: the literal
 * string `"false"` is treated as falsy. This makes the built-in
 * `_first` / `_last` / boolean-looking user values interoperate with
 * `if` expressions intuitively:
 *
 *   `<data if="_last">...</data>`     — truthy only on the last row
 *   `<data if="!_last">,</data>`      — truthy on every row except last
 *   `${{_last}}`                      — interpolates as "true" / "false"
 */
export function evaluateIf(expr: string, registry: SequenceRegistry, iteration: number): boolean {
  return evaluateInScope(expr, (name) => {
    const seq = registry[name];
    return seq ? (sequenceValueAt(seq, iteration) ?? '') : undefined;
  });
}

/**
 * How a name in an expression is given a value.
 *
 * `undefined` means "no such name here" — the evaluator then falls back to
 * treating the identifier as a bare word, which is what makes `if="x == Male"`
 * read the way it does.
 *
 * The indirection exists because `filter=` on a `<gen type="pool">` evaluates
 * the same expression language against TWO scopes at once: a candidate member's
 * fields and the current row's columns. Rather than inventing a second
 * evaluator that would drift from this one, the caller decides what a name
 * means and the operators, the precedence and the truthiness stay shared.
 */
export type ExprScope = (name: string) => string | undefined;

/** Evaluate `expr` with names resolved by `scope`, as a boolean. */
export function evaluateInScope(expr: string, scope: ExprScope): boolean {
  return toBoolean(walk(compile(expr), scope));
}

/**
 * Project a value to the boolean domain used by `if` expressions and
 * by the `!`, `&&`, `||` operators. Matches JS truthiness EXCEPT that
 * the literal string `"false"` is also falsy.
 */
function toBoolean(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v !== '' && v !== 'false';
  return Boolean(v);
}

function walk(node: JsepNode, scope: ExprScope): unknown {
  switch (node.type) {
    case 'Literal': {
      return (node as jsep.Literal).value;
    }
    case 'Identifier': {
      const name = (node as jsep.Identifier).name;
      // An unknown identifier is a bare string literal; the prototype supports
      // `if="x == Male"` where `Male` is a word, not a quoted string.
      return scope(name) ?? name;
    }
    case 'MemberExpression': {
      // Compound-sequence access: `Person.FirstName` → look up the
      // dotted key in the registry. jsep parses the whole chain into
      // nested MemberExpressions; flatten it back to the dotted string
      // the registry uses.
      const name = memberExpressionToName(node as jsep.MemberExpression);
      const direct = scope(name);
      if (direct !== undefined) return direct;
      // Sugar: `X.Value` where X IS a sequence but `X.Value` is not a compound
      // field → the value-check `X == "Value"` (a boolean), matching how
      // `parent="X.Value"` reads. So `if="Gender.Male"` means "current Gender
      // is Male". `X.A.B` compares X against the literal "A.B".
      const dot = name.indexOf('.');
      const base = dot > 0 ? scope(name.slice(0, dot)) : undefined;
      if (base !== undefined) return base === name.slice(dot + 1);
      // Unknown reference — return the dotted name as a bare string literal so
      // typos surface verbatim (mirrors the Identifier fallback).
      return name;
    }
    case 'BinaryExpression':
    case 'LogicalExpression': {
      const bin = node as jsep.BinaryExpression;
      const left = walk(bin.left, scope);
      const right = walk(bin.right, scope);
      return applyBinary(bin.operator, left, right);
    }
    case 'UnaryExpression': {
      const un = node as jsep.UnaryExpression;
      const arg = walk(un.argument, scope);
      return applyUnary(un.operator, arg);
    }
    case 'CallExpression': {
      const call = node as jsep.CallExpression;
      // Only a bare name may be called: `abs(x)`, never `obj.method(x)` or the
      // result of an expression. The validator says the same thing earlier and
      // with a position; this keeps the evaluator honest on its own.
      if (call.callee.type !== 'Identifier') {
        throw new Error('only a plain function name can be called');
      }
      const name = (call.callee as jsep.Identifier).name;
      const fn = FUNCTIONS[name];
      if (!fn) throw new Error(`unknown function "${name}"`);
      return fn(call.arguments.map((a) => walk(a, scope)));
    }
    case 'ArrayExpression': {
      // Only ever the right side of `in`, where it is a set of values to test
      // against. Bare words inside stay bare — `[US, CA, MX]` reads the way the
      // rest of the language reads an unquoted word.
      const array = node as jsep.ArrayExpression;
      return array.elements.map((e) => (e ? walk(e, scope) : undefined));
    }
    case 'ConditionalExpression': {
      const cond = node as jsep.ConditionalExpression;
      return toBoolean(walk(cond.test, scope))
        ? walk(cond.consequent, scope)
        : walk(cond.alternate, scope);
    }
    default:
      throw new Error(`unsupported expression node: ${node.type}`);
  }
}

/**
 * Collapse a MemberExpression chain back to a dotted name.
 * `Person.Address.City` → "Person.Address.City". Only plain-identifier
 * chains are supported; computed access like `x[0]` throws.
 */
function memberExpressionToName(node: jsep.MemberExpression): string {
  if (node.computed) {
    throw new Error('computed member access is not supported in if expressions');
  }
  const parts: string[] = [];
  let cur: jsep.Expression = node;
  while (cur.type === 'MemberExpression') {
    const m = cur as jsep.MemberExpression;
    if (m.computed) {
      throw new Error('computed member access is not supported in if expressions');
    }
    if (m.property.type !== 'Identifier') {
      throw new Error(`unsupported member property type: ${m.property.type}`);
    }
    parts.unshift((m.property as jsep.Identifier).name);
    cur = m.object;
  }
  if (cur.type !== 'Identifier') {
    throw new Error(`unsupported member base type: ${cur.type}`);
  }
  parts.unshift((cur as jsep.Identifier).name);
  return parts.join('.');
}

/**
 * The functions `if=` may call.
 *
 * Every one of these is EXACT: it is built from comparisons and from the
 * arithmetic IEEE-754 pins down, so the five implementations cannot disagree
 * about a result. That is the whole admission criterion, and it is why `sin`,
 * `cos`, `exp` and friends are not here yet — see EXPR_FUNCTIONS in
 * validator/known.ts.
 *
 * `round` needs saying out loud, because the host languages do not agree on it:
 * JavaScript rounds a half toward +∞ (`Math.round(-0.5)` is −0), Python rounds
 * a half to even (`round(0.5)` is 0), Java rounds a half up. TDC rounds a half
 * AWAY FROM ZERO — `round(0.5)` is 1, `round(-0.5)` is −1 — which is the rule
 * people mean when they say "round", and is symmetric, so a column of positives
 * and a column of negatives behave the same way.
 */
const FUNCTIONS: Readonly<Record<string, (args: readonly unknown[]) => unknown>> = {
  // Numbers. Each coerces its own arguments rather than the registry doing it
  // for everyone, because the string functions below must NOT be coerced:
  // `len("10")` is 2, and a registry that pre-numbered every argument could not
  // tell the two families apart.
  abs: (a) => Math.abs(num(a, 0)),
  ceil: (a) => Math.ceil(num(a, 0)),
  floor: (a) => Math.floor(num(a, 0)),
  max: (a) => a.map((v) => asNumber(v)).reduce((x, y) => (y > x ? y : x)),
  min: (a) => a.map((v) => asNumber(v)).reduce((x, y) => (y < x ? y : x)),
  round: (a) => {
    const x = num(a, 0);
    return x < 0 ? -Math.floor(-x + 0.5) : Math.floor(x + 0.5);
  },
  trunc: (a) => Math.trunc(num(a, 0)),

  // Strings. The predicates people actually reach for — a prefix, a substring,
  // a length — and none of them touches floating point, so all five agree for
  // free.
  contains: (a) => text(a, 0).includes(text(a, 1)),
  ends_with: (a) => text(a, 0).endsWith(text(a, 1)),
  is_empty: (a) => text(a, 0).length === 0,
  len: (a) => codePointLength(text(a, 0)),
  lower: (a) => text(a, 0).toLowerCase(),
  starts_with: (a) => text(a, 0).startsWith(text(a, 1)),
  upper: (a) => text(a, 0).toUpperCase(),

  // Transcendentals, computed by TDC rather than by the host — see
  // math/tdc-math.ts for why that is not paranoia. Adding one here means adding
  // it to TdcMath in all five implementations, not calling Math.something.
  acos: (a) => TdcMath.acos(num(a, 0)),
  acosh: (a) => TdcMath.acosh(num(a, 0)),
  asin: (a) => TdcMath.asin(num(a, 0)),
  asinh: (a) => TdcMath.asinh(num(a, 0)),
  atan: (a) => TdcMath.atan(num(a, 0)),
  atanh: (a) => TdcMath.atanh(num(a, 0)),
  atan2: (a) => TdcMath.atan2(num(a, 0), num(a, 1)),
  cbrt: (a) => TdcMath.cbrt(num(a, 0)),
  cos: (a) => TdcMath.cos(num(a, 0)),
  cosh: (a) => TdcMath.cosh(num(a, 0)),
  exp: (a) => TdcMath.exp(num(a, 0)),
  expm1: (a) => TdcMath.expm1(num(a, 0)),
  hypot: (a) => TdcMath.hypot(num(a, 0), num(a, 1)),
  log: (a) => TdcMath.log(num(a, 0)),
  log10: (a) => TdcMath.log10(num(a, 0)),
  log1p: (a) => TdcMath.log1p(num(a, 0)),
  log2: (a) => TdcMath.log2(num(a, 0)),
  pow: (a) => TdcMath.pow(num(a, 0), num(a, 1)),
  sin: (a) => TdcMath.sin(num(a, 0)),
  sign: (a) => TdcMath.sign(num(a, 0)),
  sinh: (a) => TdcMath.sinh(num(a, 0)),
  sqrt: (a) => TdcMath.sqrt(num(a, 0)),
  tanh: (a) => TdcMath.tanh(num(a, 0)),
  tan: (a) => TdcMath.tan(num(a, 0)),
};

/**
 * The names this evaluator can actually call. Exported so a test can pin that
 * it matches EXPR_FUNCTIONS in the validator: a name that validates and does
 * not evaluate is worse than one that does neither, because `check` calls the
 * config good and the run falls over.
 */
export const IMPLEMENTED_FUNCTION_NAMES: readonly string[] = Object.keys(FUNCTIONS).sort();

function at(args: readonly unknown[], index: number): unknown {
  if (index >= args.length) throw new Error('a function was given too few arguments');
  return args[index];
}

function num(args: readonly unknown[], index: number): number {
  return asNumber(at(args, index));
}

/** An argument as text. A list never reaches here — only `in` produces one. */
function text(args: readonly unknown[], index: number): string {
  const value = at(args, index);
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  throw new Error('a string function was given a list');
}

/**
 * `len` counts CODE POINTS.
 *
 * Three answers were available and only one is portable. UTF-16 units are what
 * JavaScript's `.length` gives — 2 for a single emoji — and neither Python nor
 * Rust would agree. Grapheme clusters are what a human means by "a character"
 * and would make a family emoji 1, but they need a Unicode segmentation table:
 * `Intl.Segmenter` here, ICU there, and a crate in Rust, which ships with none.
 *
 * Code points sit between, and they are what `len()` in Python and
 * `.chars().count()` in Rust already do, with `codePointCount` reaching them in
 * Java and C#. So `len("😀")` is 1 and `len("👨‍👩‍👧")` is 5 — the second is
 * surprising, and it is the same surprise in all five implementations rather
 * than a different one in each.
 */
function codePointLength(value: string): number {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- deliberate: see above
  return [...value].length;
}

/**
 * `Country in [US, CA, MX]` — is the left value one of the right ones?
 *
 * The alternative is `Country == US || Country == CA || Country == MX`, which
 * says the column name three times and grows a term per country. Comparison
 * uses the same loose rule `==` does, so a numeric column and a list of numeric
 * words still match.
 *
 * A right side that is not a list is a mistake the validator catches; here it
 * is one more equality, so the expression still means something definite.
 */
function membership(left: unknown, right: unknown): boolean {
  if (!Array.isArray(right)) return coerce(left, right, (a, b) => a == b);
  return right.some((candidate) => coerce(left, candidate, (a, b) => a == b));
}

/**
 * `%` — the EUCLIDEAN remainder, always in `[0, |b|)`.
 *
 * Not the host language's `%`. JavaScript, Java, C# and Rust all answer −1 to
 * `-3 % 2`; Python answers 1. The compute layer already settled this question
 * for `<mod>` and answers 1 (`compute/value.ts`, euclideanMod), so a `%` that
 * borrowed the host convention would make one engine give two different
 * answers to the same question depending on which layer the author reached
 * for. Same algorithm as `<mod>`, written for doubles.
 */
function euclideanRemainder(a: number, b: number): number {
  if (b === 0) throw new Error('the right side of % must not be zero');
  const abs = Math.abs(b);
  const r = a % abs;
  return r < 0 ? r + abs : r;
}

function applyBinary(op: string, left: unknown, right: unknown): unknown {
  switch (op) {
    case '==':
      return coerce(left, right, (a, b) => a == b);
    case '!=':
      return coerce(left, right, (a, b) => a != b);
    case '===':
      return left === right;
    case '!==':
      return left !== right;
    case '<':
      return asNumber(left) < asNumber(right);
    case '>':
      return asNumber(left) > asNumber(right);
    case '<=':
      return asNumber(left) <= asNumber(right);
    case '>=':
      return asNumber(left) >= asNumber(right);
    case '&&':
      return toBoolean(left) && toBoolean(right);
    case '||':
      return toBoolean(left) || toBoolean(right);
    case '+':
      // If both sides look numeric, prefer numeric addition; otherwise
      // fall back to string concatenation to match JS semantics.
      return typeof left === 'number' || typeof right === 'number'
        ? asNumber(left) + asNumber(right)
        : String(left) + String(right);
    case '-':
      return asNumber(left) - asNumber(right);
    case '*':
      return asNumber(left) * asNumber(right);
    case '/':
      return asNumber(left) / asNumber(right);
    case '%':
      return euclideanRemainder(asNumber(left), asNumber(right));
    case 'in':
      return membership(left, right);
    default:
      throw new Error(`unsupported binary operator: ${op}`);
  }
}

function applyUnary(op: string, arg: unknown): unknown {
  switch (op) {
    case '!':
      return !toBoolean(arg);
    case '-':
      return -asNumber(arg);
    case '+':
      return asNumber(arg);
    default:
      throw new Error(`unsupported unary operator: ${op}`);
  }
}

function coerce(left: unknown, right: unknown, op: (a: unknown, b: unknown) => boolean): boolean {
  // `==` compares loosely: if one side is a number and the other a
  // numeric string, compare as numbers; otherwise compare as strings.
  // This matches user intent when writing `if="_count == 5"` (where
  // _count is "5" as a string) and `if="Gender == Male"` (string==string).
  if (typeof left === 'number' && typeof right === 'string') {
    const n = Number(right);
    if (!Number.isNaN(n)) return op(left, n);
  }
  if (typeof right === 'number' && typeof left === 'string') {
    const n = Number(left);
    if (!Number.isNaN(n)) return op(n, right);
  }
  return op(left, right);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return Number.NaN;
}
