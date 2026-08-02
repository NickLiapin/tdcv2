import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanPacks } from '../../src/data-pack/index.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * A pack carries weights so `Smith` appears as often as it does in the Census,
 * not as often as `Zabrowski`. The hard requirement — learned from the
 * length-group bug — is that BOTH engines honour the exact quota, because the
 * streaming engine resolves one row at a time and a naive port collapses to
 * winner-take-all.
 */

function packDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'wpack-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function tally(out: string): Record<string, number> {
  const c: Record<string, number> = {};
  for (const line of out.split('\n').filter(Boolean)) c[line] = (c[line] ?? 0) + 1;
  return c;
}

const render = (config: string, root: string): string =>
  new TDC({ configString: config, dataPaths: [root] }).toString();

// Real 2010 Census counts for the top three surnames.
const SURNAME_BODY = '---\nweighted: true\n---\nSmith,2442977\nJohnson,1932812\nWilliams,1625252\n';
const TOTAL = 2442977 + 1932812 + 1625252;
const EXPECT = {
  Smith: Math.round((2442977 / TOTAL) * 10000),
  Johnson: Math.round((1932812 / TOTAL) * 10000),
  Williams: Math.round((1625252 / TOTAL) * 10000),
};

function cfg(mode: string): string {
  return (
    `<tdc><env count="10000" seed="demo"${mode}>` +
    `<sequence name="N"><gen type="template" value="common.demo.sn"/></sequence>` +
    `</env><block><line><data>\${{N}}</data></line></block></tdc>`
  );
}

describe('weighted data packs', () => {
  it('honours the weights exactly on the DEFAULT (streaming) engine', () => {
    const root = packDir({ 'common/demo/sn.txt': SURNAME_BODY });
    expect(tally(render(cfg(''), root))).toEqual(EXPECT);
  });

  it('honours the weights exactly on the MEMORY engine', () => {
    const root = packDir({ 'common/demo/sn.txt': SURNAME_BODY });
    expect(tally(render(cfg(' mode="memory"'), root))).toEqual(EXPECT);
  });

  it('both engines agree on the proportions', () => {
    const root = packDir({ 'common/demo/sn.txt': SURNAME_BODY });
    expect(tally(render(cfg(''), root))).toEqual(tally(render(cfg(' mode="memory"'), root)));
  });

  it('a plain pack is still a uniform pick, unchanged', () => {
    // Three equal values over 9000 rows → ~3000 each, nowhere near the skew
    // above. The point is that adding weights did not perturb the plain path.
    const root = packDir({ 'common/demo/sn.txt': 'Smith\nJohnson\nWilliams\n' });
    const t = tally(render(cfg('').replace('10000', '9000'), root));
    for (const v of ['Smith', 'Johnson', 'Williams']) {
      expect(t[v]).toBeGreaterThan(2700);
      expect(t[v]).toBeLessThan(3300);
    }
  });

  it('a plain pack keeps commas in its values — weighting is opt-in only', () => {
    // The trap: a user's list may legitimately hold "Washington, D.C." A pack
    // is split into value+count ONLY when it declares itself weighted, so a
    // plain pack's commas are literal. Without this, weighting could not be a
    // no-op for the packs most users write.
    const root = packDir({
      'common/demo/sn.txt': '---\ndescription: places\n---\nWashington, D.C.\nSmith, Jr\n',
    });
    const seen = new Set(render(cfg('').replace('10000', '40'), root).split('\n').filter(Boolean));
    expect([...seen].sort()).toEqual(['Smith, Jr', 'Washington, D.C.']);
  });

  describe('a custom delimiter protects comma-bearing values', () => {
    // The value is a sentence with its own commas; `@` keeps the count apart.
    const PHRASES =
      '---\nweighted: true\ndelimiter: @\n---\nПример, с запятой@100\nВторое, тоже@50\n';

    it('inline: delimiter: @ keeps the commas inside the value', () => {
      const root = packDir({ 'common/demo/sn.txt': PHRASES });
      const out = render(cfg('').replace('10000', '3000'), root);
      const t = tally(out);
      expect(t['Пример, с запятой']).toBe(2000);
      expect(t['Второе, тоже']).toBe(1000);
    });

    it('external: delimiter: @ on a file:+weight: pack', () => {
      const root = packDir({
        'data/m.csv': 'text@count\nПример, с запятой@100\nВторое, тоже@50\n',
        'common/demo/sn.txt':
          '---\nfile: ../../data/m.csv\ndelimiter: @\ncolumn: text\nweight: count\n---\n',
      });
      const t = tally(render(cfg('').replace('10000', '3000'), root));
      expect(t['Пример, с запятой']).toBe(2000);
      expect(t['Второе, тоже']).toBe(1000);
    });

    it('accepts the `tab` alias', () => {
      const root = packDir({
        'common/demo/sn.txt': '---\nweighted: true\ndelimiter: tab\n---\nSmith\t100\nJones\t100\n',
      });
      const t = tally(render(cfg('').replace('10000', '2000'), root));
      expect(t['Smith']).toBe(1000);
      expect(t['Jones']).toBe(1000);
    });
  });

  it('reads weights from an external CSV via file:+weight:', () => {
    const root = packDir({
      'data/sn.csv': 'name,count\nSmith,2442977\nJohnson,1932812\nWilliams,1625252\n',
      'common/demo/sn.txt': '---\nfile: ../../data/sn.csv\ncolumn: name\nweight: count\n---\n',
    });
    expect(tally(render(cfg(''), root))).toEqual(EXPECT);
  });

  it('is deterministic across runs', () => {
    const root = packDir({ 'common/demo/sn.txt': SURNAME_BODY });
    expect(render(cfg(''), root)).toEqual(render(cfg(''), root));
  });

  describe('malformed weighted packs are refused, not silently mishandled', () => {
    const scanError = (body: string): string[] =>
      scanPacks([packDir({ 'common/demo/sn.txt': body })]).diagnostics.map((d) => d.message);

    it('a line with no ,count', () => {
      expect(scanError('---\nweighted: true\n---\nSmith,100\nJohnson\n').join(' ')).toContain(
        'has no ",count"',
      );
    });

    it('a blank count (would be a silent zero)', () => {
      expect(scanError('---\nweighted: true\n---\nSmith,100\nJohnson,\n').join(' ')).toContain(
        'empty count',
      );
    });

    it('a non-integer count', () => {
      expect(scanError('---\nweighted: true\n---\nSmith,1.5\n').join(' ')).toContain(
        'not a non-negative integer',
      );
    });

    it('an explicit zero drops the value but is not an error', () => {
      const root = packDir({
        'common/demo/sn.txt': '---\nweighted: true\n---\nSmith,100\nGhost,0\n',
      });
      const t = tally(render(cfg(''), root));
      expect(t['Ghost']).toBeUndefined();
      expect(t['Smith']).toBe(10000);
    });
  });
});
