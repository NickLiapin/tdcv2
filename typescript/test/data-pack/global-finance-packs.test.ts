import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { luhnCheckDigit } from '../../src/presets/utils.js';

/**
 * Checksum-correctness tests for the global finance / payment / product /
 * device / security / phone presets migrated from `src/presets/global/*` into
 * bundled `common.*` (and per-country `<country>.phone`) pack generators.
 *
 * Every address renders through the normal bundled-pack path (no dataPaths).
 * Each check digit is verified against an INDEPENDENT reference re-derived
 * here: Luhn via the shared `luhnCheckDigit`; GS1 mod-10, ISSN mod-11 and IBAN
 * ISO 7064 mod-97 re-implemented inline. Format-only generators are matched
 * against the exact output shape they migrate.
 */

function render(address: string, count = 40, seed = 's'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function rows(address: string): string[] {
  const out = render(address);
  expect(out.length, `${address} row count`).toBe(40);
  return out;
}

function expectShape(address: string, re: RegExp): string[] {
  const out = rows(address);
  for (const row of out) expect(row, `${address} -> "${row}"`).toMatch(re);
  return out;
}

// --- independent checksum references ---

/** GS1 mod-10 over the payload (all digits except the trailing check). */
function gs1CheckDigit(payload: string): number {
  let sum = 0;
  for (let i = payload.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += Number(payload[i]) * weight;
  }
  return (10 - (sum % 10)) % 10;
}

/** ISSN mod-11 over the 7-digit base; 10 renders as 'X'. */
function issnCheck(base: string): string {
  const weights = [8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < base.length; i++) sum += Number(base[i]) * (weights[i] ?? 0);
  const c = (11 - (sum % 11)) % 11;
  return c === 10 ? 'X' : String(c);
}

/** ISO 7064 mod-97 over an alphanumeric string (A-Z -> 10..35). */
function iso7064Mod97(value: string): number {
  let expanded = '';
  for (const ch of value) {
    expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
  }
  let rem = 0;
  for (const d of expanded) rem = (rem * 10 + Number(d)) % 97;
  return rem;
}

/** A full IBAN is valid iff moving the first 4 chars to the end yields mod-97 == 1. */
function ibanValid(iban: string): boolean {
  return iso7064Mod97(`${iban.slice(4)}${iban.slice(0, 4)}`) === 1;
}

describe('bundled global finance/payment/product/device/security packs', () => {
  it('common.finance.iban -> DE IBAN with valid mod-97 check', () => {
    for (const row of expectShape('common.finance.iban', /^DE\d{2}\d{18}$/)) {
      expect(ibanValid(row), `${row} failed mod-97`).toBe(true);
    }
  });

  it('common.finance.bic -> BIC-11 shape', () => {
    expectShape('common.finance.bic', /^[A-Z]{4}(?:DE|ES|FR|GB|IT|NL|PL|PT|US)[A-Z0-9]{5}$/);
  });

  it('common.payment.card.pan -> 16 digits with valid Luhn', () => {
    for (const row of expectShape('common.payment.card.pan', /^(?:411111|424242)\d{10}$/)) {
      expect(row).toHaveLength(16);
      expect(luhnCheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.product.ean13 -> 13 digits with valid GS1 check', () => {
    for (const row of expectShape('common.product.ean13', /^\d{13}$/)) {
      expect(gs1CheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.product.upc_a -> 12 digits with valid GS1 check', () => {
    for (const row of expectShape('common.product.upc_a', /^\d{12}$/)) {
      expect(gs1CheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.product.gtin14 -> 14 digits with valid GS1 check', () => {
    for (const row of expectShape('common.product.gtin14', /^\d{14}$/)) {
      expect(gs1CheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.book.isbn13 -> 978/979 + 13 digits with valid GS1 check', () => {
    for (const row of expectShape('common.book.isbn13', /^(?:978|979)\d{10}$/)) {
      expect(gs1CheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.periodical.issn -> 7 digits + mod-11 check (0-9 or X)', () => {
    for (const row of expectShape('common.periodical.issn', /^\d{7}[0-9X]$/)) {
      expect(issnCheck(row.slice(0, 7))).toBe(row.slice(7));
    }
  });

  it('common.device.imei -> 15 digits with valid Luhn', () => {
    for (const row of expectShape('common.device.imei', /^\d{15}$/)) {
      expect(luhnCheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.device.iccid -> 89101 prefix, 19 digits with valid Luhn', () => {
    for (const row of expectShape('common.device.iccid', /^89101\d{14}$/)) {
      expect(luhnCheckDigit(row.slice(0, -1))).toBe(Number(row.slice(-1)));
    }
  });

  it('common.security.api_key -> tdc_ + 32 alphanumerics', () => {
    expectShape('common.security.api_key', /^tdc_[0-9A-Za-z]{32}$/);
  });

  it('common.security.otp -> 6 digits', () => {
    expectShape('common.security.otp', /^[0-9]{6}$/);
  });

  it('common.security.totp_secret -> 32 base32 chars', () => {
    expectShape('common.security.totp_secret', /^[A-Z2-7]{32}$/);
  });

  it('is deterministic for a fixed seed', () => {
    expect(render('common.finance.iban', 20, 'x')).toEqual(render('common.finance.iban', 20, 'x'));
    expect(render('common.payment.card.pan', 20, 'x')).toEqual(
      render('common.payment.card.pan', 20, 'x'),
    );
  });
});

describe('bundled phone packs (common.phone.e164 + <country>.phone)', () => {
  const COUNTRY_PATTERNS: Record<string, RegExp> = {
    'usa.phone': /^\+1202555\d{4}$/,
    'canada.phone': /^\+1613555\d{4}$/,
    'russia.phone': /^\+79\d{9}$/,
    'united_kingdom.phone': /^\+447700900\d{3}$/,
    'germany.phone': /^\+49(15[12579]|160|16[23]|17[0-9])\d{8}$/,
    'france.phone': /^\+336\d{8}$/,
    'brazil.phone': /^\+55\d{2}9\d{8}$/,
    'mexico.phone': /^\+52\d{10}$/,
    'argentina.phone': /^\+54911\d{8}$/,
    'spain.phone': /^\+346\d{8}$/,
    'poland.phone': /^\+485\d{8}$/,
  };

  for (const [address, re] of Object.entries(COUNTRY_PATTERNS)) {
    it(`${address} -> E.164 shape`, () => {
      expectShape(address, re);
    });
  }

  it('common.phone.e164 -> one of the migrated country shapes', () => {
    const union = new RegExp(
      `^(?:${Object.values(COUNTRY_PATTERNS)
        .map((re) => re.source.replace(/^\^|\$$/g, ''))
        .join('|')})$`,
    );
    expectShape('common.phone.e164', union);
  });
});
