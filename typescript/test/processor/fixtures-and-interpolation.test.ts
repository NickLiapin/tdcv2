/**
 * The three per-line fixtures see OUTPUT lines, not `<line>` elements.
 *
 * `<line each="Items">` produces one output line per element of the list, and
 * `<delimiter_line>` is documented as sitting "between the lines of a record".
 * It used to sit between the `<line>` ELEMENTS, so between the repetitions of an
 * each= line it produced nothing at all — no comma between the members of an
 * array, and no word about it. That is the whole reason a JSON array of objects
 * could not be written.
 *
 * `<before_line>` and `<after_line>` take the same reading, because they are the
 * same three-word promise about the same thing.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

function lines(config: string): string[] {
  return new TDC({ configString: config, now: NOW }).toString().split('\n');
}

/**
 * A list of exactly three elements.
 *
 * Every element is the same value on purpose: these tests are about WHERE the
 * fixtures fall, so the assertion must not depend on what was drawn. A regex
 * here would make the expected lines a function of the PRNG, and the test would
 * be pinning the draw rather than the delimiter.
 */
const THREE =
  '<sequence name="Items"><gen type="text" value="x" repeat="3" ' + 'separator=","/></sequence>';

describe('delimiter_line under each=', () => {
  it('falls between the repetitions, which is what makes an array writable', () => {
    const config =
      `<tdc><env count="1" seed="s" local="en">${THREE}` +
      '<delimiter_line><line><data>,</data></line></delimiter_line>' +
      '</env><block><line each="Items"><data>[${{Items}}]</data></line></block></tdc>';
    expect(lines(config).filter((l) => l.length > 0)).toEqual(['[x]', ',', '[x]', ',', '[x]']);
  });

  it('and between an each= line and an ordinary one, because both are lines', () => {
    const config =
      `<tdc><env count="1" seed="s" local="en">${THREE}` +
      '<delimiter_line><line><data>,</data></line></delimiter_line>' +
      '</env><block>' +
      '<line each="Items"><data>[${{Items}}]</data></line>' +
      '<line><data>total</data></line>' +
      '</block></tdc>';
    expect(lines(config).filter((l) => l.length > 0)).toEqual([
      '[x]',
      ',',
      '[x]',
      ',',
      '[x]',
      ',',
      'total',
    ]);
  });

  it('a line suppressed by if= takes its delimiter with it', () => {
    // The delimiter goes between the lines that SURVIVE, not between the ones
    // that were written — otherwise a suppressed middle line would leave a
    // stray comma where nothing stands.
    const config =
      '<tdc><env count="1" seed="s" local="en">' +
      '<sequence name="A"><gen type="text" value="x"/></sequence>' +
      '<delimiter_line><line><data>,</data></line></delimiter_line>' +
      '</env><block>' +
      '<line><data>first</data></line>' +
      '<line if="A == nothing"><data>never</data></line>' +
      '<line><data>last</data></line>' +
      '</block></tdc>';
    expect(lines(config).filter((l) => l.length > 0)).toEqual(['first', ',', 'last']);
  });
});

describe('before_line and after_line take the same reading', () => {
  it('they wrap every output line, including each repetition', () => {
    const config =
      `<tdc><env count="1" seed="s" local="en">${THREE}` +
      '<before_line><line><data>&gt;</data></line></before_line>' +
      '<after_line><line><data>&lt;</data></line></after_line>' +
      '</env><block><line each="Items"><data>${{Items}}</data></line></block></tdc>';
    expect(lines(config).filter((l) => l.length > 0)).toEqual([
      '&gt;',
      'x',
      '&lt;',
      '&gt;',
      'x',
      '&lt;',
      '&gt;',
      'x',
      '&lt;',
    ]);
  });
});

