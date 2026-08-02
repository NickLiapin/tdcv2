import { afterEach, describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import {
  render,
  renderAsync,
  resolveRenderEngine,
  specsUseHttp,
} from '../../src/processor/render.js';
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

  it('makes exactly one request for the whole column, not one per row', async () => {
    svc = await startService({ mode: 'ok' });
    const src = cfg(`<sequence name="Out"><gen type="http" src="${svc.url}"/></sequence>`, 1000);
    await renderAsync(parseStrict(src), {});
    expect(svc.requests()).toBe(1);
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
    it('routes an http config to the in-memory engine', () => {
      const specs: SequenceSpec[] = [
        { name: 'Out', gen: { type: 'http', attrs: { src: 'http://x/' } } },
      ];
      expect(specsUseHttp(specs)).toBe(true);
      // disk mode (the default) must resolve http to Engine 1, never streaming.
      expect(resolveRenderEngine({ mode: 'disk' }, specs, [])).toBe(1);
    });

    it('the synchronous render refuses http rather than emit placeholders', () => {
      const src = cfg(
        `<sequence name="Out"><gen type="http" src="http://127.0.0.1:9/x"/></sequence>`,
      );
      expect(() => render(parseStrict(src), {})).toThrow(
        /network call and cannot be rendered synchronously/,
      );
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
