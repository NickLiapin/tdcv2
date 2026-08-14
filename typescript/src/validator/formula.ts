/**
 * Validation for `<gen type="formula">` — a column computed from its own row.
 *
 * Three things have to be true before a formula can run, and all three are
 * knowable from the config alone, so all three are refused by `check` rather
 * than by the run:
 *
 *   1. it says WHAT to compute — `expr=` is there and parses;
 *   2. every NAME in it is a sequence, not a typo;
 *   3. every one of those is declared ABOVE it, because a formula is built in
 *      declaration order out of columns that already exist.
 *
 * Rule 3 borrows TDC240 from `running` and `stat` on purpose — same rule, same
 * fix, and a third code for it would lengthen the error reference without
 * telling a reader anything new.
 *
 * Rule 2 is the one that matters most in practice. An unknown name in an `if=`
 * is a bare WORD and the branch quietly stops firing; in a formula the same
 * typo reaches arithmetic, and `Heigth * 2` is NaN. Left to the run that prints
 * as a refusal on row one — after `check` has already called the config valid,
 * which is the failure this project keeps closing.
 */

import jsep from 'jsep';

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange, closestMatch, formatCandidates, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { FormulaError, formulaDecimals } from '../sequence/formula.js';
import { BUILTIN_SEQUENCES } from './known.js';
import { checkIfExpression, exprSite, xmlEntity } from './expr-check.js';

/** Everything a formula cannot do without, and the names it is allowed to read. */
export function checkGenFormula(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  declaredAbove: readonly string[],
  diagnostics: Diagnostic[],
): void {
  const attrs = extractAttrs(gen.attr());
  if (attrs['type'] !== 'formula') return;

  const expr = (attrs['expr'] ?? '').trim();
  if (expr === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="formula"> does not say what to compute',
      hint:
        'Add expr="…" — the arithmetic this column is, written the way an if= condition is ' +
        'written: expr="0.75 * Height - 58".',
      code: 'TDC294',
    });
    return;
  }

  const exprAttr = gen.attr().find((a) => a._attrName?.text === 'expr');
  const at = exprAttr ? attrValueRange(exprAttr) : nodeRange(gen);

  // Before the parser gets a chance to blame the "&": a config is XML-SHAPED and
  // not XML, so `&amp;&amp;` is five literal characters. `if=` has explained
  // this for a while; an expression in `expr=` deserves the same sentence rather
  // than a parse error pointing at a character the author never typed.
  const entity = xmlEntity(expr);
  if (entity) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...at,
      message: `expr="${expr}": TDC does not expand XML entities, so "${entity.found}" is ${String(entity.found.length)} literal characters, not "${entity.means}"`,
      hint: `Write ${entity.means} directly — the config is XML-shaped but it is not XML, and the raw character is what the expression parser reads.`,
      code: 'TDC294',
    });
    return;
  }

  let ast: jsep.Expression;
  try {
    ast = jsep(expr);
  } catch (e) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...at,
      message: `expr="${expr}" is not an expression: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'The same little language as if= — see the expressions reference.',
      code: 'TDC294',
    });
    return;
  }

  try {
    formulaDecimals(attrs);
  } catch (e) {
    const attr = gen.attr().find((a) => a._attrName?.text === 'decimals');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(attr ? attrValueRange(attr) : nodeRange(gen)),
      message: e instanceof FormulaError ? e.message : String(e),
      hint: 'decimals= rounds the answer. Without it the value prints in full.',
      code: 'TDC294',
    });
  }

  // The rest of the little language — the operators it allows, the functions it
  // knows, the constructs it can evaluate. `if=` has been handing its expression
  // to this checker all along; `expr=` parsed its own and stopped there, so a
  // misspelled function sailed through a green `check` and killed the run with a
  // bare `unknown function "…"` — no code, no line, on a page that promises the
  // four homes read the same way.
  if (exprAttr) checkIfExpression(exprAttr, expr, { diagnostics }, exprSite('expr'));

  for (const name of identifiersOf(ast)) {
    if (BUILTIN_SEQUENCES.includes(name)) continue;
    if (declaredAbove.includes(name)) continue;
    const suggestion = closestMatch(name, [...declaredAbove]);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...at,
      message: `"${name}" in expr= is not a sequence declared above this one`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint:
        declaredAbove.length === 0
          ? 'A formula is computed from columns that already exist, so the columns it reads ' +
            'have to come first.'
          : `Declared above: ${formatCandidates([...declaredAbove])}.`,
      code: 'TDC240',
    });
  }
}

/**
 * Every NAME the expression reads.
 *
 * A formula has no bare-word case to protect: `if="Gender == Male"` needs
 * `Male` to stay a word, but nothing is compared here — the whole expression is
 * arithmetic whose answer is printed. So every identifier is a column
 * reference, and one that is not a column is a typo rather than a word.
 *
 * The one exception is the branches of a ternary, which is how a formula writes
 * a LABEL — `expr="BMI > 25 ? over : normal"`. Those two are words on purpose,
 * so they are skipped, exactly as the right-hand side of a comparison is.
 */
export function identifiersOf(node: jsep.Expression): string[] {
  const found: string[] = [];
  const walk = (n: jsep.Expression | null | undefined, bareWordsAllowed: boolean): void => {
    if (!n) return;
    switch (n.type) {
      case 'Identifier':
        if (!bareWordsAllowed) found.push((n as jsep.Identifier).name);
        return;
      case 'MemberExpression': {
        // `Person.Age` — the ROOT is the column; the tail is its field, and a
        // field cannot be known from the config alone.
        const root = rootOf(n as jsep.MemberExpression);
        if (root !== undefined && !bareWordsAllowed) found.push(root);
        return;
      }
      case 'BinaryExpression': {
        const b = n as jsep.BinaryExpression;
        // The right of a comparison may be a bare word, the same reading `if=`
        // gives it. Arithmetic has no such case: both sides are numbers.
        const compare = ['==', '!=', '===', '!==', '<', '>', '<=', '>='].includes(b.operator);
        walk(b.left, false);
        walk(b.right, compare || bareWordsAllowed);
        return;
      }
      case 'LogicalExpression': {
        const l = n as unknown as { left: jsep.Expression; right: jsep.Expression };
        walk(l.left, bareWordsAllowed);
        walk(l.right, bareWordsAllowed);
        return;
      }
      case 'UnaryExpression':
        walk((n as jsep.UnaryExpression).argument, bareWordsAllowed);
        return;
      case 'ConditionalExpression': {
        const c = n as jsep.ConditionalExpression;
        walk(c.test, false);
        // Both branches may be labels — see the note above.
        walk(c.consequent, true);
        walk(c.alternate, true);
        return;
      }
      case 'CallExpression': {
        const call = n as jsep.CallExpression;
        for (const arg of call.arguments) walk(arg, false);
        return;
      }
      case 'ArrayExpression': {
        const arr = n as unknown as { elements: jsep.Expression[] };
        for (const el of arr.elements) walk(el, true);
        return;
      }
      default:
        return;
    }
  };
  walk(node, false);
  return [...new Set(found)];
}

function rootOf(node: jsep.MemberExpression): string | undefined {
  let cur: jsep.Expression = node;
  while (cur.type === 'MemberExpression') cur = (cur as jsep.MemberExpression).object;
  return cur.type === 'Identifier' ? (cur as jsep.Identifier).name : undefined;
}
