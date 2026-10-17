/**
 * `<block>` and what it holds: `<line>`s, and `<group>`s of them.
 *
 * Lives apart from `validate.ts` because that file is at its 1000-line ceiling, and because the
 * output side is a unit of its own: a line's text, its conditions, and the names they may read.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────────────────────────
 *
 * A `<group each="Depts">` puts its element in scope for every line inside it, nested groups
 * included, so `${{Depts.name}}` and `if="Doctors.dept.id == Depts.id"` are names there. The scope
 * is carried down as a list: what the enclosing groups publish, plus what the line itself walks.
 */

import { type Diagnostic, nodeRange } from '../errors/index.js';
import type {
  AttrContext,
  ContentContext,
  OpenCloseElementContext,
} from '../generated/TDCParser.js';
import {
  contentElements,
  elementKind,
  extractAttrs,
  extractDataAttrs,
  extractDataText,
} from '../processor/walk.js';

import { checkData } from './data-element.js';
import { checkBlockDataRefs } from './data-refs.js';
import { checkLineConditionalColumns, checkLineEach, eachNames } from './each.js';
import { checkIfExpression } from './expr-check.js';
import { childNode, childTagName, reportMisplaced } from './placement.js';

/** What the block checks need from the validator's context, declared structurally. */
export interface BlockCheckCtx {
  readonly diagnostics: Diagnostic[];
  readonly inject: string;
  readonly declaredSequences: readonly string[];
  readonly repeatingSequences: readonly string[];
  readonly poolFields: ReadonlyMap<string, readonly string[]>;
  readonly poolReferences: readonly string[];
  readonly listSeparators: ReadonlyMap<string, string>;
  rememberExpression(attr: AttrContext, expr: string, eachBuiltins?: readonly string[]): void;
}

/** The names the groups around a line publish, and the lists they walk. */
interface OutputScope {
  readonly names: readonly string[];
  /** Walked lists, whose names mean the current ELEMENT inside — `| json` takes it as one value. */
  readonly walked: readonly string[];
}

const TOP: OutputScope = { names: [], walked: [] };

function findAttr(attrs: readonly AttrContext[], name: string): AttrContext | undefined {
  for (const a of attrs) {
    if (a._attrName?.text === name) return a;
  }
  return undefined;
}

export function checkBlock(blockEl: OpenCloseElementContext, ctx: BlockCheckCtx): void {
  checkItems(blockEl.content(), 'block', ctx, TOP);
}

/** The `<line>`s and `<group>`s of a block or a group; anything else is misplaced. */
function checkItems(
  content: ContentContext | null,
  parent: string,
  ctx: BlockCheckCtx,
  scope: OutputScope,
): void {
  for (const el of contentElements(content)) {
    const name = childTagName(el);
    if (name === null) continue; // whitespace between tags is not an element
    const k = elementKind(el);
    if ((name === 'line' || name === 'group') && k?.kind === 'open') {
      checkLineEach(
        k.node,
        {
          declared: ctx.declaredSequences,
          repeating: ctx.repeatingSequences,
          pools: [...ctx.poolFields.keys()],
        },
        ctx.diagnostics,
      );
      if (name === 'line') checkLine(k.node, ctx, scope);
      else checkGroup(k.node, ctx, scope);
      continue;
    }
    // A <block> or a <group> holds only <line>s and <group>s; anything else is misplaced, <data>
    // included.
    reportMisplaced(el, name, parent, ctx);
  }
}

/**
 * `<group each="…" if="…">` — several lines as one unit.
 *
 * Its `each=` is checked as a line's is (TDC206, TDC207). Its `if=` reads the scope around it and
 * the element it walks, but not its own positions, which count the elements that `if=` keeps. And
 * no typed column may sit anywhere inside: a group repeats its lines or drops them as a whole, and
 * a column has one cell per record either way (TDC209).
 */
