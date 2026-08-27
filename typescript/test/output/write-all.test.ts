/**
 * The writer that refuses to hand back a truncated file.
 *
 * `fs.writeSync` is not all-or-nothing: to a pipe it writes whatever fits in
 * the kernel buffer and returns that count. Discarding the return value drops
 * the tail of every batch that did not fit, which is how
 * `tdcv2 big.tdc | gzip > out.gz` once produced 360,448 rows of 1,000,000 and
 * still exited 0. A silently short data file is the worst failure a generator
 * can have, and nothing was testing the loop that prevents it.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeAllSync, writeAllStringSync } from '../../src/output/write-all.js';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tdc-write-all-'));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write through the helper and read the file back as bytes. */
const roundTrip = (name: string, write: (fd: number) => void): Buffer => {
  const path = join(dir, name);
  const fd = openSync(path, 'w');
  try {
    write(fd);
  } finally {
    closeSync(fd);
  }
  return readFileSync(path);
};

describe('writeAllSync', () => {
  it('writes every byte it was given', () => {
    const payload = Buffer.from('the whole thing');
    expect(
      roundTrip('small.bin', (fd) => {
        writeAllSync(fd, payload);
      }),
    ).toEqual(payload);
  });

  it('writes nothing for an empty buffer, and does not hang doing it', () => {
    // The loop condition is `written < length`, so zero must not enter it.
    expect(
      roundTrip('empty.bin', (fd) => {
        writeAllSync(fd, Buffer.alloc(0));
      }),
    ).toHaveLength(0);
  });

  it('takes a Uint8Array as well as a Buffer', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect([
      ...roundTrip('bytes.bin', (fd) => {
        writeAllSync(fd, bytes);
      }),
    ]).toEqual([...bytes]);
  });

  it('carries a payload far past any one write, byte for byte', () => {
    // 4 MiB of a repeating pattern: big enough that a short write is possible,
    // and patterned so a lost or reordered chunk shows up as a mismatch rather
    // than as a length that happens to be right.
    const big = Buffer.alloc(4 << 20);
    for (let i = 0; i < big.length; i++) big[i] = i % 251;
    const back = roundTrip('big.bin', (fd) => {
      writeAllSync(fd, big);
    });
    expect(back).toHaveLength(big.length);
    expect(back.equals(big)).toBe(true);
  });

  it('appends rather than overwriting when called again on the same fd', () => {
    const back = roundTrip('twice.bin', (fd) => {
      writeAllSync(fd, Buffer.from('first '));
      writeAllSync(fd, Buffer.from('second'));
    });
    expect(back.toString()).toBe('first second');
  });
});

describe('writeAllStringSync', () => {
  it('writes text as UTF-8', () => {
    expect(
      roundTrip('utf8.txt', (fd) => {
        writeAllStringSync(fd, 'héllo');
      }).toString('utf8'),
    ).toBe('héllo');
  });

  it('counts BYTES, not characters — the mistake that truncates', () => {
    // A string length is characters; a write length is bytes. Reading one as
    // the other cuts multi-byte text short, and every non-ASCII locale is
    // multi-byte. This value is 5 characters and 10 bytes.
    const text = 'мир жив';
    const back = roundTrip('cyrillic.txt', (fd) => {
      writeAllStringSync(fd, text);
    });
    expect(back.toString('utf8')).toBe(text);
    expect(back.length).toBe(Buffer.byteLength(text, 'utf8'));
    expect(back.length).toBeGreaterThan(text.length);
  });

  it('writes an emoji whole, not half a surrogate pair', () => {
    const text = '🙂 done';
    expect(
      roundTrip('emoji.txt', (fd) => {
        writeAllStringSync(fd, text);
      }).toString('utf8'),
    ).toBe(text);
  });
});
