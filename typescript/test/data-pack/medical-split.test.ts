import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Diagnoses split by what a body can actually have. A generated patient used to
 * be able to receive a diagnosis their anatomy rules out — the general list held
 * Benign Prostatic Hyperplasia, Endometriosis and Polycystic Ovary Syndrome, and
 * the en/ru male lists held Cervicitis and Endometritis.
 *
 * The set is one canon translated into every locale: appendicitis is
 * appendicitis in Athens, Cairo and Warsaw. So each locale must carry the same
 * counts and the same ancestry keys, and a fixed seed must land on the same
 * condition everywhere.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packs = resolve(here, '../../../data/packs');

/** Every locale that ships a medical/ directory. */
const LOCALES = ['en', 'es', 'fr', 'de', 'it', 'ru', 'pt', 'pl', 'ar', 'el'] as const;

function entries(locale: string, relPath: string): string[] {
  const lines = readFileSync(join(packs, locale, 'medical', relPath), 'utf8').split('\n');
  const end = lines.indexOf('---', 1);
  return lines.slice(end + 1).filter((l) => l.trim() !== '');
}

function ancestryChildren(locale: string): string[] {
  return readdirSync(join(packs, locale, 'medical', 'diagnosisByAncestry'))
    .filter((f) => f.endsWith('.txt'))
    .map((f) => f.normalize('NFC').slice(0, -4));
}

function render(address: string, count = 30, seed = 'med'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe.each(LOCALES)('%s medical split', (locale) => {
  it('carries the canonical counts', () => {
    expect(entries(locale, 'diagnosisMale.txt')).toHaveLength(20);
    expect(entries(locale, 'diagnosisFemale.txt')).toHaveLength(26);
    expect(entries(locale, 'ancestry.txt')).toHaveLength(12);
  });

  it('never lets a diagnosis belong to both sexes', () => {
    const male = new Set(entries(locale, 'diagnosisMale.txt'));
    const shared = entries(locale, 'diagnosisFemale.txt').filter((d) => male.has(d));
    expect(shared).toEqual([]);
  });

  it('keeps the general list free of anything sex-specific', () => {
    const male = new Set(entries(locale, 'diagnosisMale.txt'));
    const female = new Set(entries(locale, 'diagnosisFemale.txt'));
    const leaked = entries(locale, 'diagnosis.txt').filter((d) => male.has(d) || female.has(d));
    expect(leaked).toEqual([]);
  });

  it('pairs every ancestry with a child file, by exact bytes', () => {
    const parents = entries(locale, 'ancestry.txt').map((a) => a.normalize('NFC'));
    const children = ancestryChildren(locale);
    expect([...children].sort()).toEqual([...parents].sort());
  });

  it('says outright that ancestry is a prevalence signal, not a rule', () => {
    const dir = join(packs, locale, 'medical', 'diagnosisByAncestry');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.txt'))) {
      const header = readFileSync(join(dir, file), 'utf8').split('---')[1] ?? '';
      expect(header, `${locale}/${file}`).toMatch(/prevalence signal, not an exclusive one/);
    }
  });
});

describe('the canon is the same everywhere, only translated', () => {
  it('gives every locale the same number of conditions per ancestry', () => {
    const shape = (locale: string) =>
      ancestryChildren(locale)
        .map((child) => entries(locale, `diagnosisByAncestry/${child}.txt`).length)
        .sort((a, b) => a - b);
    const reference = shape('en');
    for (const locale of LOCALES) expect(shape(locale), locale).toEqual(reference);
  });

  it('lands on the same condition in every locale for a fixed seed', () => {
    const pick = (locale: string) => {
      const cfg = [
        `<tdc><env count="6" seed="same" local="${locale}">`,
        `  <sequence name="A"><gen type="template" value="${locale}.medical.ancestry"/></sequence>`,
        `  <sequence name="D" parent="A"><gen type="template" value="${locale}.medical.diagnosisByAncestry.\${{A}}"/></sequence>`,
        '</env><block><line><data>${{A}}|${{D}}</data></line></block></tdc>',
      ].join('\n');
      return new TDC({ configString: cfg })
        .toString()
        .trim()
        .split('\n')
        .map((row) => {
          const [ancestry, diagnosis] = row.split('|');
          const parents = entries(locale, 'ancestry.txt');
          const kids = entries(locale, `diagnosisByAncestry/${ancestry ?? ''}.txt`);
          // Report positions, which are language-independent, rather than text.
          return `${String(parents.indexOf(ancestry ?? ''))}:${String(kids.indexOf(diagnosis ?? ''))}`;
        });
    };
    const reference = pick('en');
    expect(reference.every((p) => !p.startsWith('-1') && !p.endsWith('-1'))).toBe(true);
    for (const locale of LOCALES) expect(pick(locale), locale).toEqual(reference);
  });
});

describe('the sex lists are usable on their own', () => {
  it.each(LOCALES)('%s draws male and female conditions that stay in their list', (locale) => {
    const male = new Set(entries(locale, 'diagnosisMale.txt'));
    const female = new Set(entries(locale, 'diagnosisFemale.txt'));
    for (const v of render(`${locale}.medical.diagnosisMale`, 20))
      expect(male.has(v), v).toBe(true);
    for (const v of render(`${locale}.medical.diagnosisFemale`, 20)) {
      expect(female.has(v), v).toBe(true);
    }
  });
});

describe('the conditions that started this', () => {
  it('no longer offers prostate or ovary conditions to the general list', () => {
    const general = entries('en', 'diagnosis.txt');
    expect(general).not.toContain('Benign Prostatic Hyperplasia');
    expect(general).not.toContain('Endometriosis');
    expect(general).not.toContain('Polycystic Ovary Syndrome');
  });

  it('no longer puts female conditions in a male list', () => {
    const lines = readFileSync(join(packs, 'en/person/male/diagnosis.txt'), 'utf8');
    expect(lines).not.toMatch(/Cervicitis|Endometritis/);
    const ru = readFileSync(join(packs, 'ru/person/male/diagnosis.txt'), 'utf8');
    expect(ru).not.toMatch(/Эндометрит|Цервицит/);
  });
});
