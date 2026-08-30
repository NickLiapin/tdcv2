/**
 * Parallel generation (`--jobs`).
 *
 * Pure logic (partitioning, the "can we split this?" check) is unit-tested
 * directly. The full worker path — real threads, temp files, ordered
 * concatenation — is covered by an end-to-end test that builds the CLI and
 * runs it, asserting the parallel output is byte-identical to `--jobs 1`.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parquetMetadata, parquetReadObjects } from 'hyparquet';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AUTO_JOBS_MIN_ROWS,
  parallelBlockReason,
  partitionRows,
  resolveJobCount,
} from '../../src/cli/parallel.js';

describe('resolveJobCount — auto thread count', () => {
  const auto = (over: Partial<Parameters<typeof resolveJobCount>[0]>): number =>
    resolveJobCount({
      explicit: undefined,
      canParallelize: true,
      // Symbolic, not a literal: the threshold is a performance judgement and
      // has moved once already. A default of 1_000_000 silently stopped being
      // "big enough" the day it was raised, and every case below went green by
      // returning 1 for the wrong reason.
      count: AUTO_JOBS_MIN_ROWS,
      cores: 8,
      ...over,
    });

  it('an explicit --jobs value is used verbatim (user override wins)', () => {
    expect(resolveJobCount({ explicit: 4, canParallelize: true, count: 1_000_000, cores: 8 })).toBe(
      4,
    );
    // ...even below the auto threshold or on a non-parallelizable config —
    // the caller decides whether an explicit request is actually runnable.
    expect(resolveJobCount({ explicit: 6, canParallelize: false, count: 10, cores: 8 })).toBe(6);
    // explicit --jobs 1 forces single-threaded.
    expect(resolveJobCount({ explicit: 1, canParallelize: true, count: 1_000_000, cores: 8 })).toBe(
      1,
    );
  });

  it('auto uses cores-1 when the config parallelizes and the file is big enough', () => {
    expect(auto({ cores: 8 })).toBe(7);
    expect(auto({ cores: 4 })).toBe(3);
  });

  it('auto stays single-threaded when the config cannot be split', () => {
    expect(auto({ canParallelize: false })).toBe(1);
  });

  it('auto stays single-threaded below the row threshold (overhead not worth it)', () => {
    expect(auto({ count: AUTO_JOBS_MIN_ROWS - 1 })).toBe(1);
    // exactly at the threshold, it parallelizes.
    expect(auto({ count: AUTO_JOBS_MIN_ROWS })).toBe(7);
  });

  it('auto never drops below 1 on 1- or 2-core machines', () => {
    expect(auto({ cores: 1 })).toBe(1); // cores-1 = 0 → clamp to 1
    expect(auto({ cores: 2 })).toBe(1); // cores-1 = 1 → single anyway
  });
});

describe('partitionRows', () => {
  const covers = (count: number, jobs: number): void => {
    const ranges = partitionRows(count, jobs);
    // Contiguous and covering [0, count) with no gaps or overlaps.
    let prev = 0;
    for (const [a, b] of ranges) {
      expect(a).toBe(prev);
      expect(b).toBeGreaterThanOrEqual(a);
      prev = b;
    }
    expect(prev).toBe(count);
    // Balanced: lengths differ by at most 1.
    const lens = ranges.map(([a, b]) => b - a);
    expect(Math.max(...lens) - Math.min(...lens)).toBeLessThanOrEqual(1);
  };

  it('splits evenly and covers the whole range', () => {
    covers(100, 4);
    covers(10, 3); // 4,3,3
    covers(7, 7);
    covers(1000003, 12);
  });

  it('never makes more ranges than rows', () => {
    expect(partitionRows(5, 8)).toHaveLength(5);
    expect(partitionRows(1, 4)).toHaveLength(1);
  });

  it('count=0 yields a single empty range', () => {
    expect(partitionRows(0, 4)).toEqual([[0, 0]]);
  });
});

describe('parallelBlockReason', () => {
  const wrap = (envExtra: string, blockBody: string): string =>
    `<tdc><env count="4" seed="s" inject="\${{%}}" mode="stream">${envExtra}</env><block><line>${blockBody}</line></block></tdc>`;

  it('allows a sequence-only config', () => {
    const src = wrap(
      '<sequence name="G"><gen type="text" value="M,F"/></sequence>',
      '<data>${{G}}</data>',
    );
    expect(parallelBlockReason(src)).toBeUndefined();
  });

  it('blocks an inline <gen> in a block line', () => {
    const src = wrap('', '<gen type="number" value="1..9"/>');
    expect(parallelBlockReason(src)).toMatch(/inline <gen>/i);
  });

  it('blocks uniq="true" on a sequence — nobody can resolve that a row at a time', () => {
    // The rearrangement is of the generators INSIDE one compound column, and a
    // worker resolving row 40,000,000 on its own cannot reproduce it.
    const compound = wrap(
      '<sequence name="K" uniq="true">' +
        '<gen name="a" type="text" value="x,y"/><gen name="b" type="text" value="m,n"/>' +
        '</sequence>',
      '<data>${{K.a}}${{K.b}}</data>',
    );
    expect(parallelBlockReason(compound)).toMatch(/uniq="true"/);
  });

  it('does NOT block an env-level <uniq> group — the arrangement travels', () => {
    /*
     * It used to, and the reason given was that a worker sees only its own
     * range. True of the analysis, not of the rendering: which rows move where
     * is worked out once by the coordinator and handed to every worker as a
     * small map, after which each resolves its own rows without knowing what
     * the others hold.
     *
     * Blocking it cost exactly the configs that most want splitting — a uniq
     * group over millions of rows is the slow case, and it was the one case
     * refused all eleven cores.
     */
    const group = wrap(
      '<uniq><sequence name="A"><gen type="text" value="x,y"/></sequence>' +
        '<sequence name="B"><gen type="text" value="m,n"/></sequence></uniq>',
      '<data>${{A}}${{B}}</data>',
    );
    expect(parallelBlockReason(group)).toBeUndefined();
  });
});

