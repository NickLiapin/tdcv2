/**
 * An XML entity inside `<data>`: printed as written, because TDC expands none.
 *
 * `<data>` holds raw text — `"`, `<`, `>` and `&` all go in as they are — so an
 * entity there is almost always the XML habit of the person writing it, and the
 * output carries `&quot;` where a quote was meant: `{&quot;a&quot;: …}` is not
 * JSON. Inside `if=` the same habit is already refused (TDC100), because there it
 * breaks the expression; here it breaks the file and nothing said so.
 *
 * A warning and not an error: a config that writes HTML may want `&amp;` in its
 * output and get exactly that. Only XML's own five and numeric references are
 * looked for — the ones that habit produces.
 *
 * One pass over every `<data>` in the document, after everything else, in the
 * order they appear: a line's text, a fixture's, a composed sequence's literal
 * piece and a named constant print the same way.
 */

import { type Diagnostic, nodeRange } from '../errors/index.js';
import { DataElementContext } from '../generated/TDCParser.js';
import type { ParseTree } from 'antlr4ng';
import { ParserRuleContext } from 'antlr4ng';
import { extractDataText } from '../processor/walk.js';

const ENTITY = /&(?:quot|lt|gt|amp|apos|#[0-9]+|#[xX][0-9a-fA-F]+);/g;

export function checkDataEntities(root: ParseTree, diagnostics: Diagnostic[]): void {
  const visit = (node: ParseTree): void => {
    if (node instanceof DataElementContext) report(node, diagnostics);
    if (node instanceof ParserRuleContext) for (const child of node.children) visit(child);
  };
  visit(root);
}

function report(data: DataElementContext, diagnostics: Diagnostic[]): void {
  const found: string[] = [];
  for (const m of extractDataText(data).matchAll(ENTITY)) {
    if (!found.includes(m[0])) found.push(m[0]);
  }
  if (found.length === 0) return;
  diagnostics.push({
    severity: 'warning',
    source: 'validator',
    ...nodeRange(data),
    message: `${found.join(', ')} in <data> reaches the output as written — TDC expands no entities`,
    hint:
      'Write the character itself — <data> takes " < > & \' as they are, so &quot; is just ". ' +
      'If the entity is what the output should hold — HTML, say — leave it and ignore this.',
    code: 'TDC311',
  });
}
