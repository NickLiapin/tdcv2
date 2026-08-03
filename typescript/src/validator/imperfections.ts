/**
 * Validation for the two imperfection wrappers — `missing="p"` and `anomaly="p"`.
 *
 * Both probabilities were parsed only where they are USED, deep inside the
 * sequence builder, so `tdcv2 check` called a config valid and the run then
 * stopped on `anomaly="10x"`. A check that passes what the very next command
 * refuses is worse than no check: it teaches the reader to distrust it. The
 * parse lives here now, and the generator keeps its own as a backstop for
 * callers who build a gen through the library API without validating first.
 *
 * The second check is about a request that would be honoured and still do
 * nothing. An anomaly is a numeric perturbation — the selected value is
 * multiplied by `anomaly_factor` — so a `value=` list with no number anywhere in
 * it has nothing to perturb, and ten rows come back ordinary with no sign that
 * 30% of them were supposed to be outliers. Only a `type="text"` list is judged,
 * because it is the only source whose whole candidate set is written in the
 * config: a file, a pack address or a regex may well produce numbers, and
 * guessing at them would refuse configs that work.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

/** True when `raw` is a probability the generators will accept. */
function isProbability(raw: string): boolean {
  const p = Number(raw);
  return Number.isFinite(p) && p >= 0 && p <= 1;
}

export function checkGenImperfections(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);

  for (const name of ['anomaly', 'missing'] as const) {
    const attr = findAttr(attrs, name);
    if (!attr) continue;
    const raw = attrMap[name] ?? '';
    if (raw.trim() === '' || isProbability(raw)) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `${name}="${raw}" is not a probability — it must be a number in [0, 1]`,
      hint:
        name === 'anomaly'
          ? 'It is the share of values turned into outliers: anomaly="0.05" spikes one value in twenty.'
          : 'It is the share of values blanked: missing="0.1" empties one value in ten.',
      code: 'TDC242',
    });
  }

  const anomalyAttr = findAttr(attrs, 'anomaly');
  if (!anomalyAttr) return;
  const raw = attrMap['anomaly'] ?? '';
  if (!isProbability(raw) || Number(raw) === 0) return;
  if (attrMap['type'] !== 'text') return;
  const list = attrMap['value'];
  if (list === undefined || list.trim() === '') return;
  const values = list.split(',').map((v) => v.trim());
  if (values.some((v) => v !== '' && Number.isFinite(Number(v)))) return;

  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(anomalyAttr),
    message: `anomaly="${raw}" has nothing to perturb — no value in "${list}" is a number`,
    hint: 'An anomaly multiplies a numeric value by anomaly_factor, so a list of words comes back unchanged. Put the anomaly on a numeric generator, or drop it.',
    code: 'TDC243',
  });
}
