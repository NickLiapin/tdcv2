/**
 * `y_range=` on a `<gen type="pattern">` — the value axis, and required.
 *
 * A drawing carries no units of its own. The same curve leaves one tool running
 * 0..100, another 0..480, a third 0..10002345345, and none of those numbers mean
 * anything until somebody says what the axis is. `y_range` is that statement:
 * the picture's floor is its minimum, the picture's top is its maximum, and
 * nothing leaves the range whatever coordinates were drawn in.
 *
 * It used to be optional, and the alternative was worse than a missing value: a
 * drawing with no declared axis was measured against its own INK, so a line
 * across the middle of a canvas came out as the floor — nothing but zeros — and
 * a ripple of ten units was indistinguishable from a mountain across the whole
 * picture. Both are drawings whose author knew exactly what they meant.
 *
 * The generator refuses without it, but a refusal at run time is not enough: a
 * config that passes `check` and then dies is the exact defect this validator
 * exists to close.
 */

import { type Diagnostic, nodeRange } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

export function checkGenPattern(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrMap = extractAttrs(gen.attr());
  if ((attrMap['y_range'] ?? '').trim() !== '') return;

  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(gen),
    message: '<gen type="pattern"> needs y_range — a drawing has no scale of its own',
    hint:
      'y_range="min..max" is the value axis the picture is brought into: its floor is the ' +
      'minimum, its top is the maximum, and nothing leaves the range. Without it the drawing ' +
      'would be measured against its own ink, so a flat line halfway up would come out at the ' +
      'floor. Write y_range="0..100" for a percentage canvas, or the units you actually mean.',
    code: 'TDC293',
  });
}
