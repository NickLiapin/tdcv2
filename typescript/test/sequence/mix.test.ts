import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { createPrng } from '../../src/prng/prng.js';
import { buildSequences } from '../../src/sequence/build.js';
import type { SequenceSpec } from '../../src/sequence/types.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

describe('buildSequences — mix sequence specs', () => {
  it('materializes top-level mix cases with exact percents', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Code',
        mixSpec: {
          attrs: { percent: '20,80' },
          cases: [
            { parts: [{ kind: 'data', text: 'A' }] },
            { parts: [{ kind: 'data', text: 'B' }] },
          ],
        },
      },
    ];
    const reg = buildSequences(specs, 10, createPrng('mix-sequence'), 'en', 0);
    const values = reg['Code']?.values ?? [];
    expect(values.filter((v) => v === 'A')).toHaveLength(2);
    expect(values.filter((v) => v === 'B')).toHaveLength(8);
  });

  it('applies nested mix percents within the selected parent case subset', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Code',
        mixSpec: {
          attrs: { percent: '50,50' },
          cases: [
            {
              parts: [
                { kind: 'data', text: 'A' },
                {
                  kind: 'mix',
                  mixSpec: {
                    attrs: { percent: '25,75' },
                    cases: [
                      { parts: [{ kind: 'data', text: 'X' }] },
                      { parts: [{ kind: 'data', text: 'Y' }] },
                    ],
                  },
                },
              ],
            },
            { parts: [{ kind: 'data', text: 'B' }] },
          ],
        },
      },
    ];
    const reg = buildSequences(specs, 40, createPrng('nested-mix-sequence'), 'en', 0);
    const values = reg['Code']?.values ?? [];
    expect(values.filter((v) => v === 'AX')).toHaveLength(5);
    expect(values.filter((v) => v === 'AY')).toHaveLength(15);
    expect(values.filter((v) => v === 'B')).toHaveLength(20);
  });

  it('runs generators only for rows that selected their containing case', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Code',
        mixSpec: {
          attrs: { percent: '50,50' },
          cases: [
            {
              parts: [
                { kind: 'data', text: 'A' },
                {
                  kind: 'gen',
                  gen: { type: 'increment', attrs: { type: 'increment', value: '1' } },
                },
              ],
            },
            { parts: [{ kind: 'data', text: 'B' }] },
          ],
        },
      },
    ];
    const reg = buildSequences(specs, 6, createPrng('case-counter-sequence'), 'en', 0);
    const values = reg['Code']?.values ?? [];
    expect(values.filter((v) => v === 'B')).toHaveLength(3);
    expect(
      values
        .filter((v): v is string => v?.startsWith('A') ?? false)
        .map((v) => v.slice(1))
        .sort(),
    ).toEqual(['1', '2', '3']);
  });

  it('allows regex generators inside mix cases', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Code',
        mixSpec: {
          attrs: { percent: '50,50' },
          cases: [
            {
              parts: [
                { kind: 'data', text: 'A-' },
                {
                  kind: 'gen',
                  gen: { type: 'regex', attrs: { type: 'regex', value: '[A-Z]{2}[0-9]{2}' } },
                },
              ],
            },
            { parts: [{ kind: 'data', text: 'B' }] },
          ],
        },
      },
    ];
    const reg = buildSequences(specs, 20, createPrng('case-regex-sequence'), 'en', 0);
    const values = reg['Code']?.values ?? [];
    expect(values.filter((v) => v === 'B')).toHaveLength(10);
    for (const value of values.filter((v): v is string => v?.startsWith('A-') ?? false)) {
      expect(value).toMatch(/^A-[A-Z]{2}[0-9]{2}$/);
    }
  });

  it('allows advanced_regex weighted choices inside mix case subsets', () => {
    const specs: SequenceSpec[] = [
      {
        name: 'Code',
        mixSpec: {
          attrs: { percent: '50,50' },
          cases: [
            {
              parts: [
                {
                  kind: 'gen',
                  gen: {
                    type: 'advanced_regex',
                    attrs: { type: 'advanced_regex', value: 'A-(?%{20:X;80:Y})' },
                  },
                },
              ],
            },
            { parts: [{ kind: 'data', text: 'B' }] },
          ],
        },
      },
    ];
    const reg = buildSequences(specs, 20, createPrng('case-advanced-regex-sequence'), 'en', 0);
    const values = reg['Code']?.values ?? [];
    expect(values.filter((value) => value === 'A-X')).toHaveLength(2);
    expect(values.filter((value) => value === 'A-Y')).toHaveLength(8);
    expect(values.filter((value) => value === 'B')).toHaveLength(10);
  });
});

describe('processor — standalone <mix> in <env>', () => {
  it('extracts a mix sequence from DSL and interpolates its values', () => {
    const dsl = `
      <tdc>
        <env count="10" seed="dsl-mix-sequence" inject="\${{%}}">
          <mix name="Code" percent="30,70">
            <case><data>A</data></case>
            <case><data>B</data></case>
          </mix>
        </env>
        <block><line><data>\${{Code}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const values = out.split('\n').filter(Boolean);
    expect(values.filter((v) => v === 'A')).toHaveLength(3);
    expect(values.filter((v) => v === 'B')).toHaveLength(7);
  });

  it('respects parent filters before applying mix percents', () => {
    const dsl = `
      <tdc>
        <env count="10" seed="parent-mix-sequence" inject="\${{%}}">
          <sequence name="Gender">
            <gen type="text" value="M,F" percent="50,50"/>
          </sequence>
          <mix name="Code" parent="Gender.M" percent="40,60">
            <case><data>X</data></case>
            <case><data>Y</data></case>
          </mix>
        </env>
        <block><line><data>\${{Gender}}:\${{Code}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(lines.filter((l) => l === 'F:')).toHaveLength(5);
    expect(lines.filter((l) => l === 'M:X')).toHaveLength(2);
    expect(lines.filter((l) => l === 'M:Y')).toHaveLength(3);
  });
});
