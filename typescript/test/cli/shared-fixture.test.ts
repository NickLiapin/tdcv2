/**
 * The shared CLI fixture, run against the reference implementation.
 *
 * `fixtures/cross-language/cli.json` is the command line's contract, and the Java and Python
 * implementations run the same file. Tests written separately for each language can agree with
 * themselves and still disagree with each other; this is the only kind that cannot.
 *
 * The cases were derived from the other files in this folder, so this does not replace them — it
 * pins the part of their behaviour that three implementations have to share.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { VERSION } from '../../src/version.js';
import { cliIo, main } from '../../src/cli/main.js';
import { runInit } from '../../src/cli/init.js';

interface FixtureCase {
  readonly name: string;
  /** Why this case exists, for a reader who did not write it. */
  readonly note?: string;
  readonly command?: string;
  readonly files?: Record<string, string>;
  readonly registry?: boolean;
  readonly argv: readonly string[];
  readonly exit: number;
  readonly stdout?: string;
  readonly stdoutContains?: readonly string[];
  readonly stdoutMatches?: string;
  readonly stderr?: string;
  readonly stderrContains?: readonly string[];
  readonly wrote?: Record<string, string>;
  readonly wroteContains?: Record<string, readonly string[]>;
  readonly only?: readonly string[];
}

interface Fixture {
  readonly configs: Record<string, string>;
  readonly cases: readonly FixtureCase[];
  readonly gaps: Record<string, string>;
}

const FIXTURE_PATH = join(
  dirname(new URL(import.meta.url).pathname),
  '../../../fixtures/cross-language/cli.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;

/** A case runs here unless it names implementations and this is not one of them. */
const CASES = FIXTURE.cases.filter((c) => !c.only || c.only.includes('typescript'));
const SKIPPED = FIXTURE.cases.filter((c) => c.only && !c.only.includes('typescript'));

let stdoutBuf = '';
let stderrBuf = '';

beforeEach(() => {
  stdoutBuf = '';
  stderrBuf = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutBuf += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrBuf += String(chunk);
    return true;
  });
  vi.spyOn(cliIo, 'writeStdout').mockImplementation((data: string) => {
    stdoutBuf += data;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The demo registry every implementation's runner builds, byte for byte the same. */
function buildRegistry(root: string): string {
  // A stored (uncompressed) zip written by hand, 182 bytes.
  //
  // Its LENGTH is part of the contract now, not just its contents: `pack list`
  // prints a real size, and a fixture case compares that line byte for byte. So
  // every runner has to produce the same archive — the ones using a standard
  // library zip writer ask it for STORED explicitly, because a deflated entry
  // is a different length and the divergence used to hide behind `0.0 MB`.
  const name = 'demo/packs/demo/person/lastName.txt';
  const body = Buffer.from('Ivanov\nPetrov\n', 'utf8');
  const nameBuf = Buffer.from(name, 'utf8');
  const crc = crc32(body);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(body.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(body.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);

  const localPart = Buffer.concat([local, nameBuf, body]);
  const centralPart = Buffer.concat([central, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);

  const zip = Buffer.concat([localPart, centralPart, end]);

  mkdirSync(join(root, 'bundles'), { recursive: true });
  writeFileSync(join(root, 'bundles/demo.zip'), zip);
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: 'demo',
          name: 'Demo pack',
          description: 'two surnames',
          file: 'bundles/demo.zip',
          bytes: zip.length,
          sha256: createHash('sha256').update(zip).digest('hex'),
          locale: 'demo',
        },
      ],
    }),
  );

  // A second, deliberately broken registry beside the honest one: the same archive, advertised at
  // a size it does not have. It lives under its own path so the honest catalogue — which cases
  // assert byte for byte — keeps listing exactly one bundle.
  mkdirSync(join(root, 'broken/bundles'), { recursive: true });
  writeFileSync(join(root, 'broken/bundles/demo.zip'), zip);
  writeFileSync(
    join(root, 'broken/index.json'),
    JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: 'demo',
          name: 'Demo pack',
          description: 'two surnames',
          file: 'bundles/demo.zip',
          bytes: zip.length + 999,
          sha256: createHash('sha256').update(zip).digest('hex'),
          locale: 'demo',
        },
      ],
    }),
  );
  return pathToFileURL(root).href;
}

