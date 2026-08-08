/**
 * The ARGUMENT of an interpolation filter — the part after the colon.
 *
 * The filter NAME has been checked since TDC192, and a mask pattern since
 * TDC199/TDC256. The argument of every other filter reached the renderer
 * unread, and the renderer is lenient by design: `applyGroup` returns the value
 * untouched when the size is not a usable number, `applyCompact` when the base
 * is outside 2..36. That leniency is right at render time — one bad row must not
 * abort a million-row run — but it means the config says one thing and the
 * output does another, with nothing said anywhere. Measured, all five accepted:
 *
 *     ${{N|group:abc}}    the digits come out ungrouped
 *     ${{N|group:0}}      the same
 *     ${{N|compact:1}}    base below 2 — the number comes out unchanged
 *     ${{N|compact:99}}   base above 36 — the same
 *     ${{N|slice:abc}}    the whole value, unsliced
 *     ${{N|slice:5,2}}    the column comes out EMPTY
 *     ${{N|trim:junk}}    the argument is read by nothing
 *
 * The last two are the ones that cost real time: an empty column looks like a
 * generator that failed, and an ignored argument looks like a filter that does
 * not work.
 *
 * What is NOT refused, deliberately:
 *
 * - `group` and `compact` with no argument at all — both have a documented
 *   default (3, and base 36).
 * - `csv:;` — the delimiter is accepted and ignored on purpose; the filter
 *   quotes unconditionally, and the argument documents intent at the call site.
 * - a negative `slice` index — `slice:-3` is the last three characters, and
 *   `slice:-3,-1` is a legitimate range. Only a from/to pair of the SAME sign
 *   can be proven empty; with mixed signs the answer depends on the value's
 *   length, and a refusal has to be a proof.
 */

import type { Diagnostic } from '../errors/index.js';
import type { DataElementContext } from '../generated/TDCParser.js';
import { nodeRange } from '../errors/index.js';

/** Filters whose whole job is the transform; an argument reaches nothing. */
const NO_ARGUMENT = ['trim', 'sql', 'upper', 'lower', 'capitalize', 'title'] as const;

/** `-3`, `0`, `12` — nothing else. `Number()` alone accepts `1e3`, ` 5 ` and `0x10`. */
function wholeNumber(text: string): number | undefined {
  return /^-?\d+$/.test(text.trim()) ? Number(text.trim()) : undefined;
}

function push(
  diagnostics: Diagnostic[],
  node: DataElementContext,
  message: string,
  hint: string,
  code: string,
): void {
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(node),
    message,
    hint,
    code,
  });
}

/**
 * Check one `kind:arg` pair from a `${{X|filter:arg}}` reference.
 *
 * `mask` is not handled here — it has its own two checks beside this one.
 */
export function checkFilterArg(
  kind: string,
  arg: string | undefined,
  node: DataElementContext,
  diagnostics: Diagnostic[],
): void {
  if ((NO_ARGUMENT as readonly string[]).includes(kind) && arg !== undefined) {
    push(
      diagnostics,
      node,
      `the "${kind}" filter takes no argument — ":${arg}" is read by nothing`,
      `Write \${{X|${kind}}}. Chain filters with more pipes instead: \${{X|trim|${kind}}}.`,
      'TDC274',
    );
    return;
  }

  if (kind === 'replace' && (arg === undefined || arg === '' || arg.startsWith(','))) {
    push(
      diagnostics,
      node,
      'the "replace" filter needs something to look for — ${{X|replace}} changes nothing',
      'Write both parts: ${{X|replace:from,to}}. Leave the second empty to delete: ' +
        '${{X|replace:-,}}.',
      'TDC275',
    );
    return;
  }

  if (kind === 'slice') {
    if (arg === undefined || arg.trim() === '') {
      push(
        diagnostics,
        node,
        'the "slice" filter needs a start index — ${{X|slice}} keeps the whole value',
        'Write ${{X|slice:0,4}} for the first four characters, or ${{X|slice:-3}} for the ' +
          'last three. Indices are 0-based and the end is exclusive.',
        'TDC273',
      );
      return;
    }
    const parts = arg.split(',');
    const from = wholeNumber(parts[0] ?? '');
    const rawTo = parts[1];
    const to = rawTo === undefined || rawTo.trim() === '' ? undefined : wholeNumber(rawTo);
    if (from === undefined || (rawTo !== undefined && rawTo.trim() !== '' && to === undefined)) {
      push(
        diagnostics,
        node,
        `"slice:${arg}" is not a pair of indices — the value comes out unsliced`,
        'Indices are whole numbers, 0-based, end exclusive: ${{X|slice:0,4}}. A negative index ' +
          'counts from the end: ${{X|slice:-3}}.',
        'TDC273',
      );
      return;
    }
    // Same sign, so the ORDER is decidable without knowing the value's length.
    if (to !== undefined && from >= 0 === to >= 0 && from > to) {
      push(
        diagnostics,
        node,
        `"slice:${arg}" ends before it starts — the column comes out empty`,
        `Swap them: \${{X|slice:${String(to)},${String(from)}}}. The end is exclusive, ` +
          'so 0,4 is four characters.',
        'TDC273',
      );
    }
    return;
  }

  if (kind === 'group' && arg !== undefined && arg !== '') {
    const size = wholeNumber(arg.split(',')[0] ?? '');
    if (size === undefined || size <= 0) {
      push(
        diagnostics,
        node,
        `"group:${arg}" is not a group size — the value comes out ungrouped`,
        'The size is a whole number above zero, counted from the RIGHT: ${{X|group:3}} → ' +
          '1 234 567. A separator follows it: ${{X|group:4,-}}.',
        'TDC273',
      );
    }
    return;
  }

  if (kind === 'compact' && arg !== undefined && arg !== '') {
    const base = wholeNumber(arg);
    if (base === undefined || base < 2 || base > 36) {
      push(
        diagnostics,
        node,
        `"compact:${arg}" is not a base between 2 and 36 — the number comes out unchanged`,
        'The base is a whole number from 2 to 36; 36 is the default and the shortest. ' +
          'Base 1 has no digits to write with, and there are only 36 letters and digits.',
        'TDC273',
      );
    }
  }
}
