import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { clearPackCache, scanPacks } from '../../src/data-pack/index.js';

/**
 * A pack directory holds data files and metadata files side by side, and only
 * the data files are lists.
 *
 * The loader used to ignore extensions entirely — the spec said so, written
 * when a pack held nothing but data. Then `DATE_LOCALE.json` arrived, and
 * fifteen shipped locales silently grew an address whose values were the LINES
 * OF THE JSON SOURCE: `bn.DATE_LOCALE` drew `{`, `"months": [`, `"জানুয়ারি",`.
 * No diagnostic fired, because nothing was malformed — a file was read as a
 * list, which is exactly what the loader had been told to do with any file it
 * found. It reached the Quick API's generated type map too, so
 * `tdc.bn.DATE_LOCALE()` was a typed, autocompleted call returning a brace.
 *
 * The rule is an allowlist — `.txt` and `.tdc` — so the next metadata file to
 * be added does not have to remember to come here first.
 *
 * The roots below are shaped like the real one: the locale code is the
 * TOP-LEVEL DIRECTORY, because a pack is only registered when the first
 * segment of its address is a known locale, country or reserved bucket.
 */

function packDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'ext-pack-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  clearPackCache();
  return root;
}

const addresses = (root: string): string[] => [...scanPacks([root]).registry.keys()].sort();

const MANIFEST = '{"locale":"hu","name":"Hungarian"}\n';

describe('only .txt and .tdc are pack files', () => {
  it('does not turn a JSON metadata file into a drawable list', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/DATE_LOCALE.json': '{\n  "months": ["Január", "Február"]\n}\n',
      'hu/person/lastName.txt': 'Kovács\nNagy\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.person.lastName']);
  });

  it('keeps the JSON out no matter how deep it sits', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/person/male/NOTES.json': '{"a":1}\n',
      'hu/person/male/firstName.txt': 'László\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.person.male.firstName']);
  });

  it('still loads a .tdc generator, which is a pack file too', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/person/lastName.txt': 'Kovács\n',
      'hu/person/fullName.tdc':
        '---\ngenerator: tdc\n---\n<sequence name="p">\n' +
        '<gen name="l" type="template" value="hu.person.lastName"/>\n' +
        '</sequence>\n<data>${{p.l}}</data>\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.person.fullName', 'hu.person.lastName']);
  });

  // Distinct BASE names on purpose: had they all been `lastName`, a leak would
  // have collided onto the one address the test already expects and hidden
  // itself. Widening the allowlist must show up as extra keys.
  it('ignores an extension it does not know, and one with no extension at all', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/person/lastName.txt': 'Kovács\n',
      'hu/person/backup.bak': 'Nagy\n',
      'hu/person/export.csv': 'Nagy\n',
      'hu/person/Makefile': 'all:\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.person.lastName']);
  });

  it('matches the extension case-insensitively', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/person/lastName.TXT': 'Kovács\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.person.lastName']);
  });

  it('walks a DIRECTORY whose name carries a dot — the rule is for files only', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/person.v2/lastName.txt': 'Kovács\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.person.v2.lastName']);
  });

  // Separate defect, same file, found the same afternoon: a DECLARED address
  // that lands nowhere used to be rewritten by prefixing the header `locale:`.
  // Turkey's pack files each said `address: turkey.geo.city` and carried
  // `locale: tr` because their values are Turkish; with `turkey` missing from
  // CANONICAL_COUNTRIES they all loaded as `tr.turkey.geo.city` — country data
  // inside the Turkish LANGUAGE namespace, silently. The better a file was
  // labelled, the quieter it broke.
  it('never rewrites an address the author declared', () => {
    const root = packDir({
      'hu/_locale.json': MANIFEST,
      'hu/person/lastName.txt': 'Kovács\n',
      // `atlantis` is no country; the declared address must NOT become
      // `hu.atlantis.geo.city` just because the values are Hungarian.
      'hu/geo/city.txt': '---\naddress: atlantis.geo.city\nlocale: hu\n---\nBudapest\n',
    });
    const { registry, diagnostics } = scanPacks([root]);
    expect([...registry.keys()].sort()).toStrictEqual(['hu.person.lastName']);
    expect(diagnostics.map((d) => d.message).join(' ')).toContain('atlantis.geo.city');
  });

  it('still prefixes a PATH-derived address from the header locale', () => {
    const root = packDir({
      'loose/lastName.txt': '---\nlocale: hu\n---\nKovács\n',
    });
    expect(addresses(root)).toStrictEqual(['hu.loose.lastName']);
  });

  it('the shipped packs carry no DATE_LOCALE address', () => {
    clearPackCache();
    const { registry } = scanPacks([join(import.meta.dirname, '../../../data/packs')]);
    const leaked = [...registry.keys()].filter((a) => /DATE_LOCALE/i.test(a));
    expect(leaked).toStrictEqual([]);
    // Guard against the check passing because nothing was scanned at all.
    expect(registry.size).toBeGreaterThan(1000);
  });
});
