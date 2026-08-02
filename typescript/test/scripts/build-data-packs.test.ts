import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The data-pack builder is the release pipeline for the CDN — a bug here ships
 * broken or mislabelled data to every downloader. So the invariants that matter
 * are pinned: bundles are axis-pure (one language OR one country OR common,
 * never a mash), the index's hashes actually match the zips, the internal
 * layout is what `pack add` expects, and the build is deterministic.
 */

const here = dirname(fileURLToPath(import.meta.url));
const scriptsDir = resolve(here, '../../scripts');
const buildScript = join(scriptsDir, 'build-data-packs.mjs');

interface IndexBundle {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  locale?: string;
  country?: string;
  contents: string[];
}
interface Index {
  schemaVersion: number;
  bundles: IndexBundle[];
}

let out = '';
let index: Index;

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'tdc-buildpacks-'));
  execFileSync(process.execPath, [buildScript, '--out', out], { stdio: 'ignore' });
  index = JSON.parse(readFileSync(join(out, 'index.json'), 'utf8')) as Index;
}, 60_000);

afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

describe('build-data-packs', () => {
  it('builds exactly what the manifest lists', () => {
    expect(index.schemaVersion).toBe(1);
    // Pinned against the MANIFEST, not against a list typed in here. The manifest is itself
    // generated from the packs on disk, so a hand-kept copy of it in a test would go stale the
    // first time a language landed — which is exactly how it went stale before.
    const manifest = JSON.parse(
      readFileSync(resolve(here, '../../../data/bundles.json'), 'utf8'),
    ) as { bundles: { id: string }[] };
    const expected = manifest.bundles.map((b) => b.id).sort();
    expect(index.bundles.map((b) => b.id).sort()).toEqual(expected);
    // A catalogue this size is the point of the axis split; a handful would mean the thresholds
    // silently rejected almost everything.
    expect(expected.length).toBeGreaterThan(50);
    expect(expected).toContain('common');
  });

  it('labels each bundle on exactly one axis (never a language-country mash)', () => {
    const byId = Object.fromEntries(index.bundles.map((b) => [b.id, b]));
    // common: neither language nor country
    expect(byId['common']?.locale).toBeUndefined();
    expect(byId['common']?.country).toBeUndefined();
    // en: a language, no country
    expect(byId['en']?.locale).toBe('en');
    expect(byId['en']?.country).toBeUndefined();
    // usa: a country, no language
    expect(byId['usa']?.country).toBe('usa');
    expect(byId['usa']?.locale).toBeUndefined();
    // no id conflates the two axes
    expect(index.bundles.some((b) => b.id.includes('-'))).toBe(false);
  });

  it('index hashes match the zips they point at', async () => {
    for (const b of index.bundles) {
      const bytes = new Uint8Array(readFileSync(join(out, b.file)));
      expect(bytes.length, b.id).toBe(b.bytes);
      expect(await sha256(bytes), b.id).toBe(b.sha256);
    }
  });

  it('lays each zip out as <id>/packs/… and ships no dotfiles', () => {
    for (const b of index.bundles) {
      const files = unzipSync(new Uint8Array(readFileSync(join(out, b.file))));
      const names = Object.keys(files).filter((n) => !n.endsWith('/'));
      expect(names.length, b.id).toBeGreaterThan(0);
      for (const n of names) {
        expect(n.startsWith(`${b.id}/packs/`), `${b.id}: ${n}`).toBe(true);
        expect(
          n.split('/').some((seg) => seg.startsWith('.')),
          `dotfile ${n}`,
        ).toBe(false);
      }
    }
  });

  it('is deterministic — a second build yields identical hashes', () => {
    const out2 = mkdtempSync(join(tmpdir(), 'tdc-buildpacks2-'));
    try {
      execFileSync(process.execPath, [buildScript, '--out', out2], { stdio: 'ignore' });
      const index2 = JSON.parse(readFileSync(join(out2, 'index.json'), 'utf8')) as Index;
      const hashes = (idx: Index): Record<string, string> =>
        Object.fromEntries(idx.bundles.map((b) => [b.id, b.sha256]));
      expect(hashes(index2)).toEqual(hashes(index));
    } finally {
      rmSync(out2, { recursive: true, force: true });
    }
  }, 60_000);
});
