import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * The Argentina country pack: CUIT/CUIL, CBU, DNI and the phone/CPA/plate
 * generators, plus the geo / finance / education / sport lists.
 *
 * Every check digit below is validated against an INDEPENDENT reference
 * implementation written here from the published algorithm — the test never
 * calls the pack's own compute logic, so a wrong weight or modulus in the pack
 * fails rather than being rubber-stamped. Each algorithm is additionally
 * pinned to real published identifiers (see the `real published` cases).
 */

function render(address: string, extraAttrs = '', count = 60, seed = 'ar'): string[] {
  const gen = `<gen type="template" value="${address}"${extraAttrs}/>`;
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}" local="es">`,
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
 * CUIT/CUIL verificador: weights 5,4,3,2,7,6,5,4,3,2 over the 10 payload
 * digits, then 11 - (sum % 11), folded 11 -> 0 and 10 -> 9.
 */
function arTaxCheck(payload: string): string {
  const w = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(payload[i]) * (w[i] ?? 0);
  const c = 11 - (sum % 11);
  if (c === 11) return '0';
  if (c === 10) return '9';
  return String(c);
}

/** One CBU block check digit: weighted sum, then (10 - sum % 10) % 10. */
function cbuBlockCheck(digits: string, weights: readonly number[]): string {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (weights[i] ?? 0);
  return String((10 - (sum % 10)) % 10);
}

const CBU_W1 = [7, 1, 3, 9, 7, 1, 3];
const CBU_W2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];

/** A CBU is valid only when BOTH of its independent block check digits hold. */
function cbuValid(v: string): boolean {
  if (!/^\d{22}$/.test(v)) return false;
  return (
    cbuBlockCheck(v.slice(0, 7), CBU_W1) === v.slice(7, 8) &&
    cbuBlockCheck(v.slice(8, 21), CBU_W2) === v.slice(21, 22)
  );
}

// --- the reference algorithms, pinned to real published identifiers ---

describe('argentina check-digit algorithms (real published values)', () => {
  it('reproduces the verificador of real CUITs', () => {
    // YPF S.A. 30-54668997-9 and Banco de la Nación Argentina 30-50001091-2.
    expect(arTaxCheck('3054668997')).toBe('9');
    expect(arTaxCheck('3050001091')).toBe('2');
  });

  it('accepts real CBUs and rejects a one-digit corruption', () => {
    // Worked example published by BCRA/Wikipedia and used by python-stdnum.
    expect(cbuValid('2850590940090418135201')).toBe(true);
    expect(cbuValid('2810590940090418135201')).toBe(false);
    // A CBU published by the Colegio de Criminalistas de Corrientes; its
    // entity code 094 is Banco de Corrientes, which matches the holder.
    expect(cbuValid('0940099330004729950018')).toBe(true);
    expect('0940099330004729950018'.slice(0, 3)).toBe('094');
  });
});

// --- identifiers ---

describe('argentina.tax.cuit', () => {
  it('is a type prefix + 8-digit body + weighted mod-11 verificador', () => {
    for (const v of render('argentina.tax.cuit', '', 200)) {
      expect(v).toMatch(/^\d{11}$/);
      expect(['20', '23', '24', '27', '30', '33', '34']).toContain(v.slice(0, 2));
      expect(v.slice(10)).toBe(arTaxCheck(v.slice(0, 10)));
    }
  });

  it('honours a pinned taxpayer type', () => {
    for (const v of render('argentina.tax.cuit', ' prefix="30"')) {
      expect(v.slice(0, 2)).toBe('30');
      expect(v.slice(10)).toBe(arTaxCheck(v.slice(0, 10)));
    }
  });
});

describe('argentina.tax.cuil', () => {
  it('uses only persona-física prefixes and a valid verificador', () => {
    for (const v of render('argentina.tax.cuil', '', 200)) {
      expect(v).toMatch(/^\d{11}$/);
      expect(['20', '23', '24', '27']).toContain(v.slice(0, 2));
      expect(v.slice(10)).toBe(arTaxCheck(v.slice(0, 10)));
    }
  });

  it('carries the DNI unchanged in positions 3-10', () => {
    for (const v of render('argentina.tax.cuil')) expect(v.slice(2, 10)).toMatch(/^[1-9]\d{7}$/);
  });
});

describe('argentina.docs.dni', () => {
  it('is an 8-digit number with no leading zero', () => {
    for (const v of render('argentina.docs.dni')) expect(v).toMatch(/^[1-9]\d{7}$/);
  });
});

