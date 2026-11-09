/**
 * `fixtures/cross-language/http-batches.json`, run through the reference.
 *
 * The four ports run the same file against their own local service; between them
 * they hold the batch contract — what each request carries, where each answer
 * lands, and what a column reading an answer sees — to one behaviour.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { startService, type ServiceHandle, type ServiceOptions } from '../fixtures/http-service.js';

interface Case {
  readonly name: string;
  readonly service: string;
  readonly config: string;
  readonly requests?: readonly {
    count: number;
    offset: number;
    total: number;
    input: number | null;
  }[];
  readonly output?: string;
  readonly error?: string;
  readonly seeds?: readonly string[];
}

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(
    resolve(here, '..', '..', '..', 'fixtures', 'cross-language', 'http-batches.json'),
    'utf8',
  ),
) as { services: Record<string, string>; cases: Case[] };

/** The services the fixture names, as this suite's test service runs them. */
const SERVICES: Record<string, ServiceOptions> = {
  upper: { transform: (line) => `H${line}` },
  row: { transform: (_line, _i, row) => `r${String(row)}` },
  'row-no-echo': { echoOffset: false, transform: (_line, i) => `r${String(i)}` },
  'upper-no-echo': { echoOffset: false, transform: (line) => `H${line}` },
  'fail-second': {
    mode: 'error-after',
    errorAfterRequests: 1,
    transform: (_line, _i, row) => `r${String(row)}`,
  },
};

let svc: ServiceHandle | undefined;
afterEach(async () => {
  await svc?.close();
  svc = undefined;
});

describe('http-batches.json', () => {
  it('names a service this suite runs for every case', () => {
    expect(Object.keys(SERVICES).sort()).toEqual(Object.keys(FIXTURE.services).sort());
  });

  it.each(FIXTURE.cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
    const options = SERVICES[c.service];
    if (options === undefined) throw new Error(`no service "${c.service}"`);
    svc = await startService(options);
    const url = svc.url;
    const document = parseStrict(c.config.replaceAll('{{SRC}}', url));
    if (c.error !== undefined) {
      expect(() => render(document, {})).toThrow(c.error.replaceAll('{{SRC}}', url));
    } else {
      expect(render(document, {})).toBe(c.output);
    }
    if (c.requests !== undefined) {
      const counts = svc.counts();
      const offsets = svc.offsets();
      const totals = svc.totals();
      const inputs = svc.inputCounts();
      const seen = counts
        .map((count, i) => ({
          count,
          offset: offsets[i],
          total: totals[i],
          input: inputs[i] ?? null,
        }))
        .sort((a, b) => (a.offset ?? 0) - (b.offset ?? 0));
      expect(seen).toEqual(c.requests);
    }
    if (c.seeds !== undefined) {
      expect([...svc.seeds()].sort()).toEqual(c.seeds);
    }
  });
});
