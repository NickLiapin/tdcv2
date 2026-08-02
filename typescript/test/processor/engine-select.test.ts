import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { needsExactEngine, render, resolveRenderEngine } from '../../src/processor/render.js';
import type { SequenceSpec } from '../../src/sequence/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const NORMAL = `
  <tdc>
    <env count="200" seed="eng" inject="\${{%}}">
      <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
      <sequence name="Id"><gen type="increment" value="1"/></sequence>
    </env>
    <block><line><data>\${{Id}}:\${{G}}</data></line></block>
  </tdc>`;

// percent on a uniq column — Engine 2 refuses this; Engine 3 does it exactly.
// B has one value per row (b0..b7), so the tuple is unique via B and Engine 3's
// seekable exact-% path succeeds (ample slack): A exactly 4X/4Y, all distinct.
const PERCENT_UNIQ = `
  <tdc>
    <env count="8" seed="pu" inject="\${{%}}">
      <sequence name="K" uniq="true">
        <gen name="a" type="text" value="X,Y" percent="50,50"/>
        <gen name="b" type="text" value="b0,b1,b2,b3,b4,b5,b6,b7"/>
      </sequence>
    </env>
    <block><line><data>\${{K.a}}\${{K.b}}</data></line></block>
  </tdc>`;

const gTally = (out: string): Record<string, number> => {
  const t: Record<string, number> = {};
  for (const l of out.split('\n').filter(Boolean)) {
    const g = l.split(':')[1] ?? '';
    t[g] = (t[g] ?? 0) + 1;
  }
  return t;
};

describe('engine selection', () => {
  it('every engine gives EXACT marginals on a normal config (70/30)', () => {
    // Engines differ in arrangement, not in the guarantee: all exact 140/60.
    for (const engine of [1, 2, 3] as const) {
      expect(gTally(render(parseStrict(NORMAL), { now: NOW, engine }))).toEqual({ M: 140, F: 60 });
    }
    // default is now disk mode → this percent-only config auto-routes to Engine 2
    expect(render(parseStrict(NORMAL), { now: NOW })).toBe(
      render(parseStrict(NORMAL), { now: NOW, engine: 2 }),
    );
  });

  it('the engine="N" attribute resolves like the option, and engine 2 aliases agree', () => {
    const withAttr = (attr: string): string =>
      NORMAL.replace('inject="${{%}}"', `inject="\${{%}}" ${attr}`);
    // engine="3" attribute === engine:3 option (same routing)
    expect(render(parseStrict(withAttr('engine="3"')), { now: NOW })).toBe(
      render(parseStrict(NORMAL), { now: NOW, engine: 3 }),
    );
    // engine="2", mode="stream" and options.stream all pick the same (Engine 2)
    const streamOut = render(parseStrict(withAttr('engine="2"')), { now: NOW });
    expect(render(parseStrict(withAttr('mode="stream"')), { now: NOW })).toBe(streamOut);
    expect(render(parseStrict(NORMAL), { now: NOW, stream: true })).toBe(streamOut);
  });

  it('engine 2 refuses percent+uniq; engine 3 does it exactly (marginals + distinct)', () => {
    expect(() => render(parseStrict(PERCENT_UNIQ), { now: NOW, engine: 2 })).toThrow(/percent/i);
    const out = render(parseStrict(PERCENT_UNIQ), { now: NOW, engine: 3 });
    const lines = out.split('\n').filter(Boolean);
    expect(new Set(lines).size).toBe(8); // all rows distinct
    const aTally: Record<string, number> = {};
    for (const l of lines) aTally[l.charAt(0)] = (aTally[l.charAt(0)] ?? 0) + 1;
    expect(aTally).toEqual({ X: 4, Y: 4 }); // A exact 50/50
    // deterministic
    expect(render(parseStrict(PERCENT_UNIQ), { now: NOW, engine: 3 })).toBe(out);
  });

  it('rejects an invalid engine value', () => {
    const bad = NORMAL.replace('inject="${{%}}"', 'inject="${{%}}" engine="9"');
    expect(() => render(parseStrict(bad), { now: NOW })).toThrow(/invalid engine/i);
  });
});

describe('mode="memory|disk" and disk-mode routing', () => {
  const compoundUniq = (percent: boolean): SequenceSpec => ({
    name: 'K',
    uniq: true,
    gens: [
      {
        name: 'a',
        gen: {
          type: 'text',
          attrs: percent ? { value: 'x,y', percent: '70,30' } : { value: 'x,y' },
        },
      },
      { name: 'b', gen: { type: 'text', attrs: { value: 'm,n' } } },
    ],
  });

  it('needsExactEngine flags only the hard uniq cases', () => {
    expect(needsExactEngine([compoundUniq(false)], [])).toBe(false); // uniform uniq → Engine 2
    expect(needsExactEngine([compoundUniq(true)], [])).toBe(true); // percent+uniq → Engine 3
    expect(
      needsExactEngine([{ name: 'G', gen: { type: 'text', attrs: { value: 'M,F' } } }], []),
    ).toBe(false);
    // parented uniq → Engine 3
    expect(needsExactEngine([{ ...compoundUniq(false), parent: 'G.M' }], [])).toBe(true);
  });

  it('resolveRenderEngine maps memory→1 and routes disk by the config', () => {
    expect(resolveRenderEngine({ mode: 'memory' }, [], [])).toBe(1);
    expect(resolveRenderEngine({ mode: 'disk' }, [compoundUniq(false)], [])).toBe(2);
    expect(resolveRenderEngine({ mode: 'disk' }, [compoundUniq(true)], [])).toBe(3);
    expect(resolveRenderEngine({ forced: 2 }, [compoundUniq(true)], [])).toBe(2); // force wins
  });

  it('mode="memory" is Engine 1 (an explicit escape hatch, no longer the default)', () => {
    const mem = render(parseStrict(NORMAL), { now: NOW, mode: 'memory' });
    expect(mem).toBe(render(parseStrict(NORMAL), { now: NOW, engine: 1 }));
    // ...and the default is NOT memory anymore — it is disk (Engine 2 here).
    // Which engine ran can only be asserted by the router: the output no longer
    // tells them apart, because all three now agree byte for byte.
    expect(resolveRenderEngine({ mode: 'memory' }, [], [])).toBe(1);
    expect(resolveRenderEngine({}, [], [])).toBe(2);
    expect(render(parseStrict(NORMAL), { now: NOW })).toBe(mem);
  });

  it('mode="disk" auto-runs Engine 3 for percent+uniq — exact marginals + distinct', () => {
    // B has one value per row → the seekable exact-% path applies (ample slack).
    const dsl = `
      <tdc>
        <env count="8" seed="pu" inject="\${{%}}" mode="disk">
          <sequence name="K" uniq="true">
            <gen name="a" type="text" value="X,Y" percent="50,50"/>
            <gen name="b" type="text" value="b0,b1,b2,b3,b4,b5,b6,b7"/>
          </sequence>
        </env>
        <block><line><data>\${{K.a}}\${{K.b}}</data></line></block>
      </tdc>`;
    // No streaming refusal — disk mode routed to Engine 3, which did it exactly.
    const out = render(parseStrict(dsl), { now: NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(new Set(lines).size).toBe(8); // all distinct
    const aTally: Record<string, number> = {};
    for (const l of lines) aTally[l.charAt(0)] = (aTally[l.charAt(0)] ?? 0) + 1;
    expect(aTally).toEqual({ X: 4, Y: 4 }); // A exact 50/50
    // disk == explicit engine 3
    expect(out).toBe(render(parseStrict(dsl.replace('mode="disk"', 'engine="3"')), { now: NOW }));
  });

  it('rejects an invalid mode value', () => {
    const bad = NORMAL.replace('inject="${{%}}"', 'inject="${{%}}" mode="cloud"');
    expect(() => render(parseStrict(bad), { now: NOW })).toThrow(/invalid mode/i);
  });
});
