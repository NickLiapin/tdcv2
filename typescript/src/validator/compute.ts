/**
 * Static validation for `<compute>` subtrees (spec §11, load-time checks).
 *
 * Catches the structural problems that can be found without running the tree:
 * unknown tags, contextual tags used outside an iteration, references to an
 * unbound `<var>` or unknown `<field>`, wrong arithmetic arity, a `<choose>`
 * with no `<otherwise>`, `<let>` name shadowing, and unknown `<encode>` systems.
 * Deeper value/coercion errors are left to the evaluator, which reports them at
 * render time with a clear message.
 *
 * Diagnostic codes: TDC180–TDC189.
 */

import { type Diagnostic, nodeRange } from '../errors/index.js';
import type {
  ElementContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import type { AttrMap } from '../processor/attrs.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';

type Node = OpenCloseElementContext | SelfClosingElementContext;

interface CN {
  readonly name: string;
  readonly attrs: AttrMap;
  readonly children: readonly ElementContext[];
  readonly node: Node;
}

interface VScope {
  readonly vars: ReadonlySet<string>;
  readonly inIteration: boolean;
  readonly inReduce: boolean;
  readonly knownFields?: ReadonlySet<string>;
}

const ENCODINGS = new Set(['base36', 'ascii', 'unicode', 'hex', 'binary', 'octal']);

/**
 * Every tag of the compute sub-language, exported for the completion brain:
 * inside a `<compute>` subtree these are the only names worth offering.
 */
export const COMPUTE_TAGS = new Set([
  // literals & references
  'int',
  'str',
  'list',
  'field',
  'var',
  'current',
  'current_index',
  'acc',
  // binding
  'let',
  // collections
  'each',
  'reduce',
  'join',
  'at',
  'length',
  // arithmetic
  'add',
  'subtract',
  'multiply',
  'divide',
  'mod',
  // encoding / conversion
  'encode',
  'to_number',
  'pad',
  'concat',
  'upper',
  'lower',
  'capitalize',
  'title',
  'mask',
  'slice',
  'replace',
  'trim',
  'group',
  // conditional + role wrappers
  'choose',
  'when',
  'otherwise',
  'test',
  'then',
  'result',
  'over',
  'do',
  'init',
  'in',
  'index',
  // predicates
  'equals',
  'greater_than',
  'less_than',
  'is_digit',
]);

function cnode(el: ElementContext): CN | undefined {
  const k = elementKind(el);
  if (!k || k.kind === 'data') return undefined;
  const children = k.kind === 'open' ? contentElements(k.node.content()) : [];
  return { name: elementName(k.node), attrs: extractAttrs(k.node.attr()), children, node: k.node };
}

/**
 * Validate a `<compute>` element. `knownFields`, when provided, is the set of
 * field names visible to `<field>` (a sibling gen / named sequence); field
 * references outside it are flagged.
 */
export function checkCompute(
  computeEl: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  knownFields?: ReadonlySet<string>,
): void {
  const scope: VScope = {
    vars: new Set(),
    inIteration: false,
    inReduce: false,
    ...(knownFields ? { knownFields } : {}),
  };
  // Documented as "at most once". A second one silently won and the first was
  // discarded, so a config could compute something entirely different from what
  // its author read top-to-bottom.
  const results = contentElements(computeEl.content())
    .map(cnode)
    .filter((c) => c?.name === 'result');
  for (const extra of results.slice(1)) {
    if (extra) {
      report(
        diagnostics,
        extra.node,
        'TDC189',
        '<compute> has more than one <result>',
        'Only the last one would be used and the earlier ones silently dropped. Keep a single <result>.',
      );
    }
  }

  walkSlot(contentElements(computeEl.content()), scope, diagnostics);
}

function report(
  diagnostics: Diagnostic[],
  node: Node,
  code: string,
  message: string,
  hint?: string,
): void {
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(node),
    message,
    ...(hint ? { hint } : {}),
    code,
  });
}

/** Walk a slot: `<let>` prefixes bind for later siblings; last is the value. */
function walkSlot(children: readonly ElementContext[], scope: VScope, diags: Diagnostic[]): void {
  const bound = new Set(scope.vars);
  for (const child of children) {
    const n = cnode(child);
    if (!n) continue;
    if (n.name === 'let') {
      const name = n.attrs['name'] ?? '';
      if (bound.has(name)) {
        report(
          diags,
          n.node,
          'TDC185',
          `<let name="${name}"> shadows an outer binding of the same name`,
        );
      }
      walkSlot(n.children, { ...scope, vars: bound }, diags);
      bound.add(name);
    } else {
      walkExpr(child, { ...scope, vars: bound }, diags);
    }
  }
}

function walkWrapper(n: CN, wrapper: string, scope: VScope, diags: Diagnostic[]): void {
  const child = n.children.map(cnode).find((c) => c?.name === wrapper);
  if (!child) {
    report(diags, n.node, 'TDC187', `<${n.name}> requires a <${wrapper}> child`);
    return;
  }
  walkSlot(child.children, scope, diags);
}

/**
 * Tags the compute spec describes but this phase does not ship, so that the
 * diagnostic explains the gap instead of reading like a typo. `<param>` belongs
 * to the `compute-def`/`use` feature, which the spec defers to phase 2; the
 * evaluator has no case for it and would fail mid-run.
 */
const HINTS_BY_TAG: Record<string, string> = {
  param:
    '<param> belongs to the compute-def/use feature, which is not implemented yet. ' +
    'An inline <compute> takes no parameters — read the value with <field name="…"/> instead.',
};

