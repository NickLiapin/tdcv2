import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * First wave of the EU fill: the Netherlands, Sweden, Denmark, Finland and
 * Greece, each of which was a lone tax/vat.txt stub. Every check digit is
 * re-derived here from the published rule rather than trusted, and three of them
 * are pinned against a real-world number so the rule cannot merely agree with
 * itself. These packs carry no locale pack — a country pack needs none.
 */

function render(address: string, count = 120, seed = 'eu'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}">` +
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

function luhnValid(num: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = Number(num[i]);
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Dutch elfproef: weights 9…2 over the first eight digits, minus the ninth. */
function bsnValid(v: string): boolean {
  if (!/^\d{9}$/.test(v)) return false;
  const w = [9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(v[i]) * w[i]!;
  return (sum - Number(v[8])) % 11 === 0;
}

/** Danish CVR: weights 2,7,6,5,4,3,2; check = 11 - remainder, 11 becomes 0, 10 never issued. */
function cvrValid(v: string): boolean {
  if (!/^\d{8}$/.test(v)) return false;
  const w = [2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(v[i]) * w[i]!;
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === Number(v[7]);
}

const HETU_TABLE = '0123456789ABCDEFHJKLMNPRSTUVWXY';

/** Finnish HETU: the date and individual number as one integer, mod 31, into the table. */
function hetuValid(v: string): boolean {
  const m = /^(\d{6})([-+A])(\d{3})([0-9A-Y])$/.exec(v);
  if (!m) return false;
  const n = BigInt(m[1]! + m[3]!);
  return HETU_TABLE[Number(n % 31n)] === m[4];
}

/** Finnish Y-tunnus: weights 7,9,10,5,8,4,2; remainder 1 is never issued. */
function ytunnusValid(v: string): boolean {
  const m = /^(\d{7})-(\d)$/.exec(v);
  if (!m) return false;
  const w = [7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(m[1]![i]) * w[i]!;
  const rem = sum % 11;
  if (rem === 1) return false;
  return (rem === 0 ? 0 : 11 - rem) === Number(m[2]);
}

/** Greek AFM: weights 256…2, check = (sum mod 11) mod 10. */
function afmValid(v: string): boolean {
  if (!/^\d{9}$/.test(v)) return false;
  const w = [256, 128, 64, 32, 16, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(v[i]) * w[i]!;
  return (sum % 11) % 10 === Number(v[8]);
}

describe('netherlands.docs.bsn', () => {
  it('passes the elfproef', () => {
    const out = render('netherlands.docs.bsn');
    expect(out).toHaveLength(120);
    for (const v of out) expect(bsnValid(v), v).toBe(true);
  });
});

describe('sweden personal and company numbers', () => {
  it.each(['sweden.docs.personnummer', 'sweden.docs.organisationsnummer'] as const)(
    '%s is 10 digits and Luhn-valid',
    (addr) => {
      for (const v of render(addr)) {
        expect(v).toMatch(/^\d{10}$/);
        expect(luhnValid(v), v).toBe(true);
      }
    },
  );

  it('marks an organisationsnummer as a legal entity in the third digit', () => {
    for (const v of render('sweden.docs.organisationsnummer')) {
      expect(Number(v[2]), v).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('denmark.docs.cvr', () => {
  it('passes the weighted mod-11 rule and never uses an unissued prefix', () => {
    for (const v of render('denmark.docs.cvr')) expect(cvrValid(v), v).toBe(true);
  });
});

describe('denmark.docs.cpr', () => {
  it('is DDMMYY-SSSS — structure only, since the mod-11 rule was dropped in 2007', () => {
    for (const v of render('denmark.docs.cpr')) expect(v).toMatch(/^\d{6}-\d{4}$/);
  });
});

describe('finland.docs.hetu', () => {
  it('carries the mod-31 check character', () => {
    for (const v of render('finland.docs.hetu')) expect(hetuValid(v), v).toBe(true);
  });

  it('agrees with a real published HETU and rejects a tampered one', () => {
    expect(hetuValid('131052-308T')).toBe(true);
    expect(hetuValid('131052-308X')).toBe(false);
  });
});

describe('finland.docs.ytunnus', () => {
  it('passes the weighted mod-11 rule', () => {
    for (const v of render('finland.docs.ytunnus')) expect(ytunnusValid(v), v).toBe(true);
  });
});

describe('greece.docs.afm', () => {
  it('passes the 256…2 weighted rule', () => {
    for (const v of render('greece.docs.afm')) expect(afmValid(v), v).toBe(true);
  });

  it('agrees with real published Greek VAT numbers and rejects filler', () => {
    expect(afmValid('094014201')).toBe(true);
    expect(afmValid('094019245')).toBe(true);
    expect(afmValid('123456789')).toBe(false);
  });
});

describe('greece.docs.amka', () => {
  it('is 11 digits ending in a Luhn check', () => {
    for (const v of render('greece.docs.amka')) {
      expect(v).toMatch(/^\d{11}$/);
      expect(luhnValid(v), v).toBe(true);
    }
  });
});

describe('EU-fill IBANs carry a valid ISO 7064 check', () => {
  it.each([
    ['netherlands.finance.iban', /^NL\d{2}[A-Z]{4}\d{10}$/],
    ['sweden.finance.iban', /^SE\d{22}$/],
    ['denmark.finance.iban', /^DK\d{16}$/],
    ['finland.finance.iban', /^FI\d{16}$/],
    ['greece.finance.iban', /^GR\d{25}$/],
  ] as const)('%s', (addr, re) => {
    for (const v of render(addr, 40)) {
      expect(v).toMatch(re);
      expect(ibanIsoOk(v), v).toBe(true);
    }
  });
});

describe('EU-fill packs resolve', () => {
  const addresses = [
    'netherlands.docs.kvk',
    'netherlands.geo.province',
    'netherlands.geo.city',
    'netherlands.geo.postalCode',
    'netherlands.finance.bank',
    'netherlands.phone',
    'netherlands.vehicle.plate',
    'netherlands.holiday',
    'netherlands.sport.team',
    'netherlands.education.university',
    'sweden.geo.county',
    'sweden.geo.city',
    'sweden.geo.postalCode',
    'sweden.finance.bank',
    'sweden.phone',
    'sweden.vehicle.plate',
    'sweden.holiday',
    'sweden.sport.team',
    'sweden.education.university',
    'denmark.geo.region',
    'denmark.geo.city',
    'denmark.geo.postalCode',
    'denmark.finance.bank',
    'denmark.phone',
    'denmark.vehicle.plate',
    'denmark.holiday',
    'denmark.sport.team',
    'denmark.education.university',
    'finland.geo.region',
    'finland.geo.city',
    'finland.geo.postalCode',
    'finland.finance.bank',
    'finland.phone',
    'finland.vehicle.plate',
    'finland.holiday',
    'finland.sport.team',
    'finland.education.university',
    'greece.geo.region',
    'greece.geo.city',
    'greece.geo.postalCode',
    'greece.finance.bank',
    'greece.phone',
    'greece.vehicle.plate',
    'greece.holiday',
    'greece.sport.team',
    'greece.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('greece renders in Greek script', () => {
  it.each(['greece.geo.region', 'greece.geo.city', 'greece.holiday'] as const)('%s', (addr) => {
    for (const v of render(addr, 10)) expect(v).toMatch(/[Ͱ-Ͽἀ-῿]/);
  });

  it('issues plates only from letters shared with the Latin alphabet', () => {
    for (const v of render('greece.vehicle.plate', 40)) {
      expect(v).toMatch(/^[ABEZHIKMNOPTYX]{3}-\d{4}$/);
    }
  });
});

describe('EU-fill determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('finland.docs.hetu', 20, 'x')).toEqual(render('finland.docs.hetu', 20, 'x'));
    expect(render('greece.docs.afm', 20, 'x')).toEqual(render('greece.docs.afm', 20, 'x'));
  });
});
