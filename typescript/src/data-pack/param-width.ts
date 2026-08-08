/**
 * How many characters a composed pack's own `<sequence>` produces, when that is
 * a FACT rather than a guess.
 *
 * A pack parameter replaces one of the pack's sequences for the run:
 * `<gen type="template" value="usa.finance.aba_routing" prefix="12"/>` swaps the
 * pack's own `prefix`. That is the documented way to pin part of an identifier.
 *
 * The packs that carry a CHECK DIGIT compute it over a fixed layout, so a pinned
 * value of the wrong width does not shift the layout — it breaks it. Measured on
 * `usa.finance.aba_routing`, whose `prefix` is 2 characters and `tail` is 6:
 *
 *     prefix="12345"  →  the run aborts: <at>: index 8 is out of range
 *     tail="678"      →  326784 — six digits, and not a routing number
 *
 * `check` passed on both. The first names no file, line or code; the second says
 * nothing at all and writes data that looks right.
 *
 * So the width is worked out here, and ONLY where it can be proven from the
 * pack's own body. Three shapes carry a width; everything else returns
 * undefined and the caller stays silent, because a refusal has to be a proof:
 *
 *     <gen type="text" value="01,02,03"/>     every alternative is 2 → 2
 *     <gen type="regex" value="[0-9]{6}"/>    one class, fixed count → 6
 *     <gen type="number" value="0000..9999"/> zero-padded, equal ends → 4
 *
 * A list whose alternatives differ in length has no width. Neither has a name, a
 * `{2,4}` quantifier, an unpadded range, or a nested `template`.
 */

import type { SequenceSpec } from '../sequence/types.js';

/** One class or escape repeated an exact number of times: `[0-9]{6}`, `\d{4}`. */
const FIXED_REGEX = /^(?:\[[^\]]+\]|\\[dwsDWS]|[A-Za-z0-9])\{(\d+)\}$/;

/** `0000..9999` — both ends the same width, and the low end zero-padded. */
const NUMBER_RANGE = /^(-?\d+)\.\.(-?\d+)$/;

/**
 * The exact character count this generator always produces, or undefined when
 * it varies or cannot be read off the spec.
 */
function fixedWidth(type: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;

  if (type === 'text') {
    const items = value.split(',');
    if (items.length < 2) return undefined; // a single literal is not a list
    // Code points, like every other width in the formatting layer.
    const width = Array.from(items[0] ?? '').length;
    return items.every((item) => Array.from(item).length === width) ? width : undefined;
  }

  if (type === 'regex') {
    const m = FIXED_REGEX.exec(value);
    return m?.[1] === undefined ? undefined : Number(m[1]);
  }

  if (type === 'number') {
    const m = NUMBER_RANGE.exec(value);
    if (!m) return undefined;
    const [, low = '', high = ''] = m;
    // Only a zero-padded range has a fixed width: `1..9999` is 1 to 4 characters.
    return low.length === high.length && low.startsWith('0') ? low.length : undefined;
  }

  return undefined;
}

/** Parameter name → the width the pack's own sequence always produces. */
export type ParamWidths = ReadonlyMap<string, number>;

/** Read the provable widths out of a composed pack's sequences. */
export function parameterWidths(sequences: readonly SequenceSpec[]): ParamWidths {
  const out = new Map<string, number>();
  for (const seq of sequences) {
    const gen = seq.gen;
    if (!gen) continue; // a compound sequence has no single width
    const width = fixedWidth(gen.type, gen.attrs['value']);
    // A generator wrapped in repetition or formatting no longer produces the
    // bare width read above.
    const plain =
      gen.attrs['repeat'] === undefined &&
      gen.attrs['mask'] === undefined &&
      gen.attrs['missing'] === undefined;
    if (width !== undefined && plain) out.set(seq.name, width);
  }
  return out;
}
