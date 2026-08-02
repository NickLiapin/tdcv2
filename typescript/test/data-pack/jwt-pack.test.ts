import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/lib/tdc.js';

/** Validity test for the migrated common.security.jwt pack. */

function render(count = 30, seed = 'jwt'): string[] {
  const config = [
    `<tdc><env count="${String(count)}" seed="${seed}">`,
    '  <sequence name="P"><gen type="template" value="common.security.jwt"/></sequence>',
    '</env><block><line><data>${{P}}</data></line></block></tdc>',
  ].join('\n');
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('common.security.jwt', () => {
  it('is three base64url segments with a valid decodable header', () => {
    const out = render();
    expect(out.length).toBe(30);
    for (const v of out) {
      const parts = v.split('.');
      expect(parts).toHaveLength(3);
      for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/);
      // The header decodes to a JWT header JSON.
      const header = JSON.parse(
        Buffer.from(parts[0] ?? '', 'base64url').toString('utf8'),
      ) as Record<string, unknown>;
      expect(header['typ']).toBe('JWT');
      expect(['HS256', 'HS384', 'HS512', 'RS256', 'ES256']).toContain(header['alg']);
      expect((parts[2] ?? '').length).toBe(43);
    }
  });
});
