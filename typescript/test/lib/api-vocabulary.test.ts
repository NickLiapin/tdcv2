/**
 * The object a finished run hands back answers to the SAME names in all five
 * implementations.
 *
 * There was no guard on this surface and it drifted: Python had no `to_string`,
 * Java no `toArray`, C# neither `GetAt` nor `Iterate`, Rust neither `to_array`
 * nor `get_at`. Each was reasonable in its own language and wrong for a reader
 * crossing between them — which is the only way this library is ever read,
 * because it exists to be used beside the generator.
 *
 * The fixture is the vocabulary; this test asks the reference to answer to it.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(HERE, '..', '..', '..', 'fixtures', 'cross-language', 'api.json');

interface Member {
  readonly concept: string;
  readonly typescript: string;
}

const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  config: string;
  members: readonly Member[];
  everyReaderKeepsEachAssert: {
    config: string;
    message: string;
    readers: readonly { concept: string; index?: number }[];
  };
};

/** Each reader, read to the end — an iterator that is never drained checks nothing. */
const READERS: Record<string, (tdc: TDC, index: number) => unknown> = {
  'the whole run as text': (tdc) => tdc.toString(),
  'every record, materialised': (tdc) => tdc.toArray(),
  'every record, one at a time': (tdc) => [...tdc.iterate()],
  'one record by position': (tdc, index) => tdc.getAt(index),
  'the run as columns rather than rows': (tdc) => tdc.toColumns(),
};

describe('the shared API vocabulary', () => {
  const tdc = new TDC({ configString: fixture.config });

  for (const member of fixture.members) {
    it(`answers to "${member.typescript}" — ${member.concept}`, () => {
      expect(typeof (tdc as unknown as Record<string, unknown>)[member.typescript]).toBe(
        'function',
      );
    });
  }

  it('the vocabulary is not empty, so a broken fixture cannot pass by saying nothing', () => {
    expect(fixture.members.length).toBeGreaterThan(5);
  });
});

describe('a failing <assert each=> stops every reader', () => {
  const rule = fixture.everyReaderKeepsEachAssert;
  for (const reader of rule.readers) {
    it(reader.concept, () => {
      const read = READERS[reader.concept];
      expect(read, `no reader mapped for "${reader.concept}"`).toBeDefined();
      const tdc = new TDC({ configString: rule.config });
      expect(() => read?.(tdc, reader.index ?? 0)).toThrow(rule.message);
    });
  }
});
