/**
 * Per-type validation for `<gen type="text">`.
 *
 * Every other generator type has had its checks in a module of its own since
 * they were written; these two stayed behind in `validate.ts` for no reason but
 * the order they were added in. Moved here so the family is complete and the
 * dispatch in `validate.ts` reads as one line per type.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { PercentMaskError, expandPercentMask, inferredZeros } from '../distribution/index.js';
import { findAttr, isBlank } from './blank-value.js';

export function checkGenText(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  checkSequentialDropsPercent(gen, diagnostics);
  const valueAttr = findAttr(attrs, 'value');
  if (!valueAttr || isBlank(attrMap['value'])) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen type="text"> requires a "value" attribute',
      hint: 'Provide comma-separated values, e.g. value="Male,Female".',
      code: 'TDC050',
    });
    return;
  }
  // Split exactly as the generator does — `sequence/build.ts` splits on the comma
  // and trims, and stops there. Dropping the empty options here made the validator
  // count two where the run draws three: `value="a,,b"` really is three options
  // (measured over 300 rows: 100 `a`, 100 `b`, 100 empty), and the documented
  // `percent="30,40,30"` beside it was refused as "3 entries but value has 2".
  // A legal config was unreachable, and the four ports accepted it all along.
  const values = (attrMap['value'] ?? '').split(',').map((s) => s.trim());

  const percentAttr = findAttr(attrs, 'percent');
  if (!percentAttr) return;
  try {
    expandPercentMask(attrMap['percent'] ?? '', values.length);
    warnOnInferredZeros(attrMap['percent'] ?? '', values, percentAttr, diagnostics);
  } catch (err) {
    if (!(err instanceof PercentMaskError)) throw err;
    const code = err.kind === 'length' ? 'TDC051' : err.kind === 'number' ? 'TDC052' : 'TDC053';
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(percentAttr),
      message: err.message,
      hint:
        err.kind === 'length'
          ? 'Percent masks may be shorter than value only when missing positions can be inferred. They may never be longer than value.'
          : 'Filled positions must be non-negative numbers. Empty positions split the remaining percent equally.',
      code,
    });
  }
}

/**
 * A value that is declared and can never be drawn, because the shares written
 * beside it already add up to 100 and it was left to take what remains.
 *
 * A warning rather than a refusal: the run is well defined and somebody may want
 * exactly this — `percent="100"` is a legitimate way to say "only the first for
 * now". What is not acceptable is saying it in silence, which is what the
 * config did until this existed.
 */
export function warnOnInferredZeros(
  mask: string,
  values: readonly string[],
  percentAttr: Parameters<typeof attrValueRange>[0],
  diagnostics: Diagnostic[],
): void {
  const zeros = inferredZeros(mask, values.length);
  if (zeros.length === 0) return;
  const named = zeros.map((i: number) => `"${values[i] ?? ''}"`).join(', ');
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...attrValueRange(percentAttr),
    message:
      `percent leaves ${named} at 0% — ` +
      `${zeros.length === 1 ? 'a value that is' : 'values that are'} declared and never drawn`,
    hint:
      'A percent shorter than the list is fine: what is left over goes to the positions you ' +
      'did not write. Here the ones you did write already total 100, so there is nothing left. ' +
      'Give it the share you meant, drop it from value=, or write the 0 yourself to say you ' +
      'meant it.',
    code: 'TDC301',
  });
}

/**
 * `percent=` on a generator that walks its list in order — accepted, and read by
 * nothing.
 *
 * `order="sequential"` gives row r element `r mod N`, which is a rule about
 * POSITION and leaves no room for a rule about SHARE. The engine's own comment
 * says so ("ignoring the random pick and any percent"), and nothing told the
 * user: `percent="98,1,1"` over a hundred rows came out 34 / 33 / 33 from a
 * config `check` had called valid, which is the shape of the request answered
 * by its exact opposite.
 *
 * Shared by `type="text"` and `type="file"` — both walk a list, and both
 * dropped the shares the same way.
 */
export function checkSequentialDropsPercent(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  if ((attrMap['order'] ?? '').trim() !== 'sequential') return;
  const percentAttr = findAttr(attrs, 'percent');
  if (!percentAttr) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(percentAttr),
    message: `percent="${attrMap['percent'] ?? ''}" is not read beside order="sequential": walking the list in order fixes which value each row gets, so there is no share left to apportion`,
    hint: 'Drop order="sequential" to have the shares apportioned exactly, or drop percent= and take the values in the order they are written — each one as often as the others.',
    code: 'TDC271',
  });
}