function walkExpr(el: ElementContext, scope: VScope, diags: Diagnostic[]): void {
  const n = cnode(el);
  if (!n) return;
  if (!COMPUTE_TAGS.has(n.name)) {
    report(diags, n.node, 'TDC180', `unknown compute tag <${n.name}>`, HINTS_BY_TAG[n.name]);
    return;
  }
  switch (n.name) {
    case 'current':
    case 'current_index':
      if (!scope.inIteration) {
        report(diags, n.node, 'TDC181', `<${n.name}/> is only valid inside a <do> iteration body`);
      }
      return;
    case 'acc':
      if (!scope.inReduce) {
        report(diags, n.node, 'TDC181', '<acc/> is only valid inside a <reduce> <do> body');
      }
      return;
    case 'var': {
      const name = n.attrs['name'] ?? '';
      if (!scope.vars.has(name)) {
        report(diags, n.node, 'TDC182', `<var name="${name}"> is not bound by an enclosing <let>`);
      }
      return;
    }
    case 'field': {
      const name = n.attrs['name'] ?? '';
      if (scope.knownFields && !scope.knownFields.has(name)) {
        report(
          diags,
          n.node,
          'TDC182',
          `<field name="${name}"> refers to a value that is not in scope`,
        );
      }
      return;
    }
    case 'int': {
      // Documented as failing before the run. It was not checked at all: in an
      // unused sequence it never fired, and when used it surfaced at render
      // time with no code and no source span, while <encode> and <field> in the
      // same position reported properly. Now it matches its neighbours.
      const raw = (n.attrs['v'] ?? '').trim();
      if (!/^-?\d+$/.test(raw)) {
        report(
          diags,
          n.node,
          'TDC188',
          `<int v="${n.attrs['v'] ?? ''}"> is not an integer`,
          'Write a whole number, e.g. <int v="42"/>. For text use <str v="…"/>.',
        );
      }
      return;
    }
    case 'str':
      return;
    case 'list':
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    case 'mod':
    case 'divide':
      if (n.children.length !== 2) {
        report(
          diags,
          n.node,
          'TDC183',
          `<${n.name}> requires exactly 2 children, found ${String(n.children.length)}`,
        );
      }
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    case 'subtract':
      if (n.children.length < 1) {
        report(diags, n.node, 'TDC183', '<subtract> requires at least one child');
      }
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    case 'add':
    case 'multiply':
    case 'concat':
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    case 'each':
      walkWrapper(n, 'over', scope, diags);
      walkWrapper(n, 'do', { ...scope, inIteration: true }, diags);
      return;
    case 'reduce':
      walkWrapper(n, 'over', scope, diags);
      walkWrapper(n, 'init', scope, diags);
      walkWrapper(n, 'do', { ...scope, inIteration: true, inReduce: true }, diags);
      return;
    case 'at':
      walkWrapper(n, 'in', scope, diags);
      walkWrapper(n, 'index', scope, diags);
      return;
    case 'encode': {
      const as = n.attrs['as'] ?? '';
      if (!ENCODINGS.has(as)) {
        report(diags, n.node, 'TDC186', `<encode>: unknown encoding "${as}"`);
      }
      walkSlot(n.children, scope, diags);
      return;
    }
    case 'choose':
      walkChoose(n, scope, diags);
      return;
    case 'join':
    case 'length':
    case 'to_number':
    case 'pad':
    case 'upper':
    case 'lower':
    case 'capitalize':
    case 'title':
    case 'mask':
    case 'slice':
    case 'replace':
    case 'trim':
    case 'group':
    case 'result':
    case 'do':
    case 'init':
    case 'in':
    case 'index':
    case 'then':
    case 'otherwise':
    case 'when':
    case 'test':
    case 'let':
      walkSlot(n.children, scope, diags);
      return;
    case 'over':
      // Reaching here means no <each>/<reduce> consumed it — walkWrapper
      // descends into the over's CHILDREN and never revisits the tag itself.
      // Documented as not allowed outside them; it used to pass through
      // silently as a transparent wrapper.
      report(
        diags,
        n.node,
        'TDC181',
        '<over> is only valid inside <each> or <reduce>',
        'It names the list being walked. Outside those tags there is nothing to walk.',
      );
      return;
    default:
      return;
  }
}

function walkChoose(n: CN, scope: VScope, diags: Diagnostic[]): void {
  let hasOtherwise = false;
  for (const child of n.children) {
    const cn = cnode(child);
    if (!cn) continue;
    if (cn.name === 'when') {
      walkWhen(cn, scope, diags);
    } else if (cn.name === 'otherwise') {
      hasOtherwise = true;
      walkSlot(cn.children, scope, diags);
    }
  }
  if (!hasOtherwise) {
    report(diags, n.node, 'TDC184', '<choose> requires an <otherwise> branch');
  }
}

function walkWhen(n: CN, scope: VScope, diags: Diagnostic[]): void {
  const test = n.children.map(cnode).find((c) => c?.name === 'test');
  if (!test) {
    report(diags, n.node, 'TDC187', '<when> requires a <test> child');
  } else {
    const pred = test.children.map(cnode).find(Boolean);
    if (pred) walkPredicate(pred, scope, diags);
  }
  walkWrapper(n, 'then', scope, diags);
}

function walkPredicate(n: CN, scope: VScope, diags: Diagnostic[]): void {
  switch (n.name) {
    case 'equals':
    case 'greater_than':
    case 'less_than':
      if (n.children.length !== 2) {
        report(diags, n.node, 'TDC183', `<${n.name}> requires exactly 2 children`);
      }
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    case 'is_digit':
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    default:
      report(diags, n.node, 'TDC180', `unknown predicate <${n.name}> (valid only inside <test>)`);
  }
}
