/**
 * CLI entry point tests.
 *
 * We call the exported `main()` directly instead of spawning the
 * binary — faster, and we can capture stdout/stderr by stubbing
 * `process.stdout.write` and `process.stderr.write` for the duration
 * of each test.
 */

import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cliIo, isDirectInvocation, main } from '../../src/cli/main.js';

const TINY = `<tdc><env count="3" seed="cli" inject="\${{%}}"></env><block><line><data>row \${{_count}}</data></line></block></tdc>`;

let stdoutBuf = '';
let stderrBuf = '';
let tmpFiles: string[] = [];

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  tmpFiles = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  });
  // Rendered stdout goes through cliIo.writeStdout (synchronous fd-1 write).
  vi.spyOn(cliIo, 'writeStdout').mockImplementation((data: string) => {
    stdoutBuf += data;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeTmp(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdc-cli-'));
  const p = join(dir, name);
  writeFileSync(p, contents);
  tmpFiles.push(p);
  return p;
}

describe('CLI — exit codes and basic output', () => {
  it('--help exits 0 and prints usage', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('Usage');
  });

  it('-h exits 0 and prints usage', async () => {
    const code = await main(['-h']);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('Usage');
  });

  it('--version exits 0 and prints a semver-shaped version', async () => {
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/tdcv2 \d+\.\d+\.\d+/);
  });

  it('-v exits 0 and prints a semver-shaped version', async () => {
    const code = await main(['-v']);
    expect(code).toBe(0);
    expect(stdoutBuf).toMatch(/tdcv2 \d+\.\d+\.\d+/);
  });

  it('with no input argument exits 2 and prints usage hint', async () => {
    const code = await main([]);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('tdcv2 --help');
  });

  it('unknown option exits 2', async () => {
    const code = await main(['--not-a-real-flag']);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('unknown option');
  });

  it('missing option value exits 2', async () => {
    const code = await main(['--data-path']);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('missing value for --data-path');
  });

  it('invalid --count exits 2 before rendering', async () => {
    const code = await main(['--count', 'abc']);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('invalid --count "abc"');
  });

  it('unexpected extra input exits 2', async () => {
    const code = await main(['first.xml', 'second.xml']);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('unexpected positional argument');
  });

  it('recognizes npm bin symlinks as direct invocation', () => {
    const modulePath = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'tdc-cli-bin-'));
    const link = join(dir, 'tdc');
    symlinkSync(modulePath, link);

    expect(isDirectInvocation(link, pathToFileURL(modulePath).href)).toBe(true);
  });
});

describe('CLI — rendering', () => {
  it('prints rendered output to stdout by default', async () => {
    const p = writeTmp('a.xml', TINY);
    const code = await main([p]);
    expect(code).toBe(0);
    expect(stdoutBuf).toBe('row 1\nrow 2\nrow 3\n');
  });

  it('writes output to the file given with -o', async () => {
    const inP = writeTmp('b.xml', TINY);
    const outP = `${inP}.out`;
    const code = await main([inP, '-o', outP]);
    expect(code).toBe(0);
    expect(readFileSync(outP, 'utf8')).toBe('row 1\nrow 2\nrow 3\n');
  });

  it('writes output to the file given with --output', async () => {
    const inP = writeTmp('b-long.xml', TINY);
    const outP = `${inP}.out`;
    const code = await main([inP, '--output', outP]);
    expect(code).toBe(0);
    expect(readFileSync(outP, 'utf8')).toBe('row 1\nrow 2\nrow 3\n');
  });

  it('accepts long options in --name=value form', async () => {
    const inP = writeTmp('b-equals.xml', TINY);
    const outP = `${inP}.out`;
    const code = await main([inP, `--output=${outP}`, '--count=1', '--seed=cli']);
    expect(code).toBe(0);
    expect(readFileSync(outP, 'utf8')).toBe('row 1\n');
  });

  it('--count overrides env count', async () => {
    const p = writeTmp('c.xml', TINY);
    const code = await main([p, '--count', '1']);
    expect(code).toBe(0);
    expect(stdoutBuf).toBe('row 1\n');
  });

  it('--data-path makes @data file sources available to CLI configs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tdc-cli-data-'));
    const dataDir = join(root, 'data');
    mkdirSync(dataDir);
    writeFileSync(join(dataDir, 'names.txt'), 'Ann\nBob\n');
    const input = join(root, 'config.tdc');
    writeFileSync(
      input,
      `<tdc>
        <env count="2" seed="cli-data" inject="\${{%}}">
          <sequence name="Name"><gen type="file" src="@data/names.txt"/></sequence>
        </env>
        <block><line><data>\${{Name}}</data></line></block>
      </tdc>`,
    );

    const code = await main([input, '--data-path', dataDir]);

    expect(code).toBe(0);
    const rows = stdoutBuf.trim().split('\n');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row === 'Ann' || row === 'Bob')).toBe(true);
  });

  it('bad DSL input exits 1 and prints formatted diagnostics with location', async () => {
    const p = writeTmp('bad.xml', '<tdc><env>');
    const code = await main([p]);
    expect(code).toBe(1);
    // The formatted block uses "error:" / "error[CODE]:" header and a
    // Rust-style `-->` location line pointing at the input file.
    expect(stderrBuf).toMatch(/error(\[TDC\d+\])?:/);
    expect(stderrBuf).toContain(' --> ');
    expect(stderrBuf).toContain('bad.xml');
    expect(stderrBuf).toContain('aborted:');
  });

  it('runtime file errors exit 1 with a concise CLI error', async () => {
    const missing = join(tmpdir(), `tdc-missing-${String(Date.now())}.xml`);
    const code = await main([missing]);
    expect(code).toBe(1);
    expect(stderrBuf).toContain('tdcv2:');
    expect(stderrBuf).toContain('ENOENT');
  });
});

describe('CLI — format command', () => {
  const MESSY = `<tdc><env count="2"    seed="s"><sequence name="N"><gen type="text" value="a,b"/></sequence></env><block><line><data>\${{N}}</data></line></block></tdc>`;

  it('format <file> prints the formatted config to stdout (exit 0)', async () => {
    const p = writeTmp('m.tdc', MESSY);
    const code = await main(['format', p]);
    expect(code).toBe(0);
    expect(stdoutBuf).toContain('\n    <env count="2" seed="s">'); // reindented, tidy attrs
    expect(stdoutBuf).toContain('<line><data>${{N}}</data></line>');
  });

  it('format -w rewrites the file in place (exit 0)', async () => {
    const p = writeTmp('m.tdc', MESSY);
    const code = await main(['format', '-w', p]);
    expect(code).toBe(0);
    expect(stderrBuf).toContain('formatted');
    const after = readFileSync(p, 'utf8');
    expect(after).toContain('\n    <env count="2" seed="s">');
    expect(after).not.toBe(MESSY);
  });

  it('format on a syntactically broken file exits 1 and leaves it untouched', async () => {
    const p = writeTmp('bad.tdc', '<tdc><env><gen></tdc>');
    const code = await main(['format', '-w', p]);
    expect(code).toBe(1);
    expect(readFileSync(p, 'utf8')).toBe('<tdc><env><gen></tdc>');
  });

  it('format with no file exits 2', async () => {
    const code = await main(['format']);
    expect(code).toBe(2);
    expect(stderrBuf).toContain('file is required');
  });
});
