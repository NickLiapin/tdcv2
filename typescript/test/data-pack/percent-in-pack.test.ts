import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { scanPacks } from '../../src/data-pack/load.js';
import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

/**
 * A share declared INSIDE a pack generator — `<mix percent="60,40">` in the pack
 * file — is apportioned over the whole column, exactly like a share declared in
 * a config. The streaming engines resolve one row at a time, so they would
 * compute that quota over a single row and hand every row to the largest share:
 * 1000 rows of the 60% branch, no 40% branch at all, and nothing to show for it
 * in the output but plausible-looking data.
 *
 * So the engine chooser routes such a config to the in-memory engine, and the
 * streaming path refuses outright if one is forced on it. Wrong data is the one
 * outcome neither may produce.
 */
describe('a share declared inside a pack generator', () => {
  const NOW = new Date('2026-07-23T00:00:00Z').getTime();

  const packs = (() => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-pct-pack-'));
    mkdirSync(join(root, 'es', 'person'), { recursive: true });
    writeFileSync(join(root, 'es', '_locale.json'), '{ "code": "es", "direction": "ltr" }');
    writeFileSync(
      join(root, 'es', 'person', 'share.txt'),
      [
        '---',
        'address: es.person.share',
        'generator: tdc',
        'locale: es',
        '---',
        '<mix name="M" percent="60,40">',
        '  <case><gen type="text" value="AAA"/></case>',
        '  <case><gen type="text" value="BBB"/></case>',
        '</mix>',
        '<data>${{M}}</data>',
        '',
      ].join('\n'),
    );
    return scanPacks([root]).registry;
  })();

  const config = (envExtra: string) =>
    `<tdc><env count="1000" seed="s" local="es"${envExtra}>` +
    `<sequence name="V"><gen type="template" value="es.person.share"/></sequence>` +
    `</env><block><line><data>\${{V}}</data></line></block></tdc>`;

  const tally = (out: string) => {
    const counts = { AAA: 0, BBB: 0 };
    for (const line of out.split('\n')) {
      if (line === 'AAA') counts.AAA += 1;
      else if (line === 'BBB') counts.BBB += 1;
    }
    return counts;
  };

  it('is apportioned exactly, by default', () => {
    const out = render(parseStrict(config('')), { now: NOW, packs });
    expect(tally(out)).toEqual({ AAA: 600, BBB: 400 });
  });

  it('is apportioned exactly under disk mode, which must route to the in-memory engine', () => {
    const out = render(parseStrict(config(' mode="disk"')), { now: NOW, packs });
    expect(tally(out)).toEqual({ AAA: 600, BBB: 400 });
  });

  it('is apportioned exactly by the streaming engines too, which no longer refuse it', () => {
    /*
     * This used to be a refusal: a share declared inside a pack body could only
     * be honoured over the whole column, and the streaming builder resolved one
     * row at a time, so it would have handed every row the largest share.
     *
     * It is not a refusal any more, because the body is built by the streaming
     * builder itself at the COLUMN's count — the share is planned over the
     * column and each row mapped into it, exactly as a top-level `percent=` has
     * always been. What the refusal protected against is checked here directly:
     * the tally, on every engine, not merely that an error was raised.
     */
    for (const engine of [1, 2, 3] as const) {
      const out = render(parseStrict(config('')), { now: NOW, packs, engine });
      expect(tally(out), `engine ${String(engine)}`).toEqual({ AAA: 600, BBB: 400 });
    }
  });

  it('gives all three engines the same rows, not merely the same tally', () => {
    // A tally can be right while the rows are in a different order, and a
    // config's bytes are the product. One seed, one file, whichever engine.
    const texts = [1, 2, 3].map((engine) =>
      render(parseStrict(config('')), { now: NOW, packs, engine: engine as 1 | 2 | 3 }),
    );
    expect(texts[1]).toBe(texts[0]);
    expect(texts[2]).toBe(texts[0]);
  });
});
