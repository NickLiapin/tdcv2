import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * The Spain country pack: DNI, NIE, NIF, CIF, NUSS, CCC and IBAN, plus the
 * geo / finance / education / sport lists.
 *
 * Every check character below is validated against an INDEPENDENT reference
 * implementation written here from the published algorithm — the test never
 * calls the pack's own compute logic, so a wrong weight, modulus or alphabet
 * in the pack fails rather than being rubber-stamped.
 *
 * Reference values the implementations were calibrated against:
 *   DNI    12345678Z            (Dirección General de Ordenación del Juego)
 *   CIF    A28015865            (Telefónica S.A.)
 *   CIF    Q2818014I            (Universidad Complutense de Madrid)
 *   CIF    P2807900B            (Ayuntamiento de Madrid)
 *   CCC    2100 0418 45 …       (control digits 4 and 5)
 *   IBAN   ES91 2100 0418 45 0200051332
 *   NUSS   28 12345678 40       (Grupo Alquerque / Intervia worked example)
 */

function render(address: string, count = 60, seed = 'es'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P"><gen type="template" value="${address}"/></sequence>`,
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

const DNI_LETTERS = 'TRWAGMYFPDXBNJZSQVHLCKE';

/** DNI: the 8-digit number mod 23 indexes the official letter table. */
function dniLetter(eightDigits: string): string {
  return DNI_LETTERS[Number(eightDigits) % 23] ?? '';
}

/** NIE: the leading X/Y/Z is replaced by 0/1/2, then the DNI rule applies. */
function nieLetter(nie: string): string {
  const prefixValue = { X: '0', Y: '1', Z: '2' }[nie[0] ?? ''] ?? '';
  return DNI_LETTERS[Number(`${prefixValue}${nie.slice(1, 8)}`) % 23] ?? '';
}

/**
 * CIF: odd 1-based positions doubled with a digit fold, even positions plain;
 * the control is (10 - sum mod 10) mod 10.
 */
function cifDigit(sevenDigits: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const d = Number(sevenDigits[i]);
    if (i % 2 === 0) {
      const doubled = d * 2;
      sum += doubled > 9 ? doubled - 9 : doubled;
    } else sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

const CIF_LETTERS = 'JABCDEFGHI';

function cifValid(cif: string): boolean {
  if (!/^[ABCDEFGHJNPQRSUVW]\d{7}[0-9A-J]$/.test(cif)) return false;
  const entity = cif[0] ?? '';
  const digit = cifDigit(cif.slice(1, 8));
  const letter = CIF_LETTERS[digit];
  const control = cif[8];
  // N/P/Q/R/S/W must carry a letter, A/B/E/H a digit, the rest accept either.
  if ('NPQRSW'.includes(entity)) return control === letter;
  if ('ABEH'.includes(entity)) return control === String(digit);
  return control === String(digit) || control === letter;
}

/** CCC control digit: weights 1,2,4,8,5,10,9,7,3,6 mod 11, 10 -> 1, 11 -> 0. */
const CCC_WEIGHTS = [1, 2, 4, 8, 5, 10, 9, 7, 3, 6];

function cccDigit(tenDigits: string): string {
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(tenDigits[i]) * (CCC_WEIGHTS[i] ?? 0);
  const d = 11 - (sum % 11);
  if (d === 11) return '0';
  if (d === 10) return '1';
  return String(d);
}

/** The two national control digits of a 20-digit CCC. */
function cccControl(ccc: string): string {
  return cccDigit(`00${ccc.slice(0, 8)}`) + cccDigit(ccc.slice(10, 20));
}

/** ISO 7064 mod-97-10: a valid IBAN leaves remainder 1. */
function ibanRemainder(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const value = /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const digit of value) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem;
}

/**
 * NUSS: mod 97 of province·10^8 + serial, or province·10^7 + serial when the
 * serial is below 10 000 000.
 */
function nussControl(province: string, serial: string): string {
  const n = Number(serial);
  const base = n < 10_000_000 ? Number(province) * 10_000_000 + n : Number(province + serial);
  return String(base % 97).padStart(2, '0');
}

// --- the reference implementations themselves, against real-world values ---

describe('reference implementations', () => {
  it('reproduce published Spanish identifiers', () => {
    expect(dniLetter('12345678')).toBe('Z');
    expect(nieLetter('X1234567')).toBe('L');
    // Telefónica, Repsol, Iberdrola, Inditex, Cruz Roja, UCM, AEAT, Madrid.
    for (const cif of [
      'A28015865',
      'A78374725',
      'A48010615',
      'A15075062',
      'G28029643',
      'Q2818014I',
      'Q2826000H',
      'P2807900B',
    ])
      expect(cifValid(cif), cif).toBe(true);
    expect(cccControl('21000418450200051332')).toBe('45');
    expect(ibanRemainder('ES9121000418450200051332')).toBe(1);
    expect(nussControl('28', '12345678')).toBe('40');
  });
});

// --- identifiers ---

describe('spain.docs.dni', () => {
  it('is 8 digits plus a valid mod-23 control letter', () => {
    for (const v of render('spain.docs.dni', 200)) {
      expect(v).toMatch(/^\d{8}[A-Z]$/);
      expect(v[8]).toBe(dniLetter(v.slice(0, 8)));
    }
  });
});

describe('spain.docs.nie', () => {
  it('is X/Y/Z + 7 digits plus a valid mod-23 control letter', () => {
    for (const v of render('spain.docs.nie', 200)) {
      expect(v).toMatch(/^[XYZ]\d{7}[A-Z]$/);
      expect(v[8]).toBe(nieLetter(v));
    }
  });

  it('uses all three leading letters', () => {
    const prefixes = new Set(render('spain.docs.nie', 200).map((v) => v[0]));
    expect(prefixes).toEqual(new Set(['X', 'Y', 'Z']));
  });
});

describe('spain.tax.cif', () => {
  it('carries the control character its entity letter requires', () => {
    for (const v of render('spain.tax.cif', 300)) expect(cifValid(v), v).toBe(true);
  });

  it('emits digit-control, letter-control and either-way entity families', () => {
    const entities = new Set(render('spain.tax.cif', 300).map((v) => v[0] ?? ''));
    expect([...entities].some((e) => 'ABEH'.includes(e))).toBe(true);
    expect([...entities].some((e) => 'NPQRSW'.includes(e))).toBe(true);
    expect([...entities].some((e) => 'CDFGJUV'.includes(e))).toBe(true);
  });

  it('starts its digit block with a real INE province code', () => {
    const codes = new Set(packValues('spain.geo.provinceCode'));
    for (const v of render('spain.tax.cif', 200)) expect(codes.has(v.slice(1, 3))).toBe(true);
  });
});

describe('spain.tax.vat', () => {
  it('is ES followed by a valid CIF', () => {
    for (const v of render('spain.tax.vat', 200)) {
      expect(v.slice(0, 2)).toBe('ES');
      expect(cifValid(v.slice(2)), v).toBe(true);
    }
  });
});

describe('spain.tax.nif', () => {
  it('is a valid DNI, NIE or CIF', () => {
    const seen = new Set<string>();
    for (const v of render('spain.tax.nif', 300)) {
      if (/^\d{8}[A-Z]$/.test(v)) {
        expect(v[8]).toBe(dniLetter(v.slice(0, 8)));
        seen.add('dni');
      } else if (/^[XYZ]\d{7}[A-Z]$/.test(v)) {
        expect(v[8]).toBe(nieLetter(v));
        seen.add('nie');
      } else {
        expect(cifValid(v), v).toBe(true);
        seen.add('cif');
      }
    }
    expect(seen).toEqual(new Set(['dni', 'nie', 'cif']));
  });
});

describe('spain.docs.nuss', () => {
  it('is 12 digits with a valid mod-97 control pair', () => {
    for (const v of render('spain.docs.nuss', 300)) {
      expect(v).toMatch(/^\d{12}$/);
      expect(v.slice(10)).toBe(nussControl(v.slice(0, 2), v.slice(2, 10)));
    }
  });

  it('exercises the sub-10-million branch and still validates', () => {
    const low = render('spain.docs.nuss', 300).filter((v) => v[2] === '0');
    expect(low.length).toBeGreaterThan(0);
    for (const v of low) expect(v.slice(10)).toBe(nussControl(v.slice(0, 2), v.slice(2, 10)));
  });

  it('assigns a real province code', () => {
    const codes = new Set(packValues('spain.geo.provinceCode'));
    for (const v of render('spain.docs.nuss')) expect(codes.has(v.slice(0, 2))).toBe(true);
  });
});

describe('spain.finance.ccc', () => {
  it('is 20 digits with both national control digits correct', () => {
    for (const v of render('spain.finance.ccc', 300)) {
      expect(v).toMatch(/^\d{20}$/);
      expect(v.slice(8, 10)).toBe(cccControl(v));
    }
  });

  it('starts with a real Banco de España entity code', () => {
    const codes = new Set(packValues('spain.finance.bankCode'));
    for (const v of render('spain.finance.ccc')) expect(codes.has(v.slice(0, 4))).toBe(true);
  });
});

describe('spain.finance.iban', () => {
  it('is 24 chars, ES-prefixed, and passes ISO 7064 mod-97-10', () => {
    for (const v of render('spain.finance.iban', 300)) {
      expect(v).toHaveLength(24);
      expect(v).toMatch(/^ES\d{22}$/);
      expect(ibanRemainder(v)).toBe(1);
    }
  });

  it('embeds a CCC whose own two control digits are also correct', () => {
    for (const v of render('spain.finance.iban', 300)) {
      const ccc = v.slice(4);
      expect(ccc.slice(8, 10)).toBe(cccControl(ccc));
    }
  });

  it('never emits the same value for the IBAN and the national check digits by luck', () => {
    // Both algorithms must be present: an IBAN whose ISO digits happened to be
    // reused as the national ones would be caught by the two tests above, but
    // this asserts the two blocks really do differ for at least some values.
    const differ = render('spain.finance.iban', 100).filter(
      (v) => v.slice(2, 4) !== v.slice(12, 14),
    );
    expect(differ.length).toBeGreaterThan(50);
  });
});

describe('spain.docs.passport', () => {
  it('is 3 letters + 6 digits (structural only)', () => {
    for (const v of render('spain.docs.passport')) expect(v).toMatch(/^[A-Z]{3}\d{6}$/);
  });
});

// --- lists ---

describe('spain list packs', () => {
  it('has the 17 autonomous communities, index-aligned with their codes', () => {
    const names = packValues('spain.geo.community');
    expect(names).toHaveLength(17);
    expect(packValues('spain.geo.communityCode')).toHaveLength(17);
    expect(packValues('spain.geo.communityIso')).toHaveLength(17);
    expect(packValues('spain.geo.communityCode')[0]).toBe('01');
    expect(names[0]).toBe('Andalucía');
    expect(packValues('spain.geo.communityIso')[0]).toBe('AN');
    expect(names.indexOf('Comunidad de Madrid')).toBe(12);
    expect(packValues('spain.geo.communityCode')[12]).toBe('13');
    expect(packValues('spain.geo.communityIso')[12]).toBe('MD');
  });

  it('has the 50 provinces in INE order, index-aligned with code / ISO / community', () => {
    const names = packValues('spain.geo.province');
    const codes = packValues('spain.geo.provinceCode');
    const iso = packValues('spain.geo.provinceIso');
    const communities = packValues('spain.geo.provinceCommunity');
    expect(names).toHaveLength(50);
    expect(codes).toHaveLength(50);
    expect(iso).toHaveLength(50);
    expect(communities).toHaveLength(50);
    // INE codes run 01..50 with no gaps, in order.
    codes.forEach((code, i) => {
      expect(code).toBe(String(i + 1).padStart(2, '0'));
    });
    // Spot-checks against the official register.
    const madrid = names.indexOf('Madrid');
    expect(codes[madrid]).toBe('28');
    expect(iso[madrid]).toBe('M');
    expect(communities[madrid]).toBe('Comunidad de Madrid');
    const barcelona = names.indexOf('Barcelona');
    expect(codes[barcelona]).toBe('08');
    expect(iso[barcelona]).toBe('B');
    expect(communities[barcelona]).toBe('Cataluña');
    expect(names[0]).toBe('Álava');
    expect(names[49]).toBe('Zaragoza');
    // Every province maps to one of the 17 communities.
    const known = new Set(packValues('spain.geo.community'));
    for (const c of communities) expect(known.has(c), c).toBe(true);
  });

  it('keeps the bank name and Banco de España code lists index-aligned', () => {
    const banks = packValues('spain.finance.bank');
    const codes = packValues('spain.finance.bankCode');
    expect(banks).toHaveLength(codes.length);
    expect(banks.length).toBeGreaterThanOrEqual(30);
    for (const code of codes) expect(code).toMatch(/^\d{4}$/);
    expect(new Set(codes).size).toBe(codes.length);
    expect(codes[banks.indexOf('Banco Santander')]).toBe('0049');
    expect(codes[banks.indexOf('Banco Bilbao Vizcaya Argentaria')]).toBe('0182');
    expect(codes[banks.indexOf('CaixaBank')]).toBe('2100');
    expect(codes[banks.indexOf('Banco de Sabadell')]).toBe('0081');
    expect(codes[banks.indexOf('Bankinter')]).toBe('0128');
  });

  it('ships useful volumes of real geo / education / sport data', () => {
    expect(packValues('spain.geo.city').length).toBeGreaterThanOrEqual(120);
    expect(packValues('spain.geo.streetNamed').length).toBeGreaterThanOrEqual(80);
    expect(packValues('spain.geo.streetType').length).toBeGreaterThanOrEqual(15);
    expect(packValues('spain.education.university').length).toBeGreaterThanOrEqual(50);
    expect(packValues('spain.sport.team').length).toBeGreaterThanOrEqual(42);
    expect(packValues('spain.holiday').length).toBeGreaterThanOrEqual(12);
  });

  it('lists the LaLiga and Segunda clubs', () => {
    const teams = packValues('spain.sport.team');
    for (const club of [
      'Real Madrid Club de Fútbol',
      'Fútbol Club Barcelona',
      'Club Atlético de Madrid',
      'Athletic Club',
      'Real Zaragoza',
      'Real Sporting de Gijón',
    ])
      expect(teams).toContain(club);
    expect(new Set(teams).size).toBe(teams.length);
  });

  it('generates códigos postales whose first two digits are a real province block', () => {
    for (const v of render('spain.geo.zip', 300)) {
      expect(v).toMatch(/^\d{5}$/);
      const block = Number(v.slice(0, 2));
      // 01-50 provinces, 51 Ceuta, 52 Melilla; 00 and 53-99 are unassigned.
      expect(block, v).toBeGreaterThanOrEqual(1);
      expect(block, v).toBeLessThanOrEqual(52);
      expect(v.slice(2)).not.toBe('000');
    }
  });

  it('generates plates in the post-2000 format with no vowels, Ñ or Q', () => {
    for (const v of render('spain.vehicle.plate', 200)) {
      expect(v).toMatch(/^\d{4} [BCDFGHJKLMNPRSTVWXYZ]{3}$/);
      expect(v).not.toMatch(/[AEIOUÑQ]/);
    }
  });

  it('composes a street from a real tipo de vía and a real name', () => {
    const types = new Set(packValues('spain.geo.streetType'));
    const names = new Set(packValues('spain.geo.streetNamed'));
    for (const v of render('spain.geo.streetName', 200)) {
      const space = v.indexOf(' ');
      expect(types.has(v.slice(0, space)), v).toBe(true);
      expect(names.has(v.slice(space + 1)), v).toBe(true);
    }
  });

  it('keeps the phone in Spanish mobile E.164 form', () => {
    for (const v of render('spain.phone')) expect(v).toMatch(/^\+346\d{8}$/);
  });
});

// --- determinism ---

describe('spain determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'spain.docs.dni',
      'spain.docs.nie',
      'spain.docs.nuss',
      'spain.tax.cif',
      'spain.tax.nif',
      'spain.finance.ccc',
      'spain.finance.iban',
      'spain.geo.zip',
      'spain.geo.streetName',
      'spain.vehicle.plate',
    ]) {
      expect(render(address, 20, 'seed-a')).toEqual(render(address, 20, 'seed-a'));
    }
  });
});