describe('argentina.finance.cbu', () => {
  it('is 22 digits whose TWO block check digits both hold', () => {
    for (const v of render('argentina.finance.cbu', '', 200)) {
      expect(v).toMatch(/^\d{22}$/);
      expect(v.slice(7, 8), `block 1 DV of ${v}`).toBe(cbuBlockCheck(v.slice(0, 7), CBU_W1));
      expect(v.slice(21, 22), `block 2 DV of ${v}`).toBe(cbuBlockCheck(v.slice(8, 21), CBU_W2));
      expect(cbuValid(v)).toBe(true);
    }
  });

  it('starts with a real BCRA entity code', () => {
    const codes = new Set(packValues('argentina.finance.bankCode'));
    for (const v of render('argentina.finance.cbu', '', 200))
      expect(codes.has(v.slice(0, 3))).toBe(true);
  });

  it('honours a pinned bank and still checksums', () => {
    for (const v of render('argentina.finance.cbu', ' bank="011"')) {
      expect(v.slice(0, 3)).toBe('011');
      expect(cbuValid(v)).toBe(true);
    }
  });
});

// --- geo ---

describe('argentina.geo.cpa', () => {
  const ISO_LETTERS = new Set([
    'A',
    'B',
    'C',
    'D',
    'E',
    'F',
    'G',
    'H',
    'J',
    'K',
    'L',
    'M',
    'N',
    'P',
    'Q',
    'R',
    'S',
    'T',
    'U',
    'V',
    'W',
    'X',
    'Y',
    'Z',
  ]);

  it('is a province letter + 4 digits + 3 letters', () => {
    for (const v of render('argentina.geo.cpa', '', 200)) {
      expect(v).toMatch(/^[A-Z]\d{4}[A-Z]{3}$/);
      expect(ISO_LETTERS.has(v.slice(0, 1))).toBe(true);
    }
  });

  it('encodes the province in the leading letter — the ISO 3166-2:AR code', () => {
    const codes = new Set(packValues('argentina.geo.provinceCode'));
    expect(codes.size).toBe(24);
    for (const v of render('argentina.geo.cpa', '', 200))
      expect(codes.has(v.slice(0, 1))).toBe(true);
  });

  it('keeps the four digits inside the assigned 1000-9431 range', () => {
    for (const v of render('argentina.geo.cpa', '', 200)) {
      const cp = Number(v.slice(1, 5));
      expect(cp).toBeGreaterThanOrEqual(1000);
      expect(cp).toBeLessThanOrEqual(9431);
    }
  });

  it('pins a jurisdiction when asked', () => {
    for (const v of render('argentina.geo.cpa', ' province="C"')) expect(v.slice(0, 1)).toBe('C');
  });
});

describe('argentina.geo.zip', () => {
  it('is the legacy 4-digit código postal', () => {
    for (const v of render('argentina.geo.zip', '', 200)) {
      expect(v).toMatch(/^\d{4}$/);
      expect(Number(v)).toBeGreaterThanOrEqual(1000);
      expect(Number(v)).toBeLessThanOrEqual(9431);
    }
  });
});

describe('argentina.geo.streetName', () => {
  const TYPES = [
    'Calle',
    'Avenida',
    'Pasaje',
    'Diagonal',
    'Bulevar',
    'Camino',
    'Autopista',
    'Peatonal',
    'Callejón',
  ];

  it('is either a typed named street or a numbered La Plata street', () => {
    const named = new Set(packValues('argentina.geo.streetNamed'));
    for (const v of render('argentina.geo.streetName', '', 200)) {
      const numbered = /^(?:Calle|Diagonal) \d{1,3}$/.exec(v);
      if (numbered) {
        expect(Number(v.slice(v.indexOf(' ') + 1))).toBeLessThanOrEqual(170);
        continue;
      }
      const type = TYPES.find((t) => v.startsWith(`${t} `));
      expect(type, `unknown vialidad type in "${v}"`).toBeDefined();
      expect(named.has(v.slice((type ?? '').length + 1)), `unknown street name in "${v}"`).toBe(
        true,
      );
    }
  });
});

// --- phones and plates ---

describe('argentina.phone / argentina.phoneLandline', () => {
  it('emits AMBA mobiles in E.164', () => {
    for (const v of render('argentina.phone')) expect(v).toMatch(/^\+54911\d{8}$/);
  });

  it('emits fixed lines whose area code + subscriber number is always 10 digits', () => {
    const areas = new Set(packValues('argentina.phoneAreaCode'));
    for (const v of render('argentina.phoneLandline', '', 200)) {
      expect(v).toMatch(/^\+54\d{10}$/);
      const nsn = v.slice(3);
      const area = [2, 3, 4].find((n) => areas.has(nsn.slice(0, n)));
      expect(area, `no known area code at the head of ${v}`).toBeDefined();
    }
  });
});

describe('argentina.vehicle.plate', () => {
  it('emits the Mercosur layout or the pre-2016 one', () => {
    const seen = new Set<string>();
    for (const v of render('argentina.vehicle.plate', '', 200)) {
      expect(v).toMatch(/^(?:[A-Z]{2} \d{3} [A-Z]{2}|[A-Z]{3} \d{3})$/);
      seen.add(v.length === 9 ? 'mercosur' : 'legacy');
    }
    expect(seen.has('mercosur')).toBe(true);
    expect(seen.has('legacy')).toBe(true);
  });
});

// --- lists ---

