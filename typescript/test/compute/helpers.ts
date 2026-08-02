import { evaluateCompute } from '../../src/compute/index.js';
import { parse } from '../../src/parser/parse.js';
import { elementKind, elementName } from '../../src/processor/walk.js';

/**
 * Parse a `<compute>…</compute>` snippet and evaluate it. `fields` supplies the
 * values that `<field name>` resolves to.
 */
export function evalCompute(computeXml: string, fields: Record<string, string> = {}): string {
  const result = parse(computeXml);
  if (result.diagnostics.length > 0) {
    throw new Error(`parse error: ${result.diagnostics.map((d) => d.message).join('; ')}`);
  }
  const el = result.tree.element()[0];
  if (!el) throw new Error('no element parsed');
  const k = elementKind(el);
  if (k?.kind !== 'open' || elementName(k.node) !== 'compute') {
    throw new Error('expected a top-level <compute> element');
  }
  return evaluateCompute(k.node, (name) => fields[name]);
}

/** Evaluate a single expression by wrapping it in a bare `<compute>`. */
export function evalExpr(exprXml: string, fields: Record<string, string> = {}): string {
  return evalCompute(`<compute>${exprXml}</compute>`, fields);
}
