/**
 * The progress wire.
 *
 * A big run is silent for minutes, and a silent hour is indistinguishable from
 * a hung one — TDC Studio sits on exactly that question. The engine answers
 * through `onProgress`; these pin what a listener may rely on: the phases come
 * in order, `done` never runs backwards inside a phase, every phase ends at
 * its total, and a run with no uniq group still reports the render.
 *
 * The fingerprint phases are forced on a small config via the render option
 * rather than by generating a million rows — the same switch the engine flips
 * itself past that size.
 */
import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

import type { RenderProgress } from '../../src/processor/render.js';

const NOW = Date.parse('2024-01-01T00:00:00Z');

const names = Array.from({ length: 40 }, (_, i) => `a${String(i)}`).join(',');
const UNIQ = `
  <tdc>
    <env count="400" seed="p" local="en" mode="disk">
      <uniq>
        <sequence name="A"><gen type="text" value="${names}"/></sequence>
        <sequence name="B"><gen type="text" value="m,n,o,p,q,r,s,t,u,v,w,x"/></sequence>
      </uniq>
    </env>
    <block><line><data>\${{A}}-\${{B}}</data></line></block>
  </tdc>`;

describe('onProgress', () => {
  it('reports the uniq phases and the render, in order, each reaching its total', () => {
    const seen: RenderProgress[] = [];
    render(parseStrict(UNIQ), {
      now: NOW,
      uniqFingerprintBuckets: 4,
      onProgress: (p) => seen.push(p),
    });

    const phases = [...new Set(seen.map((p) => p.phase))];
    expect(phases).toEqual(['uniq-scan', 'uniq-sort', 'render']);

    for (const phase of phases) {
      const of = seen.filter((p) => p.phase === phase);
      // Monotone within the phase — a listener may render a bar from it.
      for (let i = 1; i < of.length; i++) {
        expect(of[i]!.done).toBeGreaterThanOrEqual(of[i - 1]!.done);
      }
    }
    // The render closes at exactly its total, so "done" is a real signal.
    const renderReports = seen.filter((p) => p.phase === 'render');
    expect(renderReports[renderReports.length - 1]).toEqual({
      phase: 'render',
      done: 400,
      total: 400,
    });
  });

  it('a run with no uniq group still reports the render', () => {
    const dsl = `
      <tdc>
        <env count="200" seed="p" local="en">
          <sequence name="N"><gen type="number" value="1..100"/></sequence>
        </env>
        <block><line><data>\${{N}}</data></line></block>
      </tdc>`;
    const seen: RenderProgress[] = [];
    render(parseStrict(dsl), { now: NOW, onProgress: (p) => seen.push(p) });

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.phase === 'render')).toBe(true);
    expect(seen[seen.length - 1]).toEqual({ phase: 'render', done: 200, total: 200 });
  });

  it('reporting changes nothing about the output', () => {
    const silent = render(parseStrict(UNIQ), { now: NOW, uniqFingerprintBuckets: 4 });
    const watched = render(parseStrict(UNIQ), {
      now: NOW,
      uniqFingerprintBuckets: 4,
      onProgress: () => undefined,
    });
    expect(watched).toBe(silent);
  });
});
