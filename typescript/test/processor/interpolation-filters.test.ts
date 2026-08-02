import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** `${{ Name | filter | filter }}` — formatting filters at the interpolation. */
function render(seqs: string, line: string, count = 4, seed = 'demo'): string[] {
  const config = `<tdc><env count="${String(count)}" seed="${seed}">${seqs}</env><block><line><data>${line}</data></line></block></tdc>`;
  return new TDC({ configString: config, now: NOW }).toString().trim().split('\n');
}

describe('interpolation filters', () => {
  it('applies a single case filter', () => {
    const out = render(
      '<sequence name="City"><gen type="text" value="Moscow,Berlin"/></sequence>',
      '${{City | lower}}',
    );
    for (const v of out) expect(['moscow', 'berlin']).toContain(v);
  });

  it('applies a mask filter with a pattern containing spaces and colons', () => {
    const out = render(
      '<sequence name="N"><gen type="regex" value="[0-9]{11}"/></sequence>',
      '${{N | mask:xxx-xxx-xxx xx}}',
    );
    for (const v of out) expect(v).toMatch(/^\d{3}-\d{3}-\d{3} \d{2}$/);
  });

  it('chains filters left to right (mask then upper)', () => {
    const out = render(
      '<sequence name="Name"><gen type="text" value="john dow"/></sequence>',
      '${{Name | mask:w:w | upper}}',
    );
    for (const v of out) expect(v).toBe('JOHN:DOW');
  });

  it('works with a custom inject delimiter', () => {
    const config = `<tdc><env count="3" seed="demo" inject="[%]"><sequence name="C"><gen type="text" value="Paris"/></sequence></env><block><line><data>[C | upper]</data></line></block></tdc>`;
    for (const v of new TDC({ configString: config, now: NOW }).toString().trim().split('\n')) {
      expect(v).toBe('PARIS');
    }
  });

  it('an unknown filter is rejected by the validator', () => {
    expect(() =>
      render('<sequence name="C"><gen type="text" value="Rome"/></sequence>', '${{C | uppper}}'),
    ).toThrow(/unknown interpolation filter/);
  });

  it('a plain reference (no filter) is unchanged', () => {
    const out = render('<sequence name="C"><gen type="text" value="Rome"/></sequence>', '${{C}}');
    for (const v of out) expect(v).toBe('Rome');
  });

  it('slice / replace / trim / group filters', () => {
    const s = '<sequence name="C"><gen type="text" value="1234567"/></sequence>';
    for (const v of render(s, '${{C | group:3}}')) expect(v).toBe('1 234 567');
    for (const v of render(s, '${{C | slice:0,3}}')) expect(v).toBe('123');
    const d = '<sequence name="D"><gen type="text" value="a-b-c"/></sequence>';
    for (const v of render(d, '${{D | replace:-,/}}')) expect(v).toBe('a/b/c');
  });
});
