/**
 * A pack file that resolves but cannot be used — empty list, empty or broken
 * generator body — is reported ONCE, as TDC170, at the `value="…"` that asked
 * for it.
 *
 * That is where the four ports have always reported it (they probe the file on
 * lookup), and where a reader can act on it. The reference used to say it twice
 * and point at nothing: the eager pack scan pushed TDC170 at 1:1 — the top of
 * the config, which names no culprit — and the validator, finding no usable
 * entry under the address, added an "unknown template path" TDC071 for a path
 * that plainly exists on disk. "aborted: 2 errors", both misleading, for one
 * mistake in one file.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';
import { TdcDiagnosticError } from '../../src/errors/TdcDiagnosticError.js';

const roots: string[] = [];

function packRoot(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), 'tdc-unusable-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function diagnosticsOf(source: string, root: string) {
  try {
    new TDC({ configString: source, dataPaths: [root] });
  } catch (err) {
    if (err instanceof TdcDiagnosticError) return err.diagnostics;
    throw err;
  }
  return [];
}

const EMPTY_LIST = '---\ndescription: a list that has no values\nlocale: pl\n---\n';

const CONFIG_HARD =
  '<tdc><env count="2" seed="s" local="pl"><sequence name="V">' +
  '<gen type="template" value="pl.empty.list"/></sequence></env>' +
  '<block><line><data>${{V}}</data></line></block></tdc>';

const CONFIG_SOFT =
  '<tdc><env count="2" seed="s" local="pl"><sequence name="V">' +
  '<gen type="template" value="empty.list"/></sequence></env>' +
  '<block><line><data>${{V}}</data></line></block></tdc>';

describe('a resolved-but-unusable pack is one TDC170 at the value that asked', () => {
  it('an empty list: one error, TDC170, pointing at value= — and no TDC071 echo', () => {
    const root = packRoot({ 'pl/empty/list.txt': EMPTY_LIST });
    const diags = diagnosticsOf(CONFIG_HARD, root);
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TDC170');
    expect(errors[0]?.message).toContain('has no values');
    expect(errors[0]?.message).toContain('pl.empty.list');
    // The caret the ports have always used: the value="…" that asked, not 1:1.
    expect(errors[0]?.line).toBe(1);
    expect(errors[0]?.column).toBeGreaterThan(1);
  });

  it('a soft (locale-relative) address finds the same broken file', () => {
    const root = packRoot({ 'pl/empty/list.txt': EMPTY_LIST });
    const diags = diagnosticsOf(CONFIG_SOFT, root);
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TDC170');
    expect(errors[0]?.message).toContain('has no values');
  });

  it('a generator body that does not parse: same shape, the parser message carried', () => {
    const root = packRoot({
      'pl/gen/broken.tdc':
        '---\ndescription: a generator whose body does not parse\ngenerator: tdc\nlocale: pl\n---\n<gen type="text" value="a,b"\n',
    });
    const diags = diagnosticsOf(CONFIG_HARD.replace('pl.empty.list', 'pl.gen.broken'), root);
    const errors = diags.filter((d) => d.severity === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('TDC170');
    expect(errors[0]?.message).toContain('generator "pl.gen.broken"');
    expect(errors[0]?.column).toBeGreaterThan(1);
  });

  it('a broken pack nobody references stays silent — the ports have always been lazy here', () => {
    const root = packRoot({ 'pl/empty/list.txt': EMPTY_LIST });
    const config =
      '<tdc><env count="1" seed="s" local="en"><sequence name="V">' +
      '<gen type="text" value="a"/></sequence></env>' +
      '<block><line><data>${{V}}</data></line></block></tdc>';
    const diags = diagnosticsOf(config, root);
    expect(diags.filter((d) => d.severity === 'error')).toHaveLength(0);
  });
});

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
