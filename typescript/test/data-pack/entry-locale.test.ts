/**
 * A registry entry's `locale` is the locale a run finds it in.
 *
 * It used to be copied from the file's `locale:` header and nothing else, and
 * 498 bundled packs have no such line — `ru.person.lastName` among them — so
 * the registry said they belonged to no locale while every run found them in
 * `ru`. A tool asking which locales carry a path then advised installing a
 * pack that was already installed.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { bundledPacksDir, scanPacks } from '../../src/index.js';

function packTree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tdc-entry-locale-'));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

describe("a pack entry's locale", () => {
  it('is the locale folder its address starts with when the header names none', () => {
    const root = packTree({ 'ru/person/lastName.txt': 'Иванов\nПетров\n' });
    expect(scanPacks([root]).registry.get('ru.person.lastName')?.locale).toBe('ru');
  });

  it('is the folder a run finds it in, even when the header says otherwise', () => {
    const root = packTree({
      'ne/geo/currency.txt': '---\ndescription: a code\nlocale: en\n---\nNPR\n',
    });
    expect(scanPacks([root]).registry.get('ne.geo.currency')?.locale).toBe('ne');
  });

  it("is the header's for a flat folder the header places in a locale", () => {
    const root = packTree({ 'mylists/colour.txt': '---\nlocale: ru\n---\nкрасный\n' });
    expect(scanPacks([root]).registry.get('ru.mylists.colour')?.locale).toBe('ru');
  });

  it('is absent for a pack outside every locale with no header to say one', () => {
    const root = packTree({ 'common/thing/code.txt': 'A1\nB2\n' });
    expect(scanPacks([root]).registry.get('common.thing.code')?.locale).toBeUndefined();
  });

  it('matches the locale folder for every bundled pack that lives in one', () => {
    const root = bundledPacksDir();
    expect(root).toBeDefined();
    const { registry, locales } = scanPacks([root ?? '']);
    const off: string[] = [];
    let checked = 0;
    for (const [address, entry] of registry) {
      const folder = relative(root ?? '', entry.sourceFile).split(sep)[0] ?? '';
      if (!locales.has(folder)) continue;
      checked++;
      if (entry.locale !== folder) off.push(`${address}: ${String(entry.locale)}`);
    }
    expect(checked).toBeGreaterThan(1000);
    expect(off.slice(0, 5)).toEqual([]);
  });
});
