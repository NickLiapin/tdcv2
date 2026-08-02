import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The French locale pack (data/packs/fr). Checks the culturally specific bits:
 * a French full name carries a single surname (not the two of es), the coherent
 * parent->child lists (cuisine/sport) stay in sync with their key files, and
 * dates render with French month names via the registered DateLocale.
 */

const here = dirname(fileURLToPath(import.meta.url));
const frDir = resolve(here, '../../../data/packs/fr');

/** Values of a pack list file, past the `--- … ---` frontmatter fence. */
function valuesOf(relPath: string): Set<string> {
  const lines = readFileSync(join(frDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return new Set(lines.slice(end + 1).filter((l) => l.trim() !== ''));
}

function render(address: string, count = 40, seed = 'fr'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="fr">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('fr.person full names', () => {
  it('carry a single surname (Prénom Nom)', () => {
    for (const gender of ['male', 'female']) {
      for (const v of render(`fr.person.${gender}.fullName`, 30)) {
        // Two whitespace-separated tokens: one given name, one surname. A
        // hyphenated surname (Saint-Martin) still counts as one token.
        expect(v.trim().split(/\s+/), v).toHaveLength(2);
      }
    }
  });
});

describe('fr coherent cuisine -> dish', () => {
  it('every dish belongs to the cuisine drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="menu" local="fr">',
      '  <sequence name="Cuisine"><gen type="template" value="fr.food.cuisine"/></sequence>',
      '  <sequence name="Dish" parent="Cuisine"><gen type="template" value="fr.food.dishByCuisine.${{Cuisine}}"/></sequence>',
      '</env><block><line><data>${{Cuisine}}|${{Dish}}</data></line></block></tdc>',
    ].join('\n');
    const rows = new TDC({ configString: cfg }).toString().trim().split('\n');
    for (const row of rows) {
      const [cuisine, dish] = row.split('|');
      expect(cuisine, row).toBeTruthy();
      expect(
        valuesOf(`food/dishByCuisine/${cuisine ?? ''}.txt`).has(dish ?? ''),
        `"${String(dish)}" is not a ${String(cuisine)} dish`,
      ).toBe(true);
    }
  });
});

describe('fr coherent sport -> position', () => {
  it('every position belongs to the sport drawn on that row', () => {
    const cfg = [
      '<tdc><env count="60" seed="team" local="fr">',
      '  <sequence name="Sport"><gen type="template" value="fr.sport.sportCoherent"/></sequence>',
      '  <sequence name="Pos" parent="Sport"><gen type="template" value="fr.sport.positionBySport.${{Sport}}"/></sequence>',
      '</env><block><line><data>${{Sport}}|${{Pos}}</data></line></block></tdc>',
    ].join('\n');
    const rows = new TDC({ configString: cfg }).toString().trim().split('\n');
    for (const row of rows) {
      const [sport, pos] = row.split('|');
      expect(sport, row).toBeTruthy();
      expect(
        valuesOf(`sport/positionBySport/${sport ?? ''}.txt`).has(pos ?? ''),
        `"${String(pos)}" is not a ${String(sport)} position`,
      ).toBe(true);
    }
  });
});

describe('fr dates', () => {
  it('render French month names in the long form', () => {
    const cfg =
      '<tdc><env count="12" seed="cal" local="fr">' +
      '<sequence name="D"><gen type="date" from="2026-01-01" to="2026-12-31" format="LL"/></sequence>' +
      '</env><block><line><data>${{D}}</data></line></block></tdc>';
    const out = new TDC({ configString: cfg }).toString();
    // At least one recognisably French month, and no Spanish/English leakage.
    expect(out).toMatch(
      /janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre/,
    );
    expect(out).not.toMatch(/January|enero|September|septiembre/);
  });
});

describe('fr locale determinism', () => {
  it('is reproducible for a fixed seed', () => {
    expect(render('fr.person.male.fullName', 20, 'x')).toEqual(
      render('fr.person.male.fullName', 20, 'x'),
    );
  });
});
