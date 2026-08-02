import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Validity tests for the Latin-American country ID/tax presets migrated from
 * `src/presets/countries/{ar,bo,br,cl,co,cr,do,ec}.ts` into bundled compute
 * packs under `data/packs/countries/<country>/…`.
 *
 * Every reference algorithm below is re-derived here from the standard/old
 * check-digit definition. It deliberately does NOT import the pack compute
 * layer, so the pack and the test cannot share a bug.
 */

function render(addr: string, extra = '', count = 40, seed = 's'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${addr}"${extra}/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

// ---- independent reference check-digit algorithms (from the old presets) ----

function arTaxCheck(payload: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += Number(payload[i]) * (w[i] ?? 0);
  const c = 11 - (sum % 11);
  if (c === 11) return '0';
  if (c === 10) return '9';
  return String(c);
}

function brMod11(source: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < source.length; i++) sum += Number(source[i]) * (weights[i] ?? 0);
  const r = sum % 11;
  return r < 2 ? 0 : 11 - r;
}

function chileCheck(body: string): string {
  let sum = 0;
  let factor = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    sum += Number(body[i]) * factor;
    factor = factor === 7 ? 2 : factor + 1;
  }
  const c = 11 - (sum % 11);
  if (c === 11) return '0';
  if (c === 10) return 'K';
  return String(c);
}

function coNitCheck(body: string): number {
  const w = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  let sum = 0;
  for (let i = body.length - 1, wi = 0; i >= 0; i--, wi++) sum += Number(body[i]) * (w[wi] ?? 0);
  const r = sum % 11;
  return r < 2 ? r : 11 - r;
}

