import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/** Validity tests for Spain/UK document presets migrated to bundled packs. */

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

function render(address: string, count = 40, seed = 'es'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('spain.docs.dni', () => {
  it('produces a valid mod-23 control letter', () => {
    for (const v of render('spain.docs.dni')) {
      expect(v).toMatch(/^\d{8}[A-Z]$/);
      const expected = DNI_LETTERS[Number(v.slice(0, 8)) % 23];
      expect(v[8]).toBe(expected);
    }
  });
});

describe('spain.docs.nie', () => {
  it('produces a valid NIE with mod-23 control letter', () => {
    for (const v of render('spain.docs.nie')) {
      expect(v).toMatch(/^[XYZ]\d{7}[A-Z]$/);
      const pv = v.startsWith('X') ? '0' : v.startsWith('Y') ? '1' : '2';
      const expected = DNI_LETTERS[Number(`${pv}${v.slice(1, 8)}`) % 23];
      expect(v[8]).toBe(expected);
    }
  });
});

describe('united_kingdom.docs.nino', () => {
  it('produces a 2-letter + 6-digit + suffix NINo', () => {
    for (const v of render('united_kingdom.docs.nino')) {
      expect(v).toMatch(/^[A-Z]{2}\d{6}[ABCD]$/);
    }
  });
});
