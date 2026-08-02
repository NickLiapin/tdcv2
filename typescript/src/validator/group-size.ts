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
import { contentElements, elementKind, elementName } from '../processor/walk.js';

import { nodeRange } from '../errors/source-map.js';

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
