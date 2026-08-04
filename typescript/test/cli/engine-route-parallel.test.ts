/**
 * A config the router runs in memory must not die when the CLI parallelises it.
 *
 * `TDC.resolveEngine()` used to be a second implementation of the router that
 * only chose between Engine 3 and Engine 2, while its own comment claimed to
 * match the renderer. It did not: the renderer sends five shapes to Engine 1,
 * and none of them were asked about here.
 *
 * The cost was a run that worked at 50,000 rows and died at 100,000 — the point
 * where auto-parallelism starts and hands each worker `stream: true`, a FORCED
 * engine with no fallback. The user set no mode=, no engine= and no --jobs, and
 * got "run without a forced streaming engine" for their trouble.
 *
 * The count here straddles AUTO_JOBS_MIN_ROWS on purpose. A test below it would
 * pass against the bug.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AUTO_JOBS_MIN_ROWS } from '../../src/cli/parallel.js';

const CLI = fileURLToPath(new URL('../../dist/cli/main.js', import.meta.url));

describe('a memory-engine config above the auto-parallel threshold', () => {
  it('still generates every row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-route-'));
    const csv = join(dir, 'w.csv');
    writeFileSync(csv, 'name,city,weight\nAnn,Rome,5\nBob,Oslo,1\nCid,Lima,3\n');

    const count = AUTO_JOBS_MIN_ROWS + 1;
    const cfg = join(dir, 'c.tdc');
    writeFileSync(
      cfg,
      `<tdc version="0.1">
  <env count="${String(count)}" seed="s" local="en">
    <sequence name="N"><gen type="file" src="${csv}" column="name" row="R" weight="weight"/></sequence>
    <sequence name="C"><gen type="file" src="${csv}" column="city" row="R"/></sequence>
  </env>
  <block><line><data>\${{N}} \${{C}}</data></line></block>
</tdc>`,
    );

    const out = join(dir, 'out.csv');
    execFileSync('node', [CLI, cfg, '-o', out], { stdio: ['ignore', 'ignore', 'pipe'] });
    const rows = readFileSync(out, 'utf8').split('\n').filter(Boolean).length;
    expect(rows).toBe(count);
  });
});
