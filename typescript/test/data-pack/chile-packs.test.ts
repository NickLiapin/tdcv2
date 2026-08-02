import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * The Chile country pack: RUN / RUT, the 16 regiones with their roman and CUT
 * codes, comunas and their Correos de Chile codes, banks, universities, clubs,
 * holidays, plates and phones.
 *
 * The módulo 11 check character is re-implemented here from the published
 * algorithm — this file never calls the pack's own compute layer, so a wrong
 * weight or a mishandled K fails the test rather than being rubber-stamped.
 */

function render(address: string, extraAttrs = '', count = 60, seed = 'cl'): string[] {
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

// --- independent reference implementation ---

/**
 * Chilean dígito verificador: walking the body right to left the weights cycle
 * 2,3,4,5,6,7; the check is 11 - (sum mod 11), where 11 folds to 0 and 10 is
 * written K.
 */
function rutCheck(body: string): string {
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

// --- identifiers ---

describe('chile RUN / RUT check character', () => {
  it('agrees with real published RUTs, K cases included', () => {
    // Institutions publish their RUT; these four are on their own websites.
    expect(rutCheck('61704000')).toBe('K'); // Codelco
    expect(rutCheck('60803000')).toBe('K'); // Servicio de Impuestos Internos
    expect(rutCheck('60910000')).toBe('1'); // Universidad de Chile
    expect(rutCheck('97004000')).toBe('5'); // Banco de Chile
  });

  for (const address of ['chile.docs.run', 'chile.tax.rut']) {
    it(`${address} is a 7-8 digit body plus a valid módulo 11 character`, () => {
      for (const v of render(address, '', 300)) {
        expect(v).toMatch(/^[1-9]\d{6,7}[0-9K]$/);
        expect(v.slice(-1)).toBe(rutCheck(v.slice(0, -1)));
      }
    });
  }

  it('emits K at roughly the 1-in-11 rate it occurs in reality', () => {
    const values = render('chile.docs.run', '', 600, 'k-rate');
    const k = values.filter((v) => v.endsWith('K')).length;
    // Exactly the bodies whose weighted sum is 1 mod 11 end in K.
    expect(k).toBeGreaterThan(20);
    expect(k).toBeLessThan(100);
  });
});

describe('chile.docs.runFormatted', () => {
  it('prints dot-grouped thousands and a hyphen before the check character', () => {
    for (const v of render('chile.docs.runFormatted', '', 300)) {
      expect(v).toMatch(/^\d{1,2}\.\d{3}\.\d{3}-[0-9K]$/);
      const [body, dv] = v.replace(/\./g, '').split('-');
      expect(dv).toBe(rutCheck(body ?? ''));
    }
  });

  it('produces K-ending RUTs too', () => {
    const values = render('chile.docs.runFormatted', '', 400, 'fmt-k');
    expect(values.some((v) => v.endsWith('-K'))).toBe(true);
  });
});

// --- lists ---

describe('chile list packs', () => {
  it('has all 16 regiones index-aligned across name / roman / ISO / CUT / capital', () => {
    const names = packValues('chile.geo.region');
    expect(names).toHaveLength(16);
    for (const address of [
      'chile.geo.regionRoman',
      'chile.geo.regionCode',
      'chile.geo.regionNumber',
      'chile.geo.regionCapital',
    ]) {
      expect(packValues(address), address).toHaveLength(16);
    }
    const roman = packValues('chile.geo.regionRoman');
    const iso = packValues('chile.geo.regionCode');
    const cut = packValues('chile.geo.regionNumber');
    const capital = packValues('chile.geo.regionCapital');

    const rm = names.indexOf('Metropolitana de Santiago');
    expect(rm).toBeGreaterThanOrEqual(0);
    expect(roman[rm]).toBe('RM');
    expect(iso[rm]).toBe('RM');
    expect(cut[rm]).toBe('13');
    expect(capital[rm]).toBe('Santiago');

    // Ñuble, split off Biobío in 2018, is the newest region: XVI / NB / 16.
    const nuble = names.indexOf('Ñuble');
    expect(roman[nuble]).toBe('XVI');
    expect(iso[nuble]).toBe('NB');
    expect(cut[nuble]).toBe('16');

    // The CUT codes are exactly 01..16 and the ISO codes are all distinct.
    expect([...cut].sort()).toEqual(
      Array.from({ length: 16 }, (_, i) => String(i + 1).padStart(2, '0')),
    );
    expect(new Set(iso).size).toBe(16);
    for (const c of iso) expect(c).toMatch(/^[A-Z]{2}$/);
  });

  it('has the 56 provincias', () => {
    expect(packValues('chile.geo.province')).toHaveLength(56);
  });

  it('keeps comunas index-aligned with their Correos de Chile codes', () => {
    const comunas = packValues('chile.geo.comuna');
    const codes = packValues('chile.geo.comunaPostalCode');
    expect(comunas.length).toBe(codes.length);
    expect(comunas.length).toBeGreaterThanOrEqual(340);
    for (const c of codes) expect(c).toMatch(/^\d{7}$/);
    const santiago = comunas.indexOf('Santiago');
    expect(codes[santiago]).toBe('8320000');
    expect(codes[comunas.indexOf('Providencia')]).toBe('7500000');
    expect(codes[comunas.indexOf('Valparaíso')]).toBe('2340000');
    expect(codes[comunas.indexOf('Antofagasta')]).toBe('1240000');
  });

  it('keeps the bank name and SBIF code lists index-aligned', () => {
    const banks = packValues('chile.finance.bank');
    const codes = packValues('chile.finance.bankCode');
    expect(banks.length).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^\d{3}$/);
    expect(codes[banks.indexOf('Banco de Chile')]).toBe('001');
    expect(codes[banks.indexOf('Banco del Estado de Chile')]).toBe('012');
    expect(codes[banks.indexOf('Banco de Crédito e Inversiones')]).toBe('016');
    expect(codes[banks.indexOf('Banco Santander-Chile')]).toBe('037');
  });

  it('ships useful volumes of real geo / education / sport data', () => {
    expect(packValues('chile.geo.city').length).toBeGreaterThanOrEqual(150);
    expect(packValues('chile.geo.streetNamed').length).toBeGreaterThanOrEqual(80);
    expect(packValues('chile.education.university').length).toBeGreaterThanOrEqual(45);
    expect(packValues('chile.sport.team').length).toBeGreaterThanOrEqual(30);
    expect(packValues('chile.holiday').length).toBeGreaterThanOrEqual(15);
    expect(packValues('chile.finance.accountType')).toContain('Cuenta RUT');
    expect(packValues('chile.sport.team')).toContain('Colo-Colo');
    expect(packValues('chile.education.university')).toContain('Universidad de Chile');
  });
});

// --- generated formats ---

describe('chile generated formats', () => {
  it('builds postal codes on a real comuna prefix', () => {
    const prefixes = new Set(packValues('chile.geo.comunaPostalCode').map((c) => c.slice(0, 3)));
    for (const v of render('chile.geo.postalCode', '', 120)) {
      expect(v).toMatch(/^\d{7}$/);
      expect(prefixes.has(v.slice(0, 3)), `${v} has no real comuna prefix`).toBe(true);
    }
  });

  it('generates plates in the post-2007 four-letter layout or the legacy one', () => {
    const values = render('chile.vehicle.plate', '', 300);
    for (const v of values) {
      expect(v).toMatch(/^(?:[BCDFGHJKLPRSTVWXYZ]{4}[1-9]\d|[A-Z]{2}\d{4})$/);
    }
    // The current series must dominate, and it never uses a vowel or M/N/Q.
    const current = values.filter((v) => /^[A-Z]{4}\d{2}$/.test(v));
    expect(current.length).toBeGreaterThan(values.length / 2);
    for (const v of current) expect(v.slice(0, 4)).not.toMatch(/[AEIOUMNQ]/);
  });

  it('generates E.164 mobiles and Santiago landlines', () => {
    const values = render('chile.phone', '', 200);
    for (const v of values) expect(v).toMatch(/^\+56(?:9[3-9]\d{7}|22\d{7})$/);
    expect(values.some((v) => v.startsWith('+569'))).toBe(true);
    expect(values.some((v) => v.startsWith('+562'))).toBe(true);
  });

  it('prefixes street names with a real Chilean vía type', () => {
    const named = new Set(packValues('chile.geo.streetNamed'));
    for (const v of render('chile.geo.streetName', '', 80)) {
      const [type, ...rest] = v.split(' ');
      expect([
        'Calle',
        'Avenida',
        'Pasaje',
        'Camino',
        'Costanera',
        'Rotonda',
        'Alameda',
        'Diagonal',
        'Subida',
        'Callejón',
      ]).toContain(type);
      expect(named.has(rest.join(' '))).toBe(true);
    }
  });
});

// --- determinism ---

describe('chile determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'chile.docs.run',
      'chile.docs.runFormatted',
      'chile.tax.rut',
      'chile.geo.postalCode',
      'chile.geo.streetName',
      'chile.vehicle.plate',
      'chile.phone',
    ]) {
      expect(render(address, '', 20, 'seed-cl')).toEqual(render(address, '', 20, 'seed-cl'));
    }
  });
});
