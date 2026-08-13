/**
 * A `<uniq>` or `<distinct>` group that wraps fewer than two sequences.
 *
 * Such a group used to be dropped in silence: `check` said the config was
 * valid, the run succeeded, and the constraint the author asked for was simply
 * not there. Measured on the reference before this check existed — five rows
 * drawn from three values inside a one-member `<uniq>` came out `2 2 2 2 3`.
 *
 * It is a warning, not an error, because the config still runs and still means
 * something; what it does not do is what the author wrote it for.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext } from '../generated/TDCParser.js';
import {
  collectSequenceGens,
  contentElements,
  elementKind,
  elementName,
  extractAttrs,
} from '../processor/walk.js';

import { nodeRange } from '../errors/source-map.js';
import { isDerived } from './gen-type.js';

/**
 * Count the `<sequence>` members and warn if there are not enough to compare.
 *
 * `<sequence>`, `<mix>` and `<switch>` all count — every one of them is a
 * member the group can rearrange, a switch only within rows that share its
 * subject.
 */
export function checkGroupSize(
  wrapper: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  tag: string,
): void {
  let members = 0;
  for (const el of contentElements(wrapper.content())) {
    const k = elementKind(el);
    // A self-closing member is counted too. It is an error in its own right
    // (TDC036 — it can hold no <gen>), and counting it keeps THIS message
    // honest: "wraps no sequences" in front of two <sequence> tags reads as a
    // lie and sends the author looking in the wrong place.
    if (k?.kind !== 'open' && k?.kind !== 'self') continue;
    const name = elementName(k.node);
    if (name === 'sequence' || name === 'mix' || name === 'switch') members += 1;
  }
  if (members >= 2) return;

  const hint =
    tag === 'uniq'
      ? 'Put at least two <sequence> members in it, or drop the wrapper and write uniq="true" on the one sequence — that draws without replacement.'
      : 'Put at least two <sequence> members in it, or drop the wrapper: there is nothing for a single value to differ from.';

  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...nodeRange(wrapper),
    message: `<${tag}> wraps ${members === 0 ? 'no sequences' : 'one sequence'} — a group constrains its members against each other, so it does nothing here`,
    hint,
    code: 'TDC221',
  });
}

/**
 * A DERIVED column inside a `<uniq>` or `<distinct>` group.
 *
 * A group is a rearrangement: it keeps every member's multiset of values and
 * permutes the columns until each record is unique. That is sound for drawn
 * columns — a draw means the same thing wherever it lands — and it destroys a
 * derived one, whose value is a statement ABOUT the row it was computed for.
 *
 * Measured on the reference, `<uniq>` over `A` (1..5) and `F = A * 10`:
 *
 *     2|20   3|20   3|30   2|30   5|50
 *
 * Two of the five rows say that ten times three is twenty. Nothing warned:
 * `check` called the config valid, and a file whose arithmetic is wrong in
 * places is worse than one that refuses to be written.
 *
 * `<distinct>` is refused for the same reason from the other end: its repair
 * looks for a different value for a member, and a derived column has no draw to
 * repair with — so it either breaks the arithmetic or is quietly skipped,
 * leaving a group that does nothing.
 */
/** How to name a derived column in a message — `of=` is what makes a date one. */
function describe(type: string | undefined): string {
  return type === 'date'
    ? 'a date measured from another column (of=)'
    : `a type="${String(type)}" column`;
}

export function checkGroupDerivedMember(
  wrapper: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  tag: string,
): void {
  for (const el of contentElements(wrapper.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'open') continue;
    if (elementName(k.node) !== 'sequence') continue;
    const name = extractAttrs(k.node.attr())['name'];
    for (const gen of collectSequenceGens(k.node).nodes) {
      const attrs = extractAttrs(gen.attr());
      const type = attrs['type'];
      if (!isDerived(type, attrs)) continue;
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(gen),
        message:
          `<sequence name="${name ?? '?'}"> holds ${describe(type)}, which cannot be a member ` +
          `of <${tag}>: the group rearranges finished columns, and a computed value moved to ` +
          'another row no longer describes that row',
        hint:
          `Put the ${tag === 'uniq' ? 'uniq' : 'distinct'} group around the columns this one ` +
          'READS, and leave the computed column outside it. It follows whatever the group ' +
          'arranges, so it stays true row by row.',
        code: 'TDC296',
      });
      break;
    }
  }
}
