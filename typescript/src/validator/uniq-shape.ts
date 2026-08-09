/**
 * Shape checks for `uniq="true"`: the bodies that cannot keep the promise.
 *
 * `uniq` is a property of a DRAW. The engine has exactly two mechanisms for it —
 * take from a pool without replacement, or rearrange the columns the sequence
 * owns — and both need the sequence's own value to BE a draw. A body that
 * derives its value, picks it per row, or joins several draws into one string
 * satisfies neither, so the attribute could only ever be ignored. It used to be,
 * in silence, which is the worst of the outcomes: the config claims the column
 * is unique, the data disagrees, and nothing says a word.
 *
 * These live apart from the main validator because they are one idea told three
 * ways, and because `validate.ts` is at its line ceiling.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

/** The `uniq` attribute node when it is declared `true`, else nothing. */
function declaredUniq(seqEl: OpenCloseElementContext): AttrContext | undefined {
  const raw = (extractAttrs(seqEl.attr())['uniq'] ?? '').trim().toLowerCase();
  if (raw !== 'true') return undefined;
  for (const a of seqEl.attr()) {
    if (a._attrName?.text === 'uniq') return a;
  }
  return undefined;
}

/**
 * `uniq="true"` where the value is not DRAWN at all — a `<compute>` result, or a
 * per-row pick among `<gen if="…">` branches. There is no pool and no column of
 * its own, so there is nothing to draw without replacement or to rearrange.
 */
export function checkUniqUnsupported(
  seqEl: OpenCloseElementContext,
  name: string | undefined,
  why: string,
  diagnostics: Diagnostic[],
): void {
  const attr = declaredUniq(seqEl);
  if (attr === undefined) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message: `uniq="true" is not allowed on <sequence name="${name ?? '?'}">: ${why}`,
    hint:
      'Put uniq= on the sequences this one reads, or wrap them in <uniq>…</uniq> so their ' +
      'combination is unique across records. When the parts have fixed widths, a unique ' +
      'combination means a unique result.',
    code: 'TDC218',
  });
}

/**
 * `uniq="true"` on a composed value that joins two or more DRAWN parts.
 *
 * One drawn part plus constants is fine and is honoured: appending a constant
 * cannot make two different draws collide, so drawing that part without
 * replacement makes the whole value unique. Two drawn parts is a different
 * story — the parts have no fixed widths, so a unique set of parts is not a
 * unique join: `9` + `15` and `91` + `5` are the same three characters.
 */
export function checkUniqOnComposed(
  seqEl: OpenCloseElementContext,
  name: string | undefined,
  gens: readonly (OpenCloseElementContext | SelfClosingElementContext)[],
  diagnostics: Diagnostic[],
): void {
  const attr = declaredUniq(seqEl);
  if (attr === undefined) return;
  // Only the UNNAMED gens build the value; a named one is a field beside it.
  const drawn = gens.filter((g) => extractAttrs(g.attr())['name'] === undefined).length;
  if (drawn < 2) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message:
      `uniq="true" cannot be honoured on <sequence name="${name ?? '?'}">: its value joins ` +
      `${String(drawn)} drawn parts, and a unique set of parts is not a unique join when the ` +
      'parts have no fixed width',
    hint:
      'Give each part its own <sequence> and wrap them in <uniq>…</uniq>, with a fixed width ' +
      'per part (length= plus first_zero="true" on a number). Then the join can be split back ' +
      'one way only, so a unique combination is a unique result.',
    code: 'TDC220',
  });
}

/**
 * Attributes that reach the value AFTER it is drawn, and so cannot survive a
 * draw without replacement.
 *
 * Every one of them can make two distinct draws print the same text — a mask
 * hides the digits that told them apart, `case` folds `ab` and `AB` together,
 * `missing` writes the same blank on many rows, `repeat` turns the cell into a
 * list. The formatting pipeline is skipped entirely on the uniq path, so today
 * they simply vanish; applying them instead would keep the attribute and break
 * the promise. Neither is acceptable in silence, so the config is refused and
 * the attribute is named.
 */
