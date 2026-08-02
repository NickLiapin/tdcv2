import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { estimateMemoryUsage, memoryWarning } from '../../src/errors/memory-estimate.js';
import { TDC } from '../../src/lib/tdc.js';

const TINY = `<tdc><env count="3" seed="t"></env><block><line><data>row</data></line></block></tdc>`;

describe('TDC.preflight — memory estimation', () => {
  it('returns undefined for a comfortably small config', () => {
    const tdc = new TDC({ configString: TINY });
    expect(tdc.preflight()).toBeUndefined();
  });

  it('uses the resolved count (CLI override beats env default)', () => {
    // Override a small env count with an enormous count — the estimate must
    // reflect the override, not the env value. Gating is against TOTAL RAM, so
    // the count is chosen huge enough to exceed even a large-RAM host (1e9 rows
    // materialized ≈ hundreds of GB), keeping the assertion machine-independent.
    // mode="memory" is required now that disk (bounded-memory) is the default —
    // only Engine 1 scales its estimate with count.
    const tdc = new TDC({ configString: TINY, count: 1_000_000_000, mode: 'memory' });
    const diag = tdc.preflight();
    expect(diag).toBeDefined();
    expect(diag?.message).toMatch(/memory/);
    // Enormous count with trivial cells — should hit the warn/error threshold.
    // Either warning or error is acceptable — the test just verifies the
    // estimate scales with count.
    expect(['warning', 'error']).toContain(diag?.severity);
  });

  it('does NOT flag a huge count under the streaming engine (Engine 2)', () => {
    // Engine 1 would estimate ~4 GB for this and error; Engine 2 is
    // O(#slots), so a billion-row stream run must pass preflight cleanly.
    const STREAM = `
      <tdc>
        <env count="1000000000" seed="s" mode="stream">
          <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
        </env>
        <block><line><data>\${{G}}</data></line></block>
      </tdc>`;
    expect(new TDC({ configString: STREAM }).preflight({ output: 'streaming' })).toBeUndefined();
    // The same count under the in-memory engine DOES trip the estimate. (Disk is
    // the default now, so this must ask for mode="memory" explicitly.)
    const MEMORY = STREAM.replace('mode="stream"', 'mode="memory"');
    expect(new TDC({ configString: MEMORY }).preflight({ output: 'streaming' })).toBeDefined();
    // The --stream option (CLI) also switches the engine for the estimate.
    expect(
      new TDC({ configString: MEMORY, stream: true }).preflight({ output: 'streaming' }),
    ).toBeUndefined();
  });

  it('counts each compound field as a separate registry slot', () => {
    const WITH_COMPOUND = `
      <tdc>
        <env count="1" seed="t">
          <sequence name="Person">
            <gen name="A" type="text" value="x"/>
            <gen name="B" type="text" value="x"/>
            <gen name="C" type="text" value="x"/>
          </sequence>
        </env>
        <block><line><data>\${{Person.A}}</data></line></block>
      </tdc>`;
    // With count=1 the estimate is tiny; preflight() should still run
    // without crashing and return undefined (well within safe bounds).
    const tdc = new TDC({ configString: WITH_COMPOUND });
    expect(tdc.preflight()).toBeUndefined();
  });
});

