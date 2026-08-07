/**
 * `${{Name}}` written into an attribute that does not read it.
 *
 * Interpolation reaches exactly two places: the TEXT inside `<data>`, and
 * `<gen type="template" value=>`, where a path may be finished by another
 * column. Everywhere else the braces are eight literal characters — and the
 * generator that receives them complains about whatever it happens to be
 * parsing, which is true and tells the reader nothing:
 *
 *     <gen type="number" value="1..${{N}}"/>   TDC081  invalid number range
 *     <gen type="date"   from="${{In}}"/>      TDC151  invalid date
 *     <gen type="regex"  value="${{N}}[0-9]"/> TDC097  quantifier must start with a number
 *     <gen type="symbol" alphabet="${{N}}"/>   TDC099  unknown alphabet
 *     <gen type="text"   value="${{N}}"/>      nothing at all — emits ${{N}} literally
 *
 * Five messages and one silence for one mistake, and none of them names it. The
 * reader has seen `${{}}` work in a `template` value and moves it one generator
 * across, which is the most natural thing in the world.
 *
 * So the cause is named once, here, before the generator ever sees the value.
 * The check is deliberately blind to WHICH attribute: a list of "attributes that
 * do not interpolate" would be every attribute but one, and would have to be
 * kept in step with every generator added later.
 *
 * It REPLACES the generator's own complaint rather than sitting beside it — the
 * same choice the XML-entity check in an `if=` makes, and for the same reason:
 * two messages for one mistake, one of them naming the wrong thing, is worse
 * than one that is right.
 */

import type { Diagnostic } from '../errors/index.js';
import type { AttrContext } from '../generated/TDCParser.js';
import { attrValueRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';

import { isDynamicTemplateValue } from './known.js';

/** The opening marker. The closing one is not needed — an unclosed one is the same mistake. */
const MARKER = '${{';

/**
 * Report `${{…}}` in any attribute of this `<gen>` that will not expand it.
 *
 * `template value=` is the one exception and is skipped by name; everything
 * else — including `value=` on any other type — is reported.
 */
export function checkAttrInterpolation(
  attrs: readonly AttrContext[],
  diagnostics: Diagnostic[],
): boolean {
  const map = extractAttrs(attrs);
  const type = (map['type'] ?? '').trim();
  let found = false;

  for (const attr of attrs) {
    const name = attr._attrName?.text ?? '';
    const raw = map[name] ?? '';
    if (!raw.includes(MARKER)) continue;
    // The one place it works: a pack path finished by another column, which is
    // the documented idiom for linked pairs.
    if (name === 'value' && type === 'template' && isDynamicTemplateValue(raw)) continue;

    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message: `${MARKER}…}} in ${name}= is not expanded — the braces are literal text here`,
      hint:
        'Interpolation reaches the text inside <data> and <gen type="template" value=>, and ' +
        'nowhere else. To make one column depend on another, read it in an if= condition, or ' +
        'build the value in a <compute> sequence.',
      code: 'TDC263',
    });
    found = true;
  }
  return found;
}
