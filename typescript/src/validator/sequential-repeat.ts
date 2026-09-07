/**
 * `repeat=` together with `order="sequential"`.
 *
 * A FIXED repeat is a feature and lives in the engines: the row's N values walk
 * the source, element k of row r taking source index `r * N + k`. At `repeat="1"`
 * that is exactly what `order="sequential"` alone has always done, which is what
 * makes it the right generalisation rather than a second meaning.
 *
 * A RANGED repeat is what stays refused, and the reason is the stride. A walk
 * advances by a fixed number of values per row; a row whose length is decided by
 * the length quota has no such number, and any answer would make row r depend on
 * how many values the rows before it happened to take — which is precisely what
 * every engine here is built not to do.
 *
 * ── What it used to be ───────────────────────────────────────────────────────
 * Both spellings were refused, because both produced different data on different
 * engines:
 *
 *   <gen type="text" value="created,paid,shipped,delivered" repeat="4" order="sequential"/>
 *
 *   engine 1        four elements per row, all of them the SAME value, and the
 *                   value did not advance from row to row either
 *   engines 2 and 3 the repeat list was dropped: ONE value per row, walking
 *
 * `check` called that document valid, so the author got a column of data that
 * looked plausible, was wrong, and was wrong DIFFERENTLY depending on which
 * engine answered.
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
  // asked for and can keep, and it is the repeat that has to become a number.
  const at = findAttr(attrs, 'repeat') ?? findAttr(attrs, 'order');
  if (!at) return;

  // A walked DATE keeps an instant beside its text, which is what lets `of=`
  // and `plus=` read it. One row holding several dates has no single instant to
  // hand them, so the pairing would go quiet rather than wrong — and quiet is
  // worse. Walk the dates one per row, or repeat a text list.
  const type = (map['type'] ?? '').trim();
  if (type === 'date') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(at),
      message: `repeat="${repeat}" cannot be combined with order="sequential" on a date`,
      hint:
        'A walked date carries an instant beside its text, and a row holding several dates has ' +
        'no single one to give of= and plus=. Walk the dates one per row, or repeat a ' +
        '<gen type="text"> list.',
      code: 'TDC254',
    });
    return;
  }

  if (repeat.includes('..')) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(at),
      message: `repeat="${repeat}" cannot be combined with order="sequential"`,
      hint:
        'A walk advances by a fixed number of values per row, and a row whose length comes from ' +
        'the length quota has no such number — row 5 would start wherever rows 0 to 4 happened ' +
        'to leave off. Give repeat= one number for a walked list, or drop order="sequential" ' +
        'for a fan-out of drawn values.',
      code: 'TDC254',
    });
    return;
  }

  // `distinct` draws without replacement, and a walked row draws nothing: its
  // values are decided by its position. Honouring both is not possible, and
  // silently ignoring one is how a config comes to claim something it never had.
  if ((map['distinct'] ?? '').trim().toLowerCase() === 'true') {
    const where = findAttr(attrs, 'distinct') ?? at;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(where),
      message: 'distinct="true" cannot be combined with order="sequential"',
      hint:
        'A walked row draws nothing — its values are decided by its position — so there is no ' +
        'draw for distinct= to make without replacement. Remove distinct=, or remove ' +
        'order="sequential" so the row draws its values.',
      code: 'TDC307',
    });
  }
}
