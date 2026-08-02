import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * The Mexico country pack: CURP, CLABE, NSS and clave de elector, plus the
 * geo/education/sport/tax lists.
 *
 * Every check digit below is validated against an INDEPENDENT reference
 * implementation written here from the published algorithm — the test never
 * calls the pack's own compute logic, so a wrong weight or modulus in the pack
 * fails rather than being rubber-stamped.
 */

function render(address: string, extraAttrs = '', count = 60, seed = 'mx'): string[] {
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
 * CURP check digit: official alphabet "0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ",
 * value(char) * (18 - index) over the first 17 chars, then (10 - sum%10) % 10.
 */
const CURP_ALPHABET = '0123456789ABCDEFGHIJKLMNÑOPQRSTUVWXYZ';
function curpCheck(first17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += CURP_ALPHABET.indexOf(first17[i] ?? '') * (18 - i);
  return String((10 - (sum % 10)) % 10);
}

/** CLABE control digit: weights 3,7,1 repeating, each product folded mod 10. */
function clabeCheck(first17: string): string {
  const weights = [3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += (Number(first17[i]) * (weights[i % 3] ?? 0)) % 10;
  return String((10 - (sum % 10)) % 10);
}

/** Plain Luhn validity: the whole number (payload + check) must sum to 0 mod 10. */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// --- identifiers ---

describe('mexico.docs.curp', () => {
  const CURP_SHAPE = /^[A-Z]{4}\d{6}[HM][A-Z]{2}[BCDFGHJKLMNPQRSTVWXYZ]{3}[A-Z0-9]\d$/;

  it('is 18 chars with the documented layout', () => {
    for (const v of render('mexico.docs.curp')) {
      expect(v).toHaveLength(18);
      expect(v).toMatch(CURP_SHAPE);
    }
  });

  it('carries a valid mod-10 check digit weighted 18..2', () => {
    for (const v of render('mexico.docs.curp')) {
      expect(v.slice(17)).toBe(curpCheck(v.slice(0, 17)));
    }
  });

  it('uses only real RENAPO entity codes (32 states + NE)', () => {
    const codes = new Set(packValues('mexico.geo.curpStateCode'));
    expect(codes.size).toBe(33);
    expect(codes.has('NE')).toBe(true);
    for (const v of render('mexico.docs.curp')) expect(codes.has(v.slice(11, 13))).toBe(true);
  });

  it('fills the homoclave slot with a digit for 1900s births and a letter for 2000s', () => {
    for (const v of render('mexico.docs.curp', '', 200)) {
      const yy = Number(v.slice(4, 6));
      const homoclave = v.slice(16, 17);
      if (yy >= 30) expect(homoclave).toMatch(/^\d$/);
      else expect(homoclave).toMatch(/^[A-Z]$/);
    }
  });
});

describe('mexico.finance.clabe', () => {
  it('is 18 digits with a valid 3,7,1 mod-10 control digit', () => {
    for (const v of render('mexico.finance.clabe')) {
      expect(v).toMatch(/^\d{18}$/);
      expect(v.slice(17)).toBe(clabeCheck(v.slice(0, 17)));
    }
  });

  it('starts with a real Banxico institution code', () => {
    const banks = new Set(packValues('mexico.finance.bankCode'));
    for (const v of render('mexico.finance.clabe')) expect(banks.has(v.slice(0, 3))).toBe(true);
  });
});

describe('mexico.docs.nss', () => {
  it('is 11 digits and passes Luhn', () => {
    for (const v of render('mexico.docs.nss')) {
      expect(v).toMatch(/^\d{11}$/);
      expect(luhnValid(v)).toBe(true);
    }
  });

  it('never uses subdelegación 00', () => {
    for (const v of render('mexico.docs.nss')) expect(v.slice(0, 2)).not.toBe('00');
  });
});

describe('mexico.docs.ine', () => {
  it('is an 18-char clave de elector with a 01-32 entity and H/M sex', () => {
    for (const v of render('mexico.docs.ine')) {
      expect(v).toHaveLength(18);
      expect(v).toMatch(/^[A-Z]{6}\d{6}(?:0[1-9]|[12]\d|3[0-2])[HM]\d{3}$/);
    }
  });
});

// --- lists ---

describe('mexico list packs', () => {
  it('has the 32 federal entities, index-aligned across name / abbr / ISO code', () => {
    expect(packValues('mexico.geo.state')).toHaveLength(32);
    expect(packValues('mexico.geo.stateAbbr')).toHaveLength(32);
    expect(packValues('mexico.geo.stateCode')).toHaveLength(32);
    // curpStateCode is the same 32 plus NE
    expect(packValues('mexico.geo.curpStateCode')).toHaveLength(33);
  });

  it('keeps the SAT regime name and code lists index-aligned, RESICO included', () => {
    const names = packValues('mexico.tax.regime');
    const codes = packValues('mexico.tax.regimeCode');
    expect(names).toHaveLength(codes.length);
    const resico = names.indexOf('Régimen Simplificado de Confianza');
    expect(resico).toBeGreaterThanOrEqual(0);
    expect(codes[resico]).toBe('626');
  });

  it('keeps the bank name and Banxico code lists index-aligned', () => {
    expect(packValues('mexico.finance.bank')).toHaveLength(
      packValues('mexico.finance.bankCode').length,
    );
    for (const code of packValues('mexico.finance.bankCode')) expect(code).toMatch(/^\d{3}$/);
  });

  it('ships useful volumes of real geo/education data', () => {
    expect(packValues('mexico.geo.city').length).toBeGreaterThanOrEqual(120);
    expect(packValues('mexico.geo.municipality').length).toBeGreaterThanOrEqual(120);
    expect(packValues('mexico.geo.streetNamed').length).toBeGreaterThanOrEqual(80);
    expect(packValues('mexico.education.university').length).toBeGreaterThanOrEqual(50);
    expect(packValues('mexico.sport.team').length).toBeGreaterThanOrEqual(18);
    expect(packValues('mexico.holiday').length).toBeGreaterThanOrEqual(8);
  });

  it('generates Códigos Postales inside real SEPOMEX state blocks', () => {
    for (const v of render('mexico.geo.zip')) {
      expect(v).toMatch(/^\d{5}$/);
      const block = Number(v.slice(0, 2));
      const assigned = (block >= 1 && block <= 16) || (block >= 20 && block <= 99);
      expect(assigned, `CP block ${v.slice(0, 2)} is not a SEPOMEX state block`).toBe(true);
    }
  });

  it('generates plates in one of the two documented layouts', () => {
    for (const v of render('mexico.vehicle.plate')) {
      expect(v).toMatch(/^(?:[A-Z]{3}-\d{2}-\d{2}|\d{3}-[A-Z]{3})$/);
    }
  });
});

// --- determinism ---

describe('mexico determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'mexico.docs.curp',
      'mexico.docs.nss',
      'mexico.docs.ine',
      'mexico.finance.clabe',
      'mexico.geo.streetName',
      'mexico.geo.zip',
    ]) {
      expect(render(address, '', 20, 'seed-a')).toEqual(render(address, '', 20, 'seed-a'));
    }
  });
});
