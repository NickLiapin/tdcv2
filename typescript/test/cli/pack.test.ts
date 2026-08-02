import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
// holding `packs/` (a scan root). A file outside `packs/` must still extract but
// stay unregistered — represented here by a `sources/` entry.
function buildBundleZip(id: string): Uint8Array {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  return zipSync({
    [`${id}/packs/en/person/male/firstName.txt`]: enc('---\nlocale: en\n---\nJohn\nPaul\n'),
    [`${id}/packs/en/person/lastName.txt`]: enc('---\nlocale: en\n---\nSmith\nJones\n'),
    [`${id}/sources/person/lastName.csv`]: enc('Smith,100\nJones,90\n'),
  });
}

interface Registry {
  server: Server;
  base: string;
  zipBytes: Uint8Array;
}

async function startRegistry(id: string): Promise<Registry> {
  const zipBytes = buildBundleZip(id);
  const sha256 = createHash('sha256').update(zipBytes).digest('hex');
  const index = JSON.stringify({
    schemaVersion: 1,
    bundles: [
      {
        id,
        name: 'Test bundle',
        description: 'fixture',
        file: `bundles/${id}.zip`,
        bytes: zipBytes.length,
        sha256,
        locale: 'en',
        contents: ['packs/en'],
      },
    ],
  });

  const server = createServer((req, res) => {
    if (req.url === '/index.json') {
      res.setHeader('content-type', 'application/json');
      res.end(index);
    } else if (req.url === `/bundles/${id}.zip`) {
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-length', String(zipBytes.length));
      res.end(Buffer.from(zipBytes));
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no server port');
  return { server, base: `http://127.0.0.1:${String(addr.port)}`, zipBytes };
}

let reg: Registry;
const ID = 'en';

beforeAll(async () => {
  reg = await startRegistry(ID);
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

describe('runPack — add (non-interactive)', () => {
  it('downloads, verifies, extracts, and registers the pack root', async () => {
    const dir = tmp();
    const { cfg, store } = initProject(dir);

    const code = await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    expect(code).toBe(0);

    // Files extracted under <store>/<id>/…
    expect(existsSync(join(store, ID, 'packs', 'en', 'person', 'lastName.txt'))).toBe(true);
    expect(existsSync(join(store, ID, 'sources', 'person', 'lastName.csv'))).toBe(true);

    // Config now points dataPaths at the bundle's packs root (relative).
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual([`./tdcv2-packs/${ID}/packs`]);
  });

  it('a second add is idempotent (no duplicate dataPath)', async () => {
    const dir = tmp();
    const { cfg } = initProject(dir);
    await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual([`./tdcv2-packs/${ID}/packs`]);
  });

  it('remove deletes the store folder and un-registers the dataPath', async () => {
    const dir = tmp();
    const { cfg, store } = initProject(dir);
    await runPack(['add', ID, '--registry', reg.base], ctx(dir));
    expect(existsSync(join(store, ID))).toBe(true);

    const code = await runPack(['remove', ID], ctx(dir));
    expect(code).toBe(0);
    expect(existsSync(join(store, ID))).toBe(false); // folder gone
    const after = JSON.parse(readFileSync(cfg, 'utf8')) as { dataPaths?: string[] };
    expect(after.dataPaths).toEqual([]); // dataPath dropped → bundled default resurfaces
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
