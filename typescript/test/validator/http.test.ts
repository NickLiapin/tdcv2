import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/index.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

/**
 * Everything about an http generator that can be caught before a run — see
 * docs/specs/2026-07-23-http-service-generator.md. The transport failures
 * (service down/slow/wrong) can only surface at render time and are covered by
 * the end-to-end tests, not here.
 */

function codes(seq: string): string[] {
  const src = `<tdc><env count="2" seed="s">${seq}</env><block><line><data>_</data></line></block></tdc>`;
  return [...validate(parse(src).tree).diagnostics].map((d: Diagnostic) => d.code ?? '');
}

describe('validator — http generator', () => {
  it('accepts a well-formed http generator', () => {
    const c = codes(
      '<sequence name="A"><gen type="http" src="http://127.0.0.1:5566/gen"/></sequence>',
    );
    expect(c.filter((x) => x.startsWith('TDC06'))).toEqual([]);
  });

  it('accepts in= that names an earlier sequence', () => {
    const c = codes(
      '<sequence name="First"><gen type="text" value="a,b"/></sequence>' +
        '<sequence name="A"><gen type="http" src="http://x/gen" in="First"/></sequence>',
    );
    expect(c).not.toContain('TDC067');
  });

  it('TDC065 when src is missing', () => {
    expect(codes('<sequence name="A"><gen type="http"/></sequence>')).toContain('TDC065');
  });

  it('TDC066 when src is not an http(s) URL', () => {
    expect(codes('<sequence name="A"><gen type="http" src="ftp://x/"/></sequence>')).toContain(
      'TDC066',
    );
    expect(
      codes('<sequence name="A"><gen type="http" src="127.0.0.1:5566"/></sequence>'),
    ).toContain('TDC066');
  });

  it('accepts https', () => {
    const c = codes(
      '<sequence name="A"><gen type="http" src="https://svc.example.com/gen"/></sequence>',
    );
    expect(c).not.toContain('TDC066');
  });

  it('TDC067 when in= names nothing declared', () => {
    expect(
      codes('<sequence name="A"><gen type="http" src="http://x/" in="Ghost"/></sequence>'),
    ).toContain('TDC067');
  });

  it('TDC067 when in= names a LATER sequence (declaration order matters)', () => {
    expect(
      codes(
        '<sequence name="A"><gen type="http" src="http://x/" in="Later"/></sequence>' +
          '<sequence name="Later"><gen type="text" value="a,b"/></sequence>',
      ),
    ).toContain('TDC067');
  });

  it('TDC068 when on_error is neither fail nor empty', () => {
    expect(
      codes('<sequence name="A"><gen type="http" src="http://x/" on_error="maybe"/></sequence>'),
    ).toContain('TDC068');
  });

  it('accepts on_error="fail" and "empty"', () => {
    for (const v of ['fail', 'empty']) {
      const c = codes(
        `<sequence name="A"><gen type="http" src="http://x/" on_error="${v}"/></sequence>`,
      );
      expect(c).not.toContain('TDC068');
    }
  });
});