function checkGroup(group: OpenCloseElementContext, ctx: BlockCheckCtx, scope: OutputScope): void {
  const attrs = extractAttrs(group.attr());
  const each = attrs['each'];
  const ifAttr = findAttr(group.attr(), 'if');
  if (ifAttr) {
    checkIfExpression(ifAttr, attrs['if'] ?? '', ctx);
    ctx.rememberExpression(ifAttr, attrs['if'] ?? '', [
      ...scope.names,
      ...eachNames(each, ctx.declaredSequences, ctx.poolFields, true),
    ]);
  }
  checkGroupColumns(group, ctx.diagnostics);
  const name = (each ?? '').trim();
  checkItems(group.content(), 'group', ctx, {
    names: [...scope.names, ...eachNames(each, ctx.declaredSequences, ctx.poolFields, false)],
    walked: name === '' ? scope.walked : [...scope.walked, name],
  });
}

/** TDC209 for the first named `<data>` anywhere inside a group — one message per group. */
function checkGroupColumns(group: OpenCloseElementContext, diagnostics: Diagnostic[]): void {
  const find = (content: ContentContext | null): string | undefined => {
    for (const el of contentElements(content)) {
      const k = elementKind(el);
      if (k?.kind === 'data') {
        const column = (extractDataAttrs(k.node)['name'] ?? '').trim();
        if (column !== '') return column;
      } else if (k?.kind === 'open') {
        const inner = find(k.node.content());
        if (inner !== undefined) return inner;
      }
    }
    return undefined;
  };
  const column = find(group.content());
  if (column === undefined) return;
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(group),
    message: `a named <data name="${column}"> cannot sit inside a <group>`,
    hint:
      'A group prints its lines several times or drops them all, and a typed column has one cell ' +
      'per record either way. Keep typed columns on lines outside the group.',
    code: 'TDC209',
  });
}

function checkLine(lineEl: OpenCloseElementContext, ctx: BlockCheckCtx, scope: OutputScope): void {
  const attrs = lineEl.attr();
  const attrMap = extractAttrs(attrs);
  const ifAttr = findAttr(attrs, 'if');
  const each = attrMap['each'];
  const lineNames = [
    ...scope.names,
    ...eachNames(each, ctx.declaredSequences, ctx.poolFields, false),
  ];
  if (ifAttr) {
    checkIfExpression(ifAttr, attrMap['if'] ?? '', ctx);
    ctx.rememberExpression(ifAttr, attrMap['if'] ?? '', [
      ...scope.names,
      ...eachNames(each, ctx.declaredSequences, ctx.poolFields, true),
    ]);
    checkLineConditionalColumns(lineEl, ifAttr, ctx.diagnostics);
  }
  const walked = (each ?? '').trim() === '' ? scope.walked : [...scope.walked, (each ?? '').trim()];

  for (const el of contentElements(lineEl.content())) {
    const name = childTagName(el);
    if (name === null) continue;
    if (name === 'data') {
      const k = elementKind(el);
      if (k?.kind === 'data') {
        checkData(k.node, ctx, lineNames);
        checkBlockDataRefs(
          extractDataText(k.node),
          k.node,
          ctx.inject,
          ctx.declaredSequences,
          ctx.diagnostics,
          lineNames,
          ctx.poolReferences,
          ctx.listSeparators,
          walked,
        );
      }
      continue;
    }
    const node = childNode(el);
    if (!node) continue;
    if (name === 'gen') {
      // Generators are not allowed in the output block — it is for formatting
      // only. Declare a named <sequence> in <env> and reference it here with
      // ${{Name}}. (Conditional/switch values also belong in <env> sequences.)
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(node),
        message: 'a <gen> is not allowed inside <line> — the output block is for formatting only',
        hint: 'Declare a named <sequence> in <env> and reference it here with ${{Name}}. See https://nickliapin.github.io/tdcv2/docs/core-concepts/sequences',
        code: 'TDC131',
      });
      continue;
    }
    if (name === 'mix' || name === 'switch') {
      // Distribution (<mix>) / lookup (<switch>) are data-producing constructs —
      // they belong in <env>, not in the output block.
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(node),
        message: `a <${name}> is not allowed inside <line> — the output block is for formatting only`,
        hint: 'Declare it in <env> and reference it here with ${{Name}}. See https://nickliapin.github.io/tdcv2/docs/constructs/mix',
        code: 'TDC132',
      });
      continue;
    }
    // Anything else in a <line> (<case>, <map>, <default>, or an arbitrary tag)
    // is misplaced.
    reportMisplaced(el, name, 'line', ctx);
  }
}