function crc32(data: Buffer): number {
  let crc = ~0;
  for (const byte of data) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function resolveText(text: string, dir: string, registry: string | undefined): string {
  const withDir = text.split('{dir}').join(dir).split('{version}').join(VERSION);
  return registry === undefined ? withDir : withDir.split('{registry}').join(registry);
}

describe('the shared CLI fixture', () => {
  it('is not empty — a runner that found nothing would pass every implementation', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(25);
    const names = FIXTURE.cases.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('explains every case it skips', () => {
    /*
     * The reference may skip a case, but only in ONE direction: when the other
     * four still do something it has moved past — an old refusal kept here,
     * named, until they are ported. It must never skip because it lacks a
     * feature the others have; that would mean the reference had fallen behind,
     * and this file would be recording the gap in the wrong place.
     *
     * So a skipped case has to name every implementation except this one, and
     * has to say in its note why. Anything else fails here rather than sitting
     * quietly in the fixture.
     */
    const OTHERS = ['csharp', 'java', 'python', 'rust'];
    for (const skipped of SKIPPED) {
      expect([...(skipped.only ?? [])].sort()).toEqual(OTHERS);
      expect(skipped.note ?? '').not.toBe('');
    }
    expect(Object.keys(FIXTURE.gaps).length).toBeGreaterThan(0);
  });

  for (const testCase of CASES) {
    it(testCase.name, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tdc-cli-fixture-'));
      const registry = testCase.registry ? buildRegistry(join(dir, 'registry')) : undefined;

      for (const [name, contents] of Object.entries(testCase.files ?? {})) {
        // A leading @ names one of the shared configs, so a config used by three cases is written
        // once and cannot drift between them.
        const body = contents.startsWith('@') ? FIXTURE.configs[contents.slice(1)] : contents;
        const target = join(dir, name);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, body ?? '');
      }

      const argv = testCase.argv.map((a) => resolveText(a, dir, registry));

      // `init` and `pack` act on a working directory rather than on a named file, so the fixture
      // hands them the temp directory instead of chdir-ing the whole test process into it.
      let code: number;
      if (testCase.command === 'init') {
        code = await runInit(argv, { cwd: dir });
      } else if (testCase.command === 'pack') {
        const { runPack } = await import('../../src/cli/pack.js');
        code = await runPack(argv, { cwd: dir });
      } else {
        code = await main(argv);
      }

      expect(code, `exit code; stderr was:\n${stderrBuf}`).toBe(testCase.exit);

      if (testCase.stdout !== undefined) expect(stdoutBuf).toBe(testCase.stdout);
      for (const fragment of testCase.stdoutContains ?? []) {
        expect(stdoutBuf).toContain(resolveText(fragment, dir, registry));
      }
      if (testCase.stdoutMatches !== undefined) {
        expect(stdoutBuf).toMatch(new RegExp(testCase.stdoutMatches, 'm'));
      }
      if (testCase.stderr !== undefined) {
        expect(stderrBuf).toBe(resolveText(testCase.stderr, dir, registry));
      }
      for (const fragment of testCase.stderrContains ?? []) {
        expect(stderrBuf).toContain(resolveText(fragment, dir, registry));
      }

      for (const [name, contents] of Object.entries(testCase.wrote ?? {})) {
        expect(readFileSync(join(dir, name), 'utf8')).toBe(contents);
      }
      for (const [name, fragments] of Object.entries(testCase.wroteContains ?? {})) {
        const written = readFileSync(join(dir, name), 'utf8');
        for (const fragment of fragments) expect(written).toContain(fragment);
      }
    });
  }
});
