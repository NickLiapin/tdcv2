import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

function lines(out: string): string[] {
  return out.split('\n').filter((l) => l.length > 0);
}

describe('order="sequential" — text', () => {
  const cfg = (count: number, extra = ''): string =>
    `<tdc><env count="${String(count)}" seed="demo"><sequence name="M">` +
    `<gen type="text" value="Jan,Feb,Mar" order="sequential"${extra}/></sequence></env>` +
    '<block><line><data>${{M}}</data></line></block></tdc>';

  it('emits values in order and loops (both engines agree)', () => {
    const expected = ['Jan', 'Feb', 'Mar', 'Jan', 'Feb', 'Mar', 'Jan'];
    expect(lines(new TDC({ configString: cfg(7), now: NOW }).toString())).toEqual(expected);
    expect(new TDC({ configString: cfg(7), now: NOW }).toArray().map((r) => r['M'])).toEqual(
      expected,
    );
  });

  it('cycle="false" errors once the data runs out', () => {
    expect(() => new TDC({ configString: cfg(5, ' cycle="false"'), now: NOW }).toString()).toThrow(
      /only 3 values/,
    );
    // exactly N rows is fine
    expect(lines(new TDC({ configString: cfg(3, ' cycle="false"'), now: NOW }).toString())).toEqual(
      ['Jan', 'Feb', 'Mar'],
    );
  });
});

describe('order="sequential" — file', () => {
  it('replays file lines in their exact order, looping', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-seq-'));
    const path = join(dir, 'villages.txt');
    writeFileSync(path, 'McMurdo\nVostok\nConcordia\n', 'utf8');
    const cfg =
      '<tdc><env count="5" seed="demo"><sequence name="V">' +
      `<gen type="file" src="${path}" order="sequential"/></sequence></env>` +
      '<block><line><data>${{V}}</data></line></block></tdc>';
    const expected = ['McMurdo', 'Vostok', 'Concordia', 'McMurdo', 'Vostok'];
    expect(lines(new TDC({ configString: cfg, now: NOW }).toString())).toEqual(expected);
    expect(new TDC({ configString: cfg, now: NOW }).toArray().map((r) => r['V'])).toEqual(expected);
  });
});
