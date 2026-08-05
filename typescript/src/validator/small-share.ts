/**
 * A share that asks for less than one whole row.
 *
 * `percent` is an exact quota over the rows that reach it, not a chance rolled
 * per row. Ten percent of a five-row subset asks for HALF a record, and half a
 * record cannot be emitted — so the branch produces one or none, and the seed
 * alone decides which. The engine rounds and says nothing, which is how a column
 * that came out empty reads as a config that was never written rather than one
 * that rounded away.
 *
 * It is a warning, not an error. The config runs, the totals still sum to
 * `count`, and nothing is lost; what does not happen is what the author wrote.
 *
 * ── Why the denominator is knowable ──────────────────────────────────────────
 * The obstacle sounds like "the validator cannot know how many rows reach the
 * branch", and for the shapes people actually write it can:
 *
 *   - a `<mix>` or a `<gen percent=>` at the top of `<env>` — the denominator is
 *     `count`;
 *   - either of those with `parent="Seq.Value"` — `count` x that value's share;
 *   - a `<mix>` inside `<case is="X">` of `<switch on="S">` — `count` x the share
 *     `X` takes of `S`.
 *
 * A share is only known when the subject is a plain `text` generator writing its
 * own `percent`. Anywhere else — a file, a pack, an expression — this stays
 * SILENT. A check that guessed the denominator would fire on working configs and
 * be turned off, which is worse than the silence it replaces.
 */

import type { Diagnostic } from '../errors/index.js';
import { nodeRange } from '../errors/source-map.js';
import { expandPercentMask } from '../distribution/percent-mask.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';

/** Rows a value takes, as a fraction, for every sequence that writes its own shares. */
type Shares = Map<string, Map<string, number>>;

/**
 * Warn about every share below one row that this `<env>` can be shown to hold.
 *
 * Runs as its own pass rather than inline: the denominator of a `<mix>` in a
 * switch branch belongs to the switch, and threading it down through the case
 * walk would put an argument about arithmetic into five signatures that are
 * about structure.
 */
export function checkSmallShares(
  envEl: OpenCloseElementContext,
  count: number,
  diagnostics: Diagnostic[],
): void {
  if (count <= 0) return;
  const shares: Shares = new Map();

  for (const el of contentElements(envEl.content())) {
    const k = elementKind(el);
    if (!k || (k.kind !== 'open' && k.kind !== 'self')) continue;
    const name = elementName(k.node);

    if (name === 'sequence' && k.kind === 'open') {
      readSequence(k.node, count, shares, diagnostics);
      continue;
    }
    if (name === 'mix' && k.kind === 'open') {
      const rows = rowsOf(extractAttrs(k.node.attr())['parent'], count, shares);
      reportIfThin(k.node, branchCount(k.node), rows, diagnostics);
      continue;
    }
    if (name === 'switch' && k.kind === 'open') {
      readSwitch(k.node, count, shares, diagnostics);
    }
  }
}

/**
 * A sequence: record what its values are worth, and check its own share.
 *
 * The recording is what later branches read, so it happens even when the
 * sequence itself has nothing to warn about.
 */
