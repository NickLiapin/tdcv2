import { describe, expect, it } from 'vitest';

import { computeCompletions, type CompletionContext } from '../../src/lsp/completion.js';
import { KNOWN_TEMPLATE_PATHS } from '../../src/validator/index.js';

/** Complete at the `|` caret marker; returns the item labels. */
function labelsAt(srcWithCaret: string, ctx: CompletionContext = {}): string[] {
  const idx = srcWithCaret.indexOf('|');
  const text = srcWithCaret.slice(0, idx) + srcWithCaret.slice(idx + 1);
  const before = srcWithCaret.slice(0, idx);
  const line = (before.match(/\n/g) ?? []).length;
  const character = before.length - (before.lastIndexOf('\n') + 1);
  return computeCompletions(text, { line, character }, ctx).map((i) => i.label);
}

describe('computeCompletions — tag names', () => {
  // At the very top of a document the only legal element IS <tdc>; the wide
  // offers now live under known parents (see the surroundings suite below).
  it('offers only <tdc> right after "<" at the top', () => {
    expect(labelsAt('<|')).toEqual(['tdc']);
  });

  it('still suggests tags for a partial tag name (editor filters)', () => {
    expect(labelsAt('<td|')).toContain('tdc');
  });

  it('the full env-level surface appears inside <env>', () => {
    const labels = labelsAt('<tdc><env count="1" seed="s"><|');
    for (const t of ['sequence', 'mix', 'switch', 'before', 'delimiter_line', 'uniq']) {
      expect(labels, t).toContain(t);
    }
  });
});

describe('computeCompletions — attribute names', () => {
  it('suggests a gen tag’s attributes after the name + space', () => {
    const labels = labelsAt('<gen |');
    expect(labels).toEqual(expect.arrayContaining(['type', 'value', 'percent']));
  });

  it('suggests env attributes', () => {
    expect(labelsAt('<env |')).toEqual(expect.arrayContaining(['count', 'seed', 'inject']));
  });

  it('suggests sequence attributes', () => {
    expect(labelsAt('<sequence |')).toEqual(expect.arrayContaining(['name', 'parent', 'uniq']));
  });

  it('suggests switch attributes (name/on — not the old percent)', () => {
    const labels = labelsAt('<switch |');
    expect(labels).toEqual(expect.arrayContaining(['name', 'on']));
    expect(labels).not.toContain('percent');
  });

  it('suggests case and mix attributes', () => {
    expect(labelsAt('<case |')).toContain('is');
    expect(labelsAt('<mix |')).toEqual(expect.arrayContaining(['name', 'percent']));
  });

  it('offers the data-science modifiers on <gen>', () => {
    expect(labelsAt('<gen |')).toEqual(
      expect.arrayContaining(['missing', 'anomaly', 'anomaly_factor']),
    );
  });
});

describe('computeCompletions — attribute values', () => {
  it('suggests generator types inside type="…"', () => {
    const labels = labelsAt('<gen type="|"/>');
    expect(labels).toEqual(expect.arrayContaining(['text', 'number', 'regex']));
  });

  it('suggests template paths + pack addresses inside a template value', () => {
    const ctx: CompletionContext = {
      packAddresses: [{ address: 'es.person.male.firstName', description: 'Испанские имена' }],
    };
    const labels = labelsAt('<gen type="template" value="|"/>', ctx);
    expect(labels).toContain('es.person.male.firstName');
    expect(labels).toContain(KNOWN_TEMPLATE_PATHS[0]);
  });

  it('attaches the pack description as detail', () => {
    const idx = '<gen type="template" value="|"/>'.indexOf('|');
    const src = '<gen type="template" value="|"/>';
    const text = src.slice(0, idx) + src.slice(idx + 1);
    const items = computeCompletions(
      text,
      { line: 0, character: idx },
      { packAddresses: [{ address: 'geo.city', description: 'Города' }] },
    );
    expect(items.find((i) => i.label === 'geo.city')?.detail).toBe('Города');
  });

  it('suggests declared sequence names inside parent="…"', () => {
    const src = `<tdc><env count="2">
      <sequence name="Gender"><gen type="text" value="M,F"/></sequence>
      <sequence parent="|" name="Kid"><gen type="text" value="a"/></sequence>
    </env></tdc>`;
    expect(labelsAt(src)).toContain('Gender');
  });

  it('suggests alphabet names inside alphabet="…"', () => {
    const labels = labelsAt('<gen type="symbol" alphabet="|"/>');
    expect(labels.length).toBeGreaterThan(0);
  });

  it('suggests declared sequence names inside a switch on="…"', () => {
    const src = `<tdc><env count="2">
      <sequence name="Country"><gen type="text" value="US,FR"/></sequence>
      <switch name="Cur" on="|"><map>US:USD</map></switch>
    </env></tdc>`;
    expect(labelsAt(src)).toContain('Country');
  });
});

