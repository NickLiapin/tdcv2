import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

/**
 * `weight=` + `row=` together: draw the shared row by a weight column (exact
 * proportions, like `percent=`) AND keep every linked column coherent (price and
 * category come from the SAME line as the name). This runs on the in-memory
 * engine — a config that uses it is routed there, since the streaming engines
 * can't weight a per-card row draw without the global total.
 */

const CSV =
  'name,price,sales\nWidget,9.99,1000\nGadget,19.99,50\nGizmo,4.99,300\nDoohickey,99.99,5\n';
const PRICE: Record<string, string> = {
  Widget: '9.99',
  Gadget: '19.99',
  Gizmo: '4.99',
  Doohickey: '99.99',
};

function csvPath(): string {
  const p = join(mkdtempSync(join(tmpdir(), 'tdc-wrl-')), 'products.csv');
  writeFileSync(p, CSV);
  return p;
}

function dsl(path: string, count: number): string {
  return `<tdc>
    <env count="${String(count)}" seed="catalogue" inject="\${{%}}">
      <sequence name="Item">
        <gen name="Name"  type="file" src="${path}" column="name"  row="p" weight="sales"/>
        <gen name="Price" type="file" src="${path}" column="price" row="p"/>
      </sequence>
    </env>
    <block><line><data>\${{Item.Name}}|\${{Item.Price}}</data></line></block>
  </tdc>`;
}

describe('weight= + row= (weighted, coherent rows)', () => {
  it('keeps columns coherent AND draws rows by the weight column', () => {
    const lines = render(parseStrict(dsl(csvPath(), 4000)))
      .split('\n')
      .filter(Boolean);
    expect(lines).toHaveLength(4000);

    // Coherence: the price on every card belongs to that card's product.
    for (const line of lines) {
      const [name, price] = line.split('|');
      expect(price, line).toBe(PRICE[name ?? '']);
    }

    // Weighting: sales 1000 ≫ 300 ≫ 50 ≫ 5 — the counts follow the same order.
    const n = (name: string): number => lines.filter((l) => l.startsWith(`${name}|`)).length;
    expect(n('Widget')).toBeGreaterThan(n('Gizmo'));
    expect(n('Gizmo')).toBeGreaterThan(n('Gadget'));
    expect(n('Gadget')).toBeGreaterThan(n('Doohickey'));
  });

  it('default output equals --mode memory (routed to Engine 1)', () => {
    const path = csvPath();
    expect(render(parseStrict(dsl(path, 60)))).toBe(
      render(parseStrict(dsl(path, 60)), { mode: 'memory' }),
    );
  });
});
