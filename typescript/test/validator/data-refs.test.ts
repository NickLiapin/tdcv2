import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

/**
 * `_item` and `_item_id` exist only while an `each=` line renders, and the
 * renderer has always defined them. The validator did not know them, so the
 * relational pattern the docs teach — one child row per list element, keyed by
 * `${{_item_id}}` — aborted with TDC193 before it could run. They must be
 * accepted on an `each` line and still rejected anywhere else, because off that
 * line they really would reach the output verbatim, which is what TDC193 exists
 * to prevent.
 */
describe('each built-ins are known only inside an each line', () => {
  const diagnose = (line: string) => {
    const src =
      `<tdc><env count="2" seed="s"><sequence name="Ord">` +
      `<gen type="number" value="1..9" repeat="1..3"/></sequence></env>` +
      `<block>${line}</block></tdc>`;
    return validate(parse(src).tree).diagnostics;
  };

  it('accepts _item_id and _item on a line that has each=', () => {
    const d = diagnose('<line each="Ord"><data>${{_item_id}}:${{_item}}</data></line>');
    expect(d.filter((x) => x.code === 'TDC193')).toEqual([]);
  });

  it('still rejects them on a line without each=', () => {
    const d = diagnose('<line><data>${{_item_id}}</data></line>');
    expect(d.some((x) => x.code === 'TDC193')).toBe(true);
  });
});
