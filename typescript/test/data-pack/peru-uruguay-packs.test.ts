import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * The Peru and Uruguay country packs: RUC, DNI, cédula, RUT and CCI, plus the
 * geo / finance / education / sport lists.
 *
 * Every check digit below is validated against an INDEPENDENT reference
 * implementation written here from the published algorithm — the test never
 * calls the pack's own compute logic, so a wrong weight or modulus in a pack
 * fails rather than being rubber-stamped.
 *
 * Real-world anchors the references are pinned to:
 *   - Peru RUC     20131257750 (SUNAT), 20100047218 (Banco de Crédito del Perú)
 *   - Uruguay RUT  211003420017 (ANTEL), 213159150013
 *   - Uruguay CI   1.234.567-2, 1.111.111-1
 */

function render(address: string, extraAttrs = '', count = 60, seed = 'pe-uy'): string[] {
  const gen = `<gen type="template" value="${address}"${extraAttrs}/>`;
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P">${gen}</sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function packValues(address: string): readonly string[] {
  const entry = bundledPacks().get(address);
  expect(entry, `pack "${address}" must exist`).toBeDefined();
  return entry?.values ?? [];
}

// --- independent reference implementations ---

/**
 * Peru RUC: weights 5,4,3,2,7,6,5,4,3,2 over the 10-digit payload,
 * check = 11 - sum%11 with 10 folded to 0 and 11 folded to 1.
 */
function peRucCheck(payload: string): string {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(payload[i]) * (weights[i] ?? 0);
  const check = 11 - (sum % 11);
  if (check === 10) return '0';
  if (check === 11) return '1';
  return String(check);
}

/** Uruguay cédula: weights 2,9,8,7,6,3,4, check = (10 - sum%10) % 10. */
function uyCiCheck(body: string): string {
  const weights = [2, 9, 8, 7, 6, 3, 4];
  let sum = 0;
  const padded = body.padStart(7, '0');
  for (let i = 0; i < 7; i++) sum += Number(padded[i]) * (weights[i] ?? 0);
  return String((10 - (sum % 10)) % 10);
}

/**
 * Uruguay RUT: weights 4,3,2,9,8,7,6,5,4,3,2 over the 11-digit body,
 * check = 11 - sum%11 with 11 folded to 0. A result of 10 has no digit to
 * carry it — DGI simply never issues such a body — so this reference returns
 * null there instead of inventing a digit.
 */
