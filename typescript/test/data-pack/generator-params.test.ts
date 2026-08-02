import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Attribute passthrough (migration spec §4.1): a caller `<gen type="template"
 * p="v">` attribute overrides a same-named local `<sequence>` in the pack
 * generator with the constant `v`; if the caller omits it, the sequence's own
 * default is used. This is what lets migrated presets keep their parameters
 * (tax_office, format, …).
 */
function packRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'tdc-param-pack-'));
  writeFileSync(
    join(root, 'id.txt'),
    [
      '---',
      'address: common.demo.prefixed_id',
      'generator: tdc',
      '---',
      // `prefix` defaults to "PP" but is overridable by the caller.
      '<sequence name="prefix"><gen type="text" value="PP"/></sequence>',
      '<sequence name="digits"><gen type="number" value="1000..9999"/></sequence>',
      '<data>${{prefix}}-${{digits}}</data>',
    ].join('\n'),
    'utf8',
  );
  return root;
}

function render(root: string, genTag: string): string[] {
  const config = [
    '<tdc><env count="6" seed="p">',
    `  <sequence name="P">${genTag}</sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW })
    .toString()
    .trim()
    .split('\n');
}

describe('pack generator parameter overrides', () => {
  it('uses the declared default when the caller passes no parameter', () => {
    const out = render(packRoot(), '<gen type="template" value="common.demo.prefixed_id"/>');
    expect(out.length).toBe(6);
    for (const v of out) expect(v).toMatch(/^PP-\d{4}$/);
  });

  it("overrides the local sequence with the caller's value", () => {
    const out = render(
      packRoot(),
      '<gen type="template" value="common.demo.prefixed_id" prefix="ZZ"/>',
    );
    for (const v of out) expect(v).toMatch(/^ZZ-\d{4}$/);
  });

  it('is deterministic across runs with the same seed and override', () => {
    const root = packRoot();
    const a = render(root, '<gen type="template" value="common.demo.prefixed_id" prefix="ZZ"/>');
    const b = render(root, '<gen type="template" value="common.demo.prefixed_id" prefix="ZZ"/>');
    expect(a).toEqual(b);
    for (const v of a) expect(v).toMatch(/^ZZ-\d{4}$/);
  });
});
