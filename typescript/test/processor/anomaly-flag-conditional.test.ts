/**
 * `anomaly_flag="NAME"` on a `<gen>` that also carries `if=`.
 *
 * Nick's case is three classes of customer, each with its own range of basket
 * value, and one shared ground-truth column saying which rows were turned into
 * outliers. Written the obvious way — a `<gen if=…>` per class, all naming the
 * same `anomaly_flag` — the column was never created at all. Nothing said so:
 * `check` reported the config valid, TDC193 stayed quiet on the half-registered
 * name, and `${{Flag}}` was written into the data as eight literal characters.
 *
 * ── What these tests are for ─────────────────────────────────────────────────
 * The flag is only worth having if it agrees with the value it describes, so
 * none of these tests read the flag alone. `anomaly_factor="1000"` against a
 * 1..3 draw makes a spike unmistakable, and every assertion checks the flag
 * against the VALUE on that row — a test that cannot pass by minting a column
 * of plausible booleans.
 *
 * The three situations a conditional flag has to answer for:
 *   1. every branch flagged      -> true/false tracks the spike, whichever branch won
 *   2. one branch flagged        -> the unflagged branch's rows are covered, so `false`
 *   3. no branch matched the row -> not covered at all, so empty, like the value
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const N = 400;

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

/** `Class|Value|Flag` per row, split. */
const rows = (doc: string, opts: RenderOptions): { cls: string; value: string; flag: string }[] =>
  render(parseStrict(doc), opts)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [cls, value, flag] = l.split('|');
      return { cls: cls ?? '', value: value ?? '', flag: flag ?? '' };
    });

const config = (branches: string): string =>
  `<tdc><env count="${String(N)}" seed="afc" local="en">` +
  `<sequence name="Class"><gen type="text" value="a,b"/></sequence>` +
  `<sequence name="V">${branches}</sequence>` +
  `</env><block><line><data>\${{Class}}|\${{V}}|\${{Flag}}</data></line></block></tdc>`;

// Both classes draw 1..3 and spike ×1000, so `value >= 1000` IS the ground truth
// the flag claims to carry — on either branch.
const BOTH_FLAGGED = config(
  `<gen type="number" value="1..3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag" if="Class == a"/>` +
    `<gen type="number" value="1..3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag"/>`,
);

// Only class `a` can spike. Class `b` is still covered by the sequence, so its
// rows are honestly `false` — not empty, which would read as "no answer".
const ONE_FLAGGED = config(
  `<gen type="number" value="1..3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag" if="Class == a"/>` +
    `<gen type="number" value="1..3"/>`,
);

// Every branch is gated, so class `b` rows have no value at all.
const GAPPED = config(
  `<gen type="number" value="1..3" anomaly="0.3" anomaly_factor="1000" anomaly_flag="Flag" if="Class == a"/>`,
);

describe('anomaly_flag on a conditional <gen>', () => {
  for (const [label, opts] of ENGINES) {
    it(`declares the column and matches the spike on every row (${label})`, () => {
      const parsed = rows(BOTH_FLAGGED, opts);
      expect(parsed.length).toBe(N);
      for (const { value, flag } of parsed) {
        expect(flag === 'true' || flag === 'false', `flag must be boolean, got "${flag}"`).toBe(
          true,
        );
        expect(flag, `value ${value}`).toBe(Number(value) >= 1000 ? 'true' : 'false');
      }
      // Both outcomes really occur — a column of all-false would pass the loop.
      expect(parsed.filter((r) => r.flag === 'true').length).toBeGreaterThan(60);
      expect(parsed.filter((r) => r.flag === 'false').length).toBeGreaterThan(60);
    });

    it(`says false — not empty — on a branch that cannot spike (${label})`, () => {
      const parsed = rows(ONE_FLAGGED, opts);
      expect(parsed.length).toBe(N);
      for (const { cls, value, flag } of parsed) {
        if (cls === 'b') expect(flag, 'unflagged branch').toBe('false');
        else expect(flag).toBe(Number(value) >= 1000 ? 'true' : 'false');
      }
      expect(parsed.filter((r) => r.cls === 'b').length).toBeGreaterThan(60);
    });

    it(`leaves the flag empty on a row the sequence does not cover (${label})`, () => {
      const parsed = rows(GAPPED, opts);
      expect(parsed.length).toBe(N);
      for (const { cls, value, flag } of parsed) {
        // Flag and value are masked together: no value, no claim about it.
        if (cls === 'b') expect([value, flag]).toEqual(['', '']);
        else expect(flag).toBe(Number(value) >= 1000 ? 'true' : 'false');
      }
    });
  }

  it('gives the same rows on all three engines', () => {
    for (const doc of [BOTH_FLAGGED, ONE_FLAGGED, GAPPED]) {
      const [memory, stream, disk] = ENGINES.map(([, opts]) => rows(doc, opts));
      expect(stream).toEqual(memory);
      expect(disk).toEqual(memory);
    }
  });
});
