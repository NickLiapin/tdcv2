import { describe, expect, it } from 'vitest';

import { formatTdc } from '../../src/formatter/format.js';
import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** THE safety net: formatting must never change what the config generates. */
function expectSameOutput(source: string): string {
  const formatted = formatTdc(source);
  const before = render(parseStrict(source), { now: NOW, mode: 'memory' });
  const after = render(parseStrict(formatted), { now: NOW, mode: 'memory' });
  expect(after, 'formatted output differs from original').toBe(before);
  return formatted;
}

describe('formatter — safety (output is preserved)', () => {
  it('a messy document generates the same output after formatting', () => {
    const src = `<tdc><env count="3" seed="s" inject="\${{%}}">
<sequence     name="Name"><gen type="template"   value="person.male.firstName"/></sequence>
   <switch name="Cur" on="Name"><map>A:1,   B:2</map><default><data>?</data></default></switch>
</env><block><line><data>\${{Name}}=\${{Cur}}</data></line></block></tdc>`;
    expectSameOutput(src);
  });

  it('preserves whitespace inside <data> bodies exactly', () => {
    const src =
      '<tdc><env count="2" seed="s"></env><block><line>' +
      '<data>  spaced   :  value  </data></line></block></tdc>';
    const before = render(parseStrict(src), { now: NOW, mode: 'memory' });
    const after = render(parseStrict(formatTdc(src)), { now: NOW, mode: 'memory' });
    expect(after).toBe(before);
    expect(after).toContain('  spaced   :  value  ');
  });

  it('preserves the JSON trailing-comma pattern (<data if>)', () => {
    const src =
      '<tdc><env count="4" seed="s"></env><block>' +
      '<line><data>{"id": ${{_count}}}</data><data if="!_last">,</data></line></block></tdc>';
    expectSameOutput(src);
  });

  it('preserves comments', () => {
    const src = `<tdc>
<!-- top comment -->
<env count="2" seed="s">
  <!-- inside env -->
  <sequence name="N"><gen type="text" value="a,b"/></sequence>
</env>
<block><line><data>\${{N}}</data></line></block>
</tdc>`;
    const formatted = expectSameOutput(src);
    expect(formatted).toContain('<!-- top comment -->');
    expect(formatted).toContain('<!-- inside env -->');
  });

  it('round-trips a <switch> with a multi-key map and generator case', () => {
    const src = `<tdc><env count="6" seed="s" inject="\${{%}}">
<sequence name="Country"><gen type="text" value="US,CA,TR,ZZ" percent="25,25,25,25"/></sequence>
<switch name="Cur" on="Country"><map>US:USD, CA|MX:USD, FR:EUR</map>
<case is="TR|BR"><gen type="text" value="ABCD"/></case><default><data>XXX</data></default></switch>
</env><block><line><data>\${{Cur}}</data></line></block></tdc>`;
    expectSameOutput(src);
  });
});

describe('formatter — idempotency & shape', () => {
  const wrap = (body: string) =>
    `<tdc><env count="2" seed="s">${body}</env>` +
    `<block><line><data>x</data></line></block></tdc>`;

  it('is idempotent — formatting twice equals formatting once', () => {
    const cases = [
      wrap('<sequence name="N"><gen type="text" value="a,b"/></sequence>'),
      wrap(
        '<switch name="S" on="N"><map>US:USD, FR:EUR, DE:EUR, JP:JPY, CA:CAD, GB:GBP, AU:AUD, NZ:NZD</map></switch>' +
          '<sequence name="N"><gen type="text" value="US,FR"/></sequence>',
      ),
    ];
    for (const c of cases) {
      const once = formatTdc(c);
      expect(formatTdc(once)).toBe(once);
    }
  });

  it('indents with 4 spaces and puts each structural tag on its own line', () => {
    const out = formatTdc(wrap('<sequence name="N"><gen type="text" value="a,b"/></sequence>'));
    // <tdc>=0, <env>=1, <sequence>=2 (8 sp), <gen>=3 (12 sp)
    expect(out).toContain('\n        <sequence name="N">');
    expect(out).toContain('\n            <gen type="text" value="a,b"/>');
  });

  it('keeps a short <map> on one line', () => {
    const short = formatTdc(
      wrap(
        '<sequence name="N"><gen type="text" value="a,b"/></sequence>' +
          '<switch name="S" on="N"><map>A:1, B:2</map></switch>',
      ),
    );
    expect(short).toContain('<map>A:1, B:2</map>');
  });

  it('wraps a long <map> into an aligned table', () => {
    const long = formatTdc(
      wrap(
        '<sequence name="N"><gen type="text" value="a,b"/></sequence>' +
          '<switch name="S" on="N"><map>US:USD, FRANCE:EUR, DE:EUR, JP:JPY, CA:CAD, GB:GBP, AU:AUD</map></switch>',
      ),
    );
    // <switch>=2, <map>=3 (12 sp), rows=4 (16 sp). "US" padded to width of "FRANCE".
    expect(long).toMatch(/\n {16}US {5}: USD,/);
    expect(long).toContain('\n            <map>');
    expect(long).toContain('\n            </map>');
  });

  it('returns the source unchanged when it has a syntax error', () => {
    const broken = '<tdc><env count="2"><sequence name="N"><gen type="text" value="a,b"/></tdc>';
    expect(formatTdc(broken)).toBe(broken);
  });
});
