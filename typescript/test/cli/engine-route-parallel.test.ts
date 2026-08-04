/**
 * A config the router runs in memory must not die when the CLI parallelises it.
 *
 * `TDC.resolveEngine()` used to be a second implementation of the router that
 * only chose between Engine 3 and Engine 2, while its own comment claimed to
 * match the renderer. It did not: the renderer sends FIVE shapes to Engine 1,
 * and four of them were never asked about here.
 *
 * The cost was a run that worked at 50,000 rows and died at 100,000 — the point
 * where auto-parallelism starts and hands each worker `stream: true`, a FORCED
 * engine with no fallback. The user set no mode=, no engine= and no --jobs, and
 * got told to "run without a forced streaming engine" for their trouble.
 *
 * All four shapes are here because all four were measured broken, each with its
 * own absurd message advising the removal of something never written:
 *
 *   weight= with row=   "run without a forced streaming engine"
 *   dynamic template    "the in-memory engine resolves it per row"
 *   percent in a pack   "Use mode='memory' or omit the engine override"
 *   http                "the in-memory engine handles it"
 *
 * The fifth, `uniq`, was never broken — it is the one shape `parallelBlockReason`
 * already knew about. That is the shape of the bug: exactly the four the second
 * router had not been told about.
 *
 * ── Why these counts ─────────────────────────────────────────────────────────
 * Every count here straddles AUTO_JOBS_MIN_ROWS deliberately. A test below the
 * threshold passes against the bug and proves nothing, which is why the constant
 * is imported rather than written out — moving it must move the tests with it.
 *
 * ── Why this is a TypeScript test and not a shared fixture ───────────────────
 * The threshold is a TypeScript concept. The five implementations thread
 * differently and their `--jobs` help texts already say so, so a shared case
 * pinned to this number would be asking the other four to grow a feature in
 * order to pass.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AUTO_JOBS_MIN_ROWS } from '../../src/cli/parallel.js';
import { startService, type ServiceHandle } from '../fixtures/http-service.js';

const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));
const ABOVE = AUTO_JOBS_MIN_ROWS + 1;

/** Run the CLI on a config and return the rows that reached the file. */
function generate(config: string): readonly string[] {
  const { cfg, out } = write(config);
  execFileSync('node', [CLI, cfg, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
  return readFileSync(out, 'utf8').split('\n').filter(Boolean);
}

/**
 * The same, but ASYNCHRONOUS — for the http case, and not as a style preference.
 *
 * The test service runs inside this process. `execFileSync` blocks its event
 * loop, so the service cannot answer the child's request at all: the run waits
 * the full 30-second client timeout and fails with "did not answer". Measured
 * against a service that serves 100,001 lines in 15 ms, which is how it became
 * clear the fault was in the test and not in the generator.
 */
async function generateAsync(config: string): Promise<readonly string[]> {
  const { cfg, out } = write(config);
  await new Promise<void>((resolve, reject) => {
    execFile('node', [CLI, cfg, '-o', out], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
  return readFileSync(out, 'utf8').split('\n').filter(Boolean);
}

function write(config: string): { cfg: string; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tdc-route-'));
  const cfg = join(dir, 'c.tdc');
  const out = join(dir, 'out.txt');
  writeFileSync(cfg, config);
  return { cfg, out };
}

describe('a memory-engine config above the auto-parallel threshold', () => {
  it('weight= with row= generates every row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-csv-'));
    const csv = join(dir, 'w.csv');
    writeFileSync(csv, 'name,city,weight\nAnn,Rome,5\nBob,Oslo,1\nCid,Lima,3\n');
    const rows = generate(
      `<tdc version="0.1">
  <env count="${String(ABOVE)}" seed="s" local="en">
    <sequence name="N"><gen type="file" src="${csv}" column="name" row="R" weight="weight"/></sequence>
    <sequence name="C"><gen type="file" src="${csv}" column="city" row="R"/></sequence>
  </env>
  <block><line><data>\${{N}} \${{C}}</data></line></block>
</tdc>`,
    );
    expect(rows).toHaveLength(ABOVE);
  });

  it('a template address that interpolates a field generates every row', () => {
    const rows = generate(
      `<tdc version="0.1">
  <env count="${String(ABOVE)}" seed="s" local="en">
    <sequence name="Brand"><gen type="template" value="common.vehicle.brand"/></sequence>
    <sequence name="Model"><gen type="template" value="common.vehicle.model.\${{Brand}}"/></sequence>
  </env>
  <block><line><data>\${{Brand}} \${{Model}}</data></line></block>
</tdc>`,
    );
    expect(rows).toHaveLength(ABOVE);
  });

  /*
   * A REAL pack generator, not one written for the test. `zh-cn.geo.streetName`
   * declares percent="60,20,15,5" over its street types, so it exercises the
   * shape as a user meets it — and the shares are asserted, because the failure
   * this routing prevents is not a crash but every row taking the largest share
   * in silence.
   */
  it('a percent-declaring pack generator keeps its exact shares', () => {
    const rows = generate(
      `<tdc version="0.1">
  <env count="${String(ABOVE)}" seed="s" local="zh-cn">
    <sequence name="S"><gen type="template" value="zh-cn.geo.streetName"/></sequence>
  </env>
  <block><line><data>\${{S}}</data></line></block>
</tdc>`,
    );
    expect(rows).toHaveLength(ABOVE);

    const shares = new Map<string, number>();
    for (const line of rows) {
      // Every type is one character except 大道; the last character identifies
      // each of the four without needing to know the named part.
      const type = line.slice(-1);
      shares.set(type, (shares.get(type) ?? 0) + 1);
    }
    // The Hamilton method is exact, so these are equalities rather than ranges.
    expect(shares.get('路')).toBe(Math.round(ABOVE * 0.6));
    expect(shares.get('街')).toBe(Math.round(ABOVE * 0.2));
    expect(shares.get('道')).toBe(Math.round(ABOVE * 0.15));
    expect(shares.get('巷')).toBe(Math.round(ABOVE * 0.05));
  });

  describe('http', () => {
    let service: ServiceHandle;
    beforeAll(async () => {
      service = await startService({ mode: 'ok' });
    });
    afterAll(async () => {
      await service.close();
    });

    it('generates every row', async () => {
      const rows = await generateAsync(
        `<tdc version="0.1">
  <env count="${String(ABOVE)}" seed="s" local="en">
    <sequence name="V"><gen type="http" src="${service.url}"/></sequence>
  </env>
  <block><line><data>\${{V}}</data></line></block>
</tdc>`,
      );
      expect(rows).toHaveLength(ABOVE);
    });
  });
});
