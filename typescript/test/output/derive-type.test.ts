/**
 * Deriving a column type from the generator that feeds it, when `type=` is
 * absent. Safety rule: when we cannot tell confidently, return undefined so the
 * caller falls back to text — a string never corrupts data.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §4.
 */

import { describe, expect, it } from 'vitest';

import {
  deriveColumnType,
  deriveOutputColumnType,
  repeatSeparatorOf,
  soleReference,
} from '../../src/output/derive-type.js';
import { parseStrict } from '../../src/parser/index.js';
import { elementKind, elementName, findChildElement } from '../../src/processor/walk.js';
import { extractSequenceSpecs } from '../../src/sequence/index.js';

/** Parse a config and hand back the sequence specs declared in its <env>. */
function specsOf(envBody: string) {
  const doc = parseStrict(
    `<tdc><env count="2" seed="s">${envBody}</env>` +
      `<block><line><data>x</data></line></block></tdc>`,
  );
  for (const el of doc.element()) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === 'tdc') {
      return extractSequenceSpecs(findChildElement(k.node.content(), 'env'));
    }
  }
  throw new Error('no <tdc> in test config');
}

describe('soleReference', () => {
  it('finds the single referenced sequence', () => {
    expect(soleReference('${{Id}}', '${{%}}')).toBe('Id');
    expect(soleReference('  ${{ Id }}  ', '${{%}}')).toBe('Id');
  });

  it('returns undefined for composite templates', () => {
    expect(soleReference('id=${{Id}}', '${{%}}')).toBeUndefined();
    expect(soleReference('${{A}}${{B}}', '${{%}}')).toBeUndefined();
    expect(soleReference('plain text', '${{%}}')).toBeUndefined();
  });

  it('honours a custom inject marker', () => {
    expect(soleReference('[Id]', '[%]')).toBe('Id');
  });
});

describe('deriveColumnType', () => {
  it('number without decimals is int64, with decimals is double', () => {
    const specs = specsOf(
      '<sequence name="A"><gen type="number" value="1..9"/></sequence>' +
        '<sequence name="B"><gen type="number" value="1..9" decimals="2"/></sequence>',
    );
    expect(deriveColumnType('A', specs)).toEqual({ kind: 'int64', nullable: false });
    expect(deriveColumnType('B', specs)).toEqual({ kind: 'double', nullable: false });
  });

  it('counters are int64', () => {
    const specs = specsOf('<sequence name="C"><gen type="increment" value="1"/></sequence>');
    expect(deriveColumnType('C', specs)).toEqual({ kind: 'int64', nullable: false });
  });

  it('missing= makes the column nullable', () => {
    const specs = specsOf(
      '<sequence name="M"><gen type="number" value="1..9" missing="0.3"/></sequence>',
    );
    expect(deriveColumnType('M', specs)).toEqual({ kind: 'int64', nullable: true });
  });

  it('an anomaly_flag column is a bool', () => {
    const specs = specsOf(
      '<sequence name="R"><gen type="number" value="1..9" anomaly="0.2" anomaly_flag="Flag"/></sequence>',
    );
    expect(deriveColumnType('Flag', specs)).toEqual({ kind: 'bool', nullable: false });
  });

  it('a uuid template is a uuid column', () => {
    const specs = specsOf(
      '<sequence name="K"><gen type="template" value="common.id.uuid"/></sequence>',
    );
    expect(deriveColumnType('K', specs)).toEqual({ kind: 'uuid', nullable: false });
  });

  it('a date is only inferred when the config asked for ISO output', () => {
    const iso = specsOf(
      '<sequence name="D"><gen type="date" range="1990-01-01..2000-01-01" format="YYYY-MM-DD"/></sequence>',
    );
    expect(deriveColumnType('D', iso)).toEqual({ kind: 'date', nullable: false });

    // Default rendering is locale-shaped (05/25/1996), so we must NOT claim date.
    const dflt = specsOf(
      '<sequence name="D"><gen type="date" range="1990-01-01..2000-01-01"/></sequence>',
    );
    expect(deriveColumnType('D', dflt)).toBeUndefined();
  });

  it('mask=/case= rewrite the text, so no numeric type is claimed', () => {
    const specs = specsOf(
      '<sequence name="N"><gen type="number" value="1..9" mask="x-x"/></sequence>',
    );
    expect(deriveColumnType('N', specs)).toBeUndefined();
  });

  it('returns undefined for anything it cannot tell', () => {
    const specs = specsOf('<sequence name="T"><gen type="text" value="a,b"/></sequence>');
    expect(deriveColumnType('T', specs)).toBeUndefined();
    expect(deriveColumnType('Nope', specs)).toBeUndefined();
  });
});

