import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Reject-and-retry (migration spec §4.2): a `<valid>` predicate makes the
 * generator redraw the base until the computed value is acceptable. Models the
 * "reject when the mod-11 check digit is 10" family (finland/poland/… VAT).
 */
function packRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tdc-reject-pack-'));
  writeFileSync(
    join(root, 'g.txt'),
    [
      '---',
      'address: common.demo.no_multiple_of_three',
      'generator: tdc',
      '---',
      '<sequence name="Base"><gen type="number" value="0..9"/></sequence>',
      '<sequence name="Mod"><compute><result>',
      '  <mod><field name="Base"/><int v="3"/></mod>',
      '</result></compute></sequence>',
      // Reject any base divisible by 3 (Mod == 0).
      '<valid><greater_than><field name="Mod"/><int v="0"/></greater_than></valid>',
      '<data>${{Base}}</data>',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function render(root: string, count: number, seed: string): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    '  <sequence name="P"><gen type="template" value="common.demo.no_multiple_of_three"/></sequence>',
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW })
    .toString()
    .trim()
    .split('\n');
}

describe('pack generator reject-and-retry', () => {
  it('never emits a base divisible by 3 (the rejected case)', () => {
    const root = packRoot();
    const out = render(root, 80, 'reject-seed');
    expect(out.length).toBe(80);
    for (const v of out) {
      expect(v).toMatch(/^\d$/);
      expect(Number(v) % 3).not.toBe(0);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const root = packRoot();
    expect(render(root, 40, 's')).toEqual(render(root, 40, 's'));
  });
});