describe('argentina list packs', () => {
  it('has the 23 provinces plus CABA, index-aligned with their ISO 3166-2:AR letters', () => {
    const provinces = packValues('argentina.geo.province');
    const codes = packValues('argentina.geo.provinceCode');
    expect(provinces).toHaveLength(24);
    expect(codes).toHaveLength(24);
    expect(new Set(codes).size).toBe(24);
    expect(provinces).toContain('Ciudad Autónoma de Buenos Aires');
    // Spot-check the pairing against ISO 3166-2:AR.
    for (const [name, code] of [
      ['Buenos Aires', 'B'],
      ['Ciudad Autónoma de Buenos Aires', 'C'],
      ['Córdoba', 'X'],
      ['Santa Fe', 'S'],
      ['Mendoza', 'M'],
      ['Tucumán', 'T'],
      ['Salta', 'A'],
      ['Tierra del Fuego, Antártida e Islas del Atlántico Sur', 'V'],
    ] as const) {
      expect(codes[provinces.indexOf(name)], `ISO code of ${name}`).toBe(code);
    }
  });

  it('keeps the bank name and BCRA code lists index-aligned', () => {
    const banks = packValues('argentina.finance.bank');
    const codes = packValues('argentina.finance.bankCode');
    expect(banks).toHaveLength(codes.length);
    expect(banks.length).toBeGreaterThanOrEqual(55);
    for (const code of codes) expect(code).toMatch(/^\d{3}$/);
    expect(new Set(codes).size).toBe(codes.length);
    // Spot-check the pairing against the BCRA nómina.
    for (const [bank, code] of [
      ['Banco de la Nación Argentina', '011'],
      ['Banco Santander Argentina S.A.', '072'],
      ['Banco Macro S.A.', '285'],
      ['Banco de Corrientes S.A.', '094'],
      ['Banco de Galicia y Buenos Aires S.A.U.', '007'],
    ] as const) {
      expect(codes[banks.indexOf(bank)], `BCRA code of ${bank}`).toBe(code);
    }
  });

  it('ships useful volumes of real geo / education / sport data', () => {
    expect(packValues('argentina.geo.city').length).toBeGreaterThanOrEqual(180);
    expect(packValues('argentina.geo.streetNamed').length).toBeGreaterThanOrEqual(120);
    expect(packValues('argentina.education.university').length).toBeGreaterThanOrEqual(80);
    expect(packValues('argentina.sport.team').length).toBeGreaterThanOrEqual(50);
    expect(packValues('argentina.phoneAreaCode').length).toBeGreaterThanOrEqual(40);
  });

  it('carries no duplicate entries in the plain lists', () => {
    for (const address of [
      'argentina.geo.city',
      'argentina.geo.province',
      'argentina.geo.streetNamed',
      'argentina.education.university',
      'argentina.sport.team',
      'argentina.holiday',
      'argentina.phoneAreaCode',
      'argentina.finance.bank',
    ]) {
      const values = packValues(address);
      expect(new Set(values).size, `${address} has duplicates`).toBe(values.length);
    }
  });

  it('lists the national holidays, movable ones included', () => {
    const holidays = packValues('argentina.holiday');
    expect(holidays.length).toBeGreaterThanOrEqual(16);
    for (const fixed of [
      'Año Nuevo',
      'Día Nacional de la Memoria por la Verdad y la Justicia',
      'Día del Veterano y de los Caídos en la Guerra de Malvinas',
      'Día del Trabajador',
      'Día de la Revolución de Mayo',
      'Día de la Independencia',
      'Inmaculada Concepción de María',
      'Navidad',
    ]) {
      expect(holidays).toContain(fixed);
    }
    for (const movable of [
      'Lunes de Carnaval',
      'Martes de Carnaval',
      'Viernes Santo',
      'Paso a la Inmortalidad del General Martín Miguel de Güemes',
      'Paso a la Inmortalidad del General José de San Martín',
      'Día del Respeto a la Diversidad Cultural',
      'Día de la Soberanía Nacional',
    ]) {
      expect(holidays).toContain(movable);
    }
  });

  it('opens the club list with the Primera División sides', () => {
    const teams = packValues('argentina.sport.team');
    for (const club of [
      'Club Atlético Boca Juniors',
      'Club Atlético River Plate',
      'Racing Club',
      'Club Atlético Independiente',
      'Club Estudiantes de La Plata',
      'Club Atlético Talleres',
    ]) {
      expect(teams.indexOf(club)).toBeGreaterThanOrEqual(0);
      expect(teams.indexOf(club)).toBeLessThan(30);
    }
  });
});

// --- determinism ---

describe('argentina determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'argentina.tax.cuit',
      'argentina.tax.cuil',
      'argentina.finance.cbu',
      'argentina.geo.cpa',
      'argentina.geo.streetName',
      'argentina.phoneLandline',
      'argentina.vehicle.plate',
    ]) {
      expect(render(address, '', 20, 'seed-a')).toEqual(render(address, '', 20, 'seed-a'));
    }
  });
});
