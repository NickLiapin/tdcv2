/**
 * `repeat` / `separator` end to end.
 *
 * The risk this feature carries is not "does it join strings" — it is
 * determinism. Every engine computes a row without computing its predecessors,
 * which needs a FIXED number of PRNG draws per row. `repeat` spends one draw on
 * the length and then `max` element draws whatever the length turns out to be,
 * so the budget never varies. If that were wrong, rows would shift and
 * `--jobs 4` would stop matching `--jobs 1` — which is what these tests watch.
 *
 * Note the engines are NOT expected to produce the same VALUES: cli.md
 * documents `--mode memory` as a different engine with its own sequence. What
 * must hold in both is the declared SHAPE.
 */

import { describe, expect, it } from 'vitest';

import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

const config = (seq: string, count = 200) =>
  `<tdc><env count="${String(count)}" seed="rep" inject="\${{%}}">` +
  `<sequence name="V">${seq}</sequence></env>` +
  `<block><line><data>\${{V}}</data></line></block></tdc>`;

const lines = (src: string, opts: RenderOptions): string[] =>
  render(parseStrict(src), opts).split('\n').slice(0, -1);

describe('repeat — shape holds in every engine', () => {
  for (const [label, opts] of ENGINES) {
    it(`a range produces between min and max values, and really varies (${label})`, () => {
      const out = lines(config('<gen type="number" value="10..99" repeat="1..4"/>'), opts);
      expect(out).toHaveLength(200);
      const sizes = new Set<number>();
      for (const line of out) {
        const parts = line.split(',');
        expect(parts.length, line).toBeGreaterThanOrEqual(1);
        expect(parts.length, line).toBeLessThanOrEqual(4);
        for (const p of parts) expect(p).toMatch(/^\d+$/);
        sizes.add(parts.length);
      }
      // All four lengths should show up over 200 rows; a constant length would
      // mean the length draw is not actually varying.
      expect(sizes, label).toEqual(new Set([1, 2, 3, 4]));
    });

    it(`a fixed count is exact (${label})`, () => {
      const out = lines(config('<gen type="number" value="1..9" repeat="3"/>'), opts);
      for (const line of out) expect(line.split(',')).toHaveLength(3);
    });

    it(`repeat="0..2" can produce an empty row (${label})`, () => {
      const out = lines(config('<gen type="number" value="1..9" repeat="0..2"/>'), opts);
      expect(out.some((l) => l === '')).toBe(true);
    });

    it(`a custom separator is used verbatim (${label})`, () => {
      const out = lines(
        config('<gen type="number" value="1..9" repeat="2" separator=" | "/>'),
        opts,
      );
      for (const line of out) expect(line).toMatch(/^\d+ \| \d+$/);
    });

    it(`is reproducible — same seed, same output (${label})`, () => {
      const src = config('<gen type="number" value="10..99" repeat="1..4"/>');
      expect(lines(src, opts)).toEqual(lines(src, opts));
    });
  }
});

describe('repeat — modifiers apply per element', () => {
  for (const [label, opts] of ENGINES) {
    it(`anomaly_flag is a list aligned with the values (${label})`, () => {
      const out = lines(
        config(
          '<gen type="number" value="1..9" repeat="3" anomaly="0.3" ' +
            'anomaly_factor="100" anomaly_flag="Bad"/>',
        ).replace('${{V}}</data>', '${{V}};${{Bad}}</data>'),
        opts,
      );
      for (const line of out) {
        const [values, flags] = line.split(';');
        const v = (values ?? '').split(',');
        const f = (flags ?? '').split(',');
        expect(f, line).toHaveLength(v.length);
        for (let k = 0; k < v.length; k++) {
          // spiked ×100 → an outlier is >= 100; the flag must agree element by element
          expect(f[k], `${line} @${String(k)}`).toBe(Number(v[k]) >= 100 ? 'true' : 'false');
        }
      }
    });

    it(`missing blanks individual elements, not the whole row (${label})`, () => {
      const out = lines(config('<gen type="number" value="1..9" repeat="4" missing="0.4"/>'), opts);
      // Every row still has 4 slots; some of them are empty.
      for (const line of out) expect(line.split(',')).toHaveLength(4);
      expect(out.some((l) => l.split(',').some((p) => p === ''))).toBe(true);
      expect(
        out.some((l) => l.split(',').every((p) => p !== '')),
        label,
      ).toBe(true);
    });
  }
});

