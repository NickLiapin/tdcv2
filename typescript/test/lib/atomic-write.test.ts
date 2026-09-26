/**
 * A run's output reaches its destination whole, or not at all.
 *
 * The shared CLI fixture pins the case that matters most — a failed run leaves
 * the previous file byte for byte. These pin the edges the fixture cannot reach
 * from a config: a link stays a link, a device is written in place, and a
 * failure halfway through a write takes its partial file with it.
 */

import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { partialPath, writeAtomically, writeAtomicallySync } from '../../src/lib/atomic-write.js';

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'tdc-atomic-'));
}

describe('writing a run atomically', () => {
  it('replaces the destination only when the write finishes', () => {
    const dir = scratch();
    const out = join(dir, 'out.csv');
    writeFileSync(out, 'old\n');
    writeAtomicallySync(out, (fd) => {
      writeSync(fd, 'new\n');
      // Mid-write, the destination is still the old file.
      expect(readFileSync(out, 'utf8')).toBe('old\n');
      expect(existsSync(partialPath(out))).toBe(true);
    });
    expect(readFileSync(out, 'utf8')).toBe('new\n');
    expect(existsSync(partialPath(out))).toBe(false);
  });

  it('a failure halfway leaves the destination as it was and no partial file', () => {
    const dir = scratch();
    const out = join(dir, 'out.csv');
    writeFileSync(out, 'old\n');
    expect(() => {
      writeAtomicallySync(out, (fd) => {
        writeSync(fd, 'half of a ');
        throw new Error('row 3 refused');
      });
    }).toThrow('row 3 refused');
    expect(readFileSync(out, 'utf8')).toBe('old\n');
    expect(existsSync(partialPath(out))).toBe(false);
  });

  it('the same for a producer that awaits', async () => {
    const dir = scratch();
    const out = join(dir, 'out.parquet');
    await expect(
      writeAtomically(out, async (fd) => {
        writeSync(fd, 'PAR1');
        await Promise.resolve();
        throw new Error('column "n" out of range');
      }),
    ).rejects.toThrow('out of range');
    expect(existsSync(out)).toBe(false);
    expect(existsSync(partialPath(out))).toBe(false);
  });

  it('writes through a symbolic link, which stays a link', () => {
    const dir = scratch();
    const real = join(dir, 'real.csv');
    const link = join(dir, 'link.csv');
    writeFileSync(real, 'old\n');
    symlinkSync(real, link);
    writeAtomicallySync(link, (fd) => void writeSync(fd, 'new\n'));
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(real, 'utf8')).toBe('new\n');
    expect(existsSync(partialPath(link))).toBe(false);
  });

  it('writes a device in place — there is nothing to rename onto', () => {
    // `/dev/null` is not a regular file; a partial beside it could not be
    // created and a rename onto it would be wrong. It is written directly.
    expect(() => {
      writeAtomicallySync('/dev/null', (fd) => void writeSync(fd, 'x'));
    }).not.toThrow();
  });
});
