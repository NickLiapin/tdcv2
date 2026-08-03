import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { writeInitConfig } from '../../src/cli/init.js';
import { runPack } from '../../src/cli/pack.js';

/**
 * End to end against a local HTTP registry — a real fflate zip, a real download,
 * a real sha256 check, a real extract and config edit. No external network, so
 * it is deterministic and runs in the default suite. The only thing not covered
 * is the Inquirer menu (needs a TTY); the non-interactive `add`/`list` paths it
 * drives are the same install code.
 */

// A minimal axis-pure bundle laid out like the real ones: a top `<id>/` folder
// holding `packs/`, whose contents are the address path. Everything under that
// prefix, and nothing beside it.
function buildBundleZip(id: string, tree: Record<string, string>): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  const entries: Record<string, Uint8Array> = {};
  for (const [path, body] of Object.entries(tree)) entries[`${id}/packs/${path}`] = enc(body);
  return zipSync(entries);
}

// Two subtrees, like a real locale bundle: the tree a bundle owns is the
// shallowest folder that holds all of it, and one file deep in one branch would
// make that branch the answer rather than the locale.
const EN_TREE: Record<string, string> = {
  'en/person/male/firstName.txt': '---\nlocale: en\n---\nJohn\nPaul\n',
  'en/person/lastName.txt': '---\nlocale: en\n---\nSmith\nJones\n',
  'en/city/name.txt': '---\nlocale: en\n---\nBoston\nAustin\n',
};

// A country bundle lives under the shared `countries/` folder — the one place
// where two bundles' trees meet, and the reason removal goes by record.
const USA_TREE: Record<string, string> = {
  'countries/usa/docs/ssn.txt': '---\naddress: usa.docs.ssn\n---\n001-01-0001\n',
  'countries/usa/finance/routing.txt': '---\naddress: usa.finance.routing\n---\n021000021\n',
};

interface Registry {
  server: Server;
  base: string;
  zipBytes: Uint8Array;
}

