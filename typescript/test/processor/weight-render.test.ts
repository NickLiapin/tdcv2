/**
 * `weight=` end to end.
 *
 * The claim the feature makes is not "roughly proportional" but EXACT: weights
 * 20000 and 10000 over 30 000 rows give precisely 20 000 and 10 000. That is
 * what separates it from every weighted-random sampler, so it is what the
 * assertions check — in all three engines, since a proportion that held in one
 * and drifted in another would be worse than none.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdc-weight-'));
  writeFileSync(join(dir, 'names.csv'), 'name,count\nBob,20000\nJack,10000\n');
  writeFileSync(join(dir, 'tail.csv'), 'name,count\nCommon,900\nMid,90\nRare,10\n');
});
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const ENGINES: readonly (readonly [string, Partial<RenderOptions>])[] = [
  ['memory', { mode: 'memory' }],
  ['stream', { stream: true }],
  ['disk', { mode: 'disk' }],
];

const config = (count: number, file: string) =>
  `<tdc><env count="${String(count)}" seed="w" inject="\${{%}}">` +
  `<sequence name="N">` +
  `<gen type="file" src="${file}" column="name" weight="count"/>` +
  `</sequence></env>` +
  `<block><line><data>\${{N}}</data></line></block></tdc>`;

const tally = (count: number, file: string, opts: Partial<RenderOptions>) => {
  const out = render(parseStrict(config(count, file)), {
    now: 0,
    dataPaths: [dir],
    ...opts,
  })
    .split('\n')
    .filter(Boolean);
  const seen = new Map<string, number>();
  for (const line of out) seen.set(line, (seen.get(line) ?? 0) + 1);
  return { total: out.length, seen };
};

describe('weight — the proportions are exact, not approximate', () => {
  for (const [label, opts] of ENGINES) {
    it(`honours the file's counts to the row (${label})`, () => {
      const { total, seen } = tally(30_000, 'names.csv', opts);
      expect(total).toBe(30_000);
      // 20000:10000 over 30000 rows. Not "about 2:1" — exactly.
      expect(seen.get('Bob'), label).toBe(20_000);
      expect(seen.get('Jack'), label).toBe(10_000);
    });

    it(`keeps a rare value rare rather than dropping it (${label})`, () => {
      // 900 / 90 / 10 over 1000 rows.
      const { seen } = tally(1000, 'tail.csv', opts);
      expect(seen.get('Common'), label).toBe(900);
      expect(seen.get('Mid'), label).toBe(90);
      expect(seen.get('Rare'), label).toBe(10);
    });

    it(`is reproducible for a fixed seed (${label})`, () => {
      const a = tally(500, 'names.csv', opts);
      const b = tally(500, 'names.csv', opts);
      expect([...a.seen]).toEqual([...b.seen]);
    });
  }

  it('an unweighted read of the same file stays uniform', () => {
    // Guards against weighting leaking into plain file reads.
    const src =
      `<tdc><env count="3000" seed="u" inject="\${{%}}">` +
      `<sequence name="N"><gen type="file" src="names.csv" column="name"/></sequence>` +
      `</env><block><line><data>\${{N}}</data></line></block></tdc>`;
    const out = render(parseStrict(src), { now: 0, dataPaths: [dir], mode: 'memory' })
      .split('\n')
      .filter(Boolean);
    const bobs = out.filter((l) => l === 'Bob').length;
    // Uniform over two values — nowhere near the 2:1 the weights would give.
    expect(bobs).toBeGreaterThan(1300);
    expect(bobs).toBeLessThan(1700);
  });
});

describe('weight — refused where it has no meaning', () => {
  const codes = (seq: string): string[] =>
    validate(
      parse(
        `<tdc><env count="3" seed="v" inject="\${{%}}"><sequence name="S">${seq}</sequence></env>` +
          `<block><line><data>\${{S}}</data></line></block></tdc>`,
      ).tree,
    ).diagnostics.map((d) => d.code ?? '');

  it('accepts a weighted CSV read', () => {
    // The file itself is absent here (TDC061) — what matters is that no
    // weight-specific complaint is raised.
    const raised = codes('<gen type="file" src="names.csv" column="name" weight="count"/>');
    expect(raised.filter((c) => c.startsWith('TDC21'))).toEqual([]);
  });

  it('rejects weight on inline values — that is what percent= is for (TDC211)', () => {
    expect(codes('<gen type="text" value="a,b" weight="count"/>')).toContain('TDC211');
  });

  it('rejects weight without column (TDC212)', () => {
    expect(codes('<gen type="file" src="names.csv" weight="count"/>')).toContain('TDC212');
  });

  it('rejects weight alongside order= (TDC213) — order walks rows by position', () => {
    expect(
      codes('<gen type="file" src="n.csv" column="name" weight="count" order="sequential"/>'),
    ).toContain('TDC213');
  });

  it('ALLOWS weight alongside row= — the shared row is drawn to the weighted quota', () => {
    expect(
      codes('<gen type="file" src="n.csv" column="name" weight="count" row="k"/>'),
    ).not.toContain('TDC213');
  });
});
