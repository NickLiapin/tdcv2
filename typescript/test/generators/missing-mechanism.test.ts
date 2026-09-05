/**
 * The three missing-data mechanisms, and what separates them.
 *
 * `missing="p"` alone is **MCAR**: every row eligible, holes carry no signal.
 * `missing_when="…"` decides eligibility, and that single attribute is the whole
 * difference between the other two:
 *
 *   MAR   the condition reads ANOTHER column      — a hole you could predict
 *   MNAR  the condition reads `_value`            — a hole only the hidden value explains
 *
 * The distinction is not vocabulary. A detector trained against MCAR has nothing
 * to learn; against MNAR the visible sample is BIASED, and these tests measure
 * that bias rather than asserting it.
 */

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();
const opts = { now: NOW } as const;

function rows(config: string): string[][] {
  return render(parseStrict(config), opts)
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split(','));
}

const MAR = `<tdc><env count="4000" seed="mech">
  <sequence name="Age"><gen type="number" value="18..60"/></sequence>
  <sequence name="Inc"><gen type="number" value="20000..200000" missing="0.4" missing_when="Age < 30"/></sequence>
</env><block><line><data>\${{Age}},[\${{Inc}}]</data></line></block></tdc>`;

const MNAR = `<tdc><env count="4000" seed="mech">
  <sequence name="Inc"><gen type="number" value="20000..200000" missing="0.5" missing_when="_value > 150000"/></sequence>
</env><block><line><data>[\${{Inc}}]</data></line></block></tdc>`;

describe('MAR — the hole depends on another column', () => {
  it('blanks only rows the condition covers, at the declared rate', () => {
    let young = 0;
    let youngBlank = 0;
    let restBlank = 0;
    for (const [age, inc] of rows(MAR)) {
      const blank = inc === '[]';
      if (Number(age) < 30) {
        young++;
        if (blank) youngBlank++;
      } else if (blank) {
        restBlank++;
      }
    }
    // Not one hole outside the condition — that is what makes it MAR rather
    // than MCAR with extra steps.
    expect(restBlank).toBe(0);
    expect(young).toBeGreaterThan(500);
    expect(youngBlank / young).toBeGreaterThan(0.35);
    expect(youngBlank / young).toBeLessThan(0.45);
  });
});

describe('MNAR — the hole depends on the value it hides', () => {
  it('leaves a visibly biased sample, which is the whole point', () => {
    const visible = rows(MNAR)
      .map(([v]) => v ?? '')
      .filter((v) => v !== '[]')
      .map((v) => Number(v.slice(1, -1)));
    const high = visible.filter((v) => v > 150_000).length;

    // 150000..200000 is 50/180 of the range, so ~27.8% of a complete sample
    // would be high. Half of those are hidden, so the visible share must fall
    // to roughly 16% — the bias a model would learn if nobody told it.
    const share = high / visible.length;
    expect(share).toBeGreaterThan(0.13);
    expect(share).toBeLessThan(0.19);
  });

  it('hides nothing the condition does not name', () => {
    // Every surviving value at or below the threshold proves the low end was
    // never eligible: the count of visible low values is the count drawn.
    const all = rows(MNAR).map(([v]) => v ?? '');
    const blanks = all.filter((v) => v === '[]').length;
    expect(blanks).toBeGreaterThan(400);
    expect(blanks).toBeLessThan(700);
  });
});

describe('the three agree with each other', () => {
  it('no condition is MCAR — every row eligible', () => {
    const mcar = `<tdc><env count="4000" seed="mech">
      <sequence name="Age"><gen type="number" value="18..60"/></sequence>
      <sequence name="Inc"><gen type="number" value="1..9" missing="0.4"/></sequence>
    </env><block><line><data>\${{Age}},[\${{Inc}}]</data></line></block></tdc>`;
    let youngBlank = 0;
    let restBlank = 0;
    for (const [age, inc] of rows(mcar)) {
      if (inc !== '[]') continue;
      if (Number(age) < 30) youngBlank++;
      else restBlank++;
    }
    // Holes land on both sides of the line the MAR test drew — the signature of
    // a mechanism that is not looking at anything.
    expect(youngBlank).toBeGreaterThan(100);
    expect(restBlank).toBeGreaterThan(500);
  });

  it('a condition nothing satisfies blanks nothing at all', () => {
    const none = `<tdc><env count="200" seed="mech">
      <sequence name="Age"><gen type="number" value="18..60"/></sequence>
      <sequence name="Inc"><gen type="number" value="1..9" missing="1" missing_when="Age > 999"/></sequence>
    </env><block><line><data>[\${{Inc}}]</data></line></block></tdc>`;
    expect(rows(none).filter(([v]) => v === '[]')).toHaveLength(0);
  });
});

describe('the engines agree about the condition', () => {
  // The types the streaming engine builds INLINE — a timeseries, a counter, a
  // text list — take their blanking draw off a keyed `#miss` stream rather than
  // the generator's own. That path skipped `missing_when` outright: the
  // in-memory engine honoured the condition and the streaming one blanked every
  // row, from the same seed. A pair of runs is the only test that catches it.
  const both = `<tdc><env count="30" seed="engines">
    <sequence name="Age"><gen type="number" value="18..60"/></sequence>
    <sequence name="TS"><gen type="timeseries" base="100" trend="1" noise="0" missing="1" missing_as="X" missing_when="Age > 40"/></sequence>
    <sequence name="Seen"><gen type="increment" step="1" missing="1" missing_as="X" missing_when="_value > 5"/></sequence>
    <sequence name="Word"><gen type="text" value="a,b,c" missing="1" missing_as="X" missing_when="_value === b"/></sequence>
  </env><block><line><data>\${{Age}},\${{TS}},\${{Seen}},\${{Word}}</data></line></block></tdc>`;

  it('renders the same file in memory and streamed', () => {
    const inMemory = render(parseStrict(both), { now: NOW });
    const streamed = render(parseStrict(both), { now: NOW, engine: 2 });
    expect(streamed).toBe(inMemory);
    // And the condition really fired: some cells blanked, some intact. Without
    // this the assertion above passes on two engines that both ignore it.
    expect(inMemory).toContain('X');
    expect(inMemory).toMatch(/,10[0-9],/);
  });

  it('agrees about anomaly_flag beside a conditional blank', () => {
    const flagged = `<tdc><env count="30" seed="engines-flag">
      <sequence name="Age"><gen type="number" value="18..60"/></sequence>
      <sequence name="TS"><gen type="timeseries" base="100" trend="1" noise="0.2" anomaly="0.5" anomaly_factor="10" anomaly_flag="IsOut" missing="1" missing_as="X" missing_when="Age > 40"/></sequence>
    </env><block><line><data>\${{Age}},\${{TS}},\${{IsOut}}</data></line></block></tdc>`;
    expect(render(parseStrict(flagged), { now: NOW, engine: 2 })).toBe(
      render(parseStrict(flagged), { now: NOW }),
    );
    // A blanked cell has no spike left to label, so the flag never says true beside one.
    for (const [, value, flag] of rows(flagged)) {
      if (value === 'X') expect(flag).toBe('false');
    }
  });
});
