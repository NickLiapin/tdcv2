/**
 * Which of the three readings a `<sequence>` body has.
 *
 * The body says which, and the three mean genuinely different things:
 *
 *   - **simple** — one unnamed `<gen>` and nothing else. The classic sequence.
 *   - **compound** — every `<gen>` named. Several columns, `Name.Field` each,
 *     and no value of its own.
 *   - **composed** — anything else: an unnamed `<gen>` beside something, or a
 *     `<data>` literal. The unnamed gens and the literals concatenate into the
 *     sequence's own value; named gens stay fields beside it.
 *
 * Kept apart from the validator because the config builder asks the same
 * question, and a rule about what a body MEANS that two files answer separately
 * is a rule that drifts.
 */

import type { Diagnostic } from '../errors/index.js';
import { attrValueRange } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import { asDataWithBody, contentElements, elementKind, extractAttrs } from '../processor/walk.js';

export type SequenceShape = 'simple' | 'compound' | 'composed';

export function sequenceShape(named: readonly boolean[], hasLiteral: boolean): SequenceShape {
  const namedCount = named.filter(Boolean).length;
  if (namedCount === named.length) return 'compound';
  if (named.length > 1 || hasLiteral) return 'composed';
  return 'simple';
}

/**
 * A `<data>` inside a `<sequence>` reads `name` and nothing else.
 *
 * It is a literal, or — with a name — a constant field. An output type belongs
 * on the `<data>` in the `<line>`, where the column is actually emitted, and
 * silently dropping one here is the failure this whole reading was introduced to
 * end.
 */
export function checkSequenceDataAttrs(
  seqEl: OpenCloseElementContext,
  diagnostics: Diagnostic[],
): void {
  for (const el of contentElements(seqEl.content())) {
    const k = elementKind(el);
    if (k?.kind !== 'data') continue;
    const body = asDataWithBody(k.node);
    if (!body) continue;
    for (const attr of body.attr()) {
      const attrName = attr._attrName?.text ?? '';
      if (attrName === 'name' || attrName === 'comment') continue;
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(attr),
        message: `<data> inside <sequence> does not read "${attrName}" — it is ignored`,
        hint: 'Inside a <sequence> a <data> is a literal or, with name="…", a constant field. Output types belong on the <data> in the <line>.',
        code: 'TDC015',
      });
    }
  }
}

/**
 * The values a sequence will actually produce, when the config says so outright.
 *
 * Only a body that is one unnamed `<gen type="text" value="a,b,c">` qualifies —
 * a text generator's list is always literal, never a file or a pack, so what is
 * written is what comes out.
 *
 * Unless something rewrites it. `case="upper"` turns `Male` into `MALE` and
 * `mask="xxxx"` turns `Female` into `Fema`, so a comparison against the written
 * word would then be wrong in both directions — flagging a config that works and
 * accepting one that never matches. `repeat=` makes the value a list rather than
 * a word. Any of the three, and the values stop being knowable from here.
 */
export function finiteTextValues(
  shape: SequenceShape,
  gens: readonly (OpenCloseElementContext | SelfClosingElementContext)[],
): readonly string[] | undefined {
  if (shape !== 'simple' || gens.length !== 1) return undefined;
  const only = gens[0];
  if (!only) return undefined;
  const attrs = extractAttrs(only.attr());
  if (attrs['type'] !== 'text') return undefined;
  if (attrs['case'] !== undefined || attrs['mask'] !== undefined) return undefined;
  if (attrs['repeat'] !== undefined) return undefined;
  const raw = attrs['value'];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.split(',').map((v) => v.trim());
}
