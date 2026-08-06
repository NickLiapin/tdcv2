/**
 * `repeat=` together with `order="sequential"`.
 *
 * The two attributes are each well defined on their own and undefined together,
 * and the engines proved it by disagreeing:
 *
 *   <gen type="text" value="created,paid,shipped,delivered" repeat="4" order="sequential"/>
 *
 *   engine 1        four elements per row, all of them the SAME value, and the
 *                   value does not advance from row to row either
 *   engines 2 and 3 the repeat list is dropped: ONE value per row, walking
 *
 * `check` called that document valid, so the author got a column of data that
 * looks plausible, is wrong, and is wrong DIFFERENTLY depending on which engine
 * answered. Refusing it is not a loss of a working feature — there was no
 * working feature to lose.
 *
 * ── Why refuse rather than implement ─────────────────────────────────────────
 * The reading a user wants is "the row's four elements walk the list", and it is
 * a real feature: the element index has to be threaded through the length-quota
 * layout that plans `repeat` — in the memory engine, in the keyed streaming
 * layout, and then in four ports. That is a wave of work with its own design
 * decisions (does the walk continue across rows, or restart per row?), not a
 * patch. Refusing it today stops the silent wrong data; the feature can be built
 * afterwards, against fixtures, like every other feature here.
 */

import type { Diagnostic } from '../errors/index.js';
import { attrValueRange } from '../errors/source-map.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}

export function checkSequentialRepeat(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  const attrs = gen.attr();
  const map = extractAttrs(attrs);
  if ((map['order'] ?? '').trim() !== 'sequential') return;
  const repeat = (map['repeat'] ?? '').trim();
  if (repeat === '') return;

  // Point at `repeat=`, not at `order=`: a walked column is the thing the author
  // asked for and can keep, and dropping `repeat=` is the edit that makes the
  // document mean one definite thing.
  const at = findAttr(attrs, 'repeat') ?? findAttr(attrs, 'order');
  if (!at) return;

  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(at),
    message: `repeat="${repeat}" cannot be combined with order="sequential"`,
    hint:
      'A walked list and a repeating list are two different columns, and together they have no ' +
      'one answer — the engines disagree about what they produce. Keep order="sequential" for a ' +
      'column that walks its source one value per row, or keep repeat= for several drawn values ' +
      'per row.',
    code: 'TDC254',
  });
}
