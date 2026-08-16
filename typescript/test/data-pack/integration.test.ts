import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundledPacksDir, scanPacks } from '../../src/data-pack/index.js';
import { TdcDiagnosticError } from '../../src/errors/index.js';
import { TDC } from '../../src/lib/tdc.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('data packs — end to end through TDC', () => {
  it('resolves a user pack address (byte-exact, deterministic)', () => {
    // A controlled temp pack — a stable golden independent of bundled data.
    const root = mkdtempSync(join(tmpdir(), 'tdc-pack-e2e-'));
    mkdirSync(join(root, 'common', 'demo'), { recursive: true });
    writeFileSync(join(root, 'common', 'demo', 'color.txt'), 'red\ngreen\nblue\n', 'utf8');

    const config = `<tdc>
      <env count="4" seed="pack-e2e" inject="\${{%}}">
        <sequence name="C"><gen type="template" value="common.demo.color"/></sequence>
      </env>
      <block><line><data>\${{C}}</data></line></block>
    </tdc>`;

    const a = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    const b = new TDC({ configString: config, dataPaths: [root], now: FIXED_NOW }).toString();
    expect(a).toBe(b); // deterministic
    const values = a.split('\n').filter(Boolean);
    expect(values).toHaveLength(4);
    for (const v of values) expect(['red', 'green', 'blue']).toContain(v);
  });

  /**
   * `scanPacks` walks the entire bundled tree, so this test gets slower every
   * time a pack ships — it crossed the 10s default at ~18,900 addresses, which
   * looks like flakiness and is not. The timeout is sized for a corpus that
   * keeps growing, not for today's count.
   */
  it('resolves bundled pack addresses; every value is a pack member', () => {
    const dir = bundledPacksDir();
    expect(dir).toBeDefined();
    const { registry } = scanPacks([dir!]);
    const ruFirst = registry.get('ru.person.male.firstName');
    expect(ruFirst?.values?.length).toBeGreaterThan(0);

    const config = `<tdc>
      <env count="12" seed="bundled-e2e" inject="\${{%}}">
        <sequence name="N"><gen type="template" value="ru.person.male.firstName"/></sequence>
      </env>
      <block><line><data>\${{N}}</data></line></block>
    </tdc>`;
    const out = new TDC({ configString: config, now: FIXED_NOW }).toString();
    const values = out.split('\n').filter(Boolean);
    expect(values).toHaveLength(12);
    for (const v of values) expect(ruFirst?.values ?? []).toContain(v);
  }, 120_000);

  it('a typo in a pack address is flagged as an unknown template (TDC071)', () => {
    const config = `<tdc>
      <env count="1" seed="x" inject="\${{%}}">
        <sequence name="N"><gen type="template" value="ru.person.male.firstNam"/></sequence>
      </env>
      <block><line><data>\${{N}}</data></line></block>
    </tdc>`;
    let caught: unknown;
    try {
      new TDC({ configString: config });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TdcDiagnosticError);
    expect((caught as TdcDiagnosticError).diagnostics.some((d) => d.code === 'TDC071')).toBe(true);
  });
});
