import { readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CANONICAL_COUNTRIES,
  CANONICAL_LOCALES,
  RESERVED_BUCKETS,
  resolvePackAddress,
} from '../../src/data-pack/locales.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * No pack category may be named the same as a locale or country code.
 *
 * The address resolver applies a locale-first rule: if the first segment of a
 * template address is a known locale, country or reserved bucket, the address
 * is ABSOLUTE and used unchanged. `fr.person.lastName` means the French pack,
 * whatever locale the config declares. That rule is deliberate and unambiguous,
 * and it has one consequence nobody checked: a CATEGORY whose name happens to
 * be a locale code can never be reached from inside a locale.
 *
 * `hr` was exactly that. Human resources — benefit, interviewStage, leaveType,
 * meetingType — collided with `hr`, the ISO code for Croatian. Every locale
 * shipped those four files and no config could ever draw from them: the
 * resolver read `hr.benefit` as "the Croatian pack, benefit list", which does
 * not exist. Sixteen locales, sixty-four dead files, and nothing anywhere said
 * so — the category was even listed in the expansion plan as something to grow.
 *
 * This test is the check that would have caught it on the first day.
 */

const here = dirname(fileURLToPath(import.meta.url));
const packsDir = resolve(here, '../../../data/packs');

/**
 * Every category directory inside a LOCALE pack, and which packs use it.
 *
 * Only locale packs matter here, because only their categories are reachable by
 * the SHORT address form. A config declaring `local="en"` writes
 * `person.lastName`, and the resolver prepends the locale. Country packs are
 * addressed `poland.docs.pesel` and the `common` bucket `common.id.nanoid` —
 * head first, always absolute, so a category inside either one can be called
 * anything at all. `common/id/` is exactly that case: it holds nanoid and uuid,
 * it declares `address: common.id.nanoid` in its own header, and it is not a
 * collision even though `id` became a locale code when Indonesian was added.
 */
function everyCategory(): Map<string, string[]> {
  const categories = new Map<string, string[]>();
  for (const pack of readdirSync(packsDir)) {
    if (!CANONICAL_LOCALES.has(pack)) continue;
    const packPath = join(packsDir, pack);
    if (!statSync(packPath).isDirectory()) continue;
    for (const entry of readdirSync(packPath)) {
      if (!statSync(join(packPath, entry)).isDirectory()) continue;
      const packs = categories.get(entry) ?? [];
      packs.push(pack);
      categories.set(entry, packs);
    }
  }
  return categories;
}

describe('a pack category must not shadow a locale or country code', () => {
  it('has no category named the same as a locale, country or reserved bucket', () => {
    const shadowed: string[] = [];
    for (const [category, packs] of everyCategory()) {
      const collides =
        CANONICAL_LOCALES.has(category) ||
        CANONICAL_COUNTRIES.has(category) ||
        RESERVED_BUCKETS.has(category);
      if (collides) {
        shadowed.push(
          `"${category}" is a locale/country code and is used as a category in ${String(packs.length)} pack(s): ${packs.slice(0, 5).join(', ')}`,
        );
      }
    }
    expect(
      shadowed,
      `these categories can never be addressed from inside a locale:\n  ${shadowed.join('\n  ')}`,
    ).toEqual([]);
  });

  /**
   * The mechanism itself, stated once so the reason above is not just a
   * comment. A category name that is also a locale code resolves to the OTHER
   * locale, not to a category in this one.
   */
  it('resolves a locale-shaped first segment as an absolute address', () => {
    expect(resolvePackAddress('person.lastName', 'en')).toBe('en.person.lastName');
    expect(resolvePackAddress('fr.person.lastName', 'en')).toBe('fr.person.lastName');
    // The trap: 'hr' is Croatian, so this never means "the hr category of en".
    expect(CANONICAL_LOCALES.has('hr')).toBe(true);
    expect(resolvePackAddress('hr.benefit', 'en')).toBe('hr.benefit');
  });

  /**
   * And the end-to-end proof: every category present in the English pack must
   * actually render through the engine. A category that loads from disk but
   * cannot be drawn is the failure this whole file is about, and only a real
   * draw shows it.
   */
  it('can draw one value from every category in the en pack', () => {
    const enDir = join(packsDir, 'en');
    const unreachable: string[] = [];
    for (const category of readdirSync(enDir)) {
      if (!statSync(join(enDir, category)).isDirectory()) continue;
      // Find the first plain list file directly inside the category.
      const file = readdirSync(join(enDir, category)).find((f) => f.endsWith('.txt'));
      if (file === undefined) continue;
      const address = `${category}.${file.replace(/\.txt$/, '')}`;
      const cfg =
        `<tdc><env count="1" seed="reach" local="en">` +
        `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
        `</env><block><line><data>\${{P}}</data></line></block></tdc>`;
      try {
        const out = new TDC({ configString: cfg }).toString().trim();
        if (out === '') unreachable.push(`${address} rendered empty`);
      } catch (error) {
        unreachable.push(`${address}: ${String(error).split('\n')[0] ?? ''}`);
      }
    }
    expect(unreachable, `unreachable categories:\n  ${unreachable.join('\n  ')}`).toEqual([]);
  });
});