describe('a fixture body that would render nothing', () => {
  it('a bare <data> is refused rather than dropped in silence', () => {
    const config =
      '<tdc><env count="1" seed="s" local="en">' +
      '<sequence name="A"><gen type="text" value="x"/></sequence>' +
      '<delimiter_line><data>,</data></delimiter_line>' +
      '</env><block><line><data>${{A}}</data></line></block></tdc>';
    expect(() => new TDC({ configString: config, now: NOW }).toString()).toThrow(
      /<data> directly inside <delimiter_line> renders nothing/,
    );
  });

  it('the same rule for every fixture, since they share one body shape', () => {
    for (const tag of ['before', 'after', 'before_block', 'after_block', 'before_line']) {
      const config =
        '<tdc><env count="1" seed="s" local="en">' +
        '<sequence name="A"><gen type="text" value="x"/></sequence>' +
        `<${tag}><data>text</data></${tag}>` +
        '</env><block><line><data>${{A}}</data></line></block></tdc>';
      expect(() => new TDC({ configString: config, now: NOW }).toString(), tag).toThrow(
        new RegExp(`<data> directly inside <${tag}> renders nothing`),
      );
    }
  });

  it('with the wrapper it renders, which is what the message tells you to write', () => {
    const config =
      '<tdc><env count="1" seed="s" local="en">' +
      '<sequence name="A"><gen type="text" value="x"/></sequence>' +
      '<before><line><data>head</data></line></before>' +
      '</env><block><line><data>${{A}}</data></line></block></tdc>';
    expect(lines(config).filter((l) => l.length > 0)).toEqual(['head', 'x']);
  });
});

/**
 * `${{Name}}` in an attribute that does not read it.
 *
 * Five generators used to each blame what they happened to be parsing — an
 * invalid range, an invalid date, a bad quantifier, an unknown alphabet — and
 * `type="text"` said nothing at all and emitted the braces. One cause, six
 * answers, none of them naming it.
 */
describe('interpolation in an attribute that does not expand it', () => {
  const gen = (g: string): string =>
    '<tdc><env count="1" seed="s" local="en">' +
    '<sequence name="N"><gen type="text" value="5"/></sequence>' +
    `<sequence name="X">${g}</sequence>` +
    '</env><block><line><data>${{X}}</data></line></block></tdc>';

  const errorsOf = (config: string): string[] => {
    try {
      new TDC({ configString: config, now: NOW }).toString();
      return [];
    } catch (e) {
      return [e instanceof Error ? e.message : String(e)];
    }
  };

  it('names the cause wherever it is written, not the parse it broke', () => {
    for (const [g, attr] of [
      ['<gen type="number" value="1..${{N}}"/>', 'value'],
      ['<gen type="date" from="${{N}}" to="2026-12-31"/>', 'from'],
      ['<gen type="regex" value="${{N}}[0-9]"/>', 'value'],
      ['<gen type="symbol" alphabet="${{N}}" length="3"/>', 'alphabet'],
    ] as const) {
      const [message] = errorsOf(gen(g));
      expect(message, g).toMatch(new RegExp(`in ${attr}= is not expanded`));
    }
  });

  it('including the one that used to emit the braces in silence', () => {
    expect(errorsOf(gen('<gen type="text" value="${{N}}"/>'))[0]).toMatch(/is not expanded/);
  });

  it('and it REPLACES the generator’s own complaint rather than joining it', () => {
    // Two messages for one mistake, one of them naming the wrong thing, is
    // worse than one that is right.
    const [message] = errorsOf(gen('<gen type="number" value="1..${{N}}"/>'));
    expect(message).not.toMatch(/invalid number range/);
  });

  it('but a template path finished by another column still works, as documented', () => {
    const config =
      '<tdc><env count="1" seed="s" local="en">' +
      '<sequence name="Brand"><gen type="template" value="common.vehicle.brand"/></sequence>' +
      '<sequence name="Model" parent="Brand">' +
      '<gen type="template" value="common.vehicle.model.${{Brand}}"/></sequence>' +
      '</env><block><line><data>${{Brand}} ${{Model}}</data></line></block></tdc>';
    expect(errorsOf(config)).toEqual([]);
    expect(lines(config).filter((l) => l.length > 0)).toHaveLength(1);
  });
});
