/**
 * Every row of a real file is distinct — counted, not sampled. LOCAL ONLY.
 *
 * The suite proves uniqueness on tables small enough to hold in a Set. That is
 * the wrong size to prove anything about: the machinery that decides
 * uniqueness at scale — fingerprints, piles, the disk ledger, the repair —
 * only engages past a million rows, and the failures it had were all of the
 * kind that a small table cannot express (a cap that trips, a fallback that
 * dies, a hash that collides).
 *
 * So this generates a real file and counts its distinct rows with an external
 * sort, which is the only answer that is not an inference.
 *
 * Never in CI: see test/heavy/README.md.
 */
import { execFile as execFileCb, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const execFile = promisify(execFileCb);
const here = dirname(fileURLToPath(import.meta.url));
const distMain = join(resolve(here, '../..'), 'dist', 'cli', 'main.js');

/** Distinct lines in a file, via the system sort — bounded memory, exact answer. */
function distinctLines(path: string, tmpDir: string): number {
  const sorted = execFileSync('sh', [
    '-c',
    `LC_ALL=C sort -u -S 1G -T ${JSON.stringify(tmpDir)} ${JSON.stringify(path)} | wc -l`,
  ]);
  return Number(sorted.toString().trim());
}

function countLines(path: string): number {
  return Number(
    execFileSync('sh', ['-c', `wc -l < ${JSON.stringify(path)}`])
      .toString()
      .trim(),
  );
}

describe('a real file, counted', () => {
  beforeAll(() => {
    if (process.env['CI']) {
      throw new Error('heavy tests must never run in CI — see test/heavy/README.md');
    }
    if (!existsSync(distMain)) {
      throw new Error(`build first: ${distMain} is missing`);
    }
  });

  it(
    'every row of a 2,000,000-row uniq run is distinct, and threads do not change the bytes',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tdc-heavy-uniq-'));
      const config = join(dir, 'run.tdc');
      const single = join(dir, 'single.jsonl');
      const parallel = join(dir, 'parallel.jsonl');

      // Deliberately tight: 60 x 30,000 x 2 is 3.6M combinations for 2M rows,
      // so the run collides in the tens of thousands and the repair — the part
      // that had the cap and the fallback bugs — really runs.
      const values = Array.from({ length: 60 }, (_, i) => `v${String(i)}`).join(',');
      writeFileSync(
        config,
        `<tdc><env count="2000000" seed="heavy-uniq" local="en"><uniq>` +
          `<sequence name="A"><gen type="text" value="${values}"/></sequence>` +
          `<sequence name="B"><gen type="number" value="1..30000"/></sequence>` +
          `<sequence name="C"><gen type="text" value="m,f" percent="60,40"/></sequence>` +
          `</uniq></env><block><line><data>\${{A}}|\${{B}}|\${{C}}</data></line></block></tdc>\n`,
      );

      try {
        await execFile('node', [distMain, config, '--jobs', '1', '-o', single], {
          maxBuffer: 1 << 20,
        });
        expect(countLines(single)).toBe(2_000_000);
        // The claim, counted rather than assumed.
        expect(distinctLines(single, dir)).toBe(2_000_000);

        // And the thread count is a speed knob, not a content one.
        await execFile('node', [distMain, config, '--jobs', '6', '-o', parallel], {
          maxBuffer: 1 << 20,
        });
        execFileSync('cmp', [single, parallel]);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30 * 60 * 1000,
  );
});
