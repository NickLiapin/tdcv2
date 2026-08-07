import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * The Ukrainian (`uk`) locale core: names and dates.
 *
 * `uk` is a partial locale on purpose — the person and date categories are
 * filled and the rest is not there yet, which the engine states rather than
 * papers over: an unfilled path is a TDC071, never a quiet fall back to English.
 * That property is what makes filling a locale in waves safe, and the last test
 * here pins it.
 *
 * The rest guards the thing Ukrainian gets wrong by default, and the reason the
 * masculine and feminine lists are separate files: **surnames inflect, but only
 * some of them**. Patronymic surnames (-енко, -ук/-чук, -ар) are the same string
 * for a man and a woman; adjectival ones are not — Ковальський/Ковальська,
 * Білий/Біла. Patronymics inflect always: -ович/-івна.
 */

const here = dirname(fileURLToPath(import.meta.url));
const ukDir = resolve(here, '../../../data/packs/uk');
const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** The values of a pack file, with its front matter stripped. */
function valuesOf(relPath: string): string[] {
  const lines = readFileSync(join(ukDir, relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return lines
    .slice(end + 1)
    .filter((l) => l.trim() !== '')
    .map((l) => l.split(',')[0] ?? '');
}

function render(address: string, count = 40, seed = 'uk'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="uk">` +
    `<sequence name="V"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{V}}</data></line></block></tdc>';
  return new TDC({ configString: config, now: NOW })
    .toString()
    .split('\n')
    .filter((l) => l.length > 0);
}

describe('uk locale pack', () => {
  it('draws names in Cyrillic, never in Latin', () => {
    for (const path of [
      'person.male.firstName',
      'person.female.firstName',
      'person.male.lastName',
      'person.female.lastName',
      'person.male.patronymic',
      'person.female.patronymic',
    ]) {
      expect(
        render(path, 20).every((v) => !/[A-Za-z]/.test(v)),
        path,
      ).toBe(true);
    }
  });

  it('inflects adjectival surnames for gender and leaves the rest alone', () => {
    const male = valuesOf('person/male/lastName.txt');
    const female = valuesOf('person/female/lastName.txt');
    // Line for line, so a husband and a wife carry one family name.
    expect(female.length).toBe(male.length);

    for (const [m, f] of [
      ['Ковальський', 'Ковальська'],
      ['Хмельницький', 'Хмельницька'],
      ['Білий', 'Біла'],
    ] as const) {
      const at = male.indexOf(m);
      expect(at, m).toBeGreaterThanOrEqual(0);
      expect(female[at]).toBe(f);
    }

    // The ones that do NOT change are the majority, and getting those "right"
    // by inflecting them would be the opposite mistake.
    for (const same of ['Шевченко', 'Ковальчук', 'Бондар', 'Мороз']) {
      const at = male.indexOf(same);
      expect(at, same).toBeGreaterThanOrEqual(0);
      expect(female[at]).toBe(same);
    }
  });

  it('never gives a woman a masculine surname ending, over four hundred rows', () => {
    const config =
      '<tdc><env count="400" seed="kyiv" local="uk">' +
      '<sequence name="Sex"><gen type="text" value="ч,ж" percent="50,50"/></sequence>' +
      '<sequence name="Last">' +
      '<gen if="Sex == \'ч\'" type="template" value="person.male.lastName"/>' +
      '<gen type="template" value="person.female.lastName"/></sequence>' +
      '</env><block><line><data>${{Sex}} ${{Last}}</data></line></block></tdc>';
    const rows = new TDC({ configString: config, now: NOW })
      .toString()
      .split('\n')
      .filter((l) => l.length > 0);
    const women = rows.filter((r) => r.startsWith('ж '));
    expect(women.length).toBeGreaterThan(100);
    expect(women.filter((r) => /(ський|цький|ий)$/.test(r))).toEqual([]);
  });

  it('pairs patronymics line for line, -ович against -івна', () => {
    const male = valuesOf('person/male/patronymic.txt');
    const female = valuesOf('person/female/patronymic.txt');
    expect(female.length).toBe(male.length);
    expect(male.every((v) => /(ович|ич)$/.test(v))).toBe(true);
    expect(female.every((v) => /(івна|ївна)$/.test(v))).toBe(true);
    expect(male[male.indexOf('Дмитрович')]).toBe('Дмитрович');
    expect(female[male.indexOf('Дмитрович')]).toBe('Дмитрівна');
  });

  it('has the twelve months and seven weekdays, in order', () => {
    expect(render('date.month', 12, 'm')).toBeDefined();
    expect(valuesOf('date/month.txt')).toEqual([
      'січень',
      'лютий',
      'березень',
      'квітень',
      'травень',
      'червень',
      'липень',
      'серпень',
      'вересень',
      'жовтень',
      'листопад',
      'грудень',
    ]);
    expect(valuesOf('date/weekday.txt')[0]).toBe('понеділок');
    expect(valuesOf('date/weekday.txt')).toHaveLength(7);
  });

  it('says so plainly for a category this locale does not have yet', () => {
    // The whole reason a partial locale is safe: what is missing is refused by
    // name, rather than answered in English while claiming to be Ukrainian.
    expect(() => render('food.dish', 3)).toThrow(/food\.dish/);
  });
});