describe('repeat — refused where it cannot be honoured', () => {
  const codes = (seq: string): string[] =>
    validate(parse(config(seq, 3)).tree).diagnostics.map((d) => d.code ?? '');

  it('refuses positional generators (the row index becomes unknowable)', () => {
    for (const t of ['increment', 'decrement', 'timeseries', 'pattern']) {
      expect(codes(`<gen type="${t}" value="1" repeat="2"/>`), t).toContain('TDC204');
    }
  });

  it('allows text — the exact quota is planned over elements, so nothing is lost', () => {
    expect(codes('<gen type="text" value="a,b" percent="70,30" repeat="3"/>')).toEqual([]);
    expect(codes('<gen type="text" value="a,b" percent="70,30" repeat="1..3"/>')).toEqual([]);
    expect(codes('<gen type="text" value="a,b" repeat="1..3"/>')).toEqual([]);
  });

  it('refuses a malformed repeat', () => {
    expect(codes('<gen type="number" value="1..9" repeat="5..2"/>')).toContain('TDC195');
    expect(codes('<gen type="number" value="1..9" repeat="many"/>')).toContain('TDC195');
    expect(codes('<gen type="number" value="1..9" repeat="1..65"/>')).toContain('TDC195');
  });

  it('refuses a separator that would do nothing', () => {
    expect(codes('<gen type="number" value="1..9" separator=";"/>')).toContain('TDC198');
  });

  it('accepts the supported generators without complaint', () => {
    expect(codes('<gen type="number" value="1..9" repeat="1..3"/>')).toEqual([]);
    expect(codes('<gen type="symbol" value="[a-z]" length="2" repeat="2"/>')).toEqual([]);
  });
});

/**
 * `<gen type="text">` is the reason lists are wanted at all ("1 to 3 tags"),
 * and it is the one generator that makes an EXACT promise about its
 * distribution. With `repeat` the quota is planned over elements instead of
 * rows, so a fixed count keeps that promise precisely; a variable count
 * discards slots that already consumed quota and can only approximate it.
 */
describe('repeat on <gen type="text"> — the exactness promise', () => {
  const tally = (out: readonly string[]): Record<string, number> => {
    const seen: Record<string, number> = {};
    for (const line of out) {
      for (const v of line.split(',')) {
        if (v !== '') seen[v] = (seen[v] ?? 0) + 1;
      }
    }
    return seen;
  };

  for (const [label, opts] of ENGINES) {
    it(`a fixed repeat keeps percentages EXACT over elements (${label})`, () => {
      // 100 rows x 4 elements = 400 slots; 75/25 must land on exactly 300/100.
      const out = lines(
        config('<gen type="text" value="a,b" percent="75,25" repeat="4"/>', 100),
        opts,
      );
      expect(tally(out), label).toEqual({ a: 300, b: 100 });
    });

    it(`a VARIABLE repeat is exact too, now that lengths are planned first (${label})`, () => {
      // 200 rows over lengths 1..4 → exactly 50 of each → 500 slots.
      // 75/25 of 500 is 375/125, on the nose.
      const out = lines(
        config('<gen type="text" value="a,b" percent="75,25" repeat="1..4"/>', 200),
        opts,
      );
      expect(new Set(out.map((l) => l.split(',').length)), label).toEqual(new Set([1, 2, 3, 4]));
      expect(tally(out), label).toEqual({ a: 375, b: 125 });
    });

    it(`list lengths really vary for text too (${label})`, () => {
      const out = lines(config('<gen type="text" value="a,b,c" repeat="1..4"/>', 300), opts);
      expect(new Set(out.map((l) => l.split(',').length)), label).toEqual(new Set([1, 2, 3, 4]));
    });
  }
});

/**
 * The validator path, which the renderer tests bypass entirely.
 *
 * A declared `type="[]int64"` worked in the writer but was REJECTED by the
 * validator, so every real run through the CLI failed while the unit tests
 * stayed green. Calling the library directly is not enough — the gate the user
 * actually walks through has to be tested too.
 */
describe('list types survive validation, not just the writer', () => {
  const codes = (block: string, seq = '<gen type="number" value="1..9" repeat="2"/>'): string[] =>
    validate(
      parse(
        `<tdc><env count="3" seed="v" inject="\${{%}}">` +
          `<sequence name="S">${seq}</sequence></env>` +
          `<block><line>${block}</line></block></tdc>`,
      ).tree,
    ).diagnostics.map((d) => d.code ?? '');

  it('accepts a declared list type', () => {
    expect(codes('<data name="s" type="[]int64">${{S}}</data>')).toEqual([]);
    expect(codes('<data name="s" type="[]string|null">${{S}}</data>')).toEqual([]);
    expect(codes('<data name="s" type="[]decimal(18,2)">${{S}}</data>')).toEqual([]);
  });

  it('still rejects a nested list, and says why', () => {
    expect(codes('<data name="s" type="[][]int64">${{S}}</data>')).toContain('TDC194');
  });

  it('still rejects an unknown element type', () => {
    expect(codes('<data name="s" type="[]widget">${{S}}</data>')).toContain('TDC194');
  });

  it('refuses repeat on <mix>, which picks a branch rather than producing a list', () => {
    const src =
      `<tdc><env count="3" seed="v" inject="\${{%}}">` +
      `<mix name="M" percent="50,50" repeat="1..3">` +
      `<case><gen type="text" value="a"/></case><case><gen type="text" value="b"/></case>` +
      `</mix></env><block><line><data>\${{M}}</data></line></block></tdc>`;
    expect(validate(parse(src).tree).diagnostics.map((d) => d.code)).toContain('TDC196');
  });
});
