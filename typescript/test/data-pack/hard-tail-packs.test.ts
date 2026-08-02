import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Validity tests for the final hard-tail wave of preset -> compute-pack
 * migrations. Each address is rendered through the bundled compute pack (no
 * dataPaths — `new TDC({ configString })` resolves the pack from data/packs),
 * then validated against an INDEPENDENT reference re-derived here from the
 * standard/old algorithm — never by re-reading the pack's own math.
 *
 * Migrated addresses:
 *   poland.docs.pesel
 *   russia.bank.account, russia.bank.correspondent_account
 *   common.vehicle.vin
 *   common.logistics.container_iso6346
 *   common.docs.mrz.passport_td3, common.docs.mrz.id_td1
 */

function render(address: string, extra = '', count = 40, seed = 's'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `<sequence name="P"><gen type="template" value="${address}"${extra}/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('');
  return new TDC({ configString: config }).toString().trimEnd().split('\n');
}

/** MRZ records embed newlines; group the flat physical-line list per record. */
function renderMrz(address: string, linesPerRecord: number, count = 40): string[][] {
  const physical = render(address, '', count);
  expect(physical.length).toBe(count * linesPerRecord);
  const records: string[][] = [];
  for (let r = 0; r < count; r++) {
    records.push(physical.slice(r * linesPerRecord, r * linesPerRecord + linesPerRecord));
  }
  return records;
}

// --- Independent reference implementations (standard algorithms) -------------

function weightedSum(src: string, weights: readonly number[]): number {
  let sum = 0;
  for (let i = 0; i < src.length; i++) sum += Number(src[i]) * (weights[i] ?? 0);
  return sum;
}

const PESEL_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9, 1, 3];
function peselCheck(base10: string): number {
  return (10 - (weightedSum(base10, PESEL_WEIGHTS) % 10)) % 10;
}

const RU_KEY_WEIGHTS = [7, 1, 3];
function ruBankKey(bikPart: string, accountWithZeroKey: string): number {
  const src = `${bikPart}${accountWithZeroKey}`;
  let sum = 0;
  for (let i = 0; i < src.length; i++) {
    sum += (Number(src[i]) * (RU_KEY_WEIGHTS[i % 3] ?? 1)) % 10;
  }
  return ((10 - (sum % 10)) * 7) % 10;
}

const VIN_TRANSLIT: Readonly<Record<string, number>> = {
  A: 1,
  B: 2,
  C: 3,
  D: 4,
  E: 5,
  F: 6,
  G: 7,
  H: 8,
  J: 1,
  K: 2,
  L: 3,
  M: 4,
  N: 5,
  P: 7,
  R: 9,
  S: 2,
  T: 3,
  U: 4,
  V: 5,
  W: 6,
  X: 7,
  Y: 8,
  Z: 9,
};
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
function vinCheck(vin: string): string {
  let sum = 0;
  for (let i = 0; i < VIN_WEIGHTS.length; i++) {
    const c = vin[i] ?? '0';
    const value = /[0-9]/.test(c) ? Number(c) : (VIN_TRANSLIT[c] ?? 0);
    sum += value * (VIN_WEIGHTS[i] ?? 0);
  }
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

const CONTAINER_VALUES: Readonly<Record<string, number>> = {
  A: 10,
  B: 12,
  C: 13,
  D: 14,
  E: 15,
  F: 16,
  G: 17,
  H: 18,
  I: 19,
  J: 20,
  K: 21,
  L: 23,
  M: 24,
  N: 25,
  O: 26,
  P: 27,
  Q: 28,
  R: 29,
  S: 30,
  T: 31,
  U: 32,
  V: 34,
  W: 35,
  X: 36,
  Y: 37,
  Z: 38,
};
function containerCheck(source: string): number {
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? '0';
    const value = /[0-9]/.test(c) ? Number(c) : (CONTAINER_VALUES[c] ?? 0);
    sum += value * 2 ** i;
  }
  return sum % 11;
}

function mrzValue(char: string): number {
  if (/[0-9]/.test(char)) return Number(char);
  if (/[A-Z]/.test(char)) return char.charCodeAt(0) - 55;
  return 0;
}
function mrzCheckDigit(source: string): string {
  const weights = [7, 3, 1];
  let sum = 0;
  for (let i = 0; i < source.length; i++) {
    sum += mrzValue(source[i] ?? '<') * (weights[i % 3] ?? 1);
  }
  return String(sum % 10);
}

// --- Tests -------------------------------------------------------------------

describe('poland.docs.pesel', () => {
  it('produces valid PESELs (century-encoded date + weighted mod-10 check)', () => {
    const out = render('poland.docs.pesel');
    expect(out.length).toBe(40);
    for (const v of out) {
      expect(v).toMatch(/^\d{11}$/);
      expect(peselCheck(v.slice(0, 10))).toBe(Number(v[10]));
      // Date decodes to a real century-encoded month (1900s: 1-12, 2000s: 21-32).
      const encMonth = Number(v.slice(2, 4));
      const month = encMonth > 20 ? encMonth - 20 : encMonth;
      expect(month).toBeGreaterThanOrEqual(1);
      expect(month).toBeLessThanOrEqual(12);
      const day = Number(v.slice(4, 6));
      expect(day).toBeGreaterThanOrEqual(1);
      expect(day).toBeLessThanOrEqual(31);
    }
  });

  it('honours the sex parameter (odd = male, even = female)', () => {
    for (const v of render('poland.docs.pesel', ' sex="male"')) {
      expect(Number(v[9]) % 2).toBe(1);
      expect(peselCheck(v.slice(0, 10))).toBe(Number(v[10]));
    }
    for (const v of render('poland.docs.pesel', ' sex="female"')) {
      expect(Number(v[9]) % 2).toBe(0);
      expect(peselCheck(v.slice(0, 10))).toBe(Number(v[10]));
    }
  });
});

describe('russia.bank.account', () => {
  it('control key at position 9 is valid for the BIK tail (cross-field mod-10)', () => {
    for (const bik of ['044525225', '045004774', '049205603']) {
      const out = render('russia.bank.account', ` bik="${bik}"`);
      expect(out.length).toBe(40);
      for (const v of out) {
        expect(v).toMatch(/^\d{20}$/);
        const zeroKey = `${v.slice(0, 8)}0${v.slice(9)}`;
        expect(ruBankKey(bik.slice(6), zeroKey)).toBe(Number(v[8]));
      }
    }
  });
});

describe('russia.bank.correspondent_account', () => {
  it('embeds the BIK tail and carries a valid control key', () => {
    for (const bik of ['044525225', '045004774']) {
      const out = render('russia.bank.correspondent_account', ` bik="${bik}"`);
      expect(out.length).toBe(40);
      for (const v of out) {
        expect(v).toMatch(/^\d{20}$/);
        expect(v.slice(17)).toBe(bik.slice(6));
        const zeroKey = `${v.slice(0, 8)}0${v.slice(9)}`;
        expect(ruBankKey(`0${bik.slice(4, 6)}`, zeroKey)).toBe(Number(v[8]));
      }
    }
  });
});

describe('common.vehicle.vin', () => {
  it('17-char VIN with a valid ISO 3779 weighted mod-11 check (10 -> X)', () => {
    const out = render('common.vehicle.vin');
    expect(out.length).toBe(40);
    for (const v of out) {
      expect(v).toMatch(/^[A-HJ-NPR-Z0-9]{8}[0-9X][A-HJ-NPR-TV-Y1-9][A-HJ-NPR-Z0-9]\d{6}$/);
      expect(v[8]).toBe(vinCheck(v));
    }
  });
});

describe('common.logistics.container_iso6346', () => {
  it('valid ISO 6346 code; check is never the rejected value 10', () => {
    const out = render('common.logistics.container_iso6346');
    expect(out.length).toBe(40);
    for (const v of out) {
      expect(v).toMatch(/^[A-Z]{3}[UJZ]\d{6}\d$/);
      const check = containerCheck(v.slice(0, 10));
      expect(check).not.toBe(10);
      expect(check).toBe(Number(v[10]));
    }
  });
});

describe('common.docs.mrz.passport_td3', () => {
  it('two 44-char lines with valid ICAO check digits', () => {
    for (const [l1, l2] of renderMrz('common.docs.mrz.passport_td3', 2)) {
      expect(l1).toHaveLength(44);
      expect(l2).toHaveLength(44);
      expect(l1?.startsWith('P<')).toBe(true);
      // doc / birth / expiry / personal check digits
      expect(l2?.[9]).toBe(mrzCheckDigit(l2?.slice(0, 9) ?? ''));
      expect(l2?.[19]).toBe(mrzCheckDigit(l2?.slice(13, 19) ?? ''));
      expect(l2?.[27]).toBe(mrzCheckDigit(l2?.slice(21, 27) ?? ''));
      expect(l2?.[42]).toBe(mrzCheckDigit(l2?.slice(28, 42) ?? ''));
      // composite over the concatenated data groups incl. their check digits
      expect(l2?.[43]).toBe(
        mrzCheckDigit(
          `${l2?.slice(0, 10) ?? ''}${l2?.slice(13, 20) ?? ''}${l2?.slice(21, 28) ?? ''}${
            l2?.slice(28, 43) ?? ''
          }`,
        ),
      );
    }
  });
});

describe('common.docs.mrz.id_td1', () => {
  it('three 30-char lines with valid ICAO check digits', () => {
    for (const [l1, l2, l3] of renderMrz('common.docs.mrz.id_td1', 3)) {
      expect(l1).toHaveLength(30);
      expect(l2).toHaveLength(30);
      expect(l3).toHaveLength(30);
      expect(l1?.startsWith('I<')).toBe(true);
      expect(l1?.[14]).toBe(mrzCheckDigit(l1?.slice(5, 14) ?? ''));
      expect(l2?.[6]).toBe(mrzCheckDigit(l2?.slice(0, 6) ?? ''));
      expect(l2?.[14]).toBe(mrzCheckDigit(l2?.slice(8, 14) ?? ''));
      expect(l2?.[29]).toBe(
        mrzCheckDigit(
          `${l1?.slice(5, 30) ?? ''}${l2?.slice(0, 7) ?? ''}${l2?.slice(8, 15) ?? ''}${
            l2?.slice(18, 29) ?? ''
          }`,
        ),
      );
    }
  });
});
