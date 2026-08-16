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

  it('refuses rather than silently misallocating when streaming is forced', () => {
    // Matched on the CONSEQUENCE, not on "declares a share". A pack earns this
    // refusal two ways — a percent= in its body, or a weighted list its body
    // draws from — and the old wording named only the first, so it described
    // twelve full-name packs wrongly the day the second one started refusing.
    expect(() => render(parseStrict(config('')), { now: NOW, packs, engine: 2 })).toThrow(
      /apportioned across the whole column/,
    );
  });
});
