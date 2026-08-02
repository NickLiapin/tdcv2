/**
 * The completion brain: (document text, cursor) → autocomplete items.
 *
 * Pure and dependency-free. Cursor context is derived from lightweight text
 * heuristics on the characters before the caret — robust while the document
 * is half-typed and invalid (a full parse would often fail). Dynamic lists
 * that DO need the document (sequence names for `parent=`) come from a
 * simple regex scan, not a parse, for the same robustness.
 *
 * Contexts detected:
 *   - `<` (+ partial)            → tag names
 *   - `<tag …·`                  → that tag's attribute names
 *   - `attr="·`                  → values for that attribute:
 *       type="·"     → generator types
 *       value="·"    → template paths + pack addresses
 *       parent="·"   → declared sequence names
 *       alphabet="·" → alphabet names
 */

import { ALPHABET_NAMES } from '../unicode/alphabets.js';
import {
  ATTRIBUTE_OWNERS,
  CLOSED_TAG_ATTRIBUTES,
  COMPUTE_TAGS,
  GEN_ATTRIBUTES,
  KNOWN_CASE_CHILDREN,
  KNOWN_ENV_CHILDREN,
  KNOWN_GEN_TYPES,
  KNOWN_MIX_CHILDREN,
  KNOWN_SWITCH_CHILDREN,
  KNOWN_TDC_CHILDREN,
  KNOWN_TEMPLATE_PATHS,
} from '../validator/index.js';

import { CompletionItemKind, type CompletionItem, type Position } from './types.js';

/** A pack address plus its human description, for the value list detail. */
export interface PackAddressInfo {
  readonly address: string;
  readonly description?: string;
}

export interface CompletionContext {
  readonly packAddresses?: readonly PackAddressInfo[];
}

/**
 * Every TDC element — the fallback offer when the caret's surroundings cannot
 * be read (an unknown enclosing tag filters NOTHING: quietly hiding a legal
 * option is the failure context-awareness exists to prevent).
 */
const TAGS: readonly string[] = [
  // structure
  'tdc',
  'env',
  'block',
  // env-level value constructs
  'sequence',
  'mix',
  'switch',
  'distinct',
  'uniq',
  // inside sequence / mix / switch
  'gen',
  'compute',
  'map',
  'case',
  'default',
  // output
  'line',
  'data',
  // fixtures (env children)
  'before',
  'after',
  'before_block',
  'after_block',
  'delimiter_block',
  'before_line',
  'after_line',
  'delimiter_line',
];

/**
 * Which tags belong inside which parent. Structural relations come from the
 * validator's own lists; the three the validator checks positively rather
 * than by list (sequence, block, line) are spelled out here with the same
 * content its checks accept. A parent absent from this map filters nothing.
 */
const CHILDREN: ReadonlyMap<string, readonly string[]> = new Map([
  ['tdc', KNOWN_TDC_CHILDREN],
  ['env', KNOWN_ENV_CHILDREN],
  ['mix', KNOWN_MIX_CHILDREN],
  ['switch', KNOWN_SWITCH_CHILDREN],
  ['case', KNOWN_CASE_CHILDREN],
  // The validator checks these three positively (TDC036 wants a <gen>, the
  // named-<data> constant shipped with composed sequences, <compute> is read
  // by findChildElement) rather than against a list.
  ['sequence', ['gen', 'data', 'compute']],
  ['block', ['line']],
  ['line', ['data']],
  // Env-level wrappers around whole sequences.
  ['distinct', ['sequence']],
  ['uniq', ['sequence']],
]);

/**
 * Attribute names per tag, DERIVED from what the validator accepts.
 *
 * This used to be a hand-written copy, and it drifted the way a hand-written
 * copy always does: `<pool>` was missing entirely, `<line>` had no `each`,
 * `<case>` had no `if`, and `<gen>` was short 34 names — among them `order`
 * and `cycle`, the only two attributes the engine gives to `text` and `file`
 * alone, so type-narrowing had nothing to narrow. Every attribute added to the
 * engine since had to be remembered twice, and the second place was silent
 * when forgotten.
 *
 * Deriving it means autocomplete offers exactly what the validator will accept.
 * `attribute-parity.test.ts` compares the two in both directions, so a name
 * added to one and not the other is a failing test rather than a quiet gap.
 *
 * Tags outside the validator's map — `block`, `compute` — carry no attributes
 * of their own and are listed here.
 */
const TAG_ATTRIBUTES: Record<string, readonly string[]> = {
  ...Object.fromEntries([...CLOSED_TAG_ATTRIBUTES].map(([tag, attrs]) => [tag, [...attrs].sort()])),
  // For `<gen>` this is the UNION across generator types; `genAttrCompletions`
  // narrows it by the `type=` already typed.
  gen: [...GEN_ATTRIBUTES].sort(),
  block: [],
  compute: [],
};

