import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { needsExactEngine, render, resolveRenderEngine } from '../../src/processor/render.js';
import type { SequenceSpec } from '../../src/sequence/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * `advanced_regex` weighted choice `(?%{70:RU;20:US;10:DE})` must deliver its
 * documented EXACT percentages under the default (disk) engine, not just under
 * mode="memory". Its generator is batch-only (Hamilton over the whole column),
 * so — like percent-weighted `uniq` — it can't be produced lazily row-by-row:
 * the streaming engine must refuse it, and disk mode must route it to an exact
 * engine instead of silently collapsing every row into the top branch.
 */
const WEIGHTED = `
  <tdc>
    <env count="100" seed="wc" inject="\${{%}}">
      <sequence name="Country"><gen type="advanced_regex" value="(?%{70:RU;20:US;10:DE})-[0-9]{2}"/></sequence>
    </env>
    <block><line><data>\${{Country}}</data></line></block>
  </tdc>`;

/** Tally the two-letter country prefix (RU / US / DE) of each `XX-99` row. */
const prefixTally = (out: string): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const l of out.split('\n').filter(Boolean)) {
    const prefix = l.split('-')[0] ?? '';
    t[prefix] = (t[prefix] ?? 0) + 1;
  }
  return t;
};

describe('advanced_regex weighted choice — exact percentages across engines', () => {
  it('the default (disk) engine gives EXACT 70/20/10, not 100/0/0', () => {
    expect(prefixTally(render(parseStrict(WEIGHTED), { now: NOW }))).toEqual({
      RU: 70,
      US: 20,
      DE: 10,
    });
  });

  it('every non-streaming engine agrees on the exact marginals', () => {
    // Engine 1 (memory) and Engine 3 (exact-on-disk) both materialize exactly.
    for (const engine of [1, 3] as const) {
      expect(prefixTally(render(parseStrict(WEIGHTED), { now: NOW, engine }))).toEqual({
        RU: 70,
        US: 20,
        DE: 10,
      });
    }
    // mode="memory" is Engine 1.
    expect(prefixTally(render(parseStrict(WEIGHTED), { now: NOW, mode: 'memory' }))).toEqual({
      RU: 70,
      US: 20,
      DE: 10,
    });
  });

  it('is deterministic on the default engine', () => {
    expect(render(parseStrict(WEIGHTED), { now: NOW })).toBe(
      render(parseStrict(WEIGHTED), { now: NOW }),
    );
  });

  it('the pure streaming engine refuses it rather than silently degrading', () => {
    // Forcing Engine 2 (engine="2" / --stream) is honored: it throws instead of
    // collapsing to 100/0/0, mirroring how percent-weighted uniq is refused.
    expect(() => render(parseStrict(WEIGHTED), { now: NOW, engine: 2 })).toThrow(
      /weighted choice/i,
    );
    expect(() => render(parseStrict(WEIGHTED), { now: NOW, stream: true })).toThrow(
      /weighted choice/i,
    );
  });

  it('also holds for a weighted choice as a compound field', () => {
    const dsl = `
      <tdc>
        <env count="100" seed="wc" inject="\${{%}}">
          <sequence name="P">
            <gen name="c" type="advanced_regex" value="(?%{70:RU;20:US;10:DE})"/>
            <gen name="n" type="increment" value="1"/>
          </sequence>
        </env>
        <block><line><data>\${{P.c}}-\${{P.n}}</data></line></block>
      </tdc>`;
    expect(prefixTally(render(parseStrict(dsl), { now: NOW }))).toEqual({ RU: 70, US: 20, DE: 10 });
  });
});

describe('needsExactEngine — advanced_regex weighted choice routing', () => {
  const advRegexSpec = (pattern: string): SequenceSpec => ({
    name: 'Country',
    gen: { type: 'advanced_regex', attrs: { value: pattern } },
  });

  it('flags an advanced_regex weighted choice, but not a plain advanced_regex', () => {
    expect(needsExactEngine([advRegexSpec('(?%{70:RU;20:US;10:DE})-[0-9]{2}')], [])).toBe(true);
    expect(needsExactEngine([advRegexSpec('[A-Z]{2}-[0-9]{2}')], [])).toBe(false);
  });

  it('routes disk mode to the exact engine for a weighted choice', () => {
    expect(resolveRenderEngine({ mode: 'disk' }, [advRegexSpec('(?%{60:A;40:B})')], [])).toBe(3);
    expect(resolveRenderEngine({ mode: 'disk' }, [advRegexSpec('[A-Z]')], [])).toBe(2);
  });

  it('detects a weighted choice buried in a compound field', () => {
    const spec: SequenceSpec = {
      name: 'P',
      gens: [
        { name: 'c', gen: { type: 'advanced_regex', attrs: { value: '(?%{60:A;40:B})' } } },
        { name: 'n', gen: { type: 'increment', attrs: { value: '1' } } },
      ],
    };
    expect(needsExactEngine([spec], [])).toBe(true);
  });
});
