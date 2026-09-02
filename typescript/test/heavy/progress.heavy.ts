/**
 * The progress channel, on a run long enough to watch — LOCAL ONLY.
 *
 * The unit tests pin the shape of a report: phases in order, `done` monotone,
 * every phase closing at its total. What they cannot pin is the thing the
 * channel exists for — that on a real run, one that is silent for minutes, a
 * watcher outside the process can tell "working" from "hung". That needs a run
 * measured in minutes and a file polled from outside, which is why this lives
 * here and not in the suite.
 *
 * Never in CI: see test/heavy/README.md.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const distMain = join(resolve(here, '../..'), 'dist', 'cli', 'main.js');

/** One row of the status file, as a poller sees it. */
interface Status {
  readonly phase: string;
  readonly percent?: number;
  readonly done?: number;
  readonly total?: number;
  readonly updatedAt?: number;
  readonly pid?: number;
  readonly elapsedSeconds?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('the status file on a real run', () => {
  beforeAll(() => {
    if (process.env['CI']) {
      throw new Error('heavy tests must never run in CI — see test/heavy/README.md');
    }
    if (!existsSync(distMain)) {
      throw new Error(`build first: ${distMain} is missing`);
    }
  });

  it(
    'moves through every phase, and its mtime is a heartbeat',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tdc-heavy-progress-'));
      const config = join(dir, 'run.tdc');
      const out = join(dir, 'out.jsonl');
      const status = `${out}.progress`;

      // Two million rows: past the million-row threshold, so the fingerprint
      // phases run and the status file has something to say beyond 'render'.
      const values = Array.from({ length: 60 }, (_, i) => `v${String(i)}`).join(',');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        config,
        `<tdc><env count="2000000" seed="heavy" local="en"><uniq>` +
          `<sequence name="A"><gen type="text" value="${values}"/></sequence>` +
          `<sequence name="B"><gen type="number" value="1..30000"/></sequence>` +
          `<sequence name="C"><gen type="text" value="m,f" percent="60,40"/></sequence>` +
          `</uniq></env><block><line><data>\${{A}}|\${{B}}|\${{C}}</data></line></block></tdc>\n`,
      );

      try {
        const child = execFile('node', [distMain, config, '--jobs', '1', '--progress', '-o', out]);
        /*
         * Subscribe BEFORE polling. The first version waited on 'exit' after
         * the loop, and the run finishes in about twenty-five seconds — so the
         * event had already fired by the time anyone was listening, and the
         * test hung until its own timeout. The listener has to exist before
         * there is anything to miss.
         */
        const finished = new Promise<number>((resolveExit) => {
          child.on('exit', (code) => {
            resolveExit(code ?? -1);
          });
        });

        const seen: Status[] = [];
        const mtimes: number[] = [];

        // Poll from OUTSIDE the process, the way a service or Studio would.
        // Often, because the whole run is half a minute and a phase that is
        // never sampled is a phase this test cannot speak about.
        while (child.exitCode === null) {
          await sleep(300);
          if (!existsSync(status)) continue;
          let parsed: Status;
          try {
            parsed = JSON.parse(readFileSync(status, 'utf8')) as Status;
          } catch {
            // A half-written file would be a bug in the writer; the atomic
            // rename is what makes this loop safe, and a parse failure here
            // would say it is not.
            throw new Error('the status file was readable but not valid JSON');
          }
          const last = seen[seen.length - 1];
          if (last?.phase !== parsed.phase || last.percent !== parsed.percent) {
            seen.push(parsed);
          }
          mtimes.push(statSync(status).mtimeMs);
        }

        expect(await finished).toBe(0);

        const phases = [...new Set(seen.map((s) => s.phase))];

        /*
         * What is pinned is the ORDER, not a fixed first element.
         *
         * This used to assert `phases[0] === 'uniq-scan'`, and it was right until
         * `starting` arrived — a phase written before any work begins, so a watcher
         * can tell "not begun yet" from "died". The engine was correct and this test
         * was five days stale, which nobody saw because the heavy suite is rightly
         * out of CI and its README claimed it cost an hour and 25 GB.
         *
         * Order is also the property worth guarding. The bug behind `starting` was a
         * phase reported OUT of turn — the coordinators primed the file with
         * `render 0%` before spawning anything, so a bar drawn from it ran
         * 0 → 68 → 100 → 0 → 100. A 300 ms poll may miss a short phase; it can never
         * see one arrive early.
         */
        const ORDER = ['starting', 'uniq-scan', 'uniq-sort', 'uniq-repair', 'render', 'done'];
        for (const phase of phases) expect(ORDER).toContain(phase);
        expect(phases).toEqual([...phases].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b)));
        expect(phases).toContain('uniq-scan');
        expect(phases).toContain('uniq-sort');
        expect(phases).toContain('render');
        expect(phases[phases.length - 1]).toBe('done');

        // The heartbeat: the file kept moving while the run did.
        const distinct = new Set(mtimes);
        expect(distinct.size).toBeGreaterThan(3);

        const final = seen[seen.length - 1];
        expect(final?.percent).toBe(100);
        expect(final?.elapsedSeconds).toBeGreaterThan(0);
        expect(final?.pid).toBeGreaterThan(0);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30 * 60 * 1000,
  );

