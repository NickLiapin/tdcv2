import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { weightedSum } from '../../src/presets/utils.js';

/** Validity test for the Polish NIP pack (weighted mod-11, reject check==10). */

function render(address: string, count = 60, seed = 'pl'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('poland.tax.nip', () => {
  it('produces valid 10-digit NIPs and never the rejected check==10', () => {
    const out = render('poland.tax.nip');
    expect(out.length).toBe(60);
    for (const v of out) {
      expect(v).toMatch(/^\d{10}$/);
      const check = weightedSum(v.slice(0, 9), [6, 5, 7, 2, 3, 4, 5, 6, 7]) % 11;
      expect(check).not.toBe(10);
      expect(check).toBe(Number(v[9]));
    }
  });
});