/**
 * Modelling outliers as a rare `<mix>` branch is the natural way to say
 * "usually 50..65, once in a while 120". Before this, such a column fell back
 * to text — so the flagship anomaly config produced string values next to a
 * boolean label. A mix derives a type only when every branch agrees.
 */
describe('deriveColumnType — <mix>', () => {
  const mix = (cases: string, attrs = '') =>
    specsOf(`<mix name="M" percent="80,20"${attrs}>${cases}</mix>`);

  it('derives the shared type when every case agrees', () => {
    const specs = mix(
      '<case><gen type="number" value="50..65"/></case>' +
        '<case anomaly="true"><gen type="number" value="118..122"/></case>',
      ' flag="Bad"',
    );
    expect(deriveColumnType('M', specs)?.kind).toBe('int64');
  });

  it('the flag companion is a bool', () => {
    const specs = mix(
      '<case><gen type="number" value="1..9"/></case>' +
        '<case anomaly="true"><gen type="number" value="90..99"/></case>',
      ' flag="Bad"',
    );
    expect(deriveColumnType('Bad', specs)?.kind).toBe('bool');
  });

  it('falls back to text when the branches disagree', () => {
    const specs = mix(
      '<case><gen type="number" value="1..9"/></case>' +
        '<case><gen type="text" value="n/a"/></case>',
    );
    expect(deriveColumnType('M', specs)).toBeUndefined();
  });

  it('falls back to text when a case is not a single <gen>', () => {
    const specs = mix(
      '<case><data>#</data><gen type="number" value="1..9"/></case>' +
        '<case><gen type="number" value="1..9"/></case>',
    );
    expect(deriveColumnType('M', specs)).toBeUndefined();
  });

  it('nullability must agree too, not just the kind', () => {
    const specs = mix(
      '<case><gen type="number" value="1..9"/></case>' +
        '<case><gen type="number" value="1..9" missing="0.5"/></case>',
    );
    expect(deriveColumnType('M', specs)).toBeUndefined();
  });
});

/**
 * A repeating gen puts a LIST in the cell, so the column is a list of whatever
 * a single value would have been — and the separator travels with it, so the
 * text view and the typed view agree on where each value ends.
 */
describe('deriveOutputColumnType — repeat', () => {
  const repeating = (attrs: string) =>
    specsOf(`<sequence name="R"><gen type="number" value="1..9" ${attrs}/></sequence>`);

  it('wraps the element type in a list', () => {
    expect(deriveOutputColumnType('R', repeating('repeat="2..3"'))).toEqual({
      kind: 'list',
      element: { kind: 'int64', nullable: false },
    });
  });

  it('missing= makes the ELEMENT nullable, not the list', () => {
    expect(deriveOutputColumnType('R', repeating('repeat="3" missing="0.3"'))).toEqual({
      kind: 'list',
      element: { kind: 'int64', nullable: true },
    });
  });

  it('without repeat it stays the plain scalar', () => {
    expect(deriveOutputColumnType('R', repeating(''))).toEqual({ kind: 'int64', nullable: false });
  });

  it('reports the separator only for a repeating gen', () => {
    expect(repeatSeparatorOf('R', repeating('repeat="3"'))).toBe(',');
    expect(repeatSeparatorOf('R', repeating('repeat="3" separator=" | "'))).toBe(' | ');
    expect(repeatSeparatorOf('R', repeating(''))).toBeUndefined();
  });

  it('an untellable element becomes []string — the list-ness is still known', () => {
    // A default-formatted date is not ISO, so the ELEMENT type is unsafe to
    // claim. The column is still a list: `repeat` says so outright, and
    // collapsing it to one comma-joined string would discard real structure.
    const specs = specsOf(
      '<sequence name="R"><gen type="date" range="1990-01-01..2000-01-01" repeat="2"/></sequence>',
    );
    expect(deriveOutputColumnType('R', specs)).toEqual({
      kind: 'list',
      element: { kind: 'string', nullable: false },
    });
  });

  it('a text list becomes []string rather than a joined string', () => {
    const specs = specsOf(
      '<sequence name="R"><gen type="text" value="a,b" repeat="2"/></sequence>',
    );
    expect(deriveOutputColumnType('R', specs)).toEqual({
      kind: 'list',
      element: { kind: 'string', nullable: false },
    });
  });

  it('missing= on an untellable element still makes the element nullable', () => {
    const specs = specsOf(
      '<sequence name="R"><gen type="text" value="a,b" repeat="2" missing="0.5"/></sequence>',
    );
    expect(deriveOutputColumnType('R', specs)).toEqual({
      kind: 'list',
      element: { kind: 'string', nullable: true },
    });
  });
});