describe('memoryWarning', () => {
  it('excludes rendered output bytes for streaming estimates', () => {
    const materialized = estimateMemoryUsage(1_000, 5, { output: 'materialized' });
    const streaming = estimateMemoryUsage(1_000, 5, { output: 'streaming' });

    expect(materialized.includesRenderedOutput).toBe(true);
    expect(materialized.renderedOutputBytes).toBeGreaterThan(0);
    expect(streaming.includesRenderedOutput).toBe(false);
    expect(streaming.renderedOutputBytes).toBe(0);
    expect(streaming.estimatedBytes).toBeLessThan(materialized.estimatedBytes);
    expect(streaming.sequenceBytes).toBe(materialized.sequenceBytes);
  });

  it('the stream engine estimate does not scale sequence bytes with count', () => {
    const small = estimateMemoryUsage(1_000, 5, { engine: 'stream' });
    const huge = estimateMemoryUsage(1_000_000_000, 5, { engine: 'stream' });
    // O(#slots): count does not change the sequence memory.
    expect(huge.sequenceBytes).toBe(small.sequenceBytes);
    expect(huge.renderedOutputBytes).toBe(0);
    // ...whereas Engine 1 scales linearly with count.
    const memHuge = estimateMemoryUsage(1_000_000_000, 5, { engine: 'memory' });
    expect(memHuge.sequenceBytes ?? 0).toBeGreaterThan((huge.sequenceBytes ?? 0) * 1000);
  });

  it('returns undefined below the warning threshold', () => {
    expect(
      memoryWarning({
        estimatedBytes: 10,
        totalBytes: 100,
        freeBytes: 50,
        ratio: 0.1,
      }),
    ).toBeUndefined();
  });

  it('warns (not errors) when the estimate is a large share of total RAM', () => {
    const diag = memoryWarning({
      estimatedBytes: 60 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      freeBytes: 20 * 1024 * 1024,
      ratio: 0.6,
    });
    expect(diag?.severity).toBe('warning');
    expect(diag?.code).toBe('TDC200');
    expect(diag?.message).toMatch(/machine's RAM/);
  });

  it('returns an error when the estimate exceeds total RAM', () => {
    const diag = memoryWarning({
      estimatedBytes: 200 * 1024 * 1024,
      totalBytes: 100 * 1024 * 1024,
      freeBytes: 10 * 1024 * 1024,
      ratio: 2,
    });
    expect(diag?.severity).toBe('error');
    expect(diag?.code).toBe('TDC201');
  });

  it('does NOT abort just because instantaneous free RAM is low (gates on total)', () => {
    // The regression this whole change fixes: macOS keeps RAM busy with
    // reclaimable caches, so os.freemem() can read <1 GB on a 32 GB machine
    // while ~13 GB is instantly available. A run that fits in TOTAL RAM must
    // not be blocked because free momentarily reads near-zero.
    const GB = 1024 * 1024 * 1024;
    expect(
      memoryWarning({
        estimatedBytes: 8 * GB,
        totalBytes: 32 * GB,
        freeBytes: 0.5 * GB,
        ratio: (8 * GB) / (32 * GB),
      }),
    ).toBeUndefined();
  });
});

describe('TDC.toIterator — streaming output', () => {
  it('yields chunks that concatenate to exactly the full rendered output', () => {
    const tdc = new TDC({ configString: TINY, seed: 's' });
    const full = tdc.toString();
    let stitched = '';
    for (const chunk of tdc.toIterator()) stitched += chunk;
    expect(stitched).toBe(full);
  });

  it('yields one chunk per card plus optional fixture chunks', () => {
    const DSL_WITH_FIXTURES = `
      <tdc>
        <env count="4" seed="s">
          <before><line><data>HEAD</data></line></before>
          <after><line><data>TAIL</data></line></after>
        </env>
        <block><line><data>row</data></line></block>
      </tdc>`;
    const tdc = new TDC({ configString: DSL_WITH_FIXTURES });
    const chunks = [...tdc.toIterator()];
    // 1 (before) + 4 (cards) + 1 (after) = 6.
    expect(chunks).toHaveLength(6);
    expect(chunks[0]).toContain('HEAD');
    expect(chunks[chunks.length - 1]).toContain('TAIL');
  });

  it('does not render future cards before the consumer asks for them', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-stream-lazy-'));
    const list = join(dir, 'values.txt');
    writeFileSync(list, 'future\n');
    const source = `
      <tdc>
        <env count="50000" seed="stream-lazy" inject="\${{%}}"><sequence name="f"><gen type="file" src="${list}"/></sequence></env>
        <block>
          <line if="_count == 1 || _count == 2"><data>safe \${{_count}}</data></line>
          <line if="_count == 50000"><data>\${{f}}</data></line>
        </block>
      </tdc>`;
    const iterator = new TDC({ configString: source }).toIterator();
    unlinkSync(list);

    expect(iterator.next()).toEqual({ value: 'safe 1\n', done: false });
    expect(iterator.next()).toEqual({ value: 'safe 2\n', done: false });
  });

  it('throws only when iteration reaches a future failing card', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-stream-future-error-'));
    const list = join(dir, 'values.txt');
    writeFileSync(list, 'future\n');
    const source = `
      <tdc>
        <env count="4" seed="stream-future-error" inject="\${{%}}"><sequence name="f"><gen type="file" src="${list}"/></sequence></env>
        <block>
          <line if="_count == 1 || _count == 2"><data>safe \${{_count}}</data></line>
          <line if="_count == 4"><data>\${{f}}</data></line>
        </block>
      </tdc>`;
    const iterator = new TDC({ configString: source }).toIterator();
    unlinkSync(list);

    expect(iterator.next().value).toBe('safe 1\n');
    expect(iterator.next().value).toBe('safe 2\n');
    expect(() => iterator.next()).toThrow(/cannot read data source/);
  });

  it('toStream emits the same chunks as toIterator', async () => {
    const tdc = new TDC({ configString: TINY, seed: 'stream-api' });
    const expected = [...tdc.toIterator()];
    const actual: string[] = [];

    for await (const chunk of tdc.toStream()) actual.push(String(chunk));

    expect(actual).toEqual(expected);
  });

  it('writeFile uses the streaming iterator path instead of toString', () => {
    const tdc = new TDC({ configString: TINY, count: 1000, seed: 'write-stream' });
    const toIteratorSpy = vi.spyOn(tdc, 'toIterator');
    const toStringSpy = vi.spyOn(tdc, 'toString');
    const dir = mkdtempSync(join(tmpdir(), 'tdc-write-stream-'));
    const out = join(dir, 'out.txt');

    tdc.writeFile(out);

    expect(toIteratorSpy).toHaveBeenCalledOnce();
    expect(toStringSpy).not.toHaveBeenCalled();
    expect(
      readFileSync(out, 'utf8')
        .split('\n')
        .filter((line) => line === 'row'),
    ).toHaveLength(1000);
  });
});