describe('computeCompletions — no completion in body text', () => {
  it('returns nothing in the raw <data> body', () => {
    expect(labelsAt('<data>hello |world</data>')).toEqual([]);
  });

  it('returns nothing in plain content between tags', () => {
    expect(labelsAt('</sequence>\n  |\n<sequence')).toEqual([]);
  });
});

describe('computeCompletions — the offer respects the surroundings', () => {
  const labels = (text: string): string[] =>
    computeCompletions(text, { line: 0, character: text.length }).map((i) => i.label);

  it('offers only <tdc> at the top of an empty document', () => {
    expect(labels('<')).toEqual(['tdc']);
  });

  it('inside <sequence>: gen, data and compute — never tdc', () => {
    const got = labels('<tdc><env count="1" seed="s"><sequence name="A"><');
    expect(got).toContain('gen');
    expect(got).toContain('compute');
    expect(got).toContain('data');
    expect(got).not.toContain('tdc');
    expect(got).not.toContain('line');
  });

  it('inside <env>: switch, uniq and distinct are on offer', () => {
    const got = labels('<tdc><env count="1" seed="s"><');
    expect(got).toContain('switch');
    expect(got).toContain('uniq');
    expect(got).toContain('distinct');
    expect(got).not.toContain('line');
  });

  it('inside <compute>: the compute sub-language, not the document tags', () => {
    const got = labels('<tdc><env count="1" seed="s"><sequence name="A"><compute><');
    expect(got).toContain('concat');
    expect(got).toContain('pad');
    expect(got).not.toContain('gen');
    expect(got).not.toContain('tdc');
  });

  it('an unknown enclosing tag filters nothing', () => {
    const got = labels('<tdc><futuretag><');
    expect(got).toContain('gen');
    expect(got).toContain('tdc');
  });

  it('gen attributes narrow by the chosen type', () => {
    const number = labels('<tdc><env count="1" seed="s"><sequence name="A"><gen type="number" ');
    expect(number).toContain('first_zero');
    expect(number).toContain('length');
    expect(number).not.toContain('range');
    expect(number).not.toContain('alphabet');
    expect(number).not.toContain('base');

    const date = labels('<tdc><env count="1" seed="s"><sequence name="A"><gen type="date" ');
    expect(date).toContain('range');
    expect(date).toContain('from');
    expect(date).not.toContain('first_zero');
    expect(date).not.toContain('points');
  });

  it('before a type is chosen, nothing is hidden', () => {
    const got = labels('<tdc><env count="1" seed="s"><sequence name="A"><gen ');
    expect(got).toContain('range');
    expect(got).toContain('first_zero');
    expect(got).toContain('base');
    expect(got).toContain('type');
  });

  it('a closed sibling does not linger on the stack', () => {
    const got = labels(
      '<tdc><env count="1" seed="s"><sequence name="A"><gen type="text" value="x"/></sequence><',
    );
    expect(got).toContain('sequence');
    expect(got).toContain('switch');
    expect(got).not.toContain('gen');
  });
});
