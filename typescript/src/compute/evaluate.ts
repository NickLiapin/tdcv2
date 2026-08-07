/**
 * Evaluator for the `compute` declarative computation layer (spec §7).
 *
 * Walks a `<compute>` element's parse subtree directly (no separate IR — this
 * matches the rest of the codebase, which operates on ANTLR contexts) and
 * produces a `Value`. The tree IS the AST: every runtime (TS/Python/Java) walks
 * the same shape, so there is no expression grammar to re-implement.
 *
 * Pure: no RNG, clock, or I/O. The only inputs are the values reachable through
 * the `fields` resolver (the same visibility as `${{name}}` — spec §3.1).
 */

import type {
  ElementContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import type { AttrMap } from '../processor/attrs.js';
import { contentElements, elementKind, elementName, extractAttrs } from '../processor/walk.js';

import {
  applyCase,
  applyGroup,
  applyMask,
  applyReplace,
  applySlice,
  applyTrim,
} from '../format/transforms.js';

import { encodeChar } from './encode.js';
import {
  coerceInt,
  coerceStr,
  ComputeError,
  euclideanMod,
  floorDiv,
  int,
  list,
  parseIntStrict,
  str,
  valueToOutput,
  type Value,
} from './value.js';

/**
 * The builtin row counters, which are numbers rather than text.
 *
 * `_first` and `_last` are deliberately absent: they are the strings "true" and
 * "false", and reading them as integers would be a lie of a different kind.
 */
const NUMERIC_BUILTIN_FIELDS: ReadonlySet<string> = new Set(['_count', '_total']);

/**
 * Evaluation scope. `fields` resolves `<field>`; `vars` holds `<let>` bindings;
 * `current`/`currentIndex`/`acc` are the contextual iteration values, present
 * only inside a `<do>` body.
 */
export interface EvalScope {
  readonly fields: (name: string) => string | undefined;
  readonly vars: ReadonlyMap<string, Value>;
  readonly current?: Value;
  readonly currentIndex?: bigint;
  readonly acc?: Value;
}

/** Normalised view of a compute element: name, attributes, child elements. */
interface CNode {
  readonly name: string;
  readonly attrs: AttrMap;
  readonly children: readonly ElementContext[];
}

function asCNode(el: ElementContext): CNode {
  const k = elementKind(el);
  if (!k || k.kind === 'data') {
    throw new ComputeError('unexpected <data> or malformed element inside <compute>');
  }
  const node: OpenCloseElementContext | SelfClosingElementContext = k.node;
  const children = k.kind === 'open' ? contentElements(k.node.content()) : [];
  return { name: elementName(node), attrs: extractAttrs(node.attr()), children };
}

function nodeName(el: ElementContext): string {
  const k = elementKind(el);
  return k && k.kind !== 'data' ? elementName(k.node) : '';
}

function childByName(n: CNode, name: string): ElementContext | undefined {
  return n.children.find((c) => nodeName(c) === name);
}

function requireChild(n: CNode, name: string): CNode {
  const child = childByName(n, name);
  if (!child) throw new ComputeError(`<${n.name}> requires a <${name}> child`);
  return asCNode(child);
}

// --- scope helpers (kept explicit for exactOptionalPropertyTypes) ---

function withVar(scope: EvalScope, name: string, value: Value): EvalScope {
  const vars = new Map(scope.vars);
  vars.set(name, value);
  // Spread the whole scope so a <let> inside an iteration keeps the contextual
  // current/currentIndex/acc — binding a variable must not drop them.
  return { ...scope, vars };
}

function withIter(scope: EvalScope, current: Value, currentIndex: bigint, acc?: Value): EvalScope {
  const base = { fields: scope.fields, vars: scope.vars, current, currentIndex };
  return acc === undefined ? base : { ...base, acc };
}

/** Turn a collection value into the list of elements iteration walks. */
function iterableOf(value: Value): Value[] {
  if (value.t === 'str') return Array.from(value.v).map((ch) => str(ch));
  if (value.t === 'list') return [...value.v];
  throw new ComputeError('<over>: expected a string or list to iterate');
}

/**
 * Evaluate a single-expression slot: zero or more `<let>` prefixes followed by
 * exactly one value-producing expression (spec §7.2). Bindings accumulate so a
 * later `<let>` and the final expression see the earlier ones.
 */
function evalSlot(children: readonly ElementContext[], scope: EvalScope): Value {
  let localScope = scope;
  let result: Value | undefined;
  for (const child of children) {
    if (nodeName(child) === 'let') {
      const cn = asCNode(child);
      const name = cn.attrs['name'] ?? '';
      localScope = withVar(localScope, name, evalSlot(cn.children, localScope));
    } else {
      result = evalElement(child, localScope);
    }
  }
  if (result === undefined) throw new ComputeError('empty expression slot: no value produced');
  return result;
}

/** Evaluate a named role-wrapper child (`<over>`, `<init>`, …) as a slot. */
function evalWrapper(n: CNode, wrapper: string, scope: EvalScope): Value {
  return evalSlot(requireChild(n, wrapper).children, scope);
}

function evalElement(el: ElementContext, scope: EvalScope): Value {
  const n = asCNode(el);
  switch (n.name) {
    // --- literals ---
    case 'int': {
      const raw = n.attrs['v'] ?? '';
      if (!/^-?[0-9]+$/.test(raw)) throw new ComputeError(`<int>: "${raw}" is not an integer`);
      return int(BigInt(raw));
    }
    case 'str':
      return str(n.attrs['v'] ?? '');
    case 'list': {
      const raw = n.attrs['v'];
      if (raw !== undefined) {
        const parts = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        return list(
          parts.map((p) => {
            if (!/^-?[0-9]+$/.test(p)) throw new ComputeError(`<list>: "${p}" is not an integer`);
            return int(BigInt(p));
          }),
        );
      }
      return list(n.children.map((c) => evalElement(c, scope)));
    }

    // --- references ---
    case 'field': {
      const name = n.attrs['name'] ?? '';
      const value = scope.fields(name);
      if (value === undefined) throw new ComputeError(`<field>: "${name}" is not in scope`);
      // A sequence's value is text, and `coerceInt` deliberately refuses a
      // multi-digit string so that "the third character" and "the number 375"
      // stay different things. The row counters are not text: `_count` and
      // `_total` are numbers by nature, and typing them as such is what makes
      // `<mod><field name="_count"/><int v="2"/></mod>` mean something.
      //
      // Without this the counters were strings, so the single-digit escape
      // hatch in `coerceInt` carried them to row 9 and the tenth row failed
      // with "expected an integer in arithmetic, got the string "10"". A
      // config tested on five rows broke on a million, which is the worst
      // shape a bug can have here.
      if (NUMERIC_BUILTIN_FIELDS.has(name)) return int(BigInt(value));
      return str(value);
    }
    case 'var': {
      const name = n.attrs['name'] ?? '';
      const value = scope.vars.get(name);
      if (value === undefined) throw new ComputeError(`<var>: "${name}" is not bound`);
      return value;
    }
    case 'current':
      if (scope.current === undefined) {
        throw new ComputeError('<current/> used outside an iteration');
      }
      return scope.current;
    case 'current_index':
      if (scope.currentIndex === undefined) {
        throw new ComputeError('<current_index/> used outside an iteration');
      }
      return int(scope.currentIndex);
    case 'acc':
      if (scope.acc === undefined) {
        throw new ComputeError('<acc/> used outside a <reduce>');
      }
      return scope.acc;
    case 'let':
      throw new ComputeError('<let> is a binding prefix, not a value expression');

    // --- collections ---
    case 'each': {
      const items = iterableOf(evalWrapper(n, 'over', scope));
      const doNode = requireChild(n, 'do');
      return list(
        items.map((item, i) => evalSlot(doNode.children, withIter(scope, item, BigInt(i)))),
      );
    }
    case 'reduce': {
      const items = iterableOf(evalWrapper(n, 'over', scope));
      const doNode = requireChild(n, 'do');
      let acc = evalWrapper(n, 'init', scope);
      items.forEach((item, i) => {
        acc = evalSlot(doNode.children, withIter(scope, item, BigInt(i), acc));
      });
      return acc;
    }
    case 'join': {
      const sep = n.attrs['sep'] ?? '';
      const value = evalSlot(n.children, scope);
      if (value.t !== 'list') throw new ComputeError('<join>: expected a list');
      return str(value.v.map(coerceStr).join(sep));
    }
    // The exact inverse of <join>, and the fourth way to get a list.
    //
    // Before it there were three — a literal <list v="…">, the result of <each>, and a string
    // walked CHARACTER by character — and none of them could read back a column that `repeat=`
    // had joined. So "sum quantity × price over the lines of this order" could not be said at
    // all unless the two lists happened to have the same length.
    //
    // The pieces are STRINGS, like every other piece of text in this layer: <to_number> turns
    // one into an integer, and the arithmetic tags say so when they are handed text.
    case 'split': {
      const sep = n.attrs['sep'] ?? '';
      // An empty separator is refused rather than given a meaning. JavaScript would answer with
      // every character, Python would refuse outright, and the other three differ again — so any
      // reading here would make one implementation disagree with the rest. Walking a string
      // character by character already has a spelling: <over> takes a string directly.
      if (sep === '') {
        throw new ComputeError(
          '<split>: sep= is empty — to walk a string character by character, put it in <over> ' +
            'directly, which is what an empty separator would have to mean',
        );
      }
      const value = evalSlot(n.children, scope);
      if (value.t !== 'str') {
        throw new ComputeError('<split>: expected a string, got a list');
      }
      return list(value.v.split(sep).map((piece) => str(piece)));
    }
    case 'at': {
      const coll = evalWrapper(n, 'in', scope);
      if (coll.t !== 'list') throw new ComputeError('<at>: <in> must be a list');
      const idx = Number(coerceInt(evalWrapper(n, 'index', scope), '<at> index'));
      const found = coll.v[idx];
      if (found !== undefined) return found;
      const dflt = n.attrs['default'];
      if (dflt !== undefined) return int(parseIntStrict(dflt));
      throw new ComputeError(`<at>: index ${String(idx)} is out of range and no default is set`);
    }
    case 'length': {
      const value = evalSlot(n.children, scope);
      if (value.t === 'str') return int(BigInt(Array.from(value.v).length));
      if (value.t === 'list') return int(BigInt(value.v.length));
      throw new ComputeError('<length>: expected a string or list');
    }

    // --- arithmetic ---
    case 'add': {
      let sum = 0n;
      for (const c of n.children) sum += coerceInt(evalElement(c, scope), '<add>');
      return int(sum);
    }
    case 'multiply': {
      let product = 1n;
      for (const c of n.children) product *= coerceInt(evalElement(c, scope), '<multiply>');
      return int(product);
    }
    case 'subtract': {
      const [head, ...rest] = n.children;
      if (head === undefined) throw new ComputeError('<subtract> requires at least one child');
      let acc = coerceInt(evalElement(head, scope), '<subtract>');
      for (const c of rest) acc -= coerceInt(evalElement(c, scope), '<subtract>');
      return int(acc);
    }
    case 'mod': {
      const [a, b] = requireTwo(n);
      return int(euclideanMod(coerceInt(evalElement(a, scope)), coerceInt(evalElement(b, scope))));
    }
    case 'divide': {
      const [a, b] = requireTwo(n);
      return int(floorDiv(coerceInt(evalElement(a, scope)), coerceInt(evalElement(b, scope))));
    }

    // --- encoding / conversion ---
    case 'encode': {
      const as = n.attrs['as'] ?? '';
      const value = evalSlot(n.children, scope);
      if (value.t !== 'str') throw new ComputeError('<encode>: expected a single-character string');
      return str(encodeChar(value.v, as));
    }
    case 'to_number':
      return int(parseIntStrict(coerceStr(evalSlot(n.children, scope))));
    case 'pad': {
      const width = Number(n.attrs['width'] ?? '0');
      const fill = n.attrs['fill'] ?? '0';
      return str(coerceStr(evalSlot(n.children, scope)).padStart(width, fill));
    }
    case 'concat':
      return str(n.children.map((c) => coerceStr(evalElement(c, scope))).join(''));

    // --- text formatting ---
    case 'upper':
    case 'lower':
    case 'capitalize':
    case 'title':
      return str(applyCase(n.name, coerceStr(evalSlot(n.children, scope))));
    case 'mask':
      return str(applyMask(n.attrs['pattern'] ?? '', coerceStr(evalSlot(n.children, scope))));
    case 'slice': {
      const to = n.attrs['to'];
      return str(
        applySlice(
          coerceStr(evalSlot(n.children, scope)),
          Number(n.attrs['from'] ?? '0'),
          to === undefined ? undefined : Number(to),
        ),
      );
    }
    case 'replace':
      return str(
        applyReplace(
          coerceStr(evalSlot(n.children, scope)),
          n.attrs['from'] ?? '',
          n.attrs['to'] ?? '',
        ),
      );
    case 'trim':
      return str(applyTrim(coerceStr(evalSlot(n.children, scope))));
    case 'group':
      return str(
        applyGroup(
          coerceStr(evalSlot(n.children, scope)),
          Number(n.attrs['size'] ?? '3'),
          n.attrs['sep'] ?? ' ',
        ),
      );

    // --- conditional ---
    case 'choose':
      return evalChoose(n, scope);

    // --- role wrappers evaluated as slots ---
    case 'result':
    case 'do':
    case 'over':
    case 'init':
    case 'in':
    case 'index':
    case 'then':
    case 'otherwise':
      return evalSlot(n.children, scope);

    default:
      throw new ComputeError(`unknown compute tag <${n.name}>`);
  }
}

function requireTwo(n: CNode): [ElementContext, ElementContext] {
  const [a, b] = n.children;
  if (a === undefined || b === undefined || n.children.length !== 2) {
    throw new ComputeError(`<${n.name}> requires exactly 2 children`);
  }
  return [a, b];
}

function evalChoose(n: CNode, scope: EvalScope): Value {
  let otherwise: CNode | undefined;
  for (const child of n.children) {
    const cn = asCNode(child);
    if (cn.name === 'when') {
      if (evalTest(requireChild(cn, 'test'), scope)) {
        return evalSlot(requireChild(cn, 'then').children, scope);
      }
    } else if (cn.name === 'otherwise') {
      otherwise = cn;
    }
  }
  if (otherwise) return evalSlot(otherwise.children, scope);
  throw new ComputeError('<choose>: no <when> matched and no <otherwise> present');
}

/** Evaluate a `<test>` (its single predicate child) to a boolean. */
function evalTest(test: CNode, scope: EvalScope): boolean {
  const pred = test.children[0];
  if (pred === undefined) throw new ComputeError('<test> requires a predicate child');
  return evalPredicate(pred, scope);
}

function evalPredicate(el: ElementContext, scope: EvalScope): boolean {
  const n = asCNode(el);
  switch (n.name) {
    case 'equals':
    case 'greater_than':
    case 'less_than': {
      const [a, b] = requireTwo(n);
      const x = coerceInt(evalElement(a, scope), `<${n.name}>`);
      const y = coerceInt(evalElement(b, scope), `<${n.name}>`);
      if (n.name === 'equals') return x === y;
      if (n.name === 'greater_than') return x > y;
      return x < y;
    }
    case 'is_digit': {
      const child = n.children[0];
      if (child === undefined) throw new ComputeError('<is_digit> requires a child');
      const value = evalElement(child, scope);
      return value.t === 'str' && /^[0-9]$/.test(value.v);
    }
    default:
      throw new ComputeError(`unknown predicate <${n.name}> (valid only inside <test>)`);
  }
}

/**
 * Evaluate a `<compute>` element to its output string. `fields` resolves
 * `<field name>` references to their in-scope values.
 */
export function evaluateCompute(
  computeEl: OpenCloseElementContext,
  fields: (name: string) => string | undefined,
): string {
  const scope: EvalScope = { fields, vars: new Map() };
  return valueToOutput(evalSlot(contentElements(computeEl.content()), scope));
}

/**
 * Evaluate a `<valid>` element's single predicate child to a boolean. Used by
 * pack generators for reject-and-retry (migration spec §4.2).
 */
export function evaluateComputePredicate(
  validEl: OpenCloseElementContext,
  fields: (name: string) => string | undefined,
): boolean {
  const pred = contentElements(validEl.content()).find((c) => nodeName(c) !== '');
  if (pred === undefined) throw new ComputeError('<valid> requires a predicate child');
  return evalPredicate(pred, { fields, vars: new Map() });
}
