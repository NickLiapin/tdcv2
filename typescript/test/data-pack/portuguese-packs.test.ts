import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Portuguese (`pt`) locale pack and the Portugal country pack. Portugal carries
 * three re-derived check digits: the NIF (weighted mod-11), the NISS (weighted
 * mod-10), and the IBAN (an inner national NIB check plus the outer ISO 7064
 * check). The pt pack checks the two-surname full name, the coherent
 * parent->child lists, and the Portuguese long-form date.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ptDir = resolve(here, '../../../data/packs/pt');

function valuesOf(baseDir: string, relPath: string): Set<string> {
  const lines = readFileSync(join(baseDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function render(address: string, count = 40, seed = 'pt'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="pt">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

function mod97(digits: string): number {
  let rem = 0;
  for (const ch of digits) rem = (rem * 10 + Number(ch)) % 97;
  return rem;
}

function nifValid(n: string): boolean {
  if (!/^\d{9}$/.test(n)) return false;
  const w = [9, 8, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += Number(n[i]) * w[i]!;
  let check = 11 - (sum % 11);
  if (check > 9) check = 0;
  return check === Number(n[8]);
}

function nissValid(n: string): boolean {
  if (!/^\d{11}$/.test(n)) return false;
  const w = [29, 23, 19, 17, 13, 11, 7, 5, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(n[i]) * w[i]!;
  const check = 9 - (sum % 10);
  return check === Number(n[10]);
}

describe('portugal.docs.nif', () => {
  it('is 9 digits and its weighted mod-11 check digit re-derives', () => {
    const out = render('portugal.docs.nif');
    expect(out).toHaveLength(40);
    for (const v of out) {
      expect(v).toMatch(/^[125]\d{8}$/);
      expect(nifValid(v)).toBe(true);
    }
  });
});

describe('portugal.docs.niss', () => {
  it('is 11 digits starting 1 or 2 and its weighted mod-10 check re-derives', () => {
    for (const v of render('portugal.docs.niss')) {
      expect(v).toMatch(/^[12]\d{10}$/);
      expect(nissValid(v)).toBe(true);
    }
  });
});

describe('portugal.finance.iban', () => {
  it('is PT + 23 digits with a valid inner NIB and outer ISO 7064 check', () => {
    for (const v of render('portugal.finance.iban', 30)) {
      expect(v).toMatch(/^PT\d{23}$/);
      // Outer IBAN check (ISO 7064 over BBAN + PT00).
      const rearranged = v.slice(4) + v.slice(0, 4);
      let expanded = '';
      for (const ch of rearranged)
        expanded += /[0-9]/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
      expect(mod97(expanded)).toBe(1);
      // Inner NIB check: the 21-digit BBAN is itself valid under MOD 97-10.
      expect(mod97(v.slice(4))).toBe(1);
    }
  });
});

describe('pt.person full names', () => {
  it('carry a given name and two surnames', () => {
    for (const gender of ['male', 'female']) {
      for (const v of render(`pt.person.${gender}.fullName`, 20)) {
        expect(v.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe('pt coherent lists', () => {
  it('every dish belongs to the cuisine drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="menu" local="pt">',
      '  <sequence name="C"><gen type="template" value="pt.food.cuisine"/></sequence>',
      '  <sequence name="D" parent="C"><gen type="template" value="pt.food.dishByCuisine.${{C}}"/></sequence>',
      '</env><block><line><data>${{C}}|${{D}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [c, d] = row.split('|');
      expect(valuesOf(ptDir, `food/dishByCuisine/${c ?? ''}.txt`).has(d ?? ''), row).toBe(true);
    }
  });

  it('every job belongs to the industry drawn on that row', () => {
    const cfg = [
      '<tdc><env count="48" seed="job" local="pt">',
      '  <sequence name="I"><gen type="template" value="pt.work.industryCoherent"/></sequence>',
      '  <sequence name="J" parent="I"><gen type="template" value="pt.work.jobByIndustry.${{I}}"/></sequence>',
      '</env><block><line><data>${{I}}|${{J}}</data></line></block></tdc>',
    ].join('\n');
    for (const row of new TDC({ configString: cfg }).toString().trim().split('\n')) {
      const [i, j] = row.split('|');
      expect(valuesOf(ptDir, `work/jobByIndustry/${i ?? ''}.txt`).has(j ?? ''), row).toBe(true);
    }
  });
});

describe('pt dates', () => {
  it('render Portuguese month names in the long form', () => {
    const cfg =
      '<tdc><env count="12" seed="cal" local="pt">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    expect(out).toMatch(
      /janeiro|fevereiro|março|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro/,
    );
    expect(out).toContain(' de ');
    expect(out).not.toMatch(/enero|janvier|January/);
  });
});

describe('portugal packs resolve', () => {
  const addresses = [
    'portugal.docs.cc',
    'portugal.finance.bank',
    'portugal.geo.district',
    'portugal.geo.city',
    'portugal.geo.postal',
    'portugal.phone',
    'portugal.vehicle.plate',
    'portugal.holiday',
    'portugal.sport.team',
    'portugal.education.university',
  ];
  it.each(addresses)('%s produces non-empty values', (addr) => {
    const rows = render(addr, 5);
    expect(rows).toHaveLength(5);
    for (const r of rows) expect(r.trim().length).toBeGreaterThan(0);
  });
});

describe('portuguese pack determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('portugal.docs.nif', 20, 'x')).toEqual(render('portugal.docs.nif', 20, 'x'));
  });
});
