/**
 * Extract `<sequence>` declarations from an `<env>` element's content.
 *
 * Each `<sequence>` tag produces one of these specs depending on how its
 * `<gen>` children are written:
 *
 *   - Exactly one anonymous `<gen>` child → simple sequence (`gen`).
 *   - Two or more named `<gen name="…">` children → compound sequence
 *     (`gens`). Field order is preserved.
 *   - Any `<gen if="…">` children → conditional sequence (`conditional`).
 *
 * A standalone env-level `<mix name="…">` tag (sibling of `<sequence>`)
 * produces a mix sequence (`mixSpec`) — its `<case>` branches are
 * distributed across the rows by `percent`.
 *
 * Structural validation (missing name, missing gen, mixed named/unnamed,
 * duplicate field names, …) is delegated to the validator — this
 * extractor is lenient and produces a best-effort spec so the render
 * path can assume a well-formed tree.
 */

import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import type { AssertSpec } from './assert.js';
import {
  collectSequenceGens,
  contentElements,
  elementKind,
  elementName,
  extractAttrs,
  extractDataAttrs,
  extractDataText,
  extractMapText,
  findChildElement,
} from '../processor/walk.js';

import type {
  CasePart,
  CaseSpec,
  CompoundField,
  CondBranch,
  GenSpec,
  MixSpec,
  SequenceItem,
  SequenceSpec,
  SwitchEntry,
  SwitchSpec,
} from './types.js';

type GenNode = OpenCloseElementContext | SelfClosingElementContext;

export function extractSequenceSpecs(env: OpenCloseElementContext | undefined): SequenceSpec[] {
  if (!env) return [];
  const specs: SequenceSpec[] = [];
  for (const node of envSequenceNodes(env)) {
    const spec = specFromSequence(node);
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Env-level wrapper tags that group whole `<sequence>`s. */
const ENV_SEQUENCE_WRAPPERS = ['distinct', 'uniq'] as const;

/**
 * Names of the members wrapped by each env-level `<${tag}>` — a `<sequence>`,
 * a `<mix>` or a `<switch>`. Groups with fewer than two members carry no constraint and are
 * dropped; `TDC221` says so out loud rather than dropping them in silence.
 */
function envWrapperGroups(env: OpenCloseElementContext | undefined, tag: string): string[][] {
  if (!env) return [];
  const groups: string[][] = [];
  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open' || elementName(k.node) !== tag) continue;
    const names: string[] = [];
    for (const inner of contentElements(k.node.content())) {
      const ik = elementKind(inner);
      if (ik?.kind !== 'open') continue;
      const innerName = elementName(ik.node);
      if (innerName !== 'sequence' && innerName !== 'mix' && innerName !== 'switch') continue;
      const nm = extractAttrs(ik.node.attr())['name'];
      if (nm) names.push(nm);
    }
    if (names.length >= 2) groups.push(names);
  }
  return groups;
}

/**
 * Env-level `<distinct>` groups — the wrapped sequences must produce different
 * values from each other per row (e.g. birth-city ≠ live-city). Sequence
 * granularity; the field-granularity `<distinct>` inside one sequence is
 * handled by `collectSequenceGens`.
 */
export function extractEnvDistinctGroups(env: OpenCloseElementContext | undefined): string[][] {
  return envWrapperGroups(env, 'distinct');
}

/**
 * Env-level `<uniq>` groups — the TUPLE of the wrapped sequences must be unique
 * across all rows (e.g. every (First, Last) pair distinct). The across-rows
 * twin of env-level `<distinct>`.
 */
export function extractEnvUniqGroups(env: OpenCloseElementContext | undefined): string[][] {
  return envWrapperGroups(env, 'uniq');
}

/**
 * Env-level `<assert that="…" says="…"/>` declarations, in document order.
 *
 * A sibling of `<uniq>` and `<distinct>` because, like them, it states something
 * about the whole run rather than about one column. Self-closing, so the generic
 * `selfClosingElement` rule already parses it and no grammar changed.
 */
export function extractAsserts(env: OpenCloseElementContext | undefined): AssertSpec[] {
  if (!env) return [];
  const out: AssertSpec[] = [];
  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'self' || elementName(k.node) !== 'assert') continue;
    const attrs = extractAttrs(k.node.attr());
    out.push({ that: (attrs['that'] ?? '').trim(), says: (attrs['says'] ?? '').trim() });
  }
  return out;
}

/**
 * A boolean attribute, read the way every other one in the DSL is read.
 *
 * `uniq` alone used to be compared against the bare literal `'true'` while the
 * validator lowercased it first. `uniq="True"` therefore passed validation as a
 * uniqueness promise and then did nothing at all — a column with duplicates that
 * `check` had already called valid.
 */
