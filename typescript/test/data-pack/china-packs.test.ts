import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Chinese Resident Identity Card (居民身份证) carries an ISO 7064 MOD 11-2
 * check character over its first 17 digits — the 18th may be `X`. The reference
 * algorithm is re-derived here so the pack and the test can't share a bug.
 */
const WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2] as const;
const CHECK = '10X98765432';

function idCheckChar(base17: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(base17[i]) * WEIGHTS[i]!;
  return CHECK[sum % 11] ?? '';
}

function render(address: string, count = 60, seed = 'zh'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="zh-cn">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('china.docs.id', () => {
  it('is 18 chars with a valid MOD 11-2 check character (X allowed)', () => {
    const out = render('china.docs.id');
    expect(out).toHaveLength(60);
    for (const v of out) {
      expect(v).toMatch(/^\d{17}[\dX]$/);
      expect(v[17]).toBe(idCheckChar(v.slice(0, 17)));
    }
  });

  it('produces the X check character for the residues that require it', () => {
    // Over enough rows at least one ID must end in X — the case a naive
    // digit-only implementation gets wrong.
    expect(render('china.docs.id', 300).some((v) => v.endsWith('X'))).toBe(true);
  });
});

describe('zh-cn person and place data resolves', () => {
  it('renders Chinese names and cities', () => {
    for (const addr of [
      'zh-cn.person.lastName',
      'zh-cn.person.male.firstName',
      'zh-cn.person.female.firstName',
      'china.geo.city',
      'china.geo.province',
    ]) {
      for (const v of render(addr, 10)) expect(v).toMatch(/[一-鿿]/); // has a CJK char
    }
  });
});
