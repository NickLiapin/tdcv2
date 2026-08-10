/**
 * Which engine the router picks — one case per row of the table in
 * `docs/guides/large-outputs.mdx`.
 *
 * The table is a promise about memory: a reader sizing a billion-row run decides
 * from it whether the machine needs 1 GB or 64. Two of its rows named the wrong
 * engine — a `uniq` counter and an env-level `<uniq>` group were listed as
 * in-memory and growing with `count`, while the router has always sent both to
 * the exact on-disk engine, bounded. Nothing could have caught that: the page
 * states the routing in prose, and prose is not run.
 *
 * These assertions are the table. A row that changes here has to change there.
 */

import { describe, expect, it } from 'vitest';

import type { OpenCloseElementContext } from '../../src/generated/TDCParser.js';
import { parse } from '../../src/parser/index.js';
import { resolveEngineSelection, resolveRenderEngine } from '../../src/processor/render.js';
import {
  elementKind,
  elementName,
  extractAttrs,
  findChildElement,
} from '../../src/processor/walk.js';
import { extractEnvUniqGroups, extractSequenceSpecs } from '../../src/sequence/index.js';

/** The engine `mode="disk"` (the default) resolves to for this `<env>` body. */
function engineFor(envBody: string): number {
  const source = `<tdc><env count="5" seed="s" local="en">${envBody}</env><block><line><data>x</data></line></block></tdc>`;
  const { tree, diagnostics } = parse(source);
  // A probe that did not parse would route nothing and pass by accident.
  expect(
    diagnostics,
    `the probe config itself must parse: ${diagnostics[0]?.message ?? ''}`,
  ).toHaveLength(0);

  let tdc: OpenCloseElementContext | undefined;
  for (const el of tree.element()) {
    const kind = elementKind(el);
    if (kind?.kind === 'open' && elementName(kind.node) === 'tdc') tdc = kind.node;
  }
  if (!tdc) throw new Error('the probe must find its own <tdc>');
  const env = findChildElement(tdc.content(), 'env');
  if (!env) throw new Error('the probe must find its own <env>');
  return resolveRenderEngine(
    resolveEngineSelection(extractAttrs(env.attr()), {}),
    extractSequenceSpecs(env),
    extractEnvUniqGroups(env),
  );
}

const DRAWN = '<gen type="number" value="1..1000"/>';

describe('the uniq routing table', () => {
  it('uniq="true" on one drawn column — in-memory', () => {
    expect(engineFor(`<sequence name="K" uniq="true">${DRAWN}</sequence>`)).toBe(1);
  });

  it('uniq="true" on a column composed of a drawn part and literals — in-memory', () => {
    expect(engineFor(`<sequence name="K" uniq="true">${DRAWN}<data>-x</data></sequence>`)).toBe(1);
  });

  it('uniq="true" on a counter — exact on-disk', () => {
    expect(
      engineFor('<sequence name="K" uniq="true"><gen type="increment" value="1"/></sequence>'),
    ).toBe(3);
  });

  it('uniq="true" on a compound sequence — exact on-disk', () => {
    expect(
      engineFor(
        '<sequence name="K" uniq="true"><gen name="A" type="number" value="1..99"/><gen name="B" type="number" value="1..99"/></sequence>',
      ),
    ).toBe(3);
  });

  it('an env-level <uniq> group — exact on-disk', () => {
    expect(
      engineFor(
        `<uniq><sequence name="A">${DRAWN}</sequence><sequence name="B">${DRAWN}</sequence></uniq>`,
      ),
    ).toBe(3);
  });

  it('no form of uniq lands on the fast streaming engine', () => {
    // The page states this in bold, and it is the claim a reader acts on when
    // they reach for uniq on a large run.
    const forms = [
      `<sequence name="K" uniq="true">${DRAWN}</sequence>`,
      `<sequence name="K" uniq="true">${DRAWN}<data>-x</data></sequence>`,
      '<sequence name="K" uniq="true"><gen type="increment" value="1"/></sequence>',
      '<sequence name="K" uniq="true"><gen name="A" type="number" value="1..99"/><gen name="B" type="number" value="1..99"/></sequence>',
      `<uniq><sequence name="A">${DRAWN}</sequence><sequence name="B">${DRAWN}</sequence></uniq>`,
    ];
    for (const form of forms) expect(engineFor(form)).not.toBe(2);
  });
});

describe('what still streams', () => {
  it('a plain drawn column', () => {
    expect(engineFor(`<sequence name="K">${DRAWN}</sequence>`)).toBe(2);
  });

  it('an env-level <distinct> group — distinct is not uniq', () => {
    // distinct asks about the row, not the finished column, so it stays on the
    // fast engine. The uniq claim above must not be read as covering it.
    expect(
      engineFor(
        `<distinct><sequence name="A">${DRAWN}</sequence><sequence name="B">${DRAWN}</sequence></distinct>`,
      ),
    ).toBe(2);
  });
});
