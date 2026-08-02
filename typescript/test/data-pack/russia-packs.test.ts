import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { weightedSum } from '../../src/presets/utils.js';

/** Validity tests for the Russian presets migrated to bundled compute packs. */

function render(genTag: string, count = 40, seed = 'ru'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P">${genTag}</sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

const tmpl = (addr: string, extra = ''): string => `<gen type="template" value="${addr}"${extra}/>`;

const innDigit = (src: string, w: readonly number[]): number => (weightedSum(src, w) % 11) % 10;

describe('russia.tax.inn_org', () => {
  it('produces valid 10-digit INNs (weighted mod-11)', () => {
    for (const v of render(tmpl('russia.tax.inn_org'))) {
      expect(v).toMatch(/^\d{10}$/);
      expect(innDigit(v.slice(0, 9), [2, 4, 10, 3, 5, 9, 4, 6, 8])).toBe(Number(v[9]));
    }
  });

  it('honours the tax_office parameter (attribute passthrough)', () => {
    for (const v of render(tmpl('russia.tax.inn_org', ' tax_office="7712"'))) {
      expect(v.startsWith('7712')).toBe(true);
      expect(innDigit(v.slice(0, 9), [2, 4, 10, 3, 5, 9, 4, 6, 8])).toBe(Number(v[9]));
    }
  });
});

describe('russia.tax.inn_person', () => {
  it('produces valid 12-digit INNs (two weighted mod-11 checks)', () => {
    for (const v of render(tmpl('russia.tax.inn_person'))) {
      expect(v).toMatch(/^\d{12}$/);
      expect(innDigit(v.slice(0, 10), [7, 2, 4, 10, 3, 5, 9, 4, 6, 8])).toBe(Number(v[10]));
      expect(innDigit(v.slice(0, 11), [3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8])).toBe(Number(v[11]));
    }
  });
});

describe('russia.docs.snils', () => {
  it('produces valid SNILS (mod-101 check)', () => {
    for (const v of render(tmpl('russia.docs.snils'))) {
      expect(v).toMatch(/^\d{11}$/);
      const sum = weightedSum(v.slice(0, 9), [9, 8, 7, 6, 5, 4, 3, 2, 1]);
      const check = ((sum % 101) % 100).toString().padStart(2, '0');
      expect(v.slice(9)).toBe(check);
    }
  });
});

describe('russia.tax.ogrn / ogrnip', () => {
  it('OGRN is 13 digits with a valid mod-11 check', () => {
    for (const v of render(tmpl('russia.tax.ogrn'))) {
      expect(v).toMatch(/^1\d{12}$/);
      expect((Number(v.slice(0, 12)) % 11) % 10).toBe(Number(v[12]));
    }
  });

  it('OGRNIP is 15 digits with a valid mod-13 check', () => {
    for (const v of render(tmpl('russia.tax.ogrnip'))) {
      expect(v).toMatch(/^3\d{14}$/);
      expect((Number(v.slice(0, 14)) % 13) % 10).toBe(Number(v[14]));
    }
  });
});

describe('russia.tax.kpp / russia.bank.bik', () => {
  it('KPP is 9 digits with a valid reason code', () => {
    for (const v of render(tmpl('russia.tax.kpp'))) {
      expect(v).toMatch(/^\d{9}$/);
      expect(['01', '06', '07', '08', '43', '44', '45']).toContain(v.slice(4, 6));
    }
  });

  it('BIK is 9 digits starting 04', () => {
    for (const v of render(tmpl('russia.bank.bik'))) {
      expect(v).toMatch(/^04\d{7}$/);
    }
  });
});

describe('russia.geo.postal', () => {
  it('produces valid 6-digit postal indices (first digit 1–6)', () => {
    for (const v of render(tmpl('russia.geo.postal'))) {
      expect(v).toMatch(/^[1-6]\d{5}$/);
      const n = Number(v);
      expect(n).toBeGreaterThanOrEqual(101000);
      expect(n).toBeLessThanOrEqual(692999);
    }
  });
});
