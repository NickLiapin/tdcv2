import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * Locks in the preset→pack migration: the old `type="preset"` form is gone, and
 * the pack-engine safety nets (reject-retry fuse) behave. The 137 migrated
 * generators are covered by the per-country validity suites; this file guards
 * the removal + the engine edges.
 */

const wrap = (gen: string): string =>
  `<tdc><env count="1" seed="s">${gen}</env><block><line><data>_</data></line></block></tdc>`;

describe('type="preset" is removed', () => {
  it('the validator flags it as an unknown gen type', () => {
    const src = wrap('<sequence name="s"><gen type="preset" value="id.uuid"/></sequence>');
    const diags = validate(parse(src).tree).diagnostics;
    expect(diags.some((d) => /gen type|preset/i.test(d.message))).toBe(true);
  });

  it('render throws on a type="preset" gen', () => {
    const src = wrap('<sequence name="s"><gen type="preset" value="id.uuid"/></sequence>');
    expect(() => new TDC({ configString: src, now: FIXED_NOW }).toString()).toThrow();
  });

  it('the same generator works via type="template" against the bundled pack', () => {
    const src =
      '<tdc><env count="3" seed="s"><sequence name="U">' +
      '<gen type="template" value="common.id.uuid"/></sequence></env>' +
      '<block><line><data>${{U}}</data></line></block></tdc>';
    for (const v of new TDC({ configString: src, now: FIXED_NOW }).toString().trim().split('\n')) {
      expect(v).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('reject-retry fuse', () => {
  it('throws a clear error when a <valid> constraint can never be satisfied', () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-fuse-'));
    writeFileSync(
      join(root, 'g.txt'),
      [
        '---',
        'address: common.demo.impossible',
        'generator: tdc',
        '---',
        '<sequence name="d"><gen type="regex" value="[0-9]"/></sequence>',
        // A single digit can never exceed 100, so the predicate never holds.
        '<valid><greater_than><field name="d"/><int v="100"/></greater_than></valid>',
        '<data>${{d}}</data>',
      ].join('\n'),
      'utf8',
    );
    const config =
      '<tdc><env count="1" seed="s"><sequence name="P">' +
      '<gen type="template" value="common.demo.impossible"/></sequence></env>' +
      '<block><line><data>${{P}}</data></line></block></tdc>';
    expect(() =>
      new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString(),
    ).toThrow(/could not be satisfied|constraint/i);
  });
});
