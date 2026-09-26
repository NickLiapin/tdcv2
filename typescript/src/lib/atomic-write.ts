/**
 * Writing a run's output so a failed run leaves the destination as it found it.
 *
 * The output is written to `<path>.partial` beside the destination and renamed
 * over it only once the run has finished; a run that fails removes the partial
 * file and never touches the destination. The rename is within one directory,
 * so within one filesystem, and therefore atomic: a reader sees the old file or
 * the new one, never half of either.
 *
 * Measured before this module, on all five implementations: a run that failed
 * with `-o out.csv` truncated an existing `out.csv` to nothing — the output of
 * the previous, successful run gone — and one of the five deleted it outright.
 * Parquet was already written this way ("TDC never writes a corrupt file"); text
 * now is too.
 *
 * A symbolic link is resolved first and its TARGET written, so the link stays a
 * link. A destination that exists and is not a regular file (`-o /dev/stdout`, a
 * named pipe) cannot be replaced by a rename, so it is written directly — and so
 * is one whose directory refuses a file beside it (`/dev/stdout` redirected to a
 * file resolves to `/dev/fd/1`, a regular file in a directory nothing can be
 * created in). Both are written exactly as they were before this module.
 */

import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';

/** The partial file beside a destination. */
export function partialPath(path: string): string {
  return `${path}.partial`;
}

/**
 * Where the bytes really go: the file behind a link, and whether it can be
 * replaced by a rename.
 */
function destinationOf(path: string): { readonly target: string; readonly replaceable: boolean } {
  if (!existsSync(path)) return { target: path, replaceable: true };
  const target = realpathSync(path);
  return { target, replaceable: statSync(target).isFile() };
}

/** The partial file opened for writing, or `undefined` when none can be made beside `target`. */
function openPartial(target: string): number | undefined {
  try {
    return openSync(partialPath(target), 'w');
  } catch {
    return undefined;
  }
}

/** `produce` writes to the descriptor it is given; the destination changes only if it returns. */
export function writeAtomicallySync(path: string, produce: (fd: number) => void): void {
  const { target, replaceable } = destinationOf(path);
  const partial = replaceable ? openPartial(target) : undefined;
  if (partial === undefined) {
    // In place, by the name it was given — exactly as before this module.
    const fd = openSync(path, 'w');
    try {
      produce(fd);
    } finally {
      closeSync(fd);
    }
    return;
  }
  const temp = partialPath(target);
  const fd = partial;
  try {
    produce(fd);
    closeSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw err;
  }
  renameSync(temp, target);
}

/** The same, for a producer that awaits. */
export async function writeAtomically(
  path: string,
  produce: (fd: number) => Promise<void>,
): Promise<void> {
  const { target, replaceable } = destinationOf(path);
  const partial = replaceable ? openPartial(target) : undefined;
  if (partial === undefined) {
    // In place, by the name it was given — exactly as before this module.
    const fd = openSync(path, 'w');
    try {
      await produce(fd);
    } finally {
      closeSync(fd);
    }
    return;
  }
  const temp = partialPath(target);
  const fd = partial;
  try {
    await produce(fd);
    closeSync(fd);
  } catch (err) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw err;
  }
  renameSync(temp, target);
}