function luhnCheck(payload: string): number {
  const fullLength = payload.length + 1;
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    let d = Number(payload[i]);
    if (i % 2 === fullLength % 2) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function rncCheck(body: string): string {
  const w = [7, 9, 8, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (w[i] ?? 0);
  return String(((10 - (sum % 11)) % 9) + 1);
}

function ecMod10(payload: string): number {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) {
    let d = Number(payload[i]) * (i % 2 === 0 ? 2 : 1);
    if (d > 9) d -= 9;
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

function ecMod11(payload: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += Number(payload[i]) * (weights[i] ?? 0);
  const c = 11 - (sum % 11);
  return c === 11 ? 0 : c;
}

const EC_PROVINCES = new Set([
  '01',
  '02',
  '03',
  '04',
  '05',
  '06',
  '07',
  '08',
  '09',
  '10',
  '11',
  '12',
  '13',
  '14',
  '15',
  '16',
  '17',
  '18',
  '19',
  '20',
  '21',
  '22',
  '23',
  '24',
  '30',
  '50',
]);

// ------------------------------- argentina --------------------------------

describe('argentina.docs.dni', () => {
  it('is an 8-digit number with no leading zero', () => {
    for (const v of render('argentina.docs.dni')) expect(v).toMatch(/^[1-9]\d{7}$/);
  });
});

describe('argentina.tax.cuit', () => {
  it('is prefix + 8-digit body + weighted mod-11 check', () => {
    for (const v of render('argentina.tax.cuit')) {
      expect(v).toMatch(/^\d{11}$/);
      expect(['20', '23', '24', '27', '30', '33', '34']).toContain(v.slice(0, 2));
      expect(arTaxCheck(v.slice(0, 10))).toBe(v.slice(10));
    }
  });

  it('honours the prefix parameter (attribute passthrough)', () => {
    for (const v of render('argentina.tax.cuit', ' prefix="30"')) {
      expect(v.startsWith('30')).toBe(true);
      expect(arTaxCheck(v.slice(0, 10))).toBe(v.slice(10));
    }
  });
});

describe('argentina.tax.cuil', () => {
  it('is a CUIL prefix + 8-digit body + weighted mod-11 check', () => {
    for (const v of render('argentina.tax.cuil')) {
      expect(v).toMatch(/^\d{11}$/);
      expect(['20', '23', '24', '27']).toContain(v.slice(0, 2));
      expect(arTaxCheck(v.slice(0, 10))).toBe(v.slice(10));
    }
  });
});

// -------------------------------- bolivia ---------------------------------

describe('bolivia.docs.ci', () => {
  it('is a 7-digit number with no leading zero', () => {
    for (const v of render('bolivia.docs.ci')) expect(v).toMatch(/^[1-9]\d{6}$/);
  });
});

describe('bolivia.tax.nit', () => {
  it('is a 9-digit number', () => {
    for (const v of render('bolivia.tax.nit')) expect(v).toMatch(/^\d{9}$/);
  });
});

// -------------------------------- brazil ----------------------------------

describe('brazil.tax.cpf', () => {
  it('is a 9-digit base + two mod-11 check digits', () => {
    for (const v of render('brazil.tax.cpf')) {
      expect(v).toMatch(/^\d{11}$/);
      const base = v.slice(0, 9);
      const d1 = brMod11(base, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
      const d2 = brMod11(`${base}${String(d1)}`, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
      expect(v).toBe(`${base}${String(d1)}${String(d2)}`);
    }
  });
});

describe('brazil.tax.cnpj', () => {
  it('is root + branch + two mod-11 check digits', () => {
    for (const v of render('brazil.tax.cnpj')) {
      expect(v).toMatch(/^\d{14}$/);
      const base = v.slice(0, 12);
      const d1 = brMod11(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      const d2 = brMod11(`${base}${String(d1)}`, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
      expect(v).toBe(`${base}${String(d1)}${String(d2)}`);
    }
  });
});

// --------------------------------- chile ----------------------------------

describe('chile.docs.run / chile.tax.rut', () => {
  for (const addr of ['chile.docs.run', 'chile.tax.rut']) {
    it(`${addr} is a 7-8 digit body + cyclic weighted mod-11 check`, () => {
      for (const v of render(addr)) {
        expect(v).toMatch(/^[1-9]\d{6,7}[0-9K]$/);
        const body = v.slice(0, -1);
        expect(chileCheck(body)).toBe(v.slice(-1));
      }
    });
  }
});

// -------------------------------- colombia --------------------------------

describe('colombia.docs.cc', () => {
  it('is an 8-10 digit number with no leading zero', () => {
    for (const v of render('colombia.docs.cc')) expect(v).toMatch(/^[1-9]\d{7,9}$/);
  });
});

describe('colombia.tax.nit', () => {
  it('is a 9-digit body + prime-weighted mod-11 check', () => {
    for (const v of render('colombia.tax.nit')) {
      expect(v).toMatch(/^\d{10}$/);
      expect(String(coNitCheck(v.slice(0, 9)))).toBe(v.slice(9));
    }
  });

  it('honours the body parameter (attribute passthrough)', () => {
    for (const v of render('colombia.tax.nit', ' body="900123456"')) {
      expect(v.startsWith('900123456')).toBe(true);
      expect(String(coNitCheck('900123456'))).toBe(v.slice(9));
    }
  });
});

// ------------------------------- costa_rica -------------------------------

describe('costa_rica.docs.cpf', () => {
  it('is 10 digits starting with 0', () => {
    for (const v of render('costa_rica.docs.cpf')) expect(v).toMatch(/^0[1-9]\d{8}$/);
  });
});

describe('costa_rica.tax.cpj', () => {
  it('is class digit + class-specific type + 6-digit serial', () => {
    const re =
      /^(2(100|200|300|400)|3(002|003|004|005|006|007|008|009|010|011|012|013|014|101|102|103|104|105|106|107|108|109|110)|4000|5001)\d{6}$/;
    for (const v of render('costa_rica.tax.cpj')) expect(v).toMatch(re);
  });
});

// --------------------------- dominican_republic ---------------------------

describe('dominican_republic.docs.cedula', () => {
  it('is a 10-digit body + Luhn check digit', () => {
    for (const v of render('dominican_republic.docs.cedula')) {
      expect(v).toMatch(/^\d{11}$/);
      expect(String(luhnCheck(v.slice(0, 10)))).toBe(v.slice(10));
    }
  });
});

describe('dominican_republic.tax.rnc', () => {
  it('is an 8-digit body + weighted mod-11 check', () => {
    for (const v of render('dominican_republic.tax.rnc')) {
      expect(v).toMatch(/^[1-9]\d{8}$/);
      expect(rncCheck(v.slice(0, 8))).toBe(v.slice(8));
    }
  });
});

// -------------------------------- ecuador ---------------------------------

describe('ecuador.docs.ci', () => {
  it('is province + 9-digit payload + mod-10 check', () => {
    for (const v of render('ecuador.docs.ci')) {
      expect(v).toMatch(/^\d{10}$/);
      expect(EC_PROVINCES.has(v.slice(0, 2))).toBe(true);
      expect(Number(v[2])).toBeLessThanOrEqual(5);
      expect(String(ecMod10(v.slice(0, 9)))).toBe(v.slice(9));
    }
  });
});

describe('ecuador.tax.ruc', () => {
  it('is org-form: province + 9 + weighted mod-11 check + 001, never 10', () => {
    for (const v of render('ecuador.tax.ruc')) {
      expect(v).toMatch(/^\d{13}$/);
      expect(EC_PROVINCES.has(v.slice(0, 2))).toBe(true);
      expect(v[2]).toBe('9');
      expect(v.slice(10)).toBe('001');
      const check = ecMod11(v.slice(0, 9), [4, 3, 2, 7, 6, 5, 4, 3, 2]);
      expect(check).toBeLessThan(10);
      expect(String(check)).toBe(v[9]);
    }
  });
});

// ------------------------------ determinism -------------------------------

describe('determinism', () => {
  it('same seed reproduces the same values across renders', () => {
    for (const addr of [
      'argentina.tax.cuit',
      'brazil.tax.cnpj',
      'chile.tax.rut',
      'ecuador.tax.ruc',
    ]) {
      expect(render(addr, '', 20, 'd')).toEqual(render(addr, '', 20, 'd'));
    }
  });
});