async function startRegistry(zips: Record<string, Uint8Array>): Promise<Registry> {
  const index = JSON.stringify({
    schemaVersion: 1,
    bundles: Object.entries(zips).map(([id, bytes]) => ({
      id,
      name: `Test bundle ${id}`,
      description: 'fixture',
      file: `bundles/${id}.zip`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      version: '1.0.0',
      contents: [`packs/${id}`],
    })),
  });

  const server = createServer((req, res) => {
    if (req.url === '/index.json') {
      res.setHeader('content-type', 'application/json');
      res.end(index);
      return;
    }
    const hit = Object.entries(zips).find(([id]) => req.url === `/bundles/${id}.zip`);
    if (hit) {
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', String(hit[1].length));
      res.end(Buffer.from(hit[1]));
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server port');
  const first = Object.values(zips)[0];
  if (first === undefined) throw new Error('no bundles');
  return { server, base: `http://127.0.0.1:${String(addr.port)}`, zipBytes: first };
}

let reg: Registry;
const ID = 'en';
const COUNTRY = 'usa';

beforeAll(async () => {
  reg = await startRegistry({
    [ID]: buildBundleZip(ID, EN_TREE),
    [COUNTRY]: buildBundleZip(COUNTRY, USA_TREE),
  });
});
afterAll(async () => {
  await promisify(reg.server.close.bind(reg.server))();
});

const tmp = (): string => mkdtempSync(join(tmpdir(), 'tdcpackrun-'));

// Isolate from the developer's real global config: point home at the temp dir
// (so the global config path resolves to a non-existent file) and only the
// temp project config drives the store.
const ctx = (
  dir: string,
): { cwd: string; home: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv } => ({
  cwd: dir,
  home: dir,
  platform: 'linux',
  env: {},
});

// Build an initialised project (config + empty store) the way `tdcv2 init` does.
function initProject(dir: string): { cfg: string; store: string } {
  const cfg = join(dir, 'tdcv2.config.json');
  const store = join(dir, 'tdcv2-packs');
  writeInitConfig({ path: cfg, packStore: store, locale: 'en', global: false }, { force: false });
  return { cfg, store };
}

interface Record_ {
  schemaVersion: number;
  bundles: { id: string; paths: string[]; version: string; sha256: string; files: number }[];
}

const readRecord = (store: string): Record_ =>
  JSON.parse(readFileSync(join(store, '.tdcv2-installed.json'), 'utf8')) as Record_;

describe('runPack — add (non-interactive)', () => {
  it('unpacks the address path straight into the store and registers it once', async () => {
    const dir = tmp();
    const { cfg, store } = initProject(dir);

    const code = await runPack(['add', ID, COUNTRY, '--registry', reg.base], ctx(dir));
    expect(code).toBe(0);

    // The address path, directly under the store. No <id>/, no packs/.
    expect(existsSync(join(store, 'en', 'person', 'lastName.txt'))).toBe(true);
    expect(existsSync(join(store, 'countries', 'usa', 'docs', 'ssn.txt'))).toBe(true);
    expect(existsSync(join(store, ID, 'packs'))).toBe(false);
    expect(readdirSync(store).sort()).toEqual(['.tdcv2-installed.json', 'countries', 'en']);

    // Two bundles, ONE dataPaths entry: the store.
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual(['./tdcv2-packs']);
  });

  it('writes down what each bundle owns, its version and its digest', async () => {
    const dir = tmp();
    const { store } = initProject(dir);
    await runPack(['add', ID, COUNTRY, '--registry', reg.base], ctx(dir));

    const record = readRecord(store);
    expect(record.schemaVersion).toBe(1);
    expect(record.bundles.map((b) => b.id)).toEqual(['en', 'usa']); // sorted
    expect(record.bundles[0]?.paths).toEqual(['en']);
    expect(record.bundles[1]?.paths).toEqual(['countries/usa']);
    expect(record.bundles[0]?.files).toBe(3);
    expect(record.bundles[0]?.version).toBe('1.0.0');
    expect(record.bundles[0]?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a second add is idempotent (no duplicate dataPath, no duplicate record)', async () => {
    const dir = tmp();
    const { cfg, store } = initProject(dir);
    await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual(['./tdcv2-packs']);
    expect(readRecord(store).bundles).toHaveLength(1);
  });

  it('refuses an archive carrying anything outside <id>/packs/', async () => {
    const stray = zipSync({
      'x/packs/en/person/lastName.txt': new TextEncoder().encode('Smith\n'),
      'x/sources/lastName.csv': new TextEncoder().encode('Smith,100\n'),
    });
    const server = await startRegistry({ x: stray });
    const dir = tmp();
    const { store } = initProject(dir);
    try {
      expect(await runPack(['add', 'x', '--registry', server.base], ctx(dir))).toBe(2);
      // Nothing scattered into the shared tree.
      expect(readdirSync(store)).toEqual([]);
    } finally {
      await promisify(server.server.close.bind(server.server))();
    }
  });

  it('remove deletes only that bundle, by record, and leaves its neighbour', async () => {
    const dir = tmp();
    const { cfg, store } = initProject(dir);
    await runPack(['add', ID, COUNTRY, '--registry', reg.base], ctx(dir));

    const code = await runPack(['remove', ID], ctx(dir));
    expect(code).toBe(0);
    expect(existsSync(join(store, 'en'))).toBe(false);
    expect(existsSync(join(store, 'countries', 'usa', 'docs', 'ssn.txt'))).toBe(true);
    expect(readRecord(store).bundles.map((b) => b.id)).toEqual(['usa']);
    // Still one bundle in the store, so the store stays registered.
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual(['./tdcv2-packs']);
  });

  it('removing the country takes the shared countries/ folder with it', async () => {
    const dir = tmp();
    const { store } = initProject(dir);
    await runPack(['add', ID, COUNTRY, '--registry', reg.base], ctx(dir));
    await runPack(['remove', COUNTRY], ctx(dir));
    expect(existsSync(join(store, 'countries'))).toBe(false); // no empty shell left
    expect(existsSync(join(store, 'en', 'person', 'lastName.txt'))).toBe(true);
  });

  it('removing the last bundle un-registers the store', async () => {
    const dir = tmp();
    const { cfg } = initProject(dir);
    await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    await runPack(['remove', ID], ctx(dir));
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual([]); // → the bundled default resurfaces
  });

  it('remove of a not-installed bundle is a clean no-op (exit 0)', async () => {
    const dir = tmp();
    initProject(dir);
    expect(await runPack(['remove', ID], ctx(dir))).toBe(0);
  });

  it('fails cleanly on a checksum mismatch and does not register', async () => {
    // A registry whose index advertises the wrong hash for the same zip.
    const badIndex = JSON.stringify({
      schemaVersion: 1,
      bundles: [
        {
          id: ID,
          name: 'X',
          description: 'wrong-hash fixture',
          file: `bundles/${ID}.zip`,
          bytes: reg.zipBytes.length,
          sha256: 'deadbeef'.repeat(8),
          contents: [],
        },
      ],
    });
    const server = createServer((req, res) => {
      if (req.url === '/index.json') res.end(badIndex);
      else res.end(Buffer.from(reg.zipBytes));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const a = server.address();
    if (a === null || typeof a === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${String(a.port)}`;

    const dir = tmp();
    const { cfg } = initProject(dir);
    const code = await runPack(['add', ID, '--registry', base], ctx(dir));
    expect(code).toBe(2); // failure
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toBeUndefined(); // nothing registered
    await promisify(server.close.bind(server))();
  });

  it('rejects an unknown bundle id', async () => {
    const dir = tmp();
    initProject(dir);
    const code = await runPack(['add', 'nope', '--registry', reg.base], ctx(dir));
    expect(code).toBe(2);
  });

  it('errors when no config exists (needs `tdcv2 init` first)', async () => {
    const dir = tmp(); // no init
    const code = await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    expect(code).toBe(2);
  });
});

describe('runPack — list (non-interactive)', () => {
  it('lists the available bundle', async () => {
    const dir = tmp();
    initProject(dir);
    const out: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    // capture stdout for this call
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      out.push(s);
      return true;
    };
    try {
      const code = await runPack(['list', '--registry', reg.base], ctx(dir));
      expect(code).toBe(0);
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    expect(out.join('')).toContain('Test bundle');
  });
});
