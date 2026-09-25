/**
 * Where a derived column and a pool reference may stand.
 *
 * A `<gen>` can be a whole `<sequence>`, one of its `if=` branches or the fallback
 * after them, the body of a `<case>`, an unnamed part of a composed sequence, or a
 * named field. Before this rule, every place but the first two let these types
 * through `check` and then broke the run: a date offset silently lost `of=` and
 * drew an unrelated date, a pool reference printed `${{Ref.field}}` as literal
 * text, and the rest stopped with `gen type "…" not yet supported`. The table
 * below is the whole rule, one row per place and type.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

const ABOVE =
  '<pool name="P" count="3"><sequence name="n"><gen type="number" value="1..9"/></sequence></pool>' +
  '<sequence name="N"><gen type="number" value="1..9"/></sequence>' +
  '<sequence name="D"><gen type="date" value="2020-01-01..2020-12-31" format="YYYY-MM-DD"/></sequence>' +
  '<sequence name="K"><gen type="text" value="a,b"/></sequence>';

const GENS = {
  formula: '<gen type="formula" expr="N * 2"/>',
  offset: '<gen type="date" of="D" plus="1d" format="YYYY-MM-DD"/>',
  running: '<gen type="running" of="N" accumulate="sum"/>',
  stat: '<gen type="stat" of="N" op="mean"/>',
  prev: '<gen type="formula" expr="prev(N, 0) + 1"/>',
  pool: '<gen type="pool" value="P"/>',
} as const;
type Kind = keyof typeof GENS;

/** The same `<gen>`, placed. `if=` goes on the gen itself for the conditional form. */
const PLACES = {
  case: (g: string) => `<mix name="C"><case><data>x</data></case><case>${g}</case></mix>`,
  switchDefault: (g: string) =>
    `<switch name="C" on="K"><case is="a"><data>x</data></case><default>${g}</default></switch>`,
  nestedCase: (g: string) =>
    `<mix name="C"><case><switch on="K"><case is="a">${g}</case></switch></case></mix>`,
  ifBranch: (g: string) =>
    `<sequence name="C">${g.replace('<gen ', '<gen if="K == a" ')}<gen type="text" value="-"/></sequence>`,
  fallback: (g: string) =>
    `<sequence name="C"><gen if="K == a" type="text" value="-"/>${g}</sequence>`,
  part: (g: string) => `<sequence name="C"><data>id-</data>${g}</sequence>`,
  field: (g: string) => `<sequence name="C">${g.replace('<gen ', '<gen name="f" ')}</sequence>`,
} as const;
type Place = keyof typeof PLACES;

function codesFor(kind: Kind, place: Place): string[] {
  const src =
    `<tdc><env count="4" seed="p" local="en">${ABOVE}${PLACES[place](GENS[kind])}</env>` +
    '<block><line><data>${{N}}</data></line></block></tdc>';
  return validate(parse(src).tree)
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.code ?? ''} ${d.message}`);
}

const ROW_LOCAL: readonly Kind[] = ['formula', 'offset'];
const WHOLE_RUN: readonly Kind[] = ['running', 'stat', 'prev'];
const BRANCHES: readonly Place[] = ['case', 'switchDefault', 'nestedCase', 'ifBranch', 'fallback'];
const RECORD: readonly Place[] = ['part', 'field'];

describe('a formula or a date offset in a branch', () => {
  for (const kind of ROW_LOCAL) {
    for (const place of BRANCHES) {
      it(`${kind} is accepted in ${place}`, () => {
        expect(codesFor(kind, place)).toEqual([]);
      });
    }
    for (const place of RECORD) {
      it(`${kind} is refused as a ${place} of a record (TDC295)`, () => {
        const [only, ...rest] = codesFor(kind, place);
        expect(rest).toEqual([]);
        expect(only).toMatch(/^TDC295 .* is computed from other columns, so it cannot be/);
      });
    }
  }
});

describe('a whole-column construct anywhere but a whole sequence', () => {
  for (const kind of WHOLE_RUN) {
    for (const place of [...BRANCHES, ...RECORD]) {
      it(`${kind} is refused in ${place} (TDC295)`, () => {
        const [only, ...rest] = codesFor(kind, place);
        expect(rest).toEqual([]);
        expect(only).toMatch(/^TDC295 .* is built for the whole run, so it cannot /);
      });
    }
  }

  it('keeps the if= sentence it always had', () => {
    expect(codesFor('running', 'ifBranch')).toEqual([
      'TDC295 a type="running" column is built for the whole run, so it cannot carry if=',
    ]);
  });

  it('names prev() as the reason a formula is a whole column', () => {
    expect(codesFor('prev', 'case')).toEqual([
      'TDC295 a type="formula" column that reads prev() is built for the whole run, so it ' +
        'cannot sit inside a <case>',
    ]);
  });
});

describe('a pool reference anywhere but a whole sequence', () => {
  for (const place of [...BRANCHES, ...RECORD]) {
    it(`is refused in ${place} (TDC268)`, () => {
      const [only, ...rest] = codesFor('pool', place);
      expect(rest).toEqual([]);
      expect(only).toMatch(/^TDC268 /);
    });
  }
});
