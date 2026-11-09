import { afterEach, describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { TDC } from '../../src/lib/tdc.js';
import { render, renderAsync, resolveRenderEngine } from '../../src/processor/render.js';
import type { SequenceSpec } from '../../src/sequence/types.js';
import { startService, type ServiceHandle } from '../fixtures/http-service.js';

/**
 * The http generator end to end through the in-memory engine — see
 * docs/specs/2026-07-23-http-service-generator.md. Every run is driven against
 * the real fixture service. Determinism is not asserted anywhere: with http the
 * output is allowed to change, and pinning it would pin a value the design lets
 * move.
 */

let svc: ServiceHandle | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
});

const cfg = (body: string, count = 3): string =>
  `<tdc><env count="${String(count)}" seed="s">${body}</env>` +
  `<block><line><data>\${{Out}}</data></line></block></tdc>`;

describe('http generator', () => {
  it('sends the in= column as the batch and substitutes the reply, in order', async () => {
    svc = await startService({ mode: 'ok', transform: (l) => l.toUpperCase() });
    const src = cfg(
      `<sequence name="In"><gen type="text" value="a,b,c" order="sequential"/></sequence>` +
        `<sequence name="Out"><gen type="http" src="${svc.url}" in="In"/></sequence>`,
    );
    const out = await renderAsync(parseStrict(src), {});
    expect(out.trim().split('\n')).toEqual(['A', 'B', 'C']);
  });

  it('a pure source (no in=) still fills the whole column', async () => {
    svc = await startService({ mode: 'ok', transform: (_l, i) => `svc${String(i)}` });
    const src = cfg(`<sequence name="Out"><gen type="http" src="${svc.url}"/></sequence>`, 4);
    const out = await renderAsync(parseStrict(src), {});
    expect(out.trim().split('\n')).toEqual(['svc0', 'svc1', 'svc2', 'svc3']);
  });

  it('a column inside one batch is one request, not one per row', async () => {
    svc = await startService({ mode: 'ok' });
    const src = cfg(`<sequence name="Out"><gen type="http" src="${svc.url}"/></sequence>`, 1000);
    await renderAsync(parseStrict(src), {});
    expect(svc.requests()).toBe(1);
  });

  describe('batches', () => {
    it('cuts a long column into batch= rows each, placed by the row of the run', async () => {
      svc = await startService({ transform: (_l, _i, row) => `r${String(row)}` });
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="10"/></sequence>`,
        25,
      );
      const out = render(parseStrict(src), {});
      expect(out.trim().split('\n')).toEqual(Array.from({ length: 25 }, (_, i) => `r${String(i)}`));
      expect(svc.counts()).toEqual([10, 10, 5]);
      expect(svc.offsets()).toEqual([0, 10, 20]);
      expect(svc.totals()).toEqual([25, 25, 25]);
    });

    it('sends each batch the inputs of its own rows', async () => {
      svc = await startService({ transform: (l) => l.toUpperCase() });
      const src = cfg(
        `<sequence name="In"><gen type="text" value="a,b,c,d,e" order="sequential"/></sequence>` +
          `<sequence name="Out"><gen type="http" src="${svc.url}" in="In" batch="2"/></sequence>`,
        5,
      );
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(['A', 'B', 'C', 'D', 'E']);
      expect(svc.inputCounts()).toEqual([2, 2, 1]);
    });

    it('refuses a source that ignores the offset once there is more than one batch', async () => {
      svc = await startService({ echoOffset: false });
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="10"/></sequence>`,
        25,
      );
      expect(() => render(parseStrict(src), {})).toThrow(/without echoing X-TDC-Offset/);
    });

    it('runs that same service unchanged when the column is one batch', async () => {
      svc = await startService({ echoOffset: false, transform: (_l, i) => `n${String(i)}` });
      const src = cfg(`<sequence name="Out"><gen type="http" src="${svc.url}"/></sequence>`, 5);
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual([
        'n0',
        'n1',
        'n2',
        'n3',
        'n4',
      ]);
    });

    it('needs no echo from a transform — each answer comes from its own input', async () => {
      svc = await startService({ echoOffset: false, transform: (l) => `<${l}>` });
      const src = cfg(
        `<sequence name="In"><gen type="text" value="a,b,c" order="sequential"/></sequence>` +
          `<sequence name="Out"><gen type="http" src="${svc.url}" in="In" batch="1"/></sequence>`,
      );
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(['<a>', '<b>', '<c>']);
    });

    it('on_error="empty" blanks only the batch that failed', async () => {
      svc = await startService({ mode: 'error-after', errorAfterRequests: 1 });
      const src =
        `<tdc><env count="5" seed="s">` +
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="2" on_error="empty"/></sequence>` +
        `</env><block><line><data>[\${{Out}}]</data></line></block></tdc>`;
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual([
        '[svc-0]',
        '[svc-1]',
        '[]',
        '[]',
        '[]',
      ]);
    });

    it('names the rows of the batch that failed', async () => {
      svc = await startService({ mode: 'error-after', errorAfterRequests: 1 });
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="2"/></sequence>`,
        5,
      );
      expect(() => render(parseStrict(src), {})).toThrow(
        /sequence "Out".*\(rows 2–3\) returned 500/s,
      );
    });

    it('parallel= puts several batches on the wire and keeps their order', async () => {
      svc = await startService({
        mode: 'slow',
        latencyMs: 40,
        transform: (_l, _i, row) => String(row),
      });
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="2" parallel="4"/></sequence>`,
        16,
      );
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(
        Array.from({ length: 16 }, (_, i) => String(i)),
      );
      expect(svc.concurrentPeak()).toBeGreaterThan(1);
    });

    it('a --jobs worker reads ahead no further than its own rows', async () => {
      // A worker renders a range; the batch after its last row belongs to the next
      // worker, and asking for it here would send it twice.
      svc = await startService({ transform: (_l, _i, row) => `r${String(row)}` });
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="10"/></sequence>`,
        40,
      );
      const first = render(parseStrict(src), { range: { start: 0, end: 20 } });
      expect(first.trim().split('\n')).toEqual(
        Array.from({ length: 20 }, (_, i) => `r${String(i)}`),
      );
      // A request sent ahead travels on the helper thread; give one the time to
      // arrive, since what is checked is that none does.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect([...svc.offsets()].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 10]);
      await svc.close();
      svc = await startService({ transform: (_l, _i, row) => `r${String(row)}` });
      const second = render(parseStrict(src.replace(/http:\/\/[^"]+/, svc.url)), {
        range: { start: 20, end: 40 },
      });
      expect(second.trim().split('\n')[0]).toBe('r20');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect([...svc.offsets()].sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([20, 30]);
    });

    it('by default one batch at a time, so a service unsafe to call concurrently is safe', async () => {
      svc = await startService({ mode: 'concurrent-unsafe' });
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="${svc.url}" batch="2"/></sequence>`,
        8,
      );
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(
        Array.from({ length: 8 }, (_, i) => `id-${String(i)}`),
      );
      expect(svc.concurrentPeak()).toBe(1);
    });
  });

  describe('a column that reads the answer sees it', () => {
    it('an if= declared below', async () => {
      svc = await startService({ transform: (l) => `H${l}` });
      const src =
        `<tdc><env count="3" seed="s">` +
        `<sequence name="In"><gen type="text" value="a,b,c" order="sequential"/></sequence>` +
        `<sequence name="H"><gen type="http" src="${svc.url}" in="In"/></sequence>` +
        `<sequence name="C"><gen type="text" value="yes" if="H == 'Hb'"/><gen type="text" value="no"/></sequence>` +
        `</env><block><line><data>\${{H}} \${{C}}</data></line></block></tdc>`;
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(['Ha no', 'Hb yes', 'Hc no']);
    });

    it('a case that prints it', async () => {
      svc = await startService({ transform: (l) => `H${l}` });
      const src =
        `<tdc><env count="4" seed="s">` +
        `<sequence name="In"><gen type="text" value="a,b,c,d" order="sequential"/></sequence>` +
        `<sequence name="H"><gen type="http" src="${svc.url}" in="In"/></sequence>` +
        `<mix name="M" percent="100"><case><data>[\${{H}}]</data></case></mix>` +
        `</env><block><line><data>\${{M}}</data></line></block></tdc>`;
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual([
        '[Ha]',
        '[Hb]',
        '[Hc]',
        '[Hd]',
      ]);
    });
  });

  describe('wherever the generator sits, row i reads answer i', () => {
    it('in a <mix> case, an if= branch and a field', async () => {
      svc = await startService({ transform: (l) => `H${l}` });
      const src =
        `<tdc><env count="4" seed="s">` +
        `<sequence name="In"><gen type="text" value="a,b,c,d" order="sequential"/></sequence>` +
        `<sequence name="Kind"><gen type="text" value="x,y,x,y" order="sequential"/></sequence>` +
        `<switch name="S" on="Kind"><case is="x"><gen type="http" src="${svc.url}" in="In"/></case><default><gen type="text" value="-"/></default></switch>` +
        `<sequence name="C"><gen type="http" src="${svc.url}" in="In" if="Kind == 'y'"/><gen type="text" value="-"/></sequence>` +
        `<sequence name="F"><gen name="a" type="http" src="${svc.url}" in="In"/><gen name="b" type="text" value="z"/></sequence>` +
        `</env><block><line><data>\${{S}} \${{C}} \${{F.a}}</data></line></block></tdc>`;
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual([
        'Ha - Ha',
        '- Hb Hb',
        'Hc - Hc',
        '- Hd Hd',
      ]);
    });

    it('a parent= child is blank where the parent does not hold', async () => {
      svc = await startService({ transform: (l) => `H${l}` });
      const src =
        `<tdc><env count="4" seed="s">` +
        `<sequence name="In"><gen type="text" value="a,b,c,d" order="sequential"/></sequence>` +
        `<sequence name="Kind"><gen type="text" value="x,y,x,y" order="sequential"/></sequence>` +
        `<sequence name="P" parent="Kind.x"><gen type="http" src="${svc.url}" in="In"/></sequence>` +
        `</env><block><line><data>[\${{P}}]</data></line></block></tdc>`;
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(['[Ha]', '[]', '[Hc]', '[]']);
    });
  });

  describe('on_error', () => {
    it('fail (default) stops the run, naming the sequence and the service', async () => {
      svc = await startService({ mode: 'error-after', errorAfterRequests: 0, errorStatus: 500 });
      const src = cfg(`<sequence name="Out"><gen type="http" src="${svc.url}"/></sequence>`);
      await expect(renderAsync(parseStrict(src), {})).rejects.toThrow(
        /sequence "Out".*returned 500/s,
      );
    });

    it('empty blanks the column and continues', async () => {
      svc = await startService({ mode: 'error-after', errorAfterRequests: 0 });
      // Wrap the value so a blank row is visible as `[]` rather than trimmed away.
      const src =
        `<tdc><env count="3" seed="s">` +
        `<sequence name="Out"><gen type="http" src="${svc.url}" on_error="empty"/></sequence>` +
        `</env><block><line><data>[\${{Out}}]</data></line></block></tdc>`;
      const out = await renderAsync(parseStrict(src), {});
      expect(out.trim().split('\n')).toEqual(['[]', '[]', '[]']);
    });
  });

  it('429 stops the run even with on_error="empty"', async () => {
    svc = await startService({ mode: 'rate-limit' });
    const src = cfg(
      `<sequence name="Out"><gen type="http" src="${svc.url}" on_error="empty"/></sequence>`,
    );
    await expect(renderAsync(parseStrict(src), {})).rejects.toThrow(/429/);
  });

  it('a hanging service is cut off by the timeout, not left to wedge', async () => {
    svc = await startService({ mode: 'hang' });
    const src = cfg(
      `<sequence name="Out"><gen type="http" src="${svc.url}" timeout="1"/></sequence>`,
    );
    await expect(renderAsync(parseStrict(src), {})).rejects.toThrow(/did not answer/);
  });

  describe('routing and the sync path', () => {
    it('routes an http config to the streaming engine, which reads it batch by batch', () => {
      const specs: SequenceSpec[] = [
        { name: 'Out', gen: { type: 'http', attrs: { src: 'http://x/' } } },
      ];
      // Until 0.4 disk mode sent http to Engine 1, which held the whole column.
      expect(resolveRenderEngine({ mode: 'disk' }, specs, [])).toBe(2);
    });

    it('finds an http generator wherever it sits, and the split --jobs must fall on', () => {
      const tdc = (body: string): TDC =>
        new TDC({
          configString: cfg(
            '<sequence name="Out"><gen type="text" value="o"/></sequence>' +
              body.replaceAll('URL', 'http://127.0.0.1:9/'),
          ),
        });
      expect(tdc('<sequence name="A"><gen type="text" value="a"/></sequence>').usesHttp()).toBe(
        false,
      );
      const nested = tdc(
        '<sequence name="K"><gen type="text" value="x,y"/></sequence>' +
          '<switch name="S" on="K"><case is="x"><gen type="http" src="URL" batch="4"/></case>' +
          '<default><gen type="text" value="-"/></default></switch>' +
          '<sequence name="F"><gen name="a" type="http" src="URL" batch="6"/>' +
          '<gen name="b" type="text" value="z"/></sequence>',
      );
      expect(nested.usesHttp()).toBe(true);
      expect(nested.httpBatchAlignment()).toBe(12);
      expect(
        tdc('<sequence name="A"><gen type="http" src="URL"/></sequence>').httpBatchAlignment(),
      ).toBe(10_000);
    });

    it('the synchronous render waits for its service like every other path', async () => {
      svc = await startService({ transform: (l) => l.toUpperCase() });
      const src = cfg(
        `<sequence name="In"><gen type="text" value="a,b,c" order="sequential"/></sequence>` +
          `<sequence name="Out"><gen type="http" src="${svc.url}" in="In"/></sequence>`,
      );
      expect(render(parseStrict(src), {}).trim().split('\n')).toEqual(['A', 'B', 'C']);
    });
  });
});

describe('X-TDC-Seed — what lets a service be reproducible on its own', () => {
  /**
   * The engine cannot make an http run reproducible: the service decides the
   * values. What it CAN do is hand the service a stable seed, so a service that
   * derives its output from it answers the same way every run. These pin the
   * three properties that makes usable.
   */
  const twoSequences = (seed: string, url: string): string =>
    `<tdc><env count="2" seed="${seed}">` +
    `<sequence name="A"><gen type="http" src="${url}"/></sequence>` +
    `<sequence name="B"><gen type="http" src="${url}"/></sequence>` +
    `</env><block><line><data>\${{A}}|\${{B}}</data></line></block></tdc>`;

  it('is sent on every request', async () => {
    svc = await startService();
    await renderAsync(
      parseStrict(cfg('<sequence name="Out"><gen type="http" src="' + svc.url + '"/></sequence>')),
    );
    expect(svc.seeds()).toHaveLength(1);
    expect(svc.seeds()[0]).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is the same on a re-run — the service can reproduce', async () => {
    svc = await startService();
    await renderAsync(parseStrict(twoSequences('ALPHA', svc.url)));
    await renderAsync(parseStrict(twoSequences('ALPHA', svc.url)));
    const [a1, b1, a2, b2] = svc.seeds();
    expect(a2).toBe(a1);
    expect(b2).toBe(b1);
  });

  it('differs per sequence, so one service does not answer two columns alike', async () => {
    svc = await startService();
    await renderAsync(parseStrict(twoSequences('ALPHA', svc.url)));
    const [a, b] = svc.seeds();
    expect(a).not.toBe(b);
  });

  it('follows the env seed', async () => {
    svc = await startService();
    await renderAsync(parseStrict(twoSequences('ALPHA', svc.url)));
    await renderAsync(parseStrict(twoSequences('BETA', svc.url)));
    const [alpha, , beta] = svc.seeds();
    expect(beta).not.toBe(alpha);
  });
});