function readSequence(
  seqEl: OpenCloseElementContext,
  count: number,
  shares: Shares,
  diagnostics: Diagnostic[],
): void {
  const seqAttrs = extractAttrs(seqEl.attr());
  const rows = rowsOf(seqAttrs['parent'], count, shares);

  const gens: (OpenCloseElementContext | SelfClosingElementContext)[] = [];
  for (const el of contentElements(seqEl.content())) {
    const k = elementKind(el);
    if (!k || (k.kind !== 'open' && k.kind !== 'self')) continue;
    if (elementName(k.node) === 'gen') gens.push(k.node);
  }

  // One generator, or the sequence is a compound and its values are not a list
  // this can reason about.
  if (gens.length !== 1) return;
  const gen = gens[0];
  if (!gen) return;
  const attrs = extractAttrs(gen.attr());
  if (attrs['type'] !== 'text') return;

  const values = (attrs['value'] ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter((v) => v !== '');
  const mask = attrs['percent'];
  if (values.length === 0 || mask === undefined) return;

  const percents = safeExpand(mask, values.length);
  if (!percents) return;

  const name = seqAttrs['name'];
  if (name !== undefined && name !== '' && rows !== undefined) {
    const map = new Map<string, number>();
    for (let i = 0; i < values.length; i++) {
      const value = values[i];
      const percent = percents[i];
      if (value !== undefined && percent !== undefined) map.set(value, percent / 100);
    }
    shares.set(name, map);
  }

  reportIfThin(gen, values.length, rows, diagnostics);
}

/** Each `<case is="X">` of a switch, with the rows that value takes. */
function readSwitch(
  switchEl: OpenCloseElementContext,
  count: number,
  shares: Shares,
  diagnostics: Diagnostic[],
): void {
  const subject = extractAttrs(switchEl.attr())['on'];
  const table = subject === undefined ? undefined : shares.get(subject);
  if (!table) return;

  for (const el of contentElements(switchEl.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'open' || elementName(k.node) !== 'case') continue;

    const is = extractAttrs(k.node.attr())['is'];
    if (is === undefined) continue;
    // `is="US|CA"` matches either, so the branch takes both their shares.
    let fraction = 0;
    let known = true;
    for (const key of is.split('|').map((v) => v.trim())) {
      const share = table.get(key);
      if (share === undefined) known = false;
      else fraction += share;
    }
    if (!known) continue;

    for (const inner of contentElements(k.node.content())) {
      const ik = elementKind(inner);
      if (ik?.kind !== 'open' || elementName(ik.node) !== 'mix') continue;
      reportIfThin(ik.node, branchCount(ik.node), count * fraction, diagnostics);
    }
  }
}

/** How many `<case>` branches a `<mix>` holds. */
function branchCount(mixEl: OpenCloseElementContext): number {
  let n = 0;
  for (const el of contentElements(mixEl.content())) {
    const k = elementKind(el);
    if (k && (k.kind === 'open' || k.kind === 'self') && elementName(k.node) === 'case') n += 1;
  }
  return n;
}

/**
 * Rows reaching something whose `parent` is `Seq.Value`, or `count` when it has
 * no parent. Undefined when the parent's shares are not written down.
 */
function rowsOf(parent: string | undefined, count: number, shares: Shares): number | undefined {
  if (parent === undefined || parent.trim() === '') return count;
  const at = parent.indexOf('.');
  if (at < 0) return undefined;
  const share = shares.get(parent.slice(0, at))?.get(parent.slice(at + 1));
  return share === undefined ? undefined : count * share;
}

/** The mask, or undefined when it does not parse — somebody else's diagnostic. */
function safeExpand(mask: string, values: number): number[] | undefined {
  try {
    return expandPercentMask(mask, values);
  } catch {
    return undefined;
  }
}

/**
 * Report the smallest share that asks for less than a row.
 *
 * One diagnostic per element, not one per share: a four-branch mix over three
 * rows would otherwise say the same thing four times about one mistake.
 */
function reportIfThin(
  el: OpenCloseElementContext | SelfClosingElementContext,
  branches: number,
  rows: number | undefined,
  diagnostics: Diagnostic[],
): void {
  if (rows === undefined || rows <= 0 || branches <= 0) return;
  const own = extractAttrs(el.attr());
  const mask = own['percent'];
  if (mask === undefined) return;

  // `repeat=` plans the quota over ELEMENTS, not rows: three per row over four
  // rows is twelve draws, and `repeat="1..3"` does not even fix how many. The
  // denominator here is rows, so it is the wrong number — say nothing.
  if ((own['repeat'] ?? '').trim() !== '') return;
  const percents = safeExpand(mask, branches);
  if (!percents) return;

  let worst: number | undefined;
  for (const percent of percents) {
    if (percent <= 0) continue; // a zero share asks for nothing on purpose
    if ((percent / 100) * rows >= 1) continue;
    if (worst === undefined || percent < worst) worst = percent;
  }
  if (worst === undefined) return;

  const asked = twoPlaces((worst / 100) * rows);
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...nodeRange(el),
    message:
      `percent="${twoPlaces(worst)}" over ${twoPlaces(rows)} rows asks for ${asked} records — ` +
      'the result is 0 or 1, and the seed decides which',
    hint:
      'A share below one whole row cannot be emitted, so the branch fires once or not at all. ' +
      'Raise the share, or raise count= until the share covers a whole row.',
    code: 'TDC251',
  });
}

/** Two decimals at most, and no trailing zeros — `0.5`, not `0.50`. */
function twoPlaces(value: number): string {
  return String(Math.round(value * 100) / 100);
}
