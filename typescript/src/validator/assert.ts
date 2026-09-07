/**
 * `<assert that="…" says="…"/>` — the attributes it cannot do without.
 *
 * An assertion is the one construct here whose whole worth is that it FAILS. A
 * half-written one is therefore worse than none at all: the config carries a
 * check, the reader believes the run was verified, and nothing was ever
 * compared. Both attributes are required, and an empty one counts as missing.
 *
 * The expression itself is not checked here. Both `that=` and `each=` are the
 * `if=` language, so each goes through the very same syntax check and the same
 * put-aside pass that resolves names once every sequence is known — a typo in a
 * column name is reported exactly as it would be in `if=`, because it IS the
 * same mistake.
 *
 * The two say different things and cannot be written together. `that=` reads
 * whole-run values ONCE; `each=` is answered on every row. A tag carrying both
 * would leave a reader to guess which of the two the sentence in `says=`
 * describes, and the answer would decide whether the run is checked once or a
 * million times.
 */

import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type { AttrContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';
import { checkIfExpression } from './expr-check.js';

/** What this needs of the walk's context: somewhere to report, and the put-aside list. */
interface AssertSink {
  readonly diagnostics: Diagnostic[];
  rememberExpression(attr: AttrContext, expr: string): void;
}

/** The attribute node with this name, for a range that points at the value. */
function attrNode(el: SelfClosingElementContext, name: string): AttrContext | undefined {
  for (const a of el.attr()) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

/**
 * Check one `<assert>`: its two attributes here, its expression in two passes.
 *
 * The expression's names are put aside rather than resolved on the spot, because
 * an assertion may name a sequence declared below it and the run resolves that
 * happily — checking mid-walk would invent errors on configs that work.
 */
export function checkAssertTag(el: SelfClosingElementContext, sink: AssertSink): void {
  const expr = checkAssertAttrs(el, sink.diagnostics);
  if (!expr) return;
  checkIfExpression(expr.attr, expr.expr, sink);
  sink.rememberExpression(expr.attr, expr.expr);
}

/** The two required attributes, and the expression to check when there is one. */
function checkAssertAttrs(
  el: SelfClosingElementContext,
  diagnostics: Diagnostic[],
): { attr: AttrContext; expr: string } | undefined {
  const attrs = extractAttrs(el.attr());
  const that = (attrs['that'] ?? '').trim();
  const each = (attrs['each'] ?? '').trim();
  const says = (attrs['says'] ?? '').trim();

  if (that !== '' && each !== '') {
    const at = attrNode(el, 'each') ?? attrNode(el, 'that');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(at ? attrValueRange(at) : nodeRange(el)),
      message: '<assert> has both that= and each= — they answer different questions',
      hint:
        'that= is read ONCE, over whole-run values; each= is answered on every row. Write ' +
        'two assertions, each with its own says=, so a failure says which one broke.',
      code: 'TDC306',
    });
    return undefined;
  }

  if (that === '' && each === '') {
    const at = attrNode(el, 'that') ?? attrNode(el, 'each');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(at ? attrValueRange(at) : nodeRange(el)),
      message: '<assert> has no condition — that= or each= is required',
      hint:
        'that= states a property of the whole run, over <gen type="stat"> columns: ' +
        '<assert that="Rows == 700" says="…"/>. each= states one every row must have: ' +
        '<assert each="Amount > 0" says="…"/>.',
      code: 'TDC265',
    });
    return undefined;
  }

  const written = that !== '' ? that : each;
  const name = that !== '' ? 'that' : 'each';

  if (says === '') {
    const at = attrNode(el, 'says');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...(at ? attrValueRange(at) : nodeRange(el)),
      message: `<assert ${name}="${written}"> has no message — says= is required`,
      hint:
        'When this fails, says= is what the reader is told. An expression alone leaves them ' +
        'to work out what it was for, months later, in a CI log.',
      code: 'TDC266',
    });
  }

  const attr = attrNode(el, name);
  return attr ? { attr, expr: written } : undefined;
}
