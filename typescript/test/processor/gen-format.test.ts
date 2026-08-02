import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** `<gen … case="…" mask="…">` post-processing, in both engines. */
function config(genTag: string, count = 6): string {
  return `<tdc><env count="${String(count)}" seed="demo"><sequence name="X">${genTag}</sequence></env><block><line><data>\${{X}}</data></line></block></tdc>`;
}

describe('<gen> case attribute', () => {
  it('lowercases via streaming (toString) and memory (toArray)', () => {
    const c = config('<gen type="text" value="Moscow,Berlin"/>' /* baseline */);
    void c;
    const lc = config('<gen type="text" value="Moscow,Berlin" case="lower"/>');
    const stream = new TDC({ configString: lc, now: NOW }).toString().trim().split('\n');
    for (const v of stream) expect(['moscow', 'berlin']).toContain(v);
    const rows = new TDC({ configString: lc, now: NOW }).toArray();
    for (const r of rows) expect(['moscow', 'berlin']).toContain(r['X']);
  });

  it('upper/capitalize', () => {
    const up = new TDC({
      configString: config('<gen type="text" value="abc"/>').replace('/>', ' case="upper"/>'),
      now: NOW,
    })
      .toString()
      .trim()
      .split('\n');
    for (const v of up) expect(v).toBe('ABC');
  });
});

describe('<gen> mask attribute', () => {
  it('masks a template generator output (SNILS) in both engines', () => {
    const c = config('<gen type="template" value="russia.docs.snils" mask="xxx-xxx-xxx xx"/>');
    for (const v of new TDC({ configString: c, now: NOW }).toString().trim().split('\n')) {
      expect(v).toMatch(/^\d{3}-\d{3}-\d{3} \d{2}$/);
    }
    for (const r of new TDC({ configString: c, now: NOW }).toArray()) {
      expect(r['X'] as string).toMatch(/^\d{3}-\d{3}-\d{3} \d{2}$/);
    }
  });

  it('applies mask then case when both are present', () => {
    const c = config('<gen type="text" value="john dow" mask="w:w" case="upper"/>');
    for (const v of new TDC({ configString: c, now: NOW }).toString().trim().split('\n')) {
      expect(v).toBe('JOHN:DOW');
    }
  });

  it('is deterministic', () => {
    const c = config('<gen type="template" value="russia.docs.snils" mask="xxx-xxx-xxx xx"/>');
    expect(new TDC({ configString: c, now: NOW }).toString()).toBe(
      new TDC({ configString: c, now: NOW }).toString(),
    );
  });
});
