import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { luhnCheckDigit } from '../../src/presets/utils.js';

/** Validity tests for Canadian presets migrated to bundled compute packs. */

function render(genTag: string, count = 40, seed = 'ca'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P">${genTag}</sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('canada.docs.sin', () => {
  it('produces valid 9-digit Luhn SINs', () => {
    for (const v of render('<gen type="template" value="canada.docs.sin"/>')) {
      expect(v).toMatch(/^\d{9}$/);
      expect(luhnCheckDigit(v.slice(0, 8))).toBe(Number(v[8]));
    }
  });
});

describe('canada.tax.bn / program_account', () => {
  it('BN is 9 digits', () => {
    for (const v of render('<gen type="template" value="canada.tax.bn"/>')) {
      expect(v).toMatch(/^\d{9}$/);
    }
  });

  it('program account is BN + program code + 4-digit reference', () => {
    for (const v of render('<gen type="template" value="canada.tax.program_account"/>')) {
      expect(v).toMatch(/^\d{9}(RC|RM|RP|RR|RT)\d{4}$/);
    }
  });
});
