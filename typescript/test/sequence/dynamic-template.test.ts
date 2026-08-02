import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * A template `value` may interpolate a parent field per row —
 * `value="common.vehicle.model.${{Brand}}"` — so the child pack is chosen by the parent
 * that was drawn on that row. This is TDC's coherent parent→child-by-name: draw
 * "Fiat" and you get a Fiat model, never a Toyota one.
 *
 * It runs on the in-memory engine (Engine 1); a config that uses it is routed
 * there (the lazy streaming engine can't resolve a per-row address, so it defers).
 */

const here = dirname(fileURLToPath(import.meta.url));
const packsDir = resolve(here, '../../../data/packs/common/vehicle/model');

/** The models declared for a brand, read straight from its pack file. */
function modelsOf(brand: string): Set<string> {
  const lines = readFileSync(join(packsDir, `${brand}.txt`), 'utf8').split('\n');
  const end = lines.indexOf('---', 1); // header is fenced by --- … ---
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

const CONFIG = [
  '<tdc><env count="40" seed="cars" local="en">',
  '  <sequence name="Brand"><gen type="template" value="common.vehicle.brand"/></sequence>',
  '  <sequence name="Model" parent="Brand"><gen type="template" value="common.vehicle.model.${{Brand}}"/></sequence>',
  '</env>',
  '<block><line><data>${{Brand}}|${{Model}}</data></line></block></tdc>',
].join('\n');

describe('dynamic template value (parent-interpolated address)', () => {
  it('every model belongs to the brand drawn on that row', () => {
    const rows = new TDC({ configString: CONFIG }).toString().trim().split('\n');
    expect(rows).toHaveLength(40);
    for (const row of rows) {
      const [brand, model] = row.split('|');
      expect(brand, row).toBeTruthy();
      expect(model, row).toBeTruthy();
      expect(
        modelsOf(brand ?? '').has(model ?? ''),
        `"${String(model)}" is not a ${String(brand)} model (${row})`,
      ).toBe(true);
    }
  });

  it('is deterministic for a fixed seed', () => {
    const a = new TDC({ configString: CONFIG }).toString();
    const b = new TDC({ configString: CONFIG }).toString();
    expect(a).toBe(b);
  });
});