function isTrue(raw: string | undefined): boolean {
  return (raw ?? '').trim().toLowerCase() === 'true';
}

/**
 * All `<sequence>` and standalone `<mix>` nodes declared directly under
 * `<env>` OR wrapped in an env-level `<distinct>` / `<uniq>`, in document
 * order — so PRNG-consumption order and parent-reference order (parent must
 * precede child) are preserved.
 *
 * A `<mix>` inside a wrapper is a member like any other: a group rearranges
 * whole columns between rows and a mix keeps its value multiset whatever the
 * order, so its percentages survive the move. A `<switch>` joins too, but the
 * group may only move its value between rows that share a subject — see
 * `env-groups.ts`.
 */
function* envSequenceNodes(env: OpenCloseElementContext): Generator<OpenCloseElementContext> {
  for (const child of contentElements(env.content())) {
    const k = elementKind(child);
    if (k?.kind !== 'open') continue;
    const name = elementName(k.node);
    if (name === 'sequence' || name === 'mix' || name === 'switch') {
      yield k.node;
    } else if ((ENV_SEQUENCE_WRAPPERS as readonly string[]).includes(name)) {
      for (const inner of contentElements(k.node.content())) {
        const ik = elementKind(inner);
        if (ik?.kind !== 'open') continue;
        const inner_name = elementName(ik.node);
        if (inner_name === 'sequence' || inner_name === 'mix' || inner_name === 'switch') {
          yield ik.node;
        }
      }
    }
  }
}

function specFromSequence(node: OpenCloseElementContext): SequenceSpec | undefined {
  // Standalone env-level `<mix name="…">` — distribution sequence.
  if (elementName(node) === 'mix') return specFromMix(node);
  // Standalone env-level `<switch name="…" on="…">` — lookup sequence.
  if (elementName(node) === 'switch') return specFromSwitch(node);

  const seqAttrs = extractAttrs(node.attr());
  const name = seqAttrs['name'];
  if (!name) return undefined;

  const { nodes: genNodes, distinctGroups: distinctNodeGroups } = collectSequenceGens(node);
  const parent = seqAttrs['parent'];

  // Compute sequence: the sole producer is a `<compute>`. Detected before the
  // gen paths — a compute reads other values, it does not draw from a <gen>.
  const computeNode = findChildElement(node.content(), 'compute');
  if (computeNode && genNodes.length === 0) {
    return parent
      ? { name, parent, compute: { node: computeNode } }
      : { name, compute: { node: computeNode } };
  }

  if (genNodes.length === 0) return undefined;

  // Conditional sequence: any <gen> carries an `if`. Each gen becomes a branch;
  // the first whose `if` is truthy (or a bare gen with no `if` — the fallback)
  // produces the value. Detected BEFORE compound so `<gen if>` doesn't demand a
  // `name`. The `if` attr is stripped from the gen's own attrs (it's the branch
  // condition, not a generator setting).
  if (isConditional(genNodes)) {
    const branches: CondBranch[] = genNodes.map((gen) => {
      const attrs = extractAttrs(gen.attr());
      const { if: cond, ...genAttrs } = attrs;
      return cond !== undefined ? { cond, gen: toGenSpec(genAttrs) } : { gen: toGenSpec(genAttrs) };
    });
    return parent ? { name, parent, conditional: branches } : { name, conditional: branches };
  }

  // Composed sequence: the body is not all named <gen>s, so it builds its own
  // value out of the unnamed ones and the literals between them. Detected
  // before compound, because a body with one named gen beside an unnamed one is
  // both — and the composed reading is the one that gives ${{Name}} a value.
  const items = composedItems(node);
  if (items) {
    const distinctGroups = namedDistinctGroups(distinctNodeGroups);
    return {
      name,
      items,
      ...(parent ? { parent } : {}),
      ...(distinctGroups.length > 0 ? { distinctGroups } : {}),
      ...(isTrue(seqAttrs['uniq']) ? { uniq: true } : {}),
    };
  }

  if (isCompound(genNodes)) {
    const fields: CompoundField[] = [];
    for (const gen of genNodes) {
      const attrs = extractAttrs(gen.attr());
      const fieldName = attrs['name'] ?? '';
      if (!fieldName) continue; // validator flags mixed named/unnamed
      fields.push({ name: fieldName, gen: toGenSpec(attrs) });
    }
    const distinctGroups = namedDistinctGroups(distinctNodeGroups);
    return {
      name,
      gens: fields,
      ...(parent ? { parent } : {}),
      ...(distinctGroups.length > 0 ? { distinctGroups } : {}),
      ...(isTrue(seqAttrs['uniq']) ? { uniq: true } : {}),
    };
  }

  // Simple sequence: one unnamed <gen>. `uniq` travels here too — on a simple
  // sequence it means a draw without replacement (see sequence/uniq-simple.ts);
  // dropping it silently was the bug that made 100 "unique" names repeat.
  const first = genNodes[0];
  if (!first) return undefined;
  const firstAttrs = extractAttrs(first.attr());
  const uniq = isTrue(seqAttrs['uniq']) ? { uniq: true as const } : {};
  return parent
    ? { name, parent, gen: toGenSpec(firstAttrs), ...uniq }
    : { name, gen: toGenSpec(firstAttrs), ...uniq };
}

