import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

/**
 * Every complete config printed in the documentation has to run.
 *
 * This replaces a test that pinned four Russian recipe files, which have moved
 * out of the repository. The target is now the generated docs/ tree, which
 * covers all three languages — and because that tree is produced by the export
 * script, running these configs also proves the converter carried every code
 * block across verbatim enough to execute.
 *
 * Fragments — a bare <sequence>, a <before> snippet, an elision — are not
 * standalone configs and are skipped; only documents with a <tdc> root run.
 */

const FIXED_NOW = new Date('2026-05-04T12:00:00Z').getTime();
const DOCS = fileURLToPath(new URL('../../../docs/', import.meta.url));

/**
 * Examples that are *meant* to fail, because the page is documenting the error.
 * Keyed by the marker that makes them invalid, so a real regression elsewhere
 * still fails the suite.
 */
const DELIBERATELY_INVALID = [
  /version="9\.9\.9"/,
  // The <assert> page shows a run that STOPS, because that is the whole point of
  // the tag. Keyed on the sentence the assertion carries rather than on `assert`
  // itself, so every other example on that page still has to run — and so that
  // editing the sentence re-arms this test loudly rather than exempting it
  // quietly.
  /says="every shipped order should carry a tracking number"/,
];

function markdownFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) markdownFiles(abs, acc);
    else if (name.endsWith('.md')) acc.push(abs);
  }
  return acc;
}

/**
 * A config the engine cannot run WITHOUT SOMETHING ELSE RUNNING TOO.
 *
 * `<gen type="http">` hands the decision to a service over a socket. There is no
 * service here, so such a config cannot execute in a unit test however correct
 * it is — the writing-a-service guide's demo prints real values only while one of
 * that page's own five services is listening on 127.0.0.1:5701.
 *
 * Keyed on the generator rather than on the page, because the reason belongs to
 * the generator: any future documented `http` config is unrunnable here for
 * exactly the same reason, and should not have to be added by hand. The output of
 * these examples is not unchecked — `check-doc-examples.mjs` carries them with a
 * `doc-check: skip` mark naming what has to be listening.
 */
const NEEDS_A_SERVICE = /<gen[^>]*\btype="http"/;

function configsIn(markdown: string): string[] {
  return [...markdown.matchAll(/```xml\n([\s\S]*?)\n```/g)]
    .map((m) => m[1] ?? '')
    .filter((block) => /<tdc[\s>]/.test(block))
    .filter((block) => !DELIBERATELY_INVALID.some((re) => re.test(block)))
    .filter((block) => !NEEDS_A_SERVICE.test(block));
}

const pages = markdownFiles(DOCS)
  .map((file) => ({ file, configs: configsIn(readFileSync(file, 'utf8')) }))
  .filter((p) => p.configs.length > 0);

describe('the documentation runs', () => {
  it('finds configs to check, so an empty docs/ cannot pass silently', () => {
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.reduce((n, p) => n + p.configs.length, 0)).toBeGreaterThan(40);
  });

  it.each(pages.map((p) => [relative(DOCS, p.file), p] as const))('%s', (_name, page) => {
    for (const source of page.configs) {
      const rendered = new TDC({
        configString: source,
        baseDir: dirname(page.file),
        now: FIXED_NOW,
      }).toString();
      expect(rendered.length).toBeGreaterThan(0);
    }
  });
});
