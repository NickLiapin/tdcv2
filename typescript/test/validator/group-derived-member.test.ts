/**
 * A derived column inside a `<uniq>` or `<distinct>` group.
 *
 * The group is a REARRANGEMENT: it keeps each member's values and permutes the
 * columns until every record is unique. Sound for a drawn column — a draw means
 * the same wherever it lands — and destructive for a computed one, whose value
 * is a statement about the row it was computed for.
 *
 * Measured on the reference before this check existed, `<uniq>` over `A` (1..5)
 * and `F = A * 10`:
 *
 *     2|20   3|20   3|30   2|30   5|50
 *
 * Two rows of five say ten times three is twenty, and `check` called the config
 * valid. That is the defect this project keeps closing — the config states one
 * thing, the file says another, nothing warns.
 */

import { describe, expect, it } from 'vitest';

import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/index.js';

function diagnose(body: string): ReturnType<typeof validate>['diagnostics'] {
  const src =
    `<tdc><env count="5" seed="g" local="en">${body}</env>` +
    '<block><line><data>${{B}}</data></line></block></tdc>';
  return validate(parse(src).tree).diagnostics;
}

const OTHER = '<sequence name="B"><gen type="number" value="1..5"/></sequence>';

describe('a derived column may not be a group member', () => {
  it('refuses a formula inside <uniq>', () => {
    const d = diagnose(
      '<sequence name="A"><gen type="number" value="1..5"/></sequence>' +
        `<uniq><sequence name="F"><gen type="formula" expr="A * 10"/></sequence>${OTHER}</uniq>`,
    );
    const found = d.find((x) => x.code === 'TDC296');
    expect(found?.message).toContain('type="formula"');
    expect(found?.message).toContain('<uniq>');
  });

  it('refuses a running total inside <uniq>', () => {
    const d = diagnose(
      '<sequence name="A"><gen type="number" value="1..5"/></sequence>' +
        `<uniq><sequence name="R"><gen type="running" of="A" accumulate="sum"/></sequence>${OTHER}</uniq>`,
    );
    expect(d.some((x) => x.code === 'TDC296')).toBe(true);
  });

  it('refuses a date measured from another column, naming of=', () => {
    const d = diagnose(
      '<sequence name="D"><gen type="date" value="2026-01-01..2026-01-10"/></sequence>' +
        `<uniq><sequence name="E"><gen type="date" of="D" plus="1d"/></sequence>${OTHER}</uniq>`,
    );
    expect(d.find((x) => x.code === 'TDC296')?.message).toContain('of=');
  });

  it('refuses it inside <distinct> too', () => {
    const d = diagnose(
      '<sequence name="A"><gen type="number" value="1..5"/></sequence>' +
        `<distinct><sequence name="F"><gen type="formula" expr="A * 10"/></sequence>${OTHER}</distinct>`,
    );
    expect(d.find((x) => x.code === 'TDC296')?.message).toContain('<distinct>');
  });

  it('leaves a group of ordinary drawn columns alone', () => {
    const d = diagnose(
      `<uniq><sequence name="A"><gen type="number" value="1..50"/></sequence>${OTHER}</uniq>`,
    );
    expect(d.filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('leaves a derived column OUTSIDE the group alone', () => {
    // The way to write it: the group arranges what it draws, and the computed
    // column follows whatever the arrangement produced, so it stays true.
    const d = diagnose(
      `<uniq><sequence name="A"><gen type="number" value="1..50"/></sequence>${OTHER}</uniq>` +
        '<sequence name="F"><gen type="formula" expr="A * 10"/></sequence>',
    );
    expect(d.filter((x) => x.severity === 'error')).toEqual([]);
  });
});
