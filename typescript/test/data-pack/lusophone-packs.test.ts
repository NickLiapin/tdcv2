import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Country packs for the Portuguese-speaking world beyond Portugal: Brazil, the
 * PALOP states (Angola, Mozambique, Cape Verde, Guinea-Bissau, Sao Tome and
 * Principe), East Timor and Macau. They all draw their values from the shared
 * `pt` locale. Brazil carries the re-derived CPF, CNPJ and PIS check digits;
 * every IBAN-registry member has its ISO 7064 check re-derived here.
 */

function render(address: string, count = 40, seed = 'pt'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="pt">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function mod97(digits: string): number {
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

function ibanIsoOk(iban: string): boolean {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  return mod97(expanded) === 1;
}

/** Both CPF check digits use the same rule: remainder < 2 means 0, else 11 - remainder. */
function mod11Check(digits: string, startWeight: number): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (startWeight - i);
  const rem = sum % 11;
  return rem < 2 ? 0 : 11 - rem;
}

function cpfValid(v: string): boolean {
  if (!/^\d{11}$/.test(v)) return false;
  if (mod11Check(v.slice(0, 9), 10) !== Number(v[9])) return false;
  return mod11Check(v.slice(0, 10), 11) === Number(v[10]);
}

function cnpjWeighted(digits: string, weights: number[]): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * weights[i]!;
  const rem = sum % 11;
  return rem < 2 ? 0 : 11 - rem;
}

function cnpjValid(v: string): boolean {
  if (!/^\d{14}$/.test(v)) return false;
  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  if (cnpjWeighted(v.slice(0, 12), w1) !== Number(v[12])) return false;
  return cnpjWeighted(v.slice(0, 13), w2) === Number(v[13]);
}

function pisValid(v: string): boolean {
  if (!/^\d{11}$/.test(v)) return false;
  const w = [3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(v[i]) * w[i]!;
  let check = 11 - (sum % 11);
  if (check > 9) check = 0;
  return check === Number(v[10]);
}

describe('brazil.tax.cpf', () => {
  it('is 11 digits and both mod-11 check digits re-derive', () => {
    const out = render('brazil.tax.cpf', 80);
    expect(out).toHaveLength(80);
    for (const v of out) expect(cpfValid(v), v).toBe(true);
  });
});

describe('brazil.tax.cnpj', () => {
  it('is 14 digits and both mod-11 check digits re-derive', () => {
    for (const v of render('brazil.tax.cnpj', 80)) expect(cnpjValid(v), v).toBe(true);
  });
});

describe('brazil.docs.pis', () => {
  it('is 11 digits and its weighted mod-11 check digit re-derives', () => {
    for (const v of render('brazil.docs.pis', 80)) expect(pisValid(v), v).toBe(true);
  });
});

describe('brazil.geo.stateCode', () => {
  it('is always a real two-letter federative unit', () => {
    const codes = new Set([
      'AC',
      'AL',
      'AP',
      'AM',
      'BA',
      'CE',
      'DF',
      'ES',
      'GO',
      'MA',
      'MT',
      'MS',
      'MG',
      'PA',
      'PB',
      'PR',
      'PE',
      'PI',
      'RJ',
      'RN',
      'RS',
      'RO',
      'RR',
      'SC',
      'SP',
      'SE',
      'TO',
    ]);
    for (const v of render('brazil.geo.stateCode', 40)) expect(codes.has(v), v).toBe(true);
  });
});

describe('lusophone IBANs carry a valid ISO 7064 check', () => {
  it.each([
    ['brazil.finance.iban', /^BR\d{25}[CSP][1-9]$/],
    ['angola.finance.iban', /^AO\d{23}$/],
    ['mozambique.finance.iban', /^MZ\d{23}$/],
    ['cape_verde.finance.iban', /^CV\d{23}$/],
    ['guinea_bissau.finance.iban', /^GW\d{2}[A-Z]{2}\d{19}$/],
    ['sao_tome_and_principe.finance.iban', /^ST\d{23}$/],
    ['east_timor.finance.iban', /^TL\d{21}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 30)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v), v).toBe(true);
    }
  });
});

describe('lusophone phone prefixes match the country calling code', () => {
  it.each([
    ['angola.phone', /^\+2449\d{8}$/],
    ['mozambique.phone', /^\+2588\d{8}$/],
    ['cape_verde.phone', /^\+2389\d{6}$/],
    ['guinea_bissau.phone', /^\+2459\d{6}$/],
    ['sao_tome_and_principe.phone', /^\+2399\d{6}$/],
    ['east_timor.phone', /^\+6707\d{6}$/],
    ['macau.phone', /^\+8536\d{7}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 20)) expect(v).toMatch(re);
  });
});

describe('lusophone packs resolve', () => {
  const addresses = [
    'brazil.geo.state',
    'brazil.geo.city',
    'brazil.geo.cep',
    'brazil.finance.bank',
    'brazil.vehicle.plate',
    'brazil.holiday',
    'brazil.sport.team',
    'brazil.education.university',
    'angola.geo.province',
    'angola.geo.city',
    'angola.finance.bank',
    'angola.docs.nif',
    'angola.vehicle.plate',
    'angola.holiday',
    'angola.sport.team',
    'angola.education.university',
    'mozambique.geo.province',
    'mozambique.geo.city',
    'mozambique.finance.bank',
    'mozambique.docs.nuit',
    'mozambique.vehicle.plate',
    'mozambique.holiday',
    'mozambique.sport.team',
    'mozambique.education.university',
    'cape_verde.geo.island',
    'cape_verde.geo.municipality',
    'cape_verde.geo.city',
    'cape_verde.finance.bank',
    'cape_verde.docs.nif',
    'cape_verde.holiday',
    'cape_verde.sport.team',
    'cape_verde.education.university',
    'guinea_bissau.geo.region',
    'guinea_bissau.geo.city',
    'guinea_bissau.finance.bank',
    'guinea_bissau.docs.nif',
    'guinea_bissau.vehicle.plate',
    'guinea_bissau.holiday',
    'guinea_bissau.sport.team',
    'guinea_bissau.education.university',
    'sao_tome_and_principe.geo.district',
    'sao_tome_and_principe.geo.city',
    'sao_tome_and_principe.finance.bank',
    'sao_tome_and_principe.docs.nif',
    'sao_tome_and_principe.holiday',
    'sao_tome_and_principe.sport.team',
    'sao_tome_and_principe.education.university',
    'east_timor.geo.municipality',
    'east_timor.geo.city',
    'east_timor.finance.bank',
    'east_timor.docs.nif',
    'east_timor.holiday',
    'east_timor.sport.team',
    'east_timor.education.university',
    'macau.docs.bir',
    'macau.finance.account',
    'macau.finance.bank',
    'macau.geo.parish',
    'macau.geo.district',
    'macau.vehicle.plate',
    'macau.holiday',
    'macau.sport.team',
    'macau.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('lusophone pack determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('brazil.tax.cpf', 20, 'x')).toEqual(render('brazil.tax.cpf', 20, 'x'));
    expect(render('angola.finance.iban', 20, 'x')).toEqual(render('angola.finance.iban', 20, 'x'));
  });
});