/**
 * The body as one ordered list, or `undefined` when it is an ordinary simple or
 * compound sequence.
 *
 * `undefined` is the important half: a lone unnamed `<gen>` and an all-named
 * body keep the paths they have always taken, so nothing that used to render
 * renders differently.
 */
function composedItems(node: OpenCloseElementContext): SequenceItem[] | undefined {
  const items: SequenceItem[] = [];
  /** Unnamed gens — the ones that both draw and compose. */
  let unnamed = 0;
  let named = 0;
  /** Unnamed literals, which compose without drawing. */
  let unnamedParts = 0;
  /** Any `<data>` at all, named or not: its presence alone means this reading. */
  let data = 0;
  /** `<gen>`s of either kind. A body with none is not a sequence. */
  let genCount = 0;

  const collect = (content: ReturnType<OpenCloseElementContext['content']>): void => {
    for (const el of contentElements(content)) {
      const k = elementKind(el);
      if (!k) continue;
      if (k.kind === 'data') {
        const text = extractDataText(k.node);
        const dataName = extractDataAttrs(k.node)['name'];
        if (dataName !== undefined && dataName !== '') {
          items.push({ kind: 'constant', name: dataName, text });
          named++;
          data++;
          continue;
        }
        if (text.length > 0) {
          items.push({ kind: 'text', text });
          unnamedParts++;
          data++;
        }
        continue;
      }
      // A <distinct> wrapper groups gens; its children are ordinary body items.
      if (k.kind === 'open' && elementName(k.node) === 'distinct') {
        collect(k.node.content());
        continue;
      }
      if (elementName(k.node) !== 'gen') continue;
      const attrs = extractAttrs(k.node.attr());
      const fieldName = attrs['name'];
      genCount++;
      if (fieldName !== undefined && fieldName !== '') {
        items.push({ kind: 'field', name: fieldName, gen: toGenSpec(attrs) });
        named++;
      } else {
        items.push({ kind: 'gen', gen: toGenSpec(attrs) });
        unnamed++;
        unnamedParts++;
      }
    }
  };
  collect(node.content());

  // A body with no <gen> at all is not a sequence; the validator says so
  // (TDC036) and inventing a column out of literals alone would hide it.
  if (genCount === 0) return undefined;
  // One unnamed gen and nothing else is the classic simple sequence; a body of
  // nothing but named <gen>s is the classic compound. Both keep their paths.
  if (data === 0 && (unnamed === 0 || (unnamed === 1 && named === 0))) return undefined;
  void unnamedParts;
  return items;
}

/**
 * Each `<distinct>` wrapper's gen nodes as field names. Groups with fewer than
 * two named fields carry no constraint.
 */
function namedDistinctGroups(groups: readonly GenNode[][]): string[][] {
  return groups
    .map((group) =>
      group.map((gen) => extractAttrs(gen.attr())['name']).filter((n): n is string => !!n),
    )
    .filter((group) => group.length >= 2);
}

function toGenSpec(attrs: Record<string, string>): GenSpec {
  return { type: attrs['type'] ?? '', attrs };
}

/**
 * A `<sequence>` is compound iff it has more than one `<gen>` child OR
 * its single `<gen>` carries a `name` attribute. The latter keeps the
 * door open for a one-field compound if someone writes it that way
 * deliberately; otherwise it's treated as simple.
 */
/** A `<sequence>` is conditional iff at least one `<gen>` child carries `if`. */
function isConditional(genNodes: readonly GenNode[]): boolean {
  return genNodes.some((gen) => extractAttrs(gen.attr())['if'] !== undefined);
}

function isCompound(genNodes: readonly GenNode[]): boolean {
  if (genNodes.length > 1) return true;
  const only = genNodes[0];
  if (!only) return false;
  const attrs = extractAttrs(only.attr());
  return attrs['name'] !== undefined;
}

