/**
 * What a `<pool>` member can see, and what a pool reference can be read for.
 *
 * A pool is built BEFORE any row exists, so its members read each other and
 * nothing from the run. Deferring the `if=` check to the end and resolving it
 * against the run's names got that wrong in both directions at once — and the
 * separate question of which dotted names a reference publishes was wrong in one.
 * Every "before" here was measured against the unfixed validator.
 */

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import { validate } from '../../src/validator/validate.js';

function codes(config: string): string[] {
  const parsed = parse(config);
  expect(parsed.diagnostics).toEqual([]);
  return validate(parsed.tree).diagnostics.map((d) => d.code ?? '?');
}

const SIBLING =
  '<tdc><env count="6" seed="po" local="en">' +
  '<pool name="Doctors" count="6">' +
  '<sequence name="role"><gen type="text" value="surgeon,nurse"/></sequence>' +
  '<sequence name="scalpel"><gen type="text" value="yes" if="role == surgeon"/></sequence>' +
  '<sequence name="name"><gen type="template" value="person.lastName"/></sequence>' +
  '</pool>' +
  '<sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>' +
  '</env><block><line><data>${{Seen.role}} s[${{Seen.scalpel}}]</data></line></block></tdc>';

const ENV_COLUMN =
  '<tdc><env count="6" seed="clinic" local="en">' +
  '<pool name="Doctors" count="6">' +
  '<sequence name="name"><gen type="template" value="person.lastName"/></sequence>' +
  '<sequence name="badge"><gen type="text" value="B" if="Age >= 18"/></sequence>' +
  '</pool>' +
  '<sequence name="Age"><gen type="number" value="1..10"/></sequence>' +
  '<sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>' +
  '</env><block><line><data>[${{Seen.badge}}]</data></line></block></tdc>';

const COMPOUND =
  '<tdc><env count="4" seed="cm" local="en">' +
  '<pool name="Doctors" count="4">' +
  '<sequence name="addr">' +
  '<gen type="text" value="city:"/>' +
  '<gen type="text" value="Rome,Paris" name="city"/>' +
  '</sequence>' +
  '<sequence name="name"><gen type="template" value="person.lastName"/></sequence>' +
  '</pool>' +
  '<sequence name="Seen"><gen type="pool" value="Doctors"/></sequence>' +
  '</env><block><line><data>c=[${{Seen.addr.city}}]</data></line></block></tdc>';

describe("a pool member's if= reads the pool, not the run", () => {
  it('accepts a sibling field', () => {
    // Before: TDC215, though the engine resolves it correctly — the deferred
    // check ran after the pool's own names had left scope.
    expect(codes(SIBLING)).toEqual([]);
  });

  it('and the engine agrees with the config', () => {
    const rows = new TDC({ configString: SIBLING }).toString().trimEnd().split('\n');
    for (const row of rows) {
      expect(row.startsWith('surgeon') ? row.endsWith('s[yes]') : row.endsWith('s[]')).toBe(true);
    }
  });

  it('refuses an env column', () => {
    // Before: valid — and then badge=[] on EVERY row, because the pool is built
    // before any row exists, so the condition is constant-false.
    expect(codes(ENV_COLUMN)).toContain('TDC215');
  });
});

describe('a compound member publishes its fields under the reference', () => {
  it('accepts Ref.member.field', () => {
    // Before: TDC193 "not a field of Seen", while a run printed Paris.
    expect(codes(COMPOUND)).toEqual([]);
  });

  it('and prints the value', () => {
    const rows = new TDC({ configString: COMPOUND }).toString().trimEnd().split('\n');
    for (const row of rows) expect(row).toMatch(/^c=\[(Rome|Paris)\]$/);
  });
});
