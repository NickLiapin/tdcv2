import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { weightedSum } from '../../src/presets/utils.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

function innCheck(base: string): string {
  return String((weightedSum(base, [2, 4, 10, 3, 5, 9, 4, 6, 8]) % 11) % 10);
}

/**
 * The point of the `compute` layer: a country checksum generator can live as
 * EDITABLE PACK DATA (a `generator: tdc` body using `<compute>`) instead of
 * application code in `src/presets/`. This proves it end-to-end — a pack file
 * on disk, referenced from a config, produces valid Russian INNs.
 */
describe('compute inside a pack generator (editable checksum as data)', () => {
  it('a Russian INN generator written as a pack produces valid INNs', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-compute-pack-'));
    writeFileSync(
      join(root, 'inn.txt'),
      [
        '---',
        'address: russia.tax.inn_demo',
        'generator: tdc',
        '---',
        '<sequence name="Base"><gen type="number" value="100000000..999999999"/></sequence>',
        '<sequence name="Full"><compute>',
        '  <let name="check">',
        '    <mod><mod>',
        '      <reduce>',
        '        <over><field name="Base"/></over>',
        '        <init><int v="0"/></init>',
        '        <do><add><acc/><multiply><current/>',
        '          <at><in><list v="2,4,10,3,5,9,4,6,8"/></in><index><current_index/></index></at>',
        '        </multiply></add></do>',
        '      </reduce>',
        '      <int v="11"/></mod><int v="10"/></mod>',
        '  </let>',
        '  <result><concat><field name="Base"/><var name="check"/></concat></result>',
        '</compute></sequence>',
        '<data>${{Full}}</data>',
      ].join('\n'),
      'utf8',
    );

    const config = [
      '<tdc><env count="12" seed="pack-inn">',
      '  <sequence name="P"><gen type="template" value="russia.tax.inn_demo"/></sequence>',
      '</env><block><line><data>${{P}}</data></line></block></tdc>',
    ].join('\n');

    const out = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW })
      .toString()
      .trim()
      .split('\n');

    expect(out.length).toBe(12);
    for (const inn of out) {
      expect(inn).toMatch(/^\d{10}$/);
      expect(inn.slice(9)).toBe(innCheck(inn.slice(0, 9)));
    }
  });
});
