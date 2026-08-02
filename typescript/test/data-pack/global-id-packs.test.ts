import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/**
 * Format-validity tests for the global technical/id/hash presets migrated from
 * `src/presets/global/{technical,security}.ts` into bundled `common.*` pack
 * generators. Each address renders through the normal bundled-pack path (no
 * dataPaths) and every row is asserted against the correct output FORMAT for
 * that standard — the contract is shape validity, not byte-equality with the
 * old code.
 */

function render(address: string, count = 30, seed = 's'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>`,
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

/** Assert every rendered row matches `re` and that the batch is non-empty. */
function expectAll(address: string, re: RegExp): string[] {
  const rows = render(address);
  expect(rows.length).toBe(30);
  for (const row of rows) expect(row, `${address} -> "${row}"`).toMatch(re);
  return rows;
}

describe('bundled global id/technical/hash packs (common.*)', () => {
  it('common.id.uuid -> UUID v4 shape', () => {
    expectAll(
      'common.id.uuid',
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('common.id.ulid -> 26-char Crockford base32', () => {
    expectAll('common.id.ulid', /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  });

  it('common.id.nanoid -> 21 URL-safe chars', () => {
    expectAll('common.id.nanoid', /^[0-9A-Za-z_-]{21}$/);
  });

  it('common.id.object_id -> 24 lowercase hex', () => {
    expectAll('common.id.object_id', /^[0-9a-f]{24}$/);
  });

  it('common.internet.username -> letter + 7-13 word chars', () => {
    expectAll('common.internet.username', /^[a-z][a-z0-9_]{7,13}$/);
  });

  it('common.internet.domain -> word-token.suffix (safe TLD)', () => {
    expectAll('common.internet.domain', /^[a-z]+-[a-z0-9]{6}\.(?:example|invalid|test)$/);
  });

  it('common.internet.slug -> 2-4 hyphenated words', () => {
    const words = 'alpha|atlas|demo|fixture|sample|sandbox|synthetic|test';
    expectAll('common.internet.slug', new RegExp(`^(?:${words})(?:-(?:${words})){1,3}$`));
  });

  it('common.internet.email -> local@safe-domain', () => {
    expectAll(
      'common.internet.email',
      /^[a-z][a-z0-9_]{9}@[a-z]+-[a-z0-9]{6}\.(?:example|invalid|test)$/,
    );
  });

  it('common.internet.url -> https://domain/slug', () => {
    expectAll(
      'common.internet.url',
      /^https:\/\/[a-z]+-[a-z0-9]{6}\.(?:example|invalid|test)\/[a-z-]+$/,
    );
  });

  it('common.internet.ipv4 -> private range, octets <= 255', () => {
    const rows = expectAll('common.internet.ipv4', /^(?:10|172|192)\.\d{1,3}\.\d{1,3}\.\d{1,3}$/);
    for (const row of rows) {
      const octets = row.split('.').map(Number);
      expect(octets).toHaveLength(4);
      for (const o of octets) expect(o).toBeGreaterThanOrEqual(0);
      for (const o of octets) expect(o).toBeLessThanOrEqual(255);
      // Private-range prefixes the old generator emitted.
      const [a, b] = octets as [number, number, number, number];
      const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      expect(isPrivate, `${row} not in a private range`).toBe(true);
    }
  });

  it('common.internet.ipv6 -> 2001:db8 documentation range', () => {
    expectAll('common.internet.ipv6', /^2001:db8(?::[0-9a-f]{1,4}){6}$/);
  });

  it('common.internet.mac -> six colon-separated hex octets', () => {
    expectAll('common.internet.mac', /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/);
  });

  it('common.system.semver -> major.minor.patch', () => {
    const rows = expectAll('common.system.semver', /^\d+\.\d+\.\d+$/);
    for (const row of rows) {
      const [major, minor, patch] = row.split('.').map(Number) as [number, number, number];
      expect(major).toBeLessThanOrEqual(9);
      expect(minor).toBeLessThanOrEqual(19);
      expect(patch).toBeLessThanOrEqual(99);
    }
  });

  it('common.git.sha -> 40 lowercase hex', () => {
    expectAll('common.git.sha', /^[0-9a-f]{40}$/);
  });

  it('common.security.sha256 -> 64 lowercase hex', () => {
    expectAll('common.security.sha256', /^[0-9a-f]{64}$/);
  });

  it('common.security.sha1 -> 40 lowercase hex', () => {
    expectAll('common.security.sha1', /^[0-9a-f]{40}$/);
  });

  it('common.security.md5 -> 32 lowercase hex', () => {
    expectAll('common.security.md5', /^[0-9a-f]{32}$/);
  });

  it('is deterministic for a fixed seed', () => {
    expect(render('common.id.uuid', 20, 'x')).toEqual(render('common.id.uuid', 20, 'x'));
    expect(render('common.internet.url', 20, 'x')).toEqual(render('common.internet.url', 20, 'x'));
  });
});