const DROPPED_BY_UNIQ = [
  'mask',
  'case',
  'missing',
  'missing_as',
  'repeat',
  'separator',
  'anomaly',
  'anomaly_flag',
] as const;

/**
 * `uniq="true"` on a simple sequence whose `<gen>` also asks for formatting,
 * blanking or repetition.
 *
 * `increment` and `decrement` are exempt: they are unique by construction, keep
 * their ordinary build, and their formatting runs as it does anywhere else.
 */
export function checkUniqDropsAttrs(
  seqEl: OpenCloseElementContext,
  name: string | undefined,
  gens: readonly (OpenCloseElementContext | SelfClosingElementContext)[],
  hasLiteral: boolean,
  diagnostics: Diagnostic[],
): void {
  const attr = declaredUniq(seqEl);
  if (attr === undefined) return;
  // Every <gen> the uniq construction replaces — the ONE unnamed gen of a simple
  // sequence, or ALL the fields of a compound one.
  //
  // This used to look only at the simple shape, and a compound was where it
  // mattered most: `<sequence uniq="true">` over two named gens, one carrying
  // `missing="0.4"`, produced ZERO blanks over twelve rows while the missing-data
  // guide says `missing` "combines with anything". `check` called it valid.
  const only = gens.length === 1 && !hasLiteral ? gens[0] : undefined;
  const simple = only !== undefined && extractAttrs(only.attr())['name'] === undefined;
  const members = simple
    ? [only]
    : gens.filter((g) => extractAttrs(g.attr())['name'] !== undefined);
  if (members.length === 0) return;
  const asked = new Set<string>();
  for (const gen of members) {
    const genAttrs = extractAttrs(gen.attr());
    const type = genAttrs['type'] ?? '';
    if (type === 'increment' || type === 'decrement') continue;
    for (const a of DROPPED_BY_UNIQ) if (genAttrs[a] !== undefined) asked.add(a);
  }
  if (asked.size === 0) return;
  const list = [...asked].map((a) => `${a}=`).join(', ');
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message:
      `uniq="true" on <sequence name="${name ?? '?'}"> cannot be combined with ${list} on its ` +
      '<gen>: a draw without replacement produces the values directly, so nothing that ' +
      'rewrites them afterwards runs',
    hint:
      'Two ways out. Drop the attribute if the uniqueness is what you wanted — or drop uniq= ' +
      'and keep the formatting, since a masked, blanked or repeated column cannot be unique ' +
      'as text anyway: a mask maps different values onto the same characters.',
    code: 'TDC267',
  });
}

/**
 * `<distinct>` inside a `uniq="true"` sequence.
 *
 * They are described as independent — "use either one, or both at once" — and
 * they are not. `<distinct>` repairs a row so its fields differ; `uniq`
 * afterwards REARRANGES the whole columns to make the records unique, and the
 * rearrangement knows nothing about which pairings the repair ruled out. So the
 * repair is undone, silently:
 *
 *     <sequence uniq="true"><distinct> A,B over p,q,r,s </distinct></sequence>
 *     12 rows, 12 legal distinct pairs — and the run still produced s,s and q,q
 *
 * The request was exactly satisfiable and the answer still broke the rule the
 * config states. Refused rather than half-kept: a row that violates `<distinct>`
 * is the one thing the tag exists to prevent.
 */
export function checkUniqWithDistinct(
  seqEl: OpenCloseElementContext,
  name: string | undefined,
  distinctGroups: readonly (readonly unknown[])[],
  diagnostics: Diagnostic[],
): void {
  const attr = declaredUniq(seqEl);
  if (attr === undefined || distinctGroups.length === 0) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...attrValueRange(attr),
    message:
      `uniq="true" on <sequence name="${name ?? '?'}"> cannot be combined with <distinct>: ` +
      'the uniq arrangement rearranges the finished columns and does not know which pairings ' +
      '<distinct> ruled out, so the repair is undone',
    hint:
      'Keep one of the two. <distinct> is about a single record (its fields differ); uniq= is ' +
      'about the whole column (no record repeats). For both at once, give each field its own ' +
      '<sequence>, wrap them in <uniq>…</uniq>, and put the <distinct> at env level.',
    code: 'TDC267',
  });
}
