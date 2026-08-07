/**
 * A fixture emits text, not draws.
 *
 * `<before>`, `<after>`, the per-card and per-line variants and the two
 * delimiters emit text around the generated rows. Interpolation DOES run there —
 * a `${{Name}}` reads the row the fixture stands beside, which is what lets a
 * record put its own fields around a nested list. A GENERATOR does not, and
 * nothing enforced that, so a
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

import { childNode, childTagName, reportUnknownChild } from './placement.js';

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
 * A generator does not run in a fixture — interpolation does.
 *
 * Nothing enforced the first half, so a `<gen>` inside one was accepted in silence and
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
    if (name === null) continue;
    // A `<data>` written straight into a fixture, with no `<line>` around it.
    // The validator used to skip it here and the renderer only ever walks
    // `<line>` children, so the text was dropped without a word — the config
    // said something and got nothing, which is the failure this project exists
    // to refuse. Named rather than rendered: a bare `<data>` would have to
    // invent whether it ends the line, and `<line><data>` already says.
    if (name === 'data') {
      const node = childNode(el);
      if (node) {
        diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...nodeRange(node),
          message: `<data> directly inside <${fixtureName}> renders nothing`,
          hint:
            `A fixture body is made of <line>s. Wrap it: ` +
            `<${fixtureName}><line><data>…</data></line></${fixtureName}>.`,
          code: 'TDC131',
        });
      }
      continue;
    }
    const k = elementKind(el);
    // A fixture holds text and <line>s. Anything else was ignored in silence
    // unless it happened to be a generator inside a <line> — so an invented tag
    // written straight into <before> passed without a word.
    if (name !== 'line') {
      const node = childNode(el);
      if (node) reportUnknownChild(node, fixtureName, name, 'TDC131', { diagnostics });
      continue;
    }
    if (k?.kind === 'open') {
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
