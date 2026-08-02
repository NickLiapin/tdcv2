/**
 * A `writeSync` that actually writes everything.
 *
 * `fs.writeSync` is NOT all-or-nothing. libuv opens a pipe non-blocking, so a
 * write to one stops at whatever fits in the kernel's pipe buffer and returns
 * that count — or throws `EAGAIN` when the buffer is already full. Discarding
 * the return value drops the tail of every batch that did not fit, which is
 * how `tdcv2 big.tdc | gzip > out.gz` produced 360,448 of 1,000,000 rows and
 * still exited 0. Silently handing back a truncated data file is the worst
 * failure a data generator can have, so every write to a descriptor the
 * caller supplied goes through here.
 *
 * Regular files never short-write at these sizes, but the destination is not
 * always knowable at the call site — `-o /dev/stdout`, a FIFO, a process
 * substitution — so the loop is unconditional rather than a pipe special case.
 */

import { writeSync } from 'node:fs';

/** How long the writer sleeps before retrying a destination that had no room. */
const FULL_PIPE_WAIT_MS = 1;

/** A lock nobody ever notifies, so `Atomics.wait` on it is purely a sleep. */
const SLEEP_LOCK = new Int32Array(new SharedArrayBuffer(4));

/**
 * Write every byte of `buf` to `fd`, however many calls that takes.
 *
 * Sleeping between attempts rather than spinning: a slow reader (gzip, psql,
 * split) can keep a pipe full for a long time, and a busy retry would burn a
 * core for the duration. `Atomics.wait` is the only synchronous sleep Node
 * offers, and staying synchronous is the whole point of this path — an async
 * `process.stdout.write` races `process.exit` and buffers without bound,
 * which would break the streaming engine's flat memory.
 */
export function writeAllSync(fd: number, buf: Buffer | Uint8Array): void {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  let written = 0;
  while (written < bytes.length) {
    try {
      written += writeSync(fd, bytes, written, bytes.length - written);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // EAGAIN: the pipe is full, wait for the reader. EINTR: a signal
      // interrupted the call before any byte moved. Both mean "try again".
      if (code !== 'EAGAIN' && code !== 'EINTR') throw err;
      Atomics.wait(SLEEP_LOCK, 0, 0, FULL_PIPE_WAIT_MS);
    }
  }
}

/** The same guarantee for a string, encoded once as UTF-8. */
export function writeAllStringSync(fd: number, text: string): void {
  writeAllSync(fd, Buffer.from(text, 'utf8'));
}
