import { describe, expect, it } from 'vitest';

import { bundledPacks, packParameterNames } from '../../src/data-pack/index.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

/**
 * A generator pack's parameters are the names of the `<sequence>`s in its body.
 * Anything else passed to it was accepted in silence and did nothing — which is
 * how a whole documented feature turned out never to have existed:
 * `format="formatted"`, `country="GB"`, `length="30"`, `algorithm="HS256"` and
 * a dozen more return byte-identical output with the attribute, without it, and
 * with a nonsense value.
 *
 * The risk in this check is the opposite direction, so these tests weigh
 * heavily toward "does a WORKING parameter still work".
 */

const packs = bundledPacks();
const params = packParameterNames(packs);

function codes(gen: string): (string | undefined)[] {
  const src =
    `<tdc><env count="1" seed="demo"><sequence name="X">${gen}</sequence></env>` +
    `<block><line><data>\${{X}}</data></line></block></tdc>`;
  const p = parse(src);
  expect(p.diagnostics, `should parse cleanly: ${gen}`).toEqual([]);
  return validate(p.tree, {
    packAddresses: [...packs.keys()],
    packParams: params,
  }).diagnostics.map((d) => d.code);
}

describe('template pack parameters', () => {
  it('reports an attribute the pack cannot act on (TDC072)', () => {
    expect(codes('<gen type="template" value="common.phone.e164" country="GB"/>')).toContain(
      'TDC072',
    );
    expect(codes('<gen type="template" value="brazil.tax.cpf" format="formatted"/>')).toContain(
      'TDC072',
    );
    expect(codes('<gen type="template" value="common.id.nanoid" length="30"/>')).toContain(
      'TDC072',
    );
    expect(codes('<gen type="template" value="common.security.jwt" algorithm="HS256"/>')).toContain(
      'TDC072',
    );
  });

  it('accepts a parameter the pack really declares', () => {
    expect(codes('<gen type="template" value="russia.tax.inn_org" tax_office="7712"/>')).toEqual(
      [],
    );
    expect(codes('<gen type="template" value="chile.tax.rut" body="7654321"/>')).toEqual([]);
    expect(codes('<gen type="template" value="common.internet.email" domain="x.test"/>')).toEqual(
      [],
    );
  });

  it('accepts the engine-level wrappers on any pack', () => {
    for (const attr of [
      'missing="0.1"',
      'repeat="1..3" separator=","',
      'mask="xxx"',
      'case="upper"',
      'anomaly="0.05" anomaly_flag="F"',
    ]) {
      expect(codes(`<gen type="template" value="brazil.tax.cpf" ${attr}/>`)).toEqual([]);
    }
  });

  it('checks a locale-relative address too, the way the engine resolves it', () => {
    // `person.male.firstName` under `en` IS the pack `en.person.male.firstName`.
    // Looking up only the literal text left every locale-relative address
    // unchecked, so the same mistake was caught on `common.…` and waved through
    // here — and the four ports, which resolve the locale, refused what this
    // accepted.
    expect(codes('<gen type="template" value="person.male.firstName" whatever="x"/>')).toContain(
      'TDC072',
    );
  });

  it('says nothing about parameters when the address resolves nowhere', () => {
    // The address itself is the complaint (TDC071); guessing at its parameters
    // would produce exactly the false errors this check must never create.
    expect(codes('<gen type="template" value="nosuch.path.at.all" whatever="x"/>')).not.toContain(
      'TDC072',
    );
  });

  it('a plain list of values has no parameters, and says so', () => {
    // Not a generator at all, so an attribute aimed at one does nothing — which
    // is indistinguishable from a typo, and is the whole point of the check.
    expect(codes('<gen type="template" value="person.lastName" domain="x"/>')).toContain('TDC072');
  });

  /**
   * The property that matters most: every parameter a pack declares must pass.
   * Generated from the registry, so a pack gaining a parameter cannot silently
   * fall outside the allowance.
   */
  it('accepts every declared parameter of every bundled generator pack', () => {
    const offenders: string[] = [];
    for (const [address, names] of params) {
      for (const name of names) {
        const found = codes(`<gen type="template" value="${address}" ${name}="1"/>`);
        if (found.includes('TDC072')) offenders.push(`${address}.${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
