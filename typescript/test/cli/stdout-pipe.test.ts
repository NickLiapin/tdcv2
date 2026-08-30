/**
 * Writing to a pipe must deliver every byte.
 *
 * `fs.writeSync` is not all-or-nothing: libuv opens fd 1 non-blocking, so a
 * write to a pipe stops at whatever fits in the kernel buffer and returns that
 * count — or throws EAGAIN once the buffer is full. Both call sites used to
 * discard the return value, so `tdcv2 big.tdc | gzip > out.gz` produced
 * 360,448 of 1,000,000 rows and still exited 0. A truncated data file reported
 * as success is the worst thing this tool can do, and only an end-to-end run
 * through a real pipe can catch it — the bug lives in the syscall's contract,
 * not in any logic a unit test could reach.
 *
 * The config is deliberately wide and the run asks for `--jobs 4` outright:
 * the losing path was the parallel concatenation (`cli/parallel.ts`), and
 * enough bytes must flow to fill the pipe buffer many times over. The job count
 * is explicit rather than inherited from `AUTO_JOBS_MIN_ROWS` — that threshold
 * is a performance judgement and has moved once already, and a test that stops
 * exercising its own subject when a constant changes is worse than no test.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..', '..');
const distMain = join(pkgRoot, 'dist', 'cli', 'main.js');

const ROWS = 200_000; // enough bytes to fill the pipe buffer many times over
const CONFIG = `<tdc>
  <env count="${String(ROWS)}" seed="pipe">
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Pad"><gen type="symbol" alphabet="latin.lower" length="120"/></sequence>
  </env>
  <block><line><data>\${{Id}},\${{Pad}}</data></line></block>
</tdc>`;

describe('stdout is a pipe', () => {
  let dir: string;

  beforeAll(() => {
    // dist/ was compiled by test/global-setup.ts, once, before any worker.
    dir = mkdtempSync(join(tmpdir(), 'tdc-pipe-'));
    writeFileSync(join(dir, 'c.tdc'), CONFIG);
  }, 120_000);

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('delivers every row through a pipe, byte-identical to -o', () => {
    const cfg = join(dir, 'c.tdc');
    const viaFile = join(dir, 'via-file.csv');
    const viaPipe = join(dir, 'via-pipe.csv');

    execFileSync('node', [distMain, cfg, '-o', viaFile], { stdio: ['ignore', 'ignore', 'pipe'] });

    // A shell pipeline, because that is the failing shape: the CLI's stdout is
    // a pipe with another process on the other end, not a file descriptor we
    // opened ourselves.
    const piped = spawnSync(
      'sh',
      ['-c', `node '${distMain}' '${cfg}' --jobs 4 | cat > '${viaPipe}'`],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    expect(piped.status, String(piped.stderr)).toBe(0);

    const expected = readFileSync(viaFile, 'utf8');
    const actual = readFileSync(viaPipe, 'utf8');
    // Row count first: it names the failure ("360448 of 200000") instead of
    // dumping 25 MB of diff when this regresses.
    expect(actual.split('\n').filter(Boolean).length).toBe(ROWS);
    expect(actual).toBe(expected);
  }, 180_000);

  it('survives a slow reader without dropping data or failing', () => {
    const cfg = join(dir, 'c.tdc');
    const out = join(dir, 'via-gzip.csv.gz');
    // gzip drains the pipe far slower than TDC fills it — the case that threw
    // EAGAIN and exited 1 before the write loop existed.
    const r = spawnSync('sh', ['-c', `node '${distMain}' '${cfg}' --jobs 4 | gzip > '${out}'`], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    expect(r.status, String(r.stderr)).toBe(0);

    const lines = spawnSync('sh', ['-c', `gzip -dc '${out}' | wc -l`], { encoding: 'utf8' });
    expect(Number(lines.stdout.trim())).toBe(ROWS);
  }, 180_000);
});
