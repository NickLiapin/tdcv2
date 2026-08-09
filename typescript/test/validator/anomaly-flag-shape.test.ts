/**
 * Where `anomaly_flag=` mints a column, and where it used to mint nothing.
 *
 * A sequence publishes the ground-truth column only when the gen carrying the
 * flag IS the sequence's value. Give the sequence a second part — another gen, a
 * `<data>` literal, or a `name=` that turns the gen into a field — and the
 * engine minted no column at all: `check` called the config valid, the anomaly
 * fired (the values came out perturbed), and `${{NAME}}` reached the output as
 * its own literal text on every row.
 *
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

function config(body: string, printed: string): string {
  return (
    '<tdc><env count="4" seed="af" local="en">' +
    `<sequence name="Rec">${body}</sequence>` +
    `</env><block><line><data>[${printed}] f=\${{F}}</data></line></block></tdc>`
  );
}

const FLAGGED = 'anomaly="0.5" anomaly_flag="F"';

const SIMPLE = config(`<gen type="number" value="10..99" ${FLAGGED}/>`, '${{Rec}}');
const COMPOUND = config(
  `<gen type="number" value="10..99" name="amt" ${FLAGGED}/>`,
  '${{Rec.amt}}',
);
const WITH_LITERAL = config(
  `<data>n=</data><gen type="number" value="10..99" ${FLAGGED}/>`,
  '${{Rec}}',
);
const TWO_GENS = config(
  `<gen type="text" value="x-"/><gen type="number" value="10..99" ${FLAGGED}/>`,
  '${{Rec}}',
);

const CONDITIONAL =
  '<tdc><env count="6" seed="af" local="en">' +
  '<sequence name="Kind"><gen type="text" value="a,b"/></sequence>' +
  '<sequence name="Amount">' +
  `<gen type="number" value="10..99" if="Kind == a" ${FLAGGED}/>` +
  '<gen type="number" value="1..9"/>' +
  '</sequence>' +
  '</env><block><line><data>${{Amount}} f=${{F}}</data></line></block></tdc>';

describe('the flag needs a sequence whose value is this gen', () => {
  it('a simple body mints the column', () => {
    expect(codes(SIMPLE)).toEqual([]);
    for (const row of new TDC({ configString: SIMPLE }).toString().trimEnd().split('\n')) {
      expect(row).toMatch(/^\[\d+] f=(true|false)$/);
    }
  });

  it('and so does a conditional one', () => {
    expect(codes(CONDITIONAL)).toEqual([]);
    for (const row of new TDC({ configString: CONDITIONAL }).toString().trimEnd().split('\n')) {
      expect(row).toMatch(/^\d+ f=(true|false)$/);
    }
  });
});

describe('a gen that is only one part of its sequence', () => {
  it('refuses a named field', () => {
    // Before: valid, and then `${{F}}` printed literally on every row.
    expect(codes(COMPOUND)).toEqual(['TDC283']);
  });

  it('refuses a body carrying a <data> literal', () => {
    expect(codes(WITH_LITERAL)).toEqual(['TDC283']);
  });

  it('refuses a body of two gens', () => {
    expect(codes(TWO_GENS)).toEqual(['TDC283']);
  });

  it('still declares the name, so the refusal is not doubled', () => {
    // The reader gets one error about the flag, not that plus a TDC193
    // sending them after `${{F}}` as though it were a typo.
    expect(codes(COMPOUND)).not.toContain('TDC193');
  });
});
