/**
 * `packRoots()` names the folders a run reads packs from, so a tool can see
 * the packs a person installed — the ones `scanPacks([bundledPacksDir()])`
 * cannot, because `tdcv2 pack add` puts them in a store only the config names.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TDC, bundledPacksDir, packRoots, scanPacks } from '../../src/index.js';

/** A project whose tdcv2.config.json registers a store holding one pack the bundle lacks. */
function projectWithStore(): {
  readonly root: string;
  readonly project: string;
  readonly config: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'tdc-pack-roots-'));
  const project = join(root, 'project');
  mkdirSync(join(project, 'store', 'zz', 'person'), { recursive: true });
  writeFileSync(join(project, 'tdcv2.config.json'), '{\n  "dataPaths": ["./store"]\n}\n');
  writeFileSync(join(project, 'store', 'zz', 'person', 'lastName.txt'), 'Ivanov\nPetrov\n');
  const config = join(project, 'a.tdc');
  writeFileSync(
    config,
    '<tdc><env count="2" seed="s"><sequence name="L"><gen type="template" value="zz.person.lastName"/></sequence></env><block><line><data>${{L}}</data></line></block></tdc>',
  );
  return { root, project, config };
}

describe('packRoots', () => {
  it('sees a pack installed into the project store — the one a run renders', () => {
    const { root, project, config } = projectWithStore();
    const roots = packRoots({ cwd: root, configFile: config });

    expect(roots).toContain(join(project, 'store'));
    expect(scanPacks(roots).registry.has('zz.person.lastName')).toBe(true);
    // The bundled folder alone does not, which is what this function is for.
    const bundled = bundledPacksDir();
    expect(bundled).toBeDefined();
    expect(scanPacks([bundled ?? '']).registry.has('zz.person.lastName')).toBe(false);
    // And the run agrees: it renders from that very pack.
    const values = new TDC({ configFile: config }).toArray().map((row) => row['L']);
    expect(values.every((v) => v === 'Ivanov' || v === 'Petrov')).toBe(true);
  });

  it('looks for the project from the config file, not from the working directory', () => {
    const { root, project, config } = projectWithStore();
    expect(packRoots({ cwd: root })).not.toContain(join(project, 'store'));
    expect(packRoots({ cwd: root, configFile: config })).toContain(join(project, 'store'));
    expect(packRoots({ cwd: project })).toContain(join(project, 'store'));
  });

  it('puts the bundled packs first and explicit folders last, the order a run gives them', () => {
    const { project } = projectWithStore();
    const extra = join(project, 'extra');
    const roots = packRoots({ cwd: project, dataPaths: [extra] });
    expect(roots[0]).toBe(bundledPacksDir());
    expect(roots.at(-1)).toBe(extra);
    expect(roots.indexOf(join(project, 'store'))).toBeLessThan(roots.indexOf(extra));
  });
});