  it(
    "counts a PARALLEL run whole — the percent is the file's, not one worker's",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tdc-heavy-progress-par-'));
      const config = join(dir, 'run.tdc');
      const out = join(dir, 'out.jsonl');
      const status = `${out}.progress`;

      /*
       * The case the channel was half-built for. Above a hundred thousand rows
       * the CLI splits the run across workers by ITSELF, so the parallel path
       * is the ordinary one and the single-threaded one is the exception — and
       * while every worker rendered its own range in silence, the status file
       * went straight from nothing to `done`. An eleven-second run reported one
       * line. This is the test that would have said so.
       *
       * No `<uniq>`: this is about the render phase being summed across workers,
       * and a wide uniq group would spend most of the run in the scan instead.
       */
      const values = Array.from({ length: 1000 }, (_, i) => `v${String(i)}`).join(',');
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        config,
        `<tdc><env count="8000000" seed="heavy-par" local="en">` +
          `<sequence name="A"><gen type="text" value="${values}"/></sequence>` +
          `<sequence name="B"><gen type="number" value="1..1000000"/></sequence>` +
          `</env><block><line><data>\${{A}}|\${{B}}</data></line></block></tdc>\n`,
      );

      try {
        // `--jobs 4`, named rather than left to the machine: the point is that
        // FOUR workers are summed, and a test that let the host decide would
        // prove nothing on a single-core runner.
        const child = execFile('node', [distMain, config, '--jobs', '4', '--progress', '-o', out]);
        const finished = new Promise<number>((resolveExit) => {
          child.on('exit', (code) => {
            resolveExit(code ?? -1);
          });
        });

        const seen: Status[] = [];
        while (child.exitCode === null) {
          await sleep(250);
          if (!existsSync(status)) continue;
          const parsed = JSON.parse(readFileSync(status, 'utf8')) as Status;
          const last = seen[seen.length - 1];
          if (last?.phase !== parsed.phase || last.done !== parsed.done) seen.push(parsed);
        }
        expect(await finished).toBe(0);

        const rendering = seen.filter((s) => s.phase === 'render');
        // More than the two a silent parallel run would produce: the opening
        // mark and whatever landed at the end.
        expect(rendering.length).toBeGreaterThan(3);

        // Every count is the WHOLE file's, so it is bounded by the row count —
        // a worker's own numbers would have topped out at a quarter of it, and
        // summing deltas twice would have overshot it.
        for (const report of rendering) {
          expect(report.total).toBe(8_000_000);
          expect(report.done).toBeLessThanOrEqual(8_000_000);
        }
        // And it really got past one worker's share, which is what "whole" means.
        const highest = Math.max(...rendering.map((r) => r.done ?? 0));
        expect(highest).toBeGreaterThan(8_000_000 / 4);

        const final = seen[seen.length - 1];
        expect(final?.phase).toBe('done');
        expect(final?.percent).toBe(100);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30 * 60 * 1000,
  );
});
