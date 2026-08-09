/**
 * `order="sequential"` on SOME members of a `row=` link.
 *
 * `row="k"` exists to keep a record together: every generator carrying the key
 * reads the SAME line of the CSV, so `first_name` and `last_name` belong to one
 * person. `order="sequential"` picks a line too — by the row's position. Two
 * rules choosing the same line, and only one of them can win.
 *
 * Measured on the files guide's own users.csv, one member sequential:
 *
 *     John Johnson      John is Smith in the file
 *     Mary Brown        Mary is Johnson
 *     James Williams
 *     Emma Brown        right, by luck
 *
 * `check` called that valid. It re-introduces exactly the drift `row=` exists to
 * prevent, and it does it while the config plainly says the two belong together.
 *
 * The refusal is narrow on purpose: when EVERY member of the link is sequential
 * they agree — both rules pick by position — and the records hold. Only a MIXED
 * link is proof of a contradiction, because two members of one link cannot both
 * be reading the line the other reads.
 */

import { type Diagnostic, attrValueRange } from '../errors/index.js';
import type {
  AttrContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import { extractAttrs } from '../processor/walk.js';

type GenElement = OpenCloseElementContext | SelfClosingElementContext;

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export function checkRowLinkOrder(gens: readonly GenElement[], diagnostics: Diagnostic[]): void {
  const links = new Map<string, GenElement[]>();
  for (const gen of gens) {
    const key = (extractAttrs(gen.attr())['row'] ?? '').trim();
    if (key === '') continue;
    const group = links.get(key);
    if (group) group.push(gen);
    else links.set(key, [gen]);
  }

  for (const [key, group] of links) {
    if (group.length < 2) continue;
    const sequential = group.filter(
      (g) => (extractAttrs(g.attr())['order'] ?? '').trim() === 'sequential',
    );
    if (sequential.length === 0 || sequential.length === group.length) continue;
    const offender = sequential[0];
    if (!offender) continue;
    const attr = findAttr(offender.attr(), 'order');
    if (!attr) continue;
    const plain = group.length - sequential.length;
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(attr),
      message:
        `order="sequential" on part of the row="${key}" link: ${String(sequential.length)} of ` +
        `${String(group.length)} members walk the file in order and ${String(plain)} pick a line ` +
        'per record, so they stop reading the same line',
      hint:
        'row= exists to keep the fields of one record together. Either give every member of ' +
        'the link order="sequential", so they walk in step, or drop it from this one.',
      code: 'TDC282',
    });
  }
}
