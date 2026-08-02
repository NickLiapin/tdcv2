import type { ParserRuleContext } from 'antlr4ng';
import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { elementKind } from '../../src/processor/walk.js';
import {
  attrNameRange,
  attrValueRange,
  nodePos,
  nodeRange,
  tokenPos,
  tokenRange,
} from '../../src/errors/source-map.js';
import type { AttrContext } from '../../src/generated/TDCParser.js';

function firstTdc(source: string) {
  const tree = parseStrict(source);
  const first = tree.element()[0];
  if (!first) throw new Error('missing first element');
  const kind = elementKind(first);
  if (kind?.kind !== 'open') throw new Error('expected open element');
  return kind.node;
}

describe('source-map helpers', () => {
  it('extracts node and token positions from real parse-tree contexts', () => {
    const tdc = firstTdc('<tdc>\n  <env count="5"></env>\n</tdc>');
    const envElement = tdc.content().element()[0];
    if (!envElement) throw new Error('missing env');
    const envKind = elementKind(envElement);
    if (envKind?.kind !== 'open') throw new Error('expected env');

    const start = envKind.node.start;
    if (!start) throw new Error('missing env start token');

    expect(nodePos(envKind.node)).toEqual({ line: 2, column: 2 });
    expect(nodeRange(envKind.node)).toMatchObject({ line: 2, column: 2, endLine: 2 });
    expect(tokenPos(start)).toEqual({ line: 2, column: 2 });
    expect(tokenRange(start)).toMatchObject({ line: 2, column: 2 });
  });

  it('points attrValueRange inside the surrounding quotes', () => {
    const tdc = firstTdc('<tdc>\n  <env count="5"></env>\n</tdc>');
    const envElement = tdc.content().element()[0];
    if (!envElement) throw new Error('missing env');
    const envKind = elementKind(envElement);
    if (envKind?.kind !== 'open') throw new Error('expected env');

    const countAttr = envKind.node.attr()[0];
    if (!countAttr) throw new Error('missing count attr');

    expect(attrNameRange(countAttr)).toMatchObject({ line: 2, column: 7, endColumn: 12 });
    expect(attrValueRange(countAttr)).toEqual({
      line: 2,
      column: 14,
      endLine: 2,
      endColumn: 15,
    });
  });

  it('handles fallback paths for malformed or synthetic contexts', () => {
    const syntheticNode = { start: undefined, stop: undefined } as unknown as ParserRuleContext;
    expect(nodePos(syntheticNode)).toEqual({ line: 1, column: 0 });
    expect(nodeRange(syntheticNode)).toEqual({
      line: 1,
      column: 0,
      endLine: 1,
      endColumn: 1,
    });

    const syntheticAttr = {
      start: undefined,
      stop: undefined,
      _attrName: undefined,
      _attrValue: undefined,
    } as unknown as AttrContext;
    expect(attrNameRange(syntheticAttr)).toEqual({
      line: 1,
      column: 0,
      endLine: 1,
      endColumn: 1,
    });
    expect(attrValueRange(syntheticAttr)).toEqual({
      line: 1,
      column: 0,
      endLine: 1,
      endColumn: 1,
    });
  });
});
