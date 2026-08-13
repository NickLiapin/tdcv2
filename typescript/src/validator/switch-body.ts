/**
 * The body of a `<switch>`: its `<map>` rows and the attributes of its cases.
 *
 * A `<map>` body: `KEY:VALUE` rows separated by commas.
 *
 * A row without its colon is skipped rather than refused — one malformed entry
 * in a table of two hundred should not stop the run — so it is said out loud, or
 * the lookup would quietly be missing a case nobody could see was gone.
 */

import { type Diagnostic, attrValueRange, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  MapElementContext,
  OpenCloseElementContext,
} from '../generated/TDCParser.js';
import { extractMapText } from '../processor/walk.js';

/** Validate a `<map>` body; returns the number of parsed entries. */
export function checkSwitchMap(
  mapEl: MapElementContext,
  ctx: { diagnostics: Diagnostic[] },
  /** The values the subject can produce, when they are known from the config. */
  subjectValues?: readonly string[],
): number {
  const text = extractMapText(mapEl);
  let entries = 0;
  for (const rawRow of text.split(',')) {
    const row = rawRow.trim();
    if (row.length === 0) continue;
    if (!row.includes(':')) {
      ctx.diagnostics.push({
        severity: 'warning',
        source: 'validator',
        ...nodeRange(mapEl),
        message: `malformed <map> row "${row}" — expected KEY:VALUE`,
        hint: 'Each entry is KEY:VALUE, entries separated by commas, multi-key via "|" (US|CA:USD).',
        code: 'TDC136',
      });
      continue;
    }
    entries += 1;
    // A key the subject never produces — the `<map>` half of the same question
    // `<case is="…">` answers below. `<map>` splits ENTRIES on commas and keys
    // within an entry on `|`, so `a:1, zzz:2` is two entries and `zzz` is the
    // unreachable one.
    if (subjectValues !== undefined && subjectValues.length > 0) {
      const key = row.slice(0, row.indexOf(':'));
      const known = new Set(subjectValues);
      for (const k of key.split('|').map((x) => x.trim())) {
        if (k === '' || known.has(k)) continue;
        ctx.diagnostics.push({
          severity: 'warning',
          source: 'validator',
          ...nodeRange(mapEl),
          message: `<map> key "${k}" is not a value the subject produces — this entry is never used`,
          hint: `The subject produces: ${[...known].sort().join(', ')}.`,
          code: 'TDC216',
        });
      }
    }
  }
  return entries;
}

/**
 * The attributes a `<case is="…">` inside a `<switch>` may carry.
 *
 * The content of the case is walked by the validator itself, which knows what a
 * generator and a nested mix mean; this is only about the attributes, and about
 * the two that look conditional and are not.
 */
export function checkSwitchCaseAttrs(
  caseEl: OpenCloseElementContext,
  ctx: { diagnostics: Diagnostic[] },
  /** The values the subject can produce, when they are known from the config. */
  subjectValues?: readonly string[],
): void {
  const caseAttrs = caseEl.attr();
  const isAttr = findAttr(caseAttrs, 'is');
  if (isAttr) checkCaseKeysReachable(isAttr, subjectValues, ctx.diagnostics);
  if (!isAttr) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(caseEl),
      message: '<case> inside <switch> is missing a required "is" attribute',
      hint: 'Give the match key(s): <case is="US"> or multi-key <case is="US|CA|MX">.',
      code: 'TDC137',
    });
  }
  // `if`/`default` on a switch <case> would look conditional but are ignored —
  // selection is by `is` key match. Flag them like the mix trap (TDC128).
  for (const badName of ['if', 'default'] as const) {
    const bad = findAttr(caseAttrs, badName);
    if (!bad) continue;
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(bad),
      message: `"${badName}" on <case> is not supported — <switch> selects by the "is" key, not by condition`,
      hint: 'Match keys go in `is` (e.g. is="US|CA"). For condition-driven values use <gen if="…"> in a <sequence>.',
      code: 'TDC128',
    });
  }
}

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const attr of attrs) {
    if (attr._attrName?.text === name) return attr;
  }
  return undefined;
}

/**
 * A `<case is="…">` key that the subject can never produce.
 *
 * Only checked when the subject's values are known from the config — a `<text>`
 * list, which is what a `<switch>` almost always looks up. Unknown values mean
 * no opinion, never a guess.
 *
 * Two shapes arrive here and they deserve different words:
 *
 *   `is="99"`   a key outside the list. A typo, usually.
 *   `is="7,8"`  a COMMA, where the separator is `|`. Not a typo at all: every
 *               other list in the language is comma-separated (`value="a,b,c"`,
 *               `percent="30,40,30"`, `include="1,2"`) and `<map>` beside it
 *               splits its entries on commas too. So the guess is a reasonable
 *               one, it is accepted in silence, and every row falls through to
 *               <default> in a file that looks perfectly plausible. The Studio
 *               agent lost an hour to exactly this before rereading the page.
 *
 * The comma is NOT quietly accepted as a second separator: a case value may
 * legitimately contain one (`is="Smith, John"`), so accepting it would change
 * what a working config means. It is reported instead, and when splitting on
 * the comma WOULD have matched, the message says so outright.
 *
 * A WARNING, not an error, and for the reason TDC216 already gives: a config may
 * narrow a list on purpose and keep the branches it will need when the list
 * opens back up. Refusing that would be refusing a config that works.
 */
function checkCaseKeysReachable(
  isAttr: AttrContext,
  subjectValues: readonly string[] | undefined,
  diagnostics: Diagnostic[],
): void {
  if (subjectValues === undefined || subjectValues.length === 0) return;
  const raw = (isAttr._attrValue?.text ?? '').replace(/^["']|["']$/g, '');
  const known = new Set(subjectValues);
  for (const key of raw.split('|').map((k) => k.trim())) {
    if (key === '' || known.has(key)) continue;
    const commaParts = key
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k !== '');
    const commaWouldMatch = commaParts.length > 1 && commaParts.every((k) => known.has(k));
    diagnostics.push({
      severity: 'warning',
      source: 'validator',
      ...attrValueRange(isAttr),
      message: commaWouldMatch
        ? `is="${key}" separates its keys with a comma, and <case> separates them with "|" — this branch matches no row`
        : `is="${key}" is not a value the subject produces — this branch matches no row`,
      ...(commaWouldMatch ? { suggestion: `did you mean is="${commaParts.join('|')}"?` } : {}),
      hint: `The subject produces: ${[...known].sort().join(', ')}.`,
      code: 'TDC216',
    });
  }
}
