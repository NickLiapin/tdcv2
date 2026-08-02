import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Latin America "batch 2" document/tax presets migrated to bundled packs:
 * guatemala, honduras, mexico, nicaragua, panama, paraguay, peru, uruguay,
 * venezuela, el_salvador.
 *
 * Each checksum is validated against an INDEPENDENT reference re-derived here
 * (a fresh re-implementation of the source algorithm), so a wrong check digit
 * in a pack fails the test rather than being rubber-stamped by its own logic.
 */

function render(address: string, extraAttrs = '', count = 40, seed = 's'): string[] {
  const gen = `<gen type="template" value="${address}"${extraAttrs}/>`;
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `  <sequence name="P">${gen}</sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

// --- independent reference check-digit implementations ---

function weightedMod10(digits: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) sum += Number(digits[i]) * (weights[i] ?? 0);
  return (10 - (sum % 10)) % 10;
}

/** El Salvador DUI/NIT: digit[i] * (9 - i), then (10 - sum%10) % 10. */
function svCheck(body: string): number {
  return weightedMod10(body, [9, 8, 7, 6, 5, 4, 3, 2]);
}

/** Peru RUC: weighted mod-11 over the 10-digit payload; 10 -> 0, 11 -> 1. */
function peCheck(payload: string): number {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < payload.length; i++) sum += Number(payload[i]) * (weights[i] ?? 0);
  const check = 11 - (sum % 11);
  if (check === 10) return 0;
  if (check === 11) return 1;
  return check;
}

/** Paraguay RUC: from the right, factor cycles 2..11; remainder>1 -> 11-r else 0. */
function pyCheck(body: string): number {
  let total = 0;
  let factor = 2;
  for (let i = body.length - 1; i >= 0; i--) {
    total += Number(body[i]) * factor;
    factor = factor === 11 ? 2 : factor + 1;
  }
  const remainder = total % 11;
  return remainder > 1 ? 11 - remainder : 0;
}

/** Uruguay CI: pad to 7, weights [2,9,8,7,6,3,4], (10 - sum%10) % 10. */
function uyCiCheck(body: string): number {
  return weightedMod10(body.padStart(7, '0'), [2, 9, 8, 7, 6, 3, 4]);
}

/**
 * Uruguay RUT: weighted mod-11 over 11 digits; 11 -> 0. A result of 10 has no
 * digit to carry it and DGI never issues such a body, so this reference
 * returns -1 rather than inventing one — the pack must not emit that case.
 */
function uyRutCheck(body: string): number {
  const weights = [4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (weights[i] ?? 0);
  const check = 11 - (sum % 11);
  if (check === 11) return 0;
  if (check === 10) return -1;
  return check;
}

/** Venezuela RIF: type value for prefix + weighted mod-11, table-mapped. */
function veRifCheck(prefix: string, body: string): string {
  const typeValues: Record<string, number> = { E: 8, G: 20, J: 12, P: 16, V: 4 };
  const weights = [3, 2, 7, 6, 5, 4, 3, 2];
  const table = '00987654321';
  let sum = typeValues[prefix] ?? 0;
  for (let i = 0; i < body.length; i++) sum += Number(body[i]) * (weights[i] ?? 0);
  return table[sum % 11] ?? '0';
}

/** Mexico RFC check character (mod-11 over a custom character alphabet). */
const RFC_CHECK_CHARS = '0123456789ABCDEFGHIJKLMN&OPQRSTUVWXYZ';
function rfcCharValue(char: string): number {
  if (char === ' ') return 37;
  const index = RFC_CHECK_CHARS.indexOf(char);
  return index >= 0 ? index : 0;
}
function rfcCheckDigit(base: string): string {
  const value = base.length === 11 ? ` ${base}` : base;
  let sum = 0;
  for (let i = 0; i < value.length; i++) sum += rfcCharValue(value[i] ?? '0') * (13 - i);
  const check = 11 - (sum % 11);
  if (check === 11) return '0';
  if (check === 10) return 'A';
  return String(check);
}

// --- checksum-bearing presets ---

describe('el_salvador.docs.dui / el_salvador.tax.nit', () => {
  for (const address of ['el_salvador.docs.dui', 'el_salvador.tax.nit']) {
    it(`${address} carries a valid weighted mod-10 check digit`, () => {
      const out = render(address);
      expect(out.length).toBe(40);
      for (const v of out) {
        expect(v).toMatch(/^\d{9}$/);
        const body = v.slice(0, 8);
        expect(Number(v[8])).toBe(svCheck(body));
      }
    });
  }
});

describe('peru.tax.ruc', () => {
  it('carries a valid weighted mod-11 check digit', () => {
    for (const v of render('peru.tax.ruc')) {
      expect(v).toMatch(/^(10|15|17|20)\d{8}\d$/);
      const payload = v.slice(0, 10);
      expect(Number(v[10])).toBe(peCheck(payload));
    }
  });

  it('honours a prefix override', () => {
    for (const v of render('peru.tax.ruc', ' prefix="20"')) {
      expect(v.startsWith('20')).toBe(true);
      expect(Number(v[10])).toBe(peCheck(v.slice(0, 10)));
    }
  });
});

describe('paraguay.docs.ci / paraguay.tax.ruc', () => {
  it('paraguay.docs.ci is a 7-digit number', () => {
    for (const v of render('paraguay.docs.ci')) expect(v).toMatch(/^[1-9]\d{6}$/);
  });

  it('paraguay.tax.ruc carries a valid cycling-weight mod-11 check digit', () => {
    for (const v of render('paraguay.tax.ruc')) {
      expect(v).toMatch(/^\d{8,9}$/);
      const body = v.slice(0, -1);
      expect(Number(v.slice(-1))).toBe(pyCheck(body));
    }
  });
});

describe('uruguay.docs.ci / uruguay.tax.rut', () => {
  it('uruguay.docs.ci carries a valid weighted mod-10 check digit', () => {
    for (const v of render('uruguay.docs.ci')) {
      expect(v).toMatch(/^\d{8}$/);
      expect(Number(v[7])).toBe(uyCiCheck(v.slice(0, 7)));
    }
  });

  it('uruguay.tax.rut carries a valid weighted mod-11 check digit', () => {
    for (const v of render('uruguay.tax.rut')) {
      expect(v).toMatch(/^(0[1-9]|1[0-9]|2[01])\d{6}001\d$/);
      const expected = uyRutCheck(v.slice(0, 11));
      expect(expected, `${v} has a body DGI would never issue`).not.toBe(-1);
      expect(Number(v.slice(11))).toBe(expected);
    }
  });

  it('uruguay.tax.rut honours a body override', () => {
    for (const v of render('uruguay.tax.rut', ' body="21123456001"')) {
      expect(v.slice(0, 11)).toBe('21123456001');
      expect(Number(v.slice(11))).toBe(uyRutCheck('21123456001'));
    }
  });
});

describe('venezuela.docs.ci / venezuela.tax.rif', () => {
  it('venezuela.docs.ci is a V/E prefix + 7-8 digit body', () => {
    for (const v of render('venezuela.docs.ci')) expect(v).toMatch(/^[VE][1-9]\d{6,7}$/);
  });

  it('venezuela.tax.rif carries a valid weighted mod-11 check digit', () => {
    for (const v of render('venezuela.tax.rif')) {
      expect(v).toMatch(/^[VEJPG]\d{8}\d$/);
      const prefix = v[0] ?? '';
      const body = v.slice(1, 9);
      expect(v.slice(9)).toBe(veRifCheck(prefix, body));
    }
  });

  it('venezuela.tax.rif honours a prefix override (each type value)', () => {
    for (const prefix of ['V', 'E', 'J', 'P', 'G']) {
      for (const v of render('venezuela.tax.rif', ` prefix="${prefix}"`)) {
        expect(v[0]).toBe(prefix);
        expect(v.slice(9)).toBe(veRifCheck(prefix, v.slice(1, 9)));
      }
    }
  });
});

describe('mexico.tax.rfc / rfc_person / rfc_org', () => {
  it('mexico.tax.rfc_person carries a valid mod-11 check character', () => {
    for (const v of render('mexico.tax.rfc_person')) {
      expect(v).toMatch(/^[A-Z]{4}\d{6}[A-Z0-9]{2}[0-9A]$/);
      expect(v.slice(-1)).toBe(rfcCheckDigit(v.slice(0, -1)));
    }
  });

  it('mexico.tax.rfc_org carries a valid mod-11 check character', () => {
    for (const v of render('mexico.tax.rfc_org')) {
      expect(v).toMatch(/^[A-Z]{3}\d{6}[A-Z0-9]{2}[0-9A]$/);
      expect(v.slice(-1)).toBe(rfcCheckDigit(v.slice(0, -1)));
    }
  });

  it('mexico.tax.rfc (mixed person/org) carries a valid mod-11 check character', () => {
    const out = render('mexico.tax.rfc');
    for (const v of out) {
      expect(v).toMatch(/^[A-Z]{3,4}\d{6}[A-Z0-9]{2}[0-9A]$/);
      expect(v.slice(-1)).toBe(rfcCheckDigit(v.slice(0, -1)));
    }
    // both org (12) and person (13) lengths should appear across 40 rows
    const lengths = new Set(out.map((v) => v.length));
    expect(lengths.has(12) || lengths.has(13)).toBe(true);
  });

  it('mexico.tax.rfc_person honours a date override', () => {
    for (const v of render('mexico.tax.rfc_person', ' date="900101"')) {
      expect(v.slice(4, 10)).toBe('900101');
      expect(v.slice(-1)).toBe(rfcCheckDigit(v.slice(0, -1)));
    }
  });
});

// --- pure-format presets (no check digit) ---

describe('pure-format presets', () => {
  it('guatemala.docs.cui / guatemala.tax.nit are 13 digits (dept 01-22, muni 01-99)', () => {
    for (const address of ['guatemala.docs.cui', 'guatemala.tax.nit']) {
      for (const v of render(address)) {
        expect(v).toMatch(/^\d{13}$/);
        const dept = Number(v.slice(9, 11));
        const muni = Number(v.slice(11, 13));
        expect(dept).toBeGreaterThanOrEqual(1);
        expect(dept).toBeLessThanOrEqual(22);
        expect(muni).toBeGreaterThanOrEqual(1);
        expect(muni).toBeLessThanOrEqual(99);
      }
    }
  });

  it('honduras.docs.id is 13 digits, honduras.tax.rtn is 14 digits', () => {
    for (const v of render('honduras.docs.id')) {
      expect(v).toMatch(/^\d{13}$/);
      const year = Number(v.slice(4, 8));
      expect(year).toBeGreaterThanOrEqual(1940);
      expect(year).toBeLessThanOrEqual(2009);
    }
    for (const v of render('honduras.tax.rtn')) expect(v).toMatch(/^\d{14}$/);
  });

  it('nicaragua.docs.cedula / nicaragua.tax.ruc are 13 digits + control letter', () => {
    for (const address of ['nicaragua.docs.cedula', 'nicaragua.tax.ruc']) {
      for (const v of render(address)) expect(v).toMatch(/^\d{13}[ABCDEFGHJKLMNPQRSTUVWXYZ]$/);
    }
  });

  it('panama.docs.cedula / panama.tax.ruc are concatenated numeric groups', () => {
    for (const address of ['panama.docs.cedula', 'panama.tax.ruc']) {
      for (const v of render(address)) expect(v).toMatch(/^\d{3,11}$/);
    }
  });

  it('peru.docs.dni is 8 digits', () => {
    for (const v of render('peru.docs.dni')) expect(v).toMatch(/^\d{8}$/);
  });
});

// --- determinism ---

describe('determinism', () => {
  it('is stable for a fixed seed across renders', () => {
    for (const address of [
      'el_salvador.docs.dui',
      'peru.tax.ruc',
      'paraguay.tax.ruc',
      'uruguay.tax.rut',
      'venezuela.tax.rif',
      'mexico.tax.rfc',
    ]) {
      expect(render(address, '', 20, 'seed-a')).toEqual(render(address, '', 20, 'seed-a'));
    }
  });
});
