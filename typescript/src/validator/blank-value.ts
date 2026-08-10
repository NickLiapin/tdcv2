/**
 * A written attribute whose text is blank is written, not absent.
 *
 * Every per-type check below used to ask only whether the attribute NODE was
 * there, so `value=""` walked past a guard meant to catch a missing list and
 * each generator then improvised. Measured across the five implementations, the
 * same six files disagreed:
 *
 *     <gen type="number" value=""/>      reference refused, four ports printed 4 2 8
 *     <gen type="text" value=""/>        reference printed empty cells, four ports refused
 *     <gen type="increment" value=""/>   reference counted 0 1 2, four ports refused
 *
 * The line between blank and absent is not a matter of taste, and the engines
 * already draw it in the one place they agree: `value=","` is two options that
 * both happen to be empty, and all five accept it; `value="()"` is a pattern
 * that matches the empty string, and all five accept that too. What none of them
 * can honour is a list with NO options and a pattern that is NO pattern — there
 * is nothing to draw from, so the value has to be invented. That is the proof a
 * refusal needs, and it is why `,` and `()` stay legal while `""` does not.
 *
 * Whitespace counts as blank: a lone space is trimmed away before anything reads
 * it, so `value=" "` names no option either.
 */

import type { AttrContext } from '../generated/TDCParser.js';

/** The attribute node by name, so a complaint can point at its value. */
export function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  return attrs.find((a) => a._attrName?.text === name);
}

/**
 * True when the attribute text is nothing but whitespace.
 *
 * Written as a test on the VALUE rather than on the pair so each call site can
 * keep the `!attrNode ||` it already had, and with it the narrowing that lets the
 * rest of the check point at the attribute.
 */
export function isBlank(value: string | undefined): boolean {
  return (value ?? '').trim() === '';
}
