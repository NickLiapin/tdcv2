/**
 * Memory does not grow with the file — LOCAL ONLY, and the slowest of these.
 *
 * This is the one test whose method matters more than its assertion. It does
 * not measure memory and compare it to a number; it FORBIDS the memory. The
 * run is given a hard heap cap far below what the file size would suggest, and
 * completing at all is the proof. A future appetite cannot hide behind a
 * machine with room to spare — it dies here instead.
 *
 * That method has already earned itself twice. Under a capped heap it caught a
 * generic sort on a typed array quietly boxing two million elements into a
 * number dictionary, and then a repair cap that tripped into an in-memory
 * fallback which cannot hold a hundred-million-row table — a failure that took
 * half an hour to arrive and wrote nothing.
 *
 * Never in CI: see test/heavy/README.md.
 */
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const distMain = join(resolve(here, '../..'), 'dist', 'cli', 'main.js');

/** Free bytes on the volume holding `path`, so a run cannot fill the disk. */
function freeBytes(path: string): number {
  const line = execFileSync('df', ['-k', path]).toString().trim().split('\n').pop() ?? '';
  const columns = line.split(/\s+/);
  return Number(columns[3] ?? 0) * 1024;
}

describe('the heap cap is the proof', () => {
  beforeAll(() => {
    if (process.env['CI']) {
      throw new Error('heavy tests must never run in CI — see test/heavy/README.md');
    }
    if (!existsSync(distMain)) {
      throw new Error(`build first: ${distMain} is missing`);
    }
  });

  it(
    'a 10,000,000-row uniq run completes with the heap capped at 512 MB',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tdc-heavy-mem-'));
      const config = join(dir, 'run.tdc');
      const out = join(dir, 'out.jsonl');

      // The output is around 250 MB and the scratch piles about 130 MB; ask for
      // room to spare rather than discovering the shortfall at minute twenty.
      const needed = 2 * 1024 * 1024 * 1024;
      if (freeBytes(dir) < needed) {
        rmSync(dir, { recursive: true, force: true });
        throw new Error('not enough free disk for the heavy memory test (needs ~2 GB)');
      }

      /*
       * A WIDE space on purpose: 1,000 x 1,000,000 x 1,000 is 10^12
       * combinations for ten million rows, so about fifty collide and the
       * fingerprint path runs to the end.
       *
       * The first version of this test used a narrow one — 400 x 500,000 — and
       * failed under the cap. Not a memory bug: 250,000 collisions tripped the
       * repair cap, the run fell back to the in-memory engine (correct below
       * twenty million rows), and THAT is what would not fit. The test was
       * measuring the fallback rather than the thing it names. A test whose
       * config decides which engine runs has to say which engine it means.
       */
      const values = Array.from({ length: 1000 }, (_, i) => `v${String(i)}`).join(',');
      writeFileSync(
        config,
        `<tdc><env count="10000000" seed="heavy-mem" local="en"><uniq>` +
          `<sequence name="A"><gen type="text" value="${values}"/></sequence>` +
          `<sequence name="B"><gen type="number" value="1..1000000"/></sequence>` +
          `<sequence name="C"><gen type="number" value="1..1000"/></sequence>` +
          `</uniq></env><block><line><data>\${{A}}|\${{B}}|\${{C}}</data></line></block></tdc>\n`,
      );

      try {
        /*
         * 512 MB is well under what the run would take if anything in it scaled
         * with the row count: ten million rows of tuple text alone would be
         * over a gigabyte. Completing means nothing does.
         */
        await execFile('node', [distMain, config, '--jobs', '1', '-o', out], {
          env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=512' },
          maxBuffer: 1 << 20,
        });

        // And it actually produced the file — a run that exits 0 having written
        // nothing would pass a cap check while proving the opposite.
        // Measured at 0.41 GB peak and 66 s on the machine this was written on.
        expect(statSync(out).size).toBeGreaterThan(100 * 1024 * 1024);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    45 * 60 * 1000,
  );
});
