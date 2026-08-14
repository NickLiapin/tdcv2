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

import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

/** Underline the offending value where there is one, the whole tag otherwise. */
function rangeOf(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  name: string,
): ReturnType<typeof nodeRange> {
  const attr: AttrContext | undefined = gen.attr().find((a) => a._attrName?.text === name);
  return attr ? attrValueRange(attr) : nodeRange(gen);
}

/**
 * `fit="low..high"` — where a drawing read from a FILE lands on the value axis.
 *
 * The drawing's own lowest and highest point become the two ends of this band.
 * Absent, they become the ends of `y_range` and the picture fills the axis.
 *
 * Two ways to write it wrong, both caught here rather than at the first row:
 * a band that is not two numbers, and a band that counts down. The second is
 * refused rather than read as "flip the drawing", because one attribute meaning
 * two things is the fault this whole area was straightened out to remove.
 *
 * It is a FILE attribute. `points=` / `upper=` / `lower=` already carry a board —
 * their 0..100 is percent of `y_range` — so a `fit=` beside them is a second
 * answer to a question already answered, and the config has to say which it
 * meant.
 */
function checkFit(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  attrMap: Record<string, string | undefined>,
  diagnostics: Diagnostic[],
): void {
  const raw = (attrMap['fit'] ?? '').trim();
  if (raw === '') return;

  const drawn = ['points', 'upper', 'lower'].filter((n) => (attrMap[n] ?? '').trim() !== '');
  if (drawn.length > 0) {
    const listed = drawn.map((n) => `${n}=`).join(' and ');
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...rangeOf(gen, 'fit'),
      message: `fit= is not read beside ${listed} — those points already carry a board`,
      hint:
        'A typed point is a percentage of the 0..100 board, so 80 already means 80% of ' +
        'y_range and there is nothing left for fit= to place. fit= is for a drawing read ' +
        "from src=, whose numbers are in some other tool's units. Drop one of the two.",
      code: 'TDC300',
    });
    return;
  }

  const parts = raw.split('..');
  const a = Number(parts[0]);
  const b = Number(parts[1]);
  if (parts.length !== 2 || !Number.isFinite(a) || !Number.isFinite(b)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...rangeOf(gen, 'fit'),
      message: `fit="${raw}" is not a band`,
      hint:
        'Write fit="low..high" with two numbers — the values the drawing\'s lowest and ' +
        'highest point become. Omit it entirely to have the drawing fill y_range.',
      code: 'TDC300',
    });
    return;
  }
  if (a > b) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...rangeOf(gen, 'fit'),
      message: `fit="${raw}" counts down — the low bound is above the high one`,
      hint:
        'Write the smaller number first. Turning the drawing upside down is a different ' +
        'request, and it is not what this attribute does.',
      code: 'TDC300',
    });
  }
}

export function checkGenPattern(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrMap = extractAttrs(gen.attr());
  checkFit(gen, attrMap, diagnostics);
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