/** Build a mix-sequence spec from a standalone env-level `<mix name="…">`. */
function specFromMix(node: OpenCloseElementContext): SequenceSpec | undefined {
  const attrs = extractAttrs(node.attr());
  const name = attrs['name'];
  if (!name) return undefined;
  const parent = attrs['parent'];
  const mixSpec = toMixSpec(node);
  return parent ? { name, parent, mixSpec } : { name, mixSpec };
}

/**
 * The body of a `<switch on="…">` — its subject, its entries and its fallback.
 *
 * Shared by the env-level form, which becomes a column of its own, and the form
 * written inside a `<case>`, which contributes a value to the branch it sits in.
 * One reader, so the two spellings cannot drift apart.
 */
function toSwitchSpec(node: OpenCloseElementContext): SwitchSpec {
  const on = extractAttrs(node.attr())['on'] ?? '';

  const entries: SwitchEntry[] = [];
  let fallback: CaseSpec | undefined;
  for (const el of contentElements(node.content())) {
    const mapEl = el.mapElement();
    if (mapEl) {
      entries.push(...parseMapEntries(extractMapText(mapEl)));
      continue;
    }
    const k = elementKind(el);
    if (k?.kind !== 'open') continue;
    const childName = elementName(k.node);
    if (childName === 'case') {
      const keys = splitKeys(extractAttrs(k.node.attr())['is'] ?? '');
      entries.push({ keys, value: toCaseSpec(k.node) });
    } else if (childName === 'default') {
      fallback = toCaseSpec(k.node);
    }
  }

  return fallback ? { on, entries, fallback } : { on, entries };
}

/** Build a switch-sequence spec from a standalone env-level `<switch on="…">`. */
function specFromSwitch(node: OpenCloseElementContext): SequenceSpec | undefined {
  const name = extractAttrs(node.attr())['name'];
  if (!name) return undefined;
  return { name, switchSpec: toSwitchSpec(node) };
}

/** Split a `A|B|C` multi-key string into trimmed, non-empty keys. */
function splitKeys(raw: string): string[] {
  return raw
    .split('|')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Parse a `<map>` body — `KEY:VALUE` rows separated by commas — into switch
 * entries. Keys may be multi-valued (`A|B:V`). Each row is split on the FIRST
 * colon, so colons inside the value survive. Blank rows (e.g. a trailing
 * comma) are skipped; a malformed row without a colon is dropped here and
 * flagged by the validator. A row's value becomes a single literal `<data>`.
 */
function parseMapEntries(text: string): SwitchEntry[] {
  const out: SwitchEntry[] = [];
  for (const rawRow of text.split(',')) {
    const row = rawRow.trim();
    if (row.length === 0) continue;
    const colon = row.indexOf(':');
    if (colon < 0) continue;
    const keys = splitKeys(row.slice(0, colon));
    if (keys.length === 0) continue;
    const value = row.slice(colon + 1).trim();
    out.push({ keys, value: { parts: [{ kind: 'data', text: value }] } });
  }
  return out;
}

function toMixSpec(node: OpenCloseElementContext | undefined): MixSpec {
  if (!node) return { attrs: {}, cases: [] };
  const cases: CaseSpec[] = [];
  for (const el of contentElements(node.content())) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === 'case') {
      cases.push(toCaseSpec(k.node));
    }
  }
  return { attrs: extractAttrs(node.attr()), cases };
}

function toCaseSpec(node: OpenCloseElementContext): CaseSpec {
  const parts: CasePart[] = [];
  for (const el of contentElements(node.content())) {
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data') {
      parts.push({ kind: 'data', text: extractDataText(k.node) });
      continue;
    }
    if (k.kind === 'self' && elementName(k.node) === 'gen') {
      parts.push({ kind: 'gen', gen: toGenSpec(extractAttrs(k.node.attr())) });
      continue;
    }
    if (k.kind === 'open') {
      const name = elementName(k.node);
      if (name === 'gen') {
        parts.push({ kind: 'gen', gen: toGenSpec(extractAttrs(k.node.attr())) });
      } else if (name === 'mix') {
        parts.push({ kind: 'mix', mixSpec: toMixSpec(k.node) });
      } else if (name === 'switch') {
        parts.push({ kind: 'switch', switchSpec: toSwitchSpec(k.node) });
      }
    }
  }
  // `anomaly="true"` labels the branch for a `<mix flag="NAME">` column.
  const anomaly = (extractAttrs(node.attr())['anomaly'] ?? '').trim().toLowerCase() === 'true';
  return anomaly ? { parts, anomaly: true } : { parts };
}
