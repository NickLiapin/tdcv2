import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * The Colombia country pack: NIT and the identity documents, the 32
 * departamentos plus Bogotá D.C. with their DANE codes, municipios, postal
 * codes, banks, universities, clubs, holidays, plates and phones.
 *
 * The NIT dígito de verificación is re-implemented here from the published
 * weight series — this file never calls the pack's own compute layer.
 */

function render(address: string, extraAttrs = '', count = 60, seed = 'co'): string[] {
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
 * NIT dígito de verificación: the prime weight series applied from the RIGHT,
 * mod 11; remainders 0 and 1 are the digit as they stand, any other r is 11-r.
 */
const NIT_WEIGHTS = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
function nitCheck(body: string): string {
  let sum = 0;
  for (let i = body.length - 1, w = 0; i >= 0; i--, w++) {
    sum += Number(body[i]) * (NIT_WEIGHTS[w] ?? 0);
  }
  const r = sum % 11;
  return String(r < 2 ? r : 11 - r);
}

// --- identifiers ---

describe('colombia.tax.nit', () => {
  it('agrees with real published NITs', () => {
    expect(nitCheck('890903938')).toBe('8'); // Bancolombia
    expect(nitCheck('899999068')).toBe('1'); // Ecopetrol
    expect(nitCheck('800197268')).toBe('4'); // DIAN
    expect(nitCheck('860002964')).toBe('4'); // Banco de Bogotá
  });

  it('is a 9-digit body plus a valid mod-11 dígito de verificación', () => {
    for (const v of render('colombia.tax.nit', '', 300)) {
      expect(v).toMatch(/^[1-9]\d{9}$/);
      expect(v.slice(9)).toBe(nitCheck(v.slice(0, 9)));
    }
  });

  it('exercises the r<2 branch as well as the 11-r one', () => {
    // Remainders 0 and 1 map to themselves; both must show up in a large draw.
    const checks = new Set(
      render('colombia.tax.nit', '', 400, 'dv').map((v) => Number(v.slice(9))),
    );
    expect(checks.has(0)).toBe(true);
    expect(checks.has(1)).toBe(true);
  });

  it('honours the body parameter (attribute passthrough)', () => {
    for (const v of render('colombia.tax.nit', ' body="900123456"')) {
      expect(v.startsWith('900123456')).toBe(true);
      expect(v.slice(9)).toBe(nitCheck('900123456'));
    }
  });
});

describe('colombia.tax.nitFormatted', () => {
  it('prints dot-grouped thousands and a hyphen before the check digit', () => {
    for (const v of render('colombia.tax.nitFormatted', '', 300)) {
      expect(v).toMatch(/^\d{3}\.\d{3}\.\d{3}-\d$/);
      const [body, dv] = v.replace(/\./g, '').split('-');
      expect(dv).toBe(nitCheck(body ?? ''));
    }
  });
});

describe('colombia identity documents', () => {
  it('cédula de ciudadanía is 8-10 digits and carries no check digit', () => {
    for (const v of render('colombia.docs.cc', '', 200)) expect(v).toMatch(/^[1-9]\d{7,9}$/);
    const description = bundledPacks().get('colombia.docs.cc')?.description ?? '';
    // The pack must say so rather than invent one.
    expect(description).toMatch(/NO check digit/i);
  });

  it('tarjeta de identidad is a 10-digit NUIP', () => {
    for (const v of render('colombia.docs.ti', '', 60)) expect(v).toMatch(/^1\d{9}$/);
  });

  it('cédula de extranjería is 6-7 digits', () => {
    for (const v of render('colombia.docs.ce', '', 60)) expect(v).toMatch(/^[1-9]\d{5,6}$/);
  });
});

// --- lists ---

describe('colombia list packs', () => {
  it('has the 32 departamentos plus Bogotá D.C., index-aligned with DANE / ISO / capital', () => {
    const names = packValues('colombia.geo.department');
    const dane = packValues('colombia.geo.departmentCode');
    const iso = packValues('colombia.geo.departmentIso');
    const capital = packValues('colombia.geo.departmentCapital');
    expect(names).toHaveLength(33);
    expect(dane).toHaveLength(33);
    expect(iso).toHaveLength(33);
    expect(capital).toHaveLength(33);

    expect(dane[names.indexOf('Antioquia')]).toBe('05');
    expect(dane[names.indexOf('Bogotá, D.C.')]).toBe('11');
    expect(dane[names.indexOf('Valle del Cauca')]).toBe('76');
    expect(dane[names.indexOf('Vichada')]).toBe('99');
    expect(iso[names.indexOf('Antioquia')]).toBe('ANT');
    expect(iso[names.indexOf('Norte de Santander')]).toBe('NSA');
    expect(capital[names.indexOf('Antioquia')]).toBe('Medellín');
    expect(capital[names.indexOf('Valle del Cauca')]).toBe('Cali');

    for (const c of dane) expect(c).toMatch(/^\d{2}$/);
    expect(new Set(dane).size).toBe(33);
    expect(new Set(iso).size).toBe(33);
  });

  it('keeps the bank name and compensation code lists index-aligned', () => {
    const banks = packValues('colombia.finance.bank');
    const codes = packValues('colombia.finance.bankCode');
    expect(banks.length).toBe(codes.length);
    for (const c of codes) expect(c).toMatch(/^\d{3}$/);
    expect(codes[banks.indexOf('Banco de Bogotá')]).toBe('001');
    expect(codes[banks.indexOf('Bancolombia')]).toBe('007');
    expect(codes[banks.indexOf('BBVA Colombia')]).toBe('013');
    expect(codes[banks.indexOf('Davivienda')]).toBe('051');
    expect(codes[banks.indexOf('Nequi')]).toBe('507');
  });

  it('keeps the holiday list aligned with how each one is dated', () => {
    const names = packValues('colombia.holiday');
    const rules = packValues('colombia.holidayRule');
    expect(names).toHaveLength(18);
    expect(rules).toHaveLength(18);
    for (const r of rules) expect(['fijo', 'lunes', 'pascua', 'pascua+lunes']).toContain(r);
    // Ley Emiliani moves ten of the eighteen to the following Monday.
    const moved = rules.filter((r) => r.includes('lunes')).length;
    expect(moved).toBe(10);
    // The four fixed civic dates never move.
    expect(rules[names.indexOf('Año Nuevo')]).toBe('fijo');
    expect(rules[names.indexOf('Día del Trabajo')]).toBe('fijo');
    expect(rules[names.indexOf('Día de la Independencia')]).toBe('fijo');
    expect(rules[names.indexOf('Batalla de Boyacá')]).toBe('fijo');
    expect(rules[names.indexOf('Navidad')]).toBe('fijo');
    // Epiphany and Reyes-style saints' days do move.
    expect(rules[names.indexOf('Día de los Reyes Magos')]).toBe('lunes');
    expect(rules[names.indexOf('Corpus Christi')]).toBe('pascua+lunes');
  });

  it('ships useful volumes of real geo / education / sport data', () => {
    expect(packValues('colombia.geo.municipality').length).toBeGreaterThanOrEqual(250);
    expect(packValues('colombia.geo.city').length).toBeGreaterThanOrEqual(120);
    expect(packValues('colombia.geo.streetNamed').length).toBeGreaterThanOrEqual(40);
    expect(packValues('colombia.education.university').length).toBeGreaterThanOrEqual(50);
    expect(packValues('colombia.sport.team').length).toBeGreaterThanOrEqual(30);
    expect(packValues('colombia.geo.city')).toContain('Bogotá');
    expect(packValues('colombia.sport.team')).toContain('Atlético Nacional');
    expect(packValues('colombia.education.university')).toContain(
      'Universidad Nacional de Colombia',
    );
  });
});

// --- generated formats ---

describe('colombia generated formats', () => {
  it('starts every postal code with a real DANE departamento code', () => {
    const depts = new Set(packValues('colombia.geo.departmentCode'));
    for (const v of render('colombia.geo.postalCode', '', 200)) {
      expect(v).toMatch(/^\d{6}$/);
      expect(depts.has(v.slice(0, 2)), `${v} does not start with a DANE code`).toBe(true);
      // Zona de encaminamiento is 00-89.
      expect(Number(v.slice(2, 4))).toBeLessThanOrEqual(89);
    }
  });

  it('generates car and motorcycle plates in their real layouts', () => {
    const values = render('colombia.vehicle.plate', '', 200);
    for (const v of values) expect(v).toMatch(/^(?:[A-Z]{3}\d{3}|[A-Z]{3}\d{2}[A-Z])$/);
    expect(values.some((v) => /^[A-Z]{3}\d{3}$/.test(v))).toBe(true);
    expect(values.some((v) => /^[A-Z]{3}\d{2}[A-Z]$/.test(v))).toBe(true);
    for (const v of render('colombia.vehicle.plateCar', '', 40)) {
      expect(v).toMatch(/^[A-Z]{3}\d{3}$/);
    }
    for (const v of render('colombia.vehicle.plateMotorcycle', '', 40)) {
      expect(v).toMatch(/^[A-Z]{3}\d{2}[A-Z]$/);
    }
  });

  it('generates 10-digit national numbers in E.164 form', () => {
    const values = render('colombia.phone', '', 200);
    for (const v of values) {
      expect(v).toMatch(/^\+57(?:3(?:0[0-5]|1\d|2[0-4]|5[01])\d{7}|60[124-8]\d{7})$/);
      expect(v).toHaveLength(13); // "+57" + ten national digits
    }
    expect(values.some((v) => v.startsWith('+573'))).toBe(true);
    expect(values.some((v) => v.startsWith('+5760'))).toBe(true);
  });

  it('builds numbered Calles / Carreras as well as named avenues', () => {
    const named = new Set(packValues('colombia.geo.streetNamed'));
    const values = render('colombia.geo.streetName', '', 200);
    for (const v of values) {
      const numbered =
        /^(?:Calle|Carrera|Diagonal|Transversal) \d{1,3}(?:[A-D]|Bis)?(?: (?:Sur|Norte|Este|Oeste))?$/.test(
          v,
        );
      expect(numbered || named.has(v), `unexpected street "${v}"`).toBe(true);
    }
    expect(values.some((v) => named.has(v))).toBe(true);
    expect(values.some((v) => v.startsWith('Carrera '))).toBe(true);
  });
});

// --- determinism ---

describe('colombia determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'colombia.tax.nit',
      'colombia.tax.nitFormatted',
      'colombia.docs.cc',
      'colombia.geo.postalCode',
      'colombia.geo.streetName',
      'colombia.vehicle.plate',
      'colombia.phone',
    ]) {
      expect(render(address, '', 20, 'seed-co')).toEqual(render(address, '', 20, 'seed-co'));
    }
  });
});
