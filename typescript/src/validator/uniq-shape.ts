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
  // A simple sequence is ONE unnamed <gen> and no literal beside it. That is the
  // body the uniq draw replaces wholesale, taking the formatting layer with it.
  const gen = gens.length === 1 && !hasLiteral ? gens[0] : undefined;
  if (gen === undefined || extractAttrs(gen.attr())['name'] !== undefined) return;
  const genAttrs = extractAttrs(gen.attr());
  const type = genAttrs['type'] ?? '';
  if (type === 'increment' || type === 'decrement') return;
  const asked = DROPPED_BY_UNIQ.filter((a) => genAttrs[a] !== undefined);
  if (asked.length === 0) return;
  const list = asked.map((a) => `${a}=`).join(', ');
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
