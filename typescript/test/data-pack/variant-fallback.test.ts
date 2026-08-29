/**
 * A regional variant falls back to its base language.
 *
 * `en-gb`, `pt-br`, `de-at` are locales in every sense the project uses the
 * word: they are canonical codes, they have `_locale.json`, the date layer
 * knows the names. What they have never had is data — and a config that said
 * `local="en-gb"`, the most natural thing in the world to write, was refused
 * with "template path has no data for locale en-gb" and handed a list of 82
 * other locales that never mentioned `en`.
 *
 * Thirty-six variant folders were in that state. The fix is the rule every
 * i18n system on earth already follows (RFC 4647 lookup, moment's own
 * `en-gb` → `en`): a variant answers for itself where it ships something, and
 * defers to its base language everywhere else. One step, never a chain, and
 * never as far as English — `zh-tw` has no `zh` to fall back to and still
 * refuses, which is correct, because Traditional is not Simplified.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

const roots: string[] = [];

function packRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tdc-variant-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function render(source: string, dataPaths: readonly string[] = []): string {
  return new TDC({ configString: source, ...(dataPaths.length > 0 ? { dataPaths } : {}) })
    .toString()
    .trim();
}

const NAMES = (locale: string): string =>
  `<tdc><env count="4" seed="v" local="${locale}"><sequence name="N">` +
  `<gen type="template" value="person.lastName"/></sequence></env>` +
  '<block><line><data>${{N}}</data></line></block></tdc>';

describe('a variant locale defers to its base language', () => {
  it('en-gb draws English data instead of refusing', () => {
    expect(render(NAMES('en-gb'))).toBe(render(NAMES('en')));
  });

  it('so do the other variants whose base ships data', () => {
    for (const [variant, base] of [
      ['pt-br', 'pt'],
      ['es-mx', 'es'],
      ['de-at', 'de'],
      ['fr-ca', 'fr'],
      ['ar-sa', 'ar'],
    ] as const) {
      expect(render(NAMES(variant))).toBe(render(NAMES(base)));
    }
  });

  it('the variant WINS where it ships something of its own', () => {
    // The whole point of the rule: a variant carries its differences only.
    const root = packRoot({
      'en-gb/person/lastName.txt':
        '---\ndescription: British surnames\nlocale: en-gb\n---\nFeatherstonehaugh\n',
    });
    expect(render(NAMES('en-gb'), [root])).toBe(
      ['Featherstonehaugh', 'Featherstonehaugh', 'Featherstonehaugh', 'Featherstonehaugh'].join(
        '\n',
      ),
    );
    // ...and still defers for everything it does NOT ship.
    const other =
      '<tdc><env count="2" seed="v" local="en-gb"><sequence name="C">' +
      '<gen type="template" value="geo.country"/></sequence></env>' +
      '<block><line><data>${{C}}</data></line></block></tdc>';
    expect(render(other, [root])).toBe(render(other.replace('en-gb', 'en'), [root]));
  });

  it('dates follow the same rule — de-at reads German months, not English', () => {
    const dated = (locale: string): string =>
      `<tdc><env count="1" seed="d" local="${locale}"><sequence name="D">` +
      '<gen type="date" value="2024-03-01..2024-03-01" format="MMMM"/></sequence></env>' +
      '<block><line><data>${{D}}</data></line></block></tdc>';
    expect(render(dated('de-at'))).toBe(render(dated('de')));
    expect(render(dated('de-at'))).not.toBe(render(dated('en')));
  });

  it('a variant with no base data still refuses — the fallback is one step, not a search', () => {
    // `zh-tw` would have to reach `zh`, which ships nothing; falling on to
    // `zh-cn` would hand Traditional readers Simplified data.
    expect(() => render(NAMES('zh-tw'))).toThrow(/no data for locale "zh-tw"/);
    // And the empty-locale test vector the pack suite relies on stays empty.
    expect(() => render(NAMES('x-pseudo'))).toThrow(/no data for locale "x-pseudo"/);
  });

  it('check agrees with the run — no TDC217 for a variant the run can serve', () => {
    const tdc = new TDC({ configString: NAMES('en-gb') });
    expect(tdc.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
