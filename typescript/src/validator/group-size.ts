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
  findChildElement,
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
    // A `<compute>` is the same case reached from the other side: `f(x)` is
    // `f(x)`, so it has no pool to draw from and no column of its own to
    // rearrange. `uniq="true"` on such a sequence is already TDC218; inside a
    // GROUP it used to be accepted and then quietly do nothing — measured on
    // five rows, two records came out identical and nothing said so.
    const compute = findChildElement(k.node.content(), 'compute');
    if (compute !== undefined) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(compute),
        message:
          `<sequence name="${name ?? '?'}"> holds a <compute>, which cannot be a member of ` +
          `<${tag}>: it derives its value from other columns, so it has nothing of its own to ` +
          "rearrange and cannot keep the group's promise",
        hint:
          `Put the <${tag}> around the <gen> sequences the <compute> READS. Its value follows ` +
          'them, so arranging the inputs arranges the result.',
        code: 'TDC296',
      });
      continue;
    }
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

/**
 * What a `<sequence>` inside a group is, for the group's purposes.
 *
 * `pool` — it draws a whole MEMBER; the group compares which member.
 * `value` — it draws a value; the group compares the value.
 */
function groupMemberKind(
  seq: OpenCloseElementContext,
): { kind: 'pool'; pool: string } | { kind: 'value' } {
  const gens = collectSequenceGens(seq).nodes;
  if (gens.length !== 1) return { kind: 'value' };
  const attrs = extractAttrs(gens[0]?.attr() ?? []);
  if (attrs['type'] !== 'pool') return { kind: 'value' };
  return { kind: 'pool', pool: (attrs['value'] ?? '').trim() };
}

/**
 * A group whose members draw from a `<pool>`.
 *
 * The group's promise is kept by member IDENTITY here — no two of them hand one
 * row the same member of the pool — because a record has no value of its own to
 * compare. That works, and these are the three shapes it cannot mean:
 *
 *   - a reference beside an ordinary sequence: one holds a record and the other
 *     a string, and there is no field the comparison would be about;
 *   - references to two DIFFERENT pools: a doctor is never the same record as a
 *     ward, so the group would be satisfied without doing anything;
 *   - more references than the pool has members: no arrangement exists.
 *
 * All three used to be accepted and then do nothing at all — the config asked
 * for a constraint, the engine agreed, and the constraint was not there.
 */
export function checkGroupPoolMembers(
  wrapper: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  tag: string,
  poolCounts: ReadonlyMap<string, number>,
): void {
  const pooled: { node: OpenCloseElementContext; name: string; pool: string }[] = [];
  const plain: { node: OpenCloseElementContext; name: string }[] = [];
  for (const el of contentElements(wrapper.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'open' || elementName(k.node) !== 'sequence') continue;
    const name = extractAttrs(k.node.attr())['name'] ?? '?';
    const kind = groupMemberKind(k.node);
    if (kind.kind === 'pool') pooled.push({ node: k.node, name, pool: kind.pool });
    else plain.push({ node: k.node, name });
  }
  if (pooled.length === 0) return;

  if (plain.length > 0) {
    const first = plain[0];
    if (first) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(first.node),
        message:
          `<${tag}> mixes <sequence name="${first.name}">, which draws a value, with ` +
          `<sequence name="${pooled[0]?.name ?? '?'}">, which draws a whole member of pool ` +
          `"${pooled[0]?.pool ?? '?'}" — there is nothing the two can be compared on`,
        hint:
          `A <${tag}> over pool references compares WHICH MEMBER each row took; over ordinary ` +
          `sequences it compares the value. One group does one of the two. To keep a value ` +
          `away from a member's field, filter instead: <gen type="pool" ` +
          `filter="field != Other"/>.`,
        code: 'TDC302',
      });
    }
    return;
  }

  const pools = [...new Set(pooled.map((p) => p.pool))];
  if (pools.length > 1) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(wrapper),
      message:
        `<${tag}> holds references to ${String(pools.length)} different pools ` +
        `(${pools.join(', ')}) — a member of one is never a member of another, so the group ` +
        `would be satisfied without changing anything`,
      hint: `Group the references that draw from the SAME pool. Two pools cannot collide.`,
      code: 'TDC302',
    });
    return;
  }

  const pool = pools[0] ?? '';
  const available = poolCounts.get(pool);
  if (available !== undefined && available < pooled.length) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(wrapper),
      message:
        `<${tag}> puts ${String(pooled.length)} references on pool "${pool}", which has ` +
        `${String(available)} members — one row cannot give each of them a different one`,
      hint:
        `Raise count= on <pool name="${pool}"> to at least ${String(pooled.length)}, or take a ` +
        `reference out of the group.`,
      code: 'TDC302',
    });
  }
}