export function computeCompletions(
  text: string,
  position: Position,
  ctx: CompletionContext = {},
): CompletionItem[] {
  const before = sliceBefore(text, position);
  const lastLt = before.lastIndexOf('<');
  const lastGt = before.lastIndexOf('>');
  if (lastLt <= lastGt) return []; // caret is in body text, not inside a tag

  const openTag = before.slice(lastLt); // e.g. '<gen type="te'
  const insideValue = (openTag.match(/"/g) ?? []).length % 2 === 1;

  if (insideValue) {
    const m = /([A-Za-z_][\w-]*)\s*=\s*"([^"]*)$/.exec(openTag);
    if (!m?.[1]) return [];
    return valueCompletions(m[1], openTag, text, ctx);
  }

  // Not inside a value → either the tag name or an attribute name.
  if (/^<\/?[A-Za-z]*$/.test(openTag)) {
    return tagsFor(before.slice(0, lastLt)).map((t) => item(t, CompletionItemKind.Keyword));
  }
  const tagName = /^<\/?([A-Za-z][\w-]*)/.exec(openTag)?.[1];
  if (!tagName) return [];
  if (tagName === 'gen') {
    return genAttrCompletions(openTag);
  }
  const attrs = TAG_ATTRIBUTES[tagName] ?? [];
  return attrs.map((a) => item(a, CompletionItemKind.Property));
}

/**
 * Tag names that belong where the caret is, read off the still-open elements
 * before it. A suggestion list reads as permission — offering `tdc` inside a
 * `<sequence>` is how a wrong attribute ends up typed in good faith — so the
 * list is narrowed by the enclosing tag. Two deliberate outs: an enclosing
 * tag this map does not know filters nothing, and anywhere inside a
 * `<compute>` subtree the offer is the compute sub-language.
 */
function tagsFor(before: string): readonly string[] {
  const stack = openTags(before);
  if (stack.includes('compute')) return [...COMPUTE_TAGS];
  const parent = stack[stack.length - 1];
  if (parent === undefined) return ['tdc'];
  return CHILDREN.get(parent) ?? TAGS;
}

/**
 * The stack of elements still open at the end of `text`. A lightweight scan,
 * like everything here: quotes are respected so a `>` inside an attribute
 * value does not end a tag, and raw `<data>`/`<map>` bodies cannot confuse it
 * because completion never fires inside body text (the caret check above).
 */
function openTags(text: string): string[] {
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w-]*)((?:"[^"]*"|'[^']*'|[^"'>])*)>/g;
  for (let m = tag.exec(text); m !== null; m = tag.exec(text)) {
    const [, close, name, body] = m;
    if (close === '/') {
      const at = stack.lastIndexOf(name ?? '');
      if (at >= 0) stack.length = at;
    } else if (!(body ?? '').trimEnd().endsWith('/')) {
      stack.push(name ?? '');
    }
  }
  return stack;
}

/**
 * `<gen …>` attributes, narrowed by the `type=` already written. Before a
 * type is chosen nothing is hidden — every generator is still possible, so
 * every attribute stays on offer. The ownership map is the validator's own,
 * so the offer and the later check cannot disagree.
 */
function genAttrCompletions(openTag: string): CompletionItem[] {
  const all = TAG_ATTRIBUTES['gen'] ?? [];
  const type = /\btype\s*=\s*"([^"]*)"/.exec(openTag)?.[1];
  const known = type !== undefined && KNOWN_GEN_TYPES.includes(type);
  const attrs = !known
    ? all
    : all.filter((a) => {
        const owners = ATTRIBUTE_OWNERS.get(a);
        return owners === undefined || owners.has(type);
      });
  return attrs.map((a) => item(a, CompletionItemKind.Property));
}

function valueCompletions(
  attrName: string,
  openTag: string,
  text: string,
  ctx: CompletionContext,
): CompletionItem[] {
  switch (attrName) {
    case 'type':
      return KNOWN_GEN_TYPES.map((t) => item(t, CompletionItemKind.EnumMember));
    case 'value':
      return valueAttrCompletions(openTag, ctx);
    case 'parent':
    case 'on': // <switch on="Subject"> — a declared sequence, like parent=
      return sequenceNames(text).map((n) => item(n, CompletionItemKind.Reference));
    case 'alphabet':
      return ALPHABET_NAMES.map((a) => item(a, CompletionItemKind.EnumMember));
    default:
      return [];
  }
}

/**
 * `value="…"` lists the loaded pack addresses plus the builtin template
 * paths — the common case. (`type="preset"` was retired; identifiers are
 * template paths now.)
 */
function valueAttrCompletions(_openTag: string, ctx: CompletionContext): CompletionItem[] {
  const packs = (ctx.packAddresses ?? []).map((p) =>
    item(p.address, CompletionItemKind.Value, p.description),
  );
  const builtins = KNOWN_TEMPLATE_PATHS.map((p) => item(p, CompletionItemKind.Value));
  return [...packs, ...builtins];
}

/** All `<sequence name="…">` names in the document (regex, parse-free). */
function sequenceNames(text: string): string[] {
  const out: string[] = [];
  const re = /<sequence\b[^>]*\bname\s*=\s*"([^"]+)"/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function item(label: string, kind: CompletionItem['kind'], detail?: string): CompletionItem {
  return { label, ...(kind !== undefined ? { kind } : {}), ...(detail ? { detail } : {}) };
}

/** Document text from the start up to (and including) the caret column. */
function sliceBefore(text: string, position: Position): string {
  const lines = text.split('\n');
  if (position.line >= lines.length) return text;
  const head = lines.slice(0, position.line);
  head.push((lines[position.line] ?? '').slice(0, position.character));
  return head.join('\n');
}
