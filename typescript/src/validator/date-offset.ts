/**
 * Validation for `<gen type="date" of="…">` — a date measured from another date.
 *
 * `of=` is what turns a date generator from a DRAW into an OFFSET, and the two
 * are configured by different attributes entirely. That makes the mistakes here
 * silent ones by nature: a `from=` written beside an `of=` looks like it bounds
 * the result and does nothing at all, because the result is wherever the source
 * plus the offset lands. So each is named rather than ignored.
 *
 * The declaration-order complaint is TDC240, shared with `running` and `stat` —
 * the same rule, the same fix, and the offset is built in declaration order for
 * the same reason they are: it reads a column that has to exist already.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { attrValueRange, closestMatch, formatCandidates, nodeRange } from '../errors/index.js';
import { extractAttrs } from '../processor/walk.js';
import { OFFSET_SYNTAX, parseOffset } from '../date/calendar.js';

/**
 * Attributes that place a date generator's OWN draw, and so say nothing once
 * `of=` has placed it relative to another column.
 *
 * Listed by name because ignoring them is exactly the failure this exists to
 * prevent — a config that says `from="2026-06-01"` and gets January dates is
 * right about what it asked for and wrong about what it got.
 */
const DRAW_ATTRS = ['value', 'from', 'to', 'range', 'oldest', 'youngest', 'order', 'step'] as const;

/** Everything a date offset needs said, and nothing that contradicts it. */
export function checkGenDateOffset(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  declaredAbove: readonly string[],
  diagnostics: Diagnostic[],
  repeating: readonly string[] = [],
): void {
  const attrs = extractAttrs(gen.attr());
  if (attrs['type'] !== 'date') return;
  const of = (attrs['of'] ?? '').trim();
  if (of === '') return; // a plain date draw — validated in `date.ts`

  /** Underline the offending value where there is one, the whole tag otherwise. */
  const rangeOf = (name: string): ReturnType<typeof nodeRange> => {
    const attr = gen.attr().find((a) => a._attrName?.text === name);
    return attr ? attrValueRange(attr) : nodeRange(gen);
  };

  const plus = (attrs['plus'] ?? '').trim();
  if (plus === '') {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: `<gen type="date" of="${of}"> does not say how far from it`,
      hint:
        `Add plus="…" — ${OFFSET_SYNTAX}. A range is drawn per row, so plus="3..10d" is ` +
        'the length of the stay; a single value is the same distance on every row.',
      code: 'TDC264',
    });
  } else {
    const parsed = parseOffset(plus);
    if (!parsed.ok) {
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...rangeOf('plus'),
        message:
          parsed.reason === 'order'
            ? `plus="${plus}" counts down, not up — the low bound is above the high one`
            : `plus="${plus}" is not an offset`,
        hint:
          parsed.reason === 'order'
            ? 'Write the smaller number first. To measure BACKWARDS, make both negative: ' +
              'plus="-10..-3d".'
            : `One of: ${OFFSET_SYNTAX}. A bare number means days.`,
        code: 'TDC264',
      });
    }
  }

  for (const name of DRAW_ATTRS) {
    if (attrs[name] === undefined) continue;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...rangeOf(name),
      message: `${name}= is not read when the date is measured from of="${of}"`,
      hint:
        `An offset lands wherever ${of} plus the offset lands — ${name}= would have to ` +
        `contradict that to mean anything. Drop it, or drop of= and bound the draw itself.`,
      code: 'TDC264',
    });
  }

  // A `repeat=` source is a LIST in one cell, and an offset measures from a DATE.
  // The run said so in the worst possible words — it quoted the joined text and
  // blamed the format, sending the reader to look for a `format=` mistake that was
  // never there. The cause is the repetition, so name it.
  if (repeating.includes(of)) {
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...rangeOf('of'),
      message: `of="${of}" repeats, so each cell holds a LIST of dates rather than one date`,
      hint:
        'An offset measures from a single date. Drop repeat= on that column, or measure from ' +
        'one that does not repeat.',
      code: 'TDC240',
    });
  }

  if (!declaredAbove.includes(of)) {
    const suggestion = closestMatch(of, [...declaredAbove]);
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...rangeOf('of'),
      message: `of="${of}" is not a sequence declared above this one`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint:
        declaredAbove.length === 0
          ? 'A date is measured from a column that already exists, so the column it reads has ' +
            'to come first.'
          : `Declared above: ${formatCandidates([...declaredAbove])}.`,
      code: 'TDC240',
    });
  }
}
