/**
 * Autocomplete offers exactly what the validator accepts — checked both ways.
 *
 * The completion map used to be a hand-written copy of the validator's, and it
 * drifted silently: `<pool>` never appeared at all, `<gen>` was short 34 names,
 * and the two attributes the engine gives only to `text` and `file` were absent
 * from the very list the type-narrowing filters. Nobody noticed because a
 * missing suggestion looks exactly like a suggestion that does not apply.
 *
 * The map is derived now, so these tests cannot fail by drift — they fail if
 * someone reintroduces a hand-written copy, which is the point.
 */

import { describe, expect, it } from 'vitest';

import { computeCompletions } from '../../src/lsp/completion.js';
import { CLOSED_TAG_ATTRIBUTES, GEN_ATTRIBUTES } from '../../src/validator/index.js';

/** What autocomplete offers just inside an open tag. */
function offered(tag: string, typed = ''): string[] {
  const text = `<tdc><env><${tag} ${typed}`;
  return computeCompletions(text, { line: 0, character: text.length }).map((i) => i.label);
}

describe('completion attributes match the validator', () => {
  for (const [tag, attrs] of CLOSED_TAG_ATTRIBUTES) {
    it(`<${tag}> offers exactly what the validator accepts`, () => {
      expect(offered(tag).sort()).toEqual([...attrs].sort());
    });
  }

  it('<gen> with no type= offers the whole union', () => {
    expect(offered('gen').sort()).toEqual([...GEN_ATTRIBUTES].sort());
  });

  it('every offered <gen> attribute would pass the validator', () => {
    // Narrowing by type= may only ever REMOVE names from the union. An offer
    // outside it is an attribute the validator would then reject — the worst
    // kind of suggestion.
    for (const type of ['text', 'number', 'file', 'pool', 'running', 'date']) {
      for (const attr of offered('gen', `type="${type}" `)) {
        expect(GEN_ATTRIBUTES.has(attr), `${attr} on type="${type}"`).toBe(true);
      }
    }
  });

  it('narrowing by type= actually narrows', () => {
    // The regression that hid in plain sight: `text` and `file` differed by one
    // name, because `order` and `cycle` — the two the engine gives them alone —
    // were missing from the source list, so there was nothing to narrow to.
    const text = offered('gen', 'type="text" ');
    const file = offered('gen', 'type="file" ');
    expect(text).toContain('order');
    expect(file).toContain('row');
    expect(text).not.toContain('row');
    expect(text.length).toBeLessThan(GEN_ATTRIBUTES.size);
  });

  it('the tags the report named are all reachable', () => {
    // Every one of these offered nothing, or nothing useful, before deriving.
    expect(offered('pool')).toContain('count');
    expect(offered('uniq')).toContain('comment');
    expect(offered('distinct')).toContain('comment');
    expect(offered('env')).toContain('engine');
    expect(offered('line')).toContain('each');
    expect(offered('case')).toContain('if');
    expect(offered('data')).toContain('name');
    expect(offered('mix')).toContain('flag');
    expect(offered('switch')).toContain('on');
  });

  it('an attribute that belongs on another tag is not offered', () => {
    // Deriving the map surfaced two the validator was wrongly accepting: the
    // engine reads neither, and both now say so (TDC015) instead of sitting
    // there looking like they work.
    expect(offered('switch')).not.toContain('percent');
    expect(offered('gen')).not.toContain('parent');
  });

  it('the new generator’s attributes are offered', () => {
    const running = offered('gen', 'type="running" ');
    expect(running).toContain('of');
    expect(running).toContain('reset');
    expect(running).toContain('accumulate');
    expect(offered('gen', 'type="pool" ')).toContain('filter');
  });
});
