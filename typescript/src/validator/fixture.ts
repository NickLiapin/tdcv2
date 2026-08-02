/**
 * Fixtures hold literal text only.
 *
 * `<before>`, `<after>`, the per-card and per-line variants and the two
 * delimiters emit text around the generated rows. Interpolation and generators
 * do not run there — every fixture page says so — but nothing enforced it, so a
 * `<gen>` inside one was accepted in silence and emitted a CONSTANT:
 * `value="500..999"` produced `500` on every card and under every seed. A
 * constant that looks like a generated value is worse than either honouring the
 * generator or refusing it, and the identical tag inside `<block><line>` has
 * always been a hard error. Same rule, same code (TDC131).
 */

import type { Diagnostic } from '../errors/index.js';
import { nodeRange } from '../errors/index.js';
import type { OpenCloseElementContext } from '../generated/TDCParser.js';
import { contentElements, elementKind } from '../processor/walk.js';

import { childNode, childTagName } from './placement.js';

/** Fixture tags: text emitted around cards and lines, never generated data. */
export const FIXTURE_TAGS: readonly string[] = [
  'before',
  'after',
  'before_block',
  'after_block',
  'delimiter_block',
  'before_line',
  'after_line',
  'delimiter_line',
];

/**
 * Fixtures hold literal text only — interpolation and generators do not run
 * there, which every fixture page already states.
 *
 * Nothing enforced it, so a `<gen>` inside one was accepted in silence and
 * emitted a CONSTANT: `value="500..999"` produced `500` on every card and under
 * every seed. A constant that looks like a generated value is worse than either
 * honouring the generator or refusing it, and the identical tag inside
 * `<block><line>` has always been a hard error (TDC131). Same rule, same code.
 */
export function checkFixture(
  fixtureEl: OpenCloseElementContext,
  fixtureName: string,
  diagnostics: Diagnostic[],
): void {
  for (const el of contentElements(fixtureEl.content())) {
    const name = childTagName(el);
    if (name === null || name === 'data') continue;
    const k = elementKind(el);
    if (name === 'line' && k?.kind === 'open') {
      for (const inner of contentElements(k.node.content())) {
        const innerName = childTagName(inner);
        if (innerName === null || innerName === 'data') continue;
        const node = childNode(inner);
        if (!node) continue;
        if (innerName === 'gen' || innerName === 'mix' || innerName === 'switch') {
          diagnostics.push({
            severity: 'error',
            source: 'validator',
            ...nodeRange(node),
            message: `a <${innerName}> is not allowed inside <${fixtureName}> — fixtures are literal text`,
            hint: `Generators do not run in fixtures; this would emit a constant. Declare a <sequence> in <env> if the value must vary, or write the text literally.`,
            code: 'TDC131',
          });
        }
      }
      continue;
    }
  }
}
