import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { pathToAddress, scanPacks } from '../../src/data-pack/load.js';

function tmpRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('pathToAddress', () => {
  it('derives a dotted address from the path relative to the root', () => {
    const root = '/data/packs';
    expect(pathToAddress(root, '/data/packs/es/person/male/firstName.txt')).toBe(
      'es.person.male.firstName',
    );
  });

  it('ignores the extension', () => {
    const root = '/r';
    expect(pathToAddress(root, '/r/colors.csv')).toBe('colors');
    expect(pathToAddress(root, '/r/a/b')).toBe('a.b');
  });
});

describe('scanPacks', () => {
  it('registers path-derived addresses from folder structure', () => {
    const root = tmpRoot('tdc-pack-path-');
    mkdirSync(join(root, 'ru', 'person', 'male'), { recursive: true });
    writeFileSync(join(root, 'ru', 'person', 'male', 'firstName.txt'), 'Ivan\nOleg\n', 'utf8');

    const { registry, diagnostics } = scanPacks([root]);
    expect(diagnostics).toEqual([]);
    const entry = registry.get('ru.person.male.firstName');
    expect(entry?.values).toEqual(['Ivan', 'Oleg']);
  });

  it('honors an explicit address in the header (override)', () => {
    const root = tmpRoot('tdc-pack-override-');
    // Loose file at the root, header declares a non-path address.
    writeFileSync(
      join(root, 'colors.txt'),
      ['---', 'description: Colours', 'address: common.color.name', '---', 'chrome', 'plasma'].join(
        '\n',
      ),
      'utf8',
    );

    const { registry, diagnostics } = scanPacks([root]);
    expect(diagnostics).toEqual([]);
    expect(registry.has('common.color.name')).toBe(true);
    // The path-derived address is NOT registered when overridden.
    expect(registry.has('colors')).toBe(false);
    expect(registry.get('common.color.name')?.description).toBe('Colours');
  });

  it('errors on two files resolving to the same address', () => {
    const root = tmpRoot('tdc-pack-dup-');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    // Both override to the same address.
    writeFileSync(
      join(root, 'a', 'x.txt'),
      ['---', 'address: ru.dup.addr', '---', 'v1'].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(root, 'b', 'y.txt'),
      ['---', 'address: ru.dup.addr', '---', 'v2'].join('\n'),
      'utf8',
    );

    const { diagnostics } = scanPacks([root]);
    const dup = diagnostics.find((d) => d.message.includes('duplicate data-pack address'));
    expect(dup).toBeDefined();
    expect(dup?.severity).toBe('error');
    expect(dup?.source).toBe('pack');
  });

  it('flags an empty list', () => {
    const root = tmpRoot('tdc-pack-empty-');
    mkdirSync(join(root, 'ru'), { recursive: true });
    writeFileSync(join(root, 'ru', 'empty.txt'), '\n\n', 'utf8');
    const { diagnostics } = scanPacks([root]);
    expect(diagnostics.some((d) => d.message.includes('has no values'))).toBe(true);
  });

  it('skips non-existent roots silently', () => {
    const { registry, diagnostics } = scanPacks(['/no/such/dir/hopefully']);
    expect(registry.size).toBe(0);
    expect(diagnostics).toEqual([]);
  });

  it('resolves an external file reference', () => {
    const root = tmpRoot('tdc-pack-ext-');
    mkdirSync(join(root, 'ru'), { recursive: true });
    writeFileSync(join(root, 'ru', 'surnames.txt'), 'Ivanov\nPetrov\n', 'utf8');
    writeFileSync(
      join(root, 'ru', 'ref.txt'),
      ['---', 'address: ru.person.lastName', 'file: ./surnames.txt', '---'].join('\n'),
      'utf8',
    );
    const { registry, diagnostics } = scanPacks([root]);
    // ref.txt -> external; surnames.txt -> its own path-derived address.
    expect(diagnostics).toEqual([]);
    expect(registry.get('ru.person.lastName')?.values).toEqual(['Ivanov', 'Petrov']);
  });
});

describe('locale manifests', () => {
  it('skips _locale.json as data and exposes it as a locale', () => {
    const root = tmpRoot('tdc-pack-manifest-');
    mkdirSync(join(root, 'ru', 'person'), { recursive: true });
    writeFileSync(join(root, 'ru', '_locale.json'), '{"code":"ru","direction":"ltr"}');
    writeFileSync(join(root, 'ru', 'person', 'lastName.txt'), 'Иванов\nПетров\n');

    const { registry, locales, diagnostics } = scanPacks([root]);

    expect(diagnostics).toEqual([]);
    expect(registry.has('ru.person.lastName')).toBe(true);
    expect(registry.has('ru._locale')).toBe(false); // manifest is not data
    expect(locales.get('ru')).toEqual({ code: 'ru', direction: 'ltr' });
  });
});

describe('countries grouping folder', () => {
  it('strips the countries/ segment — the country name is the first address part', () => {
    const root = tmpRoot('tdc-pack-country-');
    mkdirSync(join(root, 'countries', 'russia', 'vehicle'), { recursive: true });
    writeFileSync(join(root, 'countries', 'russia', 'vehicle', 'plate.txt'), 'A123BC\n');
    // Unknown country -> skipped (no error), like any non-known first segment.
    mkdirSync(join(root, 'countries', 'atlantis', 'tax'), { recursive: true });
    writeFileSync(join(root, 'countries', 'atlantis', 'tax', 'x.txt'), '1\n');

    const { registry, diagnostics } = scanPacks([root]);

    expect(diagnostics).toEqual([]);
    expect(registry.has('russia.vehicle.plate')).toBe(true);
    expect(registry.has('countries.russia.vehicle.plate')).toBe(false);
    expect(registry.has('atlantis.tax.x')).toBe(false); // unknown country -> skipped
  });
});

describe('first-segment rule', () => {
  it('does not register a file outside a locale folder as a pack (no error)', () => {
    const root = tmpRoot('tdc-pack-badloc-');
    mkdirSync(join(root, 'zz', 'person'), { recursive: true });
    writeFileSync(join(root, 'zz', 'person', 'name.txt'), 'A\nB\n');
    // A raw file at the root — the `@data` file-source pattern, not a pack.
    writeFileSync(join(root, 'statuses.txt'), 'new\npaid\n');

    const { registry, diagnostics } = scanPacks([root]);

    // Not locale-first -> not registered, and NOT an error (may be @data data).
    expect(registry.has('zz.person.name')).toBe(false);
    expect(registry.has('statuses')).toBe(false);
    expect(diagnostics).toEqual([]);
  });

  it('accepts common and known locales', () => {
    const root = tmpRoot('tdc-pack-goodloc-');
    mkdirSync(join(root, 'common', 'code'), { recursive: true });
    mkdirSync(join(root, 'es', 'person'), { recursive: true });
    writeFileSync(join(root, 'es', '_locale.json'), '{"code":"es","direction":"ltr"}');
    writeFileSync(join(root, 'common', 'code', 'currency.txt'), 'USD\nEUR\n');
    writeFileSync(join(root, 'es', 'person', 'lastName.txt'), 'García\n');

    const { registry, diagnostics } = scanPacks([root]);

    expect(diagnostics).toEqual([]);
    expect(registry.has('common.code.currency')).toBe(true);
    expect(registry.has('es.person.lastName')).toBe(true);
  });
});