describe('--jobs end-to-end (real worker threads)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, '../..');
  const distMain = join(pkgRoot, 'dist', 'cli', 'main.js');
  let dir = '';

  // An exact percentage, a counter and a compound — each a different way for a
  // worker boundary to go wrong. An env-level `<uniq>` has its own case below,
  // because there the coordinator has to work something out and hand it over
  // rather than every worker deriving the same answer independently.
  const CONFIG = `<tdc>
    <env count="900" seed="par-e2e" inject="\${{%}}" mode="stream">
      <before><line><data>HEAD</data></line></before>
      <after><line><data>TAIL</data></line></after>
      <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
      <sequence name="Id"><gen type="increment" value="1"/></sequence>
      <sequence name="K">
        <gen name="a" type="text" value="a0,a1,a2,a3,a4,a5,a6,a7,a8,a9"/>
        <gen name="b" type="text" value="b0,b1,b2,b3,b4,b5,b6,b7,b8,b9"/>
        <gen name="c" type="text" value="c0,c1,c2,c3,c4,c5,c6,c7,c8,c9"/>
      </sequence>
    </env>
    <block><line><data>\${{Id}},\${{G}},\${{K.a}}\${{K.b}}\${{K.c}}</data></line></block>
  </tdc>`;

  /**
   * Run the CLI and, on failure, surface WHAT went wrong.
   *
   * These cases spawn real worker threads while the rest of the suite runs, so
   * they are the ones most likely to hit resource limits. With `stdio: 'ignore'`
   * a failure reported only "Command failed" — indistinguishable from a genuine
   * regression, which is how the same flake ate four debugging detours in one
   * evening. Capturing stderr costs nothing and makes the next failure readable.
   */
  function runCli(args: readonly string[]): void {
    try {
      execFileSync('node', [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
      throw new Error(
        `${e.message ?? 'CLI failed'}\n--- stderr ---\n${stderr.trim() || '(empty)'}`,
      );
    }
  }

  beforeAll(() => {
    // dist/cli/render-worker.js was compiled by test/global-setup.ts, once,
    // before any worker — not here, where three files raced to write it.
    dir = mkdtempSync(join(tmpdir(), 'tdc-par-e2e-'));
  }, 120_000);

  const run = (jobs: number): string => {
    const cfg = join(dir, 'c.tdc');
    const out = join(dir, `out-${String(jobs)}.csv`);
    writeFileSync(cfg, CONFIG);
    runCli([distMain, cfg, '--jobs', String(jobs), '-o', out]);
    return readFileSync(out, 'utf8');
  };

  it('parallel output is byte-identical to single-threaded', () => {
    const single = run(1);
    expect(run(4)).toBe(single);
    expect(run(7)).toBe(single); // job count must not change output
    // Sanity: fixtures present, every row there, the counter unbroken across
    // the boundaries — a worker that started its own count would show here.
    const lines = single.split('\n').filter(Boolean);
    expect(lines[0]).toBe('HEAD');
    expect(lines[lines.length - 1]).toBe('TAIL');
    const rows = lines.slice(1, -1);
    expect(rows).toHaveLength(900);
    expect(rows.map((l) => l.split(',')[0])).toEqual(
      Array.from({ length: 900 }, (_, i) => String(i + 1)),
    );
    // And the exact 70/30 survives the split, whole-file.
    const males = rows.filter((l) => l.split(',')[1] === 'M').length;
    expect(males).toBe(630);
    // Three whole CLI runs with 1, 4 and 7 worker threads. Every other heavy
    // test in this file carries this budget; this one was left on the 10s
    // default and passed alone while timing out inside the full suite, where
    // the machine is busy — a red run that says nothing about the code.
  }, 120_000);

  it('an env-level <uniq> splits, and every row is still distinct', () => {
    /*
     * The case that used to be refused outright, and the reason the refusal
     * mattered: a uniq group over millions of rows IS the slow config, and it
     * was the one shape denied every core but one.
     *
     * Two things have to hold at once here. The bytes must match the
     * single-threaded run — so the arrangement the coordinator worked out
     * reached every worker intact — and the rows must all be distinct, which is
     * what the config asked for in the first place. A worker that quietly
     * analysed its own range instead would satisfy neither.
     *
     * 40 x 12 = 480 combinations over 400 rows: tight enough that the repair
     * has real work to do, wide enough to be possible.
     */
    const names = Array.from({ length: 40 }, (_, i) => `a${String(i)}`).join(',');
    const cfg = join(dir, 'uniq.tdc');
    writeFileSync(
      cfg,
      `<tdc>
        <env count="400" seed="par-uniq" local="en" mode="disk">
          <uniq>
            <sequence name="A"><gen type="text" value="${names}"/></sequence>
            <sequence name="B"><gen type="text" value="m,n,o,p,q,r,s,t,u,v,w,x"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}-\${{B}}</data></line></block>
      </tdc>`,
    );

    const read = (jobs: number): string => {
      const out = join(dir, `uniq-${String(jobs)}.csv`);
      runCli([distMain, cfg, '--jobs', String(jobs), '-o', out]);
      return readFileSync(out, 'utf8');
    };

    const single = read(1);
    expect(read(5)).toBe(single);
    expect(read(9)).toBe(single);

    const rows = single.split('\n').filter(Boolean);
    expect(rows).toHaveLength(400);
    expect(new Set(rows).size).toBe(400); // what uniq promised
  }, 120_000);

  it('--engine 3 refuses a too-tight uniq under --jobs the way it does single-threaded', () => {
    /*
     * The named-engine rule has to survive the split. `--engine 3` on a uniq
     * too tight for the bounded repair refuses single-threaded — and the
     * parallel coordinator used to render everything with `mode: "disk"`,
     * dropping the FORCED selection on the floor. The repair refusal then
     * took exact-disk's silent in-memory fallback in the coordinator and in
     * every worker: `--engine 3 --jobs 2` wrote engine 1's bytes and exited 0,
     * and on a shape engine 1 could arrange (the medical demo at 8,000,000)
     * that silence was a 16 GB engine-1 run dying on a 4 GB default heap —
     * reported as "engine 3 runs out of memory" when engine 3 never ran.
     */
    const cfg = join(dir, 'tight.tdc');
    writeFileSync(
      cfg,
      `<tdc><env count="4" seed="env-u" local="en"><uniq>` +
        `<sequence name="A"><gen type="text" value="x,y" percent="70,30"/></sequence>` +
        `<sequence name="B"><gen type="text" value="m,n"/></sequence>` +
        `</uniq></env><block><line><data>\${{A}}\${{B}}</data></line></block></tdc>`,
    );
    const out = join(dir, 'tight.csv');
    let stderr = '';
    let failed = false;
    try {
      execFileSync('node', [distMain, cfg, '--engine', '3', '--jobs', '2', '-o', out], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      failed = true;
      const e = err as { stderr?: Buffer | string };
      stderr = typeof e.stderr === 'string' ? e.stderr : (e.stderr?.toString() ?? '');
    }
    expect(failed).toBe(true);
    // The NAMED refusal — not engine 1's capacity message, which would mean
    // the in-memory engine ran under a flag that named a different one.
    expect(stderr).toContain('asked for by name');
  }, 120_000);

  /**
   * The config's OWN settings have to reach the worker, and for a long time
   * they did not. The coordinator built worker parameters from the command
   * line, whose locale defaults to 'en' — so `local="ru"` came back English —
   * and a worker had no pack registry, so it fell back to the bundled set and
   * every installed pack vanished. Neither showed up in a diagnostic, and
   * neither needed a flag: parallelism turns itself on by row count.
   *
   * The e2e case above could not catch it. Its config names no locale, uses no
   * pack and reads no file — the three things that were being dropped.
   */
  it("a worker gets the config's locale, its packs and its relative sources", () => {
    const packs = join(dir, 'packs', 'common', 'custom');
    mkdirSync(packs, { recursive: true });
    writeFileSync(join(packs, 'codes.txt'), 'ALPHA\nBRAVO\nCHARLIE\n');
    writeFileSync(join(dir, 'rows.csv'), 'x\ny\nz\n');
    const cfg = join(dir, 'carry.tdc');
    writeFileSync(
      cfg,
      `<tdc><env count="600" seed="carry" local="ru" mode="stream">` +
        `<sequence name="N"><gen type="template" value="person.lastName"/></sequence>` +
        `<sequence name="C"><gen type="template" value="custom.codes" local="common"/></sequence>` +
        `<sequence name="R"><gen type="file" src="rows.csv"/></sequence>` +
        `</env><block><line><data>\${{N}},\${{C}},\${{R}}</data></line></block></tdc>`,
    );
    const write = (jobs: number): string => {
      const out = join(dir, `carry-${String(jobs)}.csv`);
      runCli([distMain, cfg, '--data-path', join(dir, 'packs'), '--jobs', String(jobs), '-o', out]);
      return readFileSync(out, 'utf8');
    };
    const single = write(1);
    expect(write(4)).toBe(single);

    // Assert on the CONTENT too, not only on the agreement: two runs that both
    // lost the locale would agree with each other perfectly.
    const rows = single.split('\n').filter(Boolean);
    expect(rows).toHaveLength(600);
    expect(rows.every((r) => /^[\u0400-\u04FF]/.test(r))).toBe(true);
    expect(rows.every((r) => /,(ALPHA|BRAVO|CHARLIE),[xyz]$/.test(r))).toBe(true);
  }, 120_000);

  /**
   * `repeat` spends one draw on the row's length and then a FIXED budget of
   * element draws, so a row never depends on how long its predecessors turned
   * out to be. If that budget slipped, rows would desynchronise across worker
   * boundaries and this test would catch it — the whole reason the feature is
   * built that way rather than drawing exactly N.
   */
  it('a repeating gen survives being split across workers', () => {
    const cfg = join(dir, 'rep.tdc');
    const write = (jobs: number): string => {
      const out = join(dir, `rep-${String(jobs)}.csv`);
      writeFileSync(
        cfg,
        `<tdc><env count="20000" seed="rep-par" inject="\${{%}}" mode="stream">` +
          // No `missing` here on purpose: a blanked element and an empty list
          // are the same "" in text, which would make the alignment assertion
          // below ambiguous. Per-element `missing` is covered in
          // test/processor/repeat-values.test.ts against a fixed repeat.
          `<sequence name="V"><gen type="number" value="10..99" repeat="0..5" ` +
          `anomaly="0.05" anomaly_flag="Bad"/></sequence>` +
          `</env><block><line><data>\${{V}};\${{Bad}}</data></line></block></tdc>`,
      );
      runCli([distMain, cfg, '--jobs', String(jobs), '-o', out]);
      return readFileSync(out, 'utf8');
    };
    const single = write(1);
    expect(write(4)).toBe(single);
    expect(write(7)).toBe(single);

    const rows = single.split('\n').filter(Boolean);
    expect(rows).toHaveLength(20000);
    // The label must stay element-aligned with the values on every single row.
    for (const row of rows) {
      const [values, flags] = row.split(';');
      const v = (values ?? '').split(',').filter((s) => s !== '');
      const f = (flags ?? '').split(',').filter((s) => s !== '');
      expect(f.length, row).toBe((values ?? '') === '' ? 0 : (values ?? '').split(',').length);
      expect(
        v.every((x) => /^\d+$/.test(x)),
        row,
      ).toBe(true);
    }
    expect(
      rows.some((r) => r.startsWith(';')),
      'repeat="0.." must yield empty rows',
    ).toBe(true);
  }, 120_000);

  /**
   * A .parquet output must never take the TEXT parallel path — shards of
   * rendered text cannot be concatenated into a structured container. This
   * regressed once: the CLI auto-parallelised a big config and wrote plain
   * text into a .parquet file. It now has its own coordinator (splitting row
   * groups, see the test below), and this guards the plain auto-run.
   */
  it('an auto-parallelised .parquet run is still a valid parquet file', async () => {
    const cfg = join(dir, 'pq.tdc');
    const out = join(dir, 'out.parquet');
    // Above AUTO_JOBS_MIN_ROWS, so the CLI would otherwise auto-parallelise,
    // and above one row group, so the multi-group path is exercised too.
    writeFileSync(
      cfg,
      `<tdc><env count="120000" seed="pq" inject="\${{%}}" mode="stream">` +
        `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
        `<sequence name="V"><gen type="number" value="1..1000" missing="0.1"/></sequence>` +
        `</env><block><line>` +
        `<data name="id">\${{Id}}</data><data name="v">\${{V}}</data>` +
        `</line></block></tdc>`,
    );
    runCli([distMain, cfg, '-o', out]);

    const buf = readFileSync(out);
    expect(buf.subarray(0, 4).toString('latin1')).toBe('PAR1');
    expect(buf.subarray(-4).toString('latin1')).toBe('PAR1');

    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const meta = parquetMetadata(ab);
    expect(Number(meta.num_rows)).toBe(120000);
    expect(meta.row_groups.length).toBeGreaterThan(1); // several row groups
    const rows = (await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(120000);
    expect(rows[0]?.['id']).toBe(1n);
    expect(rows.some((r) => r['v'] === null)).toBe(true); // missing= became real NULLs
  }, 120_000);

  /**
   * Parquet across workers.
   *
   * A row group's bytes are position-independent — page headers carry sizes and
   * every offset lives in the footer — so workers build whole groups and the
   * coordinator lays them end to end with one corrected footer. The split is by
   * GROUP: cutting mid-group would produce groups a single-threaded run never
   * makes, and the outputs would stop matching.
   */
  it('a .parquet output is byte-identical across worker counts', async () => {
    const cfg = join(dir, 'pqpar.tdc');
    const write = (jobs: number): Buffer => {
      const out = join(dir, `pqpar-${String(jobs)}.parquet`);
      writeFileSync(
        cfg,
        `<tdc><env count="130000" seed="pqpar" inject="\${{%}}" mode="stream">` +
          `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
          `<sequence name="C"><gen type="text" value="Moscow,Paris,Berlin" percent="50,30,20"/></sequence>` +
          `<sequence name="V"><gen type="number" value="1..1000" missing="0.1"/></sequence>` +
          `<sequence name="T"><gen type="number" value="1..9" repeat="0..3"/></sequence>` +
          `</env><block><line>` +
          `<data name="id">\${{Id}}</data><data name="c">\${{C}}</data>` +
          `<data name="v">\${{V}}</data><data name="t">\${{T}}</data>` +
          `</line></block></tdc>`,
      );
      runCli([distMain, cfg, '--jobs', String(jobs), '-o', out]);
      return readFileSync(out);
    };

    const single = write(1);
    expect(write(3)).toEqual(single);
    expect(write(8)).toEqual(single);

    // And the parallel file is a real, readable parquet — not merely identical
    // to another file we also produced.
    const buf = write(4);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    const meta = parquetMetadata(ab);
    expect(Number(meta.num_rows)).toBe(130000);
    expect(meta.row_groups.length).toBe(3); // 130k over 50k-row groups
    const rows = (await parquetReadObjects({
      file: { byteLength: ab.byteLength, slice: (s: number, e?: number) => ab.slice(s, e) },
    })) as Record<string, unknown>[];
    expect(rows).toHaveLength(130000);
    // Row ORDER must survive the split, or the groups were reassembled wrong.
    expect(Number(rows[0]?.['id'])).toBe(1);
    expect(Number(rows[49_999]?.['id'])).toBe(50_000);
    expect(Number(rows[50_000]?.['id'])).toBe(50_001); // first row of group 2
    expect(Number(rows[129_999]?.['id'])).toBe(130_000);
    expect(rows.some((r) => r['v'] === null)).toBe(true);
    expect(rows.every((r) => Array.isArray(r['t']))).toBe(true);
  }, 180_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
});