function uyRutCheck(body: string): string | null {
  const weights = [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(body[i]) * (weights[i] ?? 0);
  const check = 11 - (sum % 11);
  if (check === 11) return '0';
  if (check === 10) return null;
  return String(check);
}

// --- the references agree with published real-world identifiers ---

describe('reference implementations match published identifiers', () => {
  it('peru RUC', () => {
    for (const ruc of ['20131257750', '20100047218', '20100017491', '20148092282']) {
      expect(peRucCheck(ruc.slice(0, 10)), ruc).toBe(ruc.slice(10));
    }
  });

  it('uruguay RUT', () => {
    for (const rut of ['211003420017', '213159150013']) {
      expect(uyRutCheck(rut.slice(0, 11)), rut).toBe(rut.slice(11));
    }
  });

  it('uruguay cédula', () => {
    expect(uyCiCheck('1234567')).toBe('2');
    expect(uyCiCheck('1111111')).toBe('1');
  });
});

// --- Peru identifiers ---

describe('peru.tax.ruc', () => {
  it('is 11 digits with a real tipo de contribuyente and a valid mod-11 check', () => {
    for (const v of render('peru.tax.ruc', '', 200)) {
      expect(v).toMatch(/^(?:10|15|17|20)\d{9}$/);
      expect(v.slice(10)).toBe(peRucCheck(v.slice(0, 10)));
    }
  });

  it('emits every documented prefix over enough rows', () => {
    const prefixes = new Set(render('peru.tax.ruc', '', 200).map((v) => v.slice(0, 2)));
    expect(prefixes).toEqual(new Set(['10', '15', '17', '20']));
  });

  it('honours a prefix override', () => {
    for (const v of render('peru.tax.ruc', ' prefix="20"')) {
      expect(v.startsWith('20')).toBe(true);
      expect(v.slice(10)).toBe(peRucCheck(v.slice(0, 10)));
    }
  });
});

describe('peru.tax.ruc_person / ruc_company', () => {
  it('ruc_person is 10 + an 8-digit DNI + a valid check digit', () => {
    for (const v of render('peru.tax.ruc_person')) {
      expect(v).toMatch(/^10\d{9}$/);
      expect(v.slice(10)).toBe(peRucCheck(v.slice(0, 10)));
    }
  });

  it('ruc_person carries the DNI it was given, check digit and all', () => {
    for (const v of render('peru.tax.ruc_person', ' dni="43816728"')) {
      expect(v.slice(0, 10)).toBe('1043816728');
      expect(v.slice(10)).toBe(peRucCheck('1043816728'));
    }
  });

  it('ruc_company is 20 + a real-shaped SUNAT serial + a valid check digit', () => {
    for (const v of render('peru.tax.ruc_company')) {
      expect(v).toMatch(/^20[13456]\d{8}$/);
      expect(v.slice(10)).toBe(peRucCheck(v.slice(0, 10)));
    }
  });
});

describe('peru.docs.dni', () => {
  it('is exactly 8 digits and carries no check character', () => {
    for (const v of render('peru.docs.dni')) expect(v).toMatch(/^\d{8}$/);
  });
});

describe('peru.finance.cci', () => {
  it('is 20 digits opening on a real BCRP institution code', () => {
    const codes = new Set(packValues('peru.finance.bankCode'));
    for (const v of render('peru.finance.cci')) {
      expect(v).toMatch(/^\d{20}$/);
      expect(codes.has(v.slice(0, 3))).toBe(true);
    }
  });

  it('says in its own description that the control pair is structural only', () => {
    const description = bundledPacks().get('peru.finance.cci')?.description ?? '';
    expect(description.toLowerCase()).toContain('structural only');
  });
});

// --- Uruguay identifiers ---

describe('uruguay.docs.ci', () => {
  it('is 7 digits plus a valid weighted mod-10 check digit', () => {
    for (const v of render('uruguay.docs.ci', '', 200)) {
      expect(v).toMatch(/^[1-9]\d{6}\d$/);
      expect(v.slice(7)).toBe(uyCiCheck(v.slice(0, 7)));
    }
  });

  it('honours a body override', () => {
    for (const v of render('uruguay.docs.ci', ' body="1234567"')) expect(v).toBe('12345672');
  });
});

describe('uruguay.tax.rut', () => {
  it('is 12 digits with a valid mod-11 check digit and never the unusable case', () => {
    for (const v of render('uruguay.tax.rut', '', 400)) {
      expect(v).toMatch(/^(?:0[1-9]|1\d|2[01])\d{6}001\d$/);
      const expected = uyRutCheck(v.slice(0, 11));
      expect(expected, `${v} has a body DGI would never issue`).not.toBeNull();
      expect(v.slice(11)).toBe(expected);
    }
  });

  it('honours a body override', () => {
    for (const v of render('uruguay.tax.rut', ' body="21123456001"')) {
      expect(v.slice(0, 11)).toBe('21123456001');
      expect(v.slice(11)).toBe(uyRutCheck('21123456001'));
    }
  });
});

// --- list packs ---

describe('peru list packs', () => {
  it('has the 24 departamentos plus Callao, index-aligned across name / INEI / ISO', () => {
    const names = packValues('peru.geo.department');
    const inei = packValues('peru.geo.departmentCode');
    const iso = packValues('peru.geo.departmentIso');
    expect(names).toHaveLength(25);
    expect(inei).toHaveLength(25);
    expect(iso).toHaveLength(25);
    expect(inei[names.indexOf('Callao')]).toBe('07');
    expect(iso[names.indexOf('Callao')]).toBe('CAL');
    expect(inei[names.indexOf('Lima')]).toBe('15');
    for (const code of inei) expect(code).toMatch(/^(?:0[1-9]|1\d|2[0-5])$/);
    for (const code of iso) expect(code).toMatch(/^[A-Z]{3}$/);
  });

  it('has all 196 provincias, each paired with its department', () => {
    const provinces = packValues('peru.geo.province');
    const departments = packValues('peru.geo.provinceDepartment');
    expect(provinces).toHaveLength(196);
    expect(departments).toHaveLength(196);
    const known = new Set(packValues('peru.geo.department'));
    for (const department of departments) expect(known.has(department)).toBe(true);
    expect(departments[provinces.indexOf('Maynas')]).toBe('Loreto');
    expect(departments[provinces.indexOf('Tambopata')]).toBe('Madre de Dios');
  });

  it('keeps the bank name and BCRP code lists index-aligned', () => {
    const banks = packValues('peru.finance.bank');
    const codes = packValues('peru.finance.bankCode');
    expect(banks).toHaveLength(codes.length);
    for (const code of codes) expect(code).toMatch(/^\d{3}$/);
    expect(codes[banks.indexOf('Banco de Crédito del Perú')]).toBe('002');
    expect(codes[banks.indexOf('BBVA Perú')]).toBe('011');
    expect(codes[banks.indexOf('Banco de la Nación')]).toBe('018');
  });

  it('ships useful volumes of real geo / education / sport data', () => {
    expect(packValues('peru.geo.city').length).toBeGreaterThanOrEqual(120);
    expect(packValues('peru.geo.streetNamed').length).toBeGreaterThanOrEqual(80);
    expect(packValues('peru.education.university').length).toBeGreaterThanOrEqual(50);
    expect(packValues('peru.sport.team').length).toBeGreaterThanOrEqual(18);
    expect(packValues('peru.holiday').length).toBeGreaterThanOrEqual(16);
  });

  it('generates postal codes inside a real INEI department block', () => {
    const blocks = new Set(packValues('peru.geo.departmentCode'));
    for (const v of render('peru.geo.zip', '', 120)) {
      expect(v).toMatch(/^\d{5}$/);
      expect(blocks.has(v.slice(0, 2))).toBe(true);
    }
  });

  it('generates plates in one of the documented MTC layouts', () => {
    for (const v of render('peru.vehicle.plate', '', 120)) {
      expect(v).toMatch(/^(?:[A-Z]\d[A-Z]-\d{3}|[A-Z]{2}\d-\d{3}|[A-Z]{3}-\d{3}|[A-Z]{2}-\d{4})$/);
    }
  });

  it('generates a phone number that is a real Peruvian mobile', () => {
    for (const v of render('peru.phone')) expect(v).toMatch(/^\+519\d{8}$/);
  });
});

describe('uruguay list packs', () => {
  it('has the 19 departamentos, index-aligned across name / ISO / plate letter / zip', () => {
    const names = packValues('uruguay.geo.department');
    const iso = packValues('uruguay.geo.departmentCode');
    const letters = packValues('uruguay.geo.departmentPlateLetter');
    const zips = packValues('uruguay.geo.zipPrefix');
    expect(names).toHaveLength(19);
    expect(iso).toHaveLength(19);
    expect(letters).toHaveLength(19);
    expect(zips).toHaveLength(19);
    expect(new Set(letters).size).toBe(19);
    expect(iso[names.indexOf('Montevideo')]).toBe('MO');
    expect(letters[names.indexOf('Montevideo')]).toBe('S');
    expect(zips[names.indexOf('Montevideo')]).toBe('11');
    expect(iso[names.indexOf('Flores')]).toBe('FS');
    expect(iso[names.indexOf('Florida')]).toBe('FD');
  });

  it('keeps the bank name, BCU code and BIC lists index-aligned', () => {
    const banks = packValues('uruguay.finance.bank');
    const codes = packValues('uruguay.finance.bankCode');
    const bics = packValues('uruguay.finance.bic');
    expect(banks).toHaveLength(codes.length);
    expect(banks).toHaveLength(bics.length);
    expect(codes[banks.indexOf('Banco de la República Oriental del Uruguay')]).toBe('001');
    expect(bics[banks.indexOf('Banco de la República Oriental del Uruguay')]).toBe('BROUUYMM');
    for (const code of codes) expect(code).toMatch(/^\d{3}$/);
    // 4-letter institution code + the UY country code + a 2-char location.
    for (const bic of bics) expect(bic).toMatch(/^[A-Z]{4}UY[A-Z0-9]{2}$/);
  });

  it('ships an honest, unpadded amount of real data for a small country', () => {
    expect(packValues('uruguay.geo.city').length).toBeGreaterThanOrEqual(60);
    expect(packValues('uruguay.geo.streetNamed').length).toBeGreaterThanOrEqual(60);
    // Two public plus five private universities and six university institutes
    // is the whole recognised sector — anything longer would be invented.
    expect(packValues('uruguay.education.university')).toHaveLength(13);
    expect(packValues('uruguay.sport.team').length).toBeGreaterThanOrEqual(16);
    expect(packValues('uruguay.holiday').length).toBeGreaterThanOrEqual(13);
  });

  it('generates postal codes inside a real departmental block', () => {
    const blocks = new Set(packValues('uruguay.geo.zipPrefix'));
    for (const v of render('uruguay.geo.zip', '', 120)) {
      expect(v).toMatch(/^\d{5}$/);
      expect(blocks.has(v.slice(0, 2))).toBe(true);
    }
  });

  it('generates Mercosur plates whose first letter is a real department letter', () => {
    const letters = new Set(packValues('uruguay.geo.departmentPlateLetter'));
    for (const v of render('uruguay.vehicle.plate', '', 120)) {
      expect(v).toMatch(/^[A-Z]{3} \d{4}$/);
      expect(letters.has(v.slice(0, 1))).toBe(true);
    }
  });

  it('generates a phone number that is a real Uruguayan mobile', () => {
    for (const v of render('uruguay.phone')) expect(v).toMatch(/^\+5989\d{7}$/);
  });
});

// --- determinism ---

describe('peru / uruguay determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'peru.tax.ruc',
      'peru.tax.ruc_person',
      'peru.tax.ruc_company',
      'peru.finance.cci',
      'peru.geo.zip',
      'peru.geo.streetName',
      'uruguay.docs.ci',
      'uruguay.tax.rut',
      'uruguay.geo.zip',
      'uruguay.vehicle.plate',
    ]) {
      expect(render(address, '', 20, 'seed-a')).toEqual(render(address, '', 20, 'seed-a'));
    }
  });
});
