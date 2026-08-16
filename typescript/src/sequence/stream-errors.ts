/**
 * The refusal the streaming builder raises, in a module of its own.
 *
 * It used to live in `stream-build.ts`, which is where it is thrown from — but
 * `stream-refusals.ts` throws it too, and importing it back out of the file
 * that imports the refusals would close a cycle. A two-line module breaks it,
 * and `stream-build.ts` re-exports the class so every existing importer keeps
 * working.
 */

/** A feature the streaming builder can't do lazily — Engine 3 catches this to fall back. */
export class StreamUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamUnsupportedError';
  }
}
