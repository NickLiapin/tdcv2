/**
 * Parse a pack generator body into an executable form.
 *
 * Two shapes (docs/superpowers/specs/2026-07-14-pack-generators-design.md):
 *
 *   - **single** — one primitive `<gen type="…" …/>`. Simplest case
 *     (a licence plate via one regex).
 *   - **composed** — one or more local `<sequence>` declarations
 *     (compound allowed) plus one `<data>` output template that combines
 *     them, e.g. a Spanish full name from name/surname lists:
 *
 *       <sequence>
 *         <gen name="F1" type="template" value="es.person.man.firstName"/>
 *         <gen name="L1" type="template" value="es.person.lastName"/>
 *       </sequence>
 *       <data>${{F1}} ${{L1}}</data>
 *
 * The body reuses TDC's own parser, so it is identical to the config DSL.
 * Local sequences are materialised over `count` by the same engine, so
 * exact percentages / shuffle / determinism transfer for free.
 *
 * Safety (phase 2): generators may reference DATA lists and use primitive
 * generators only. `template` references to other GENERATORS are rejected
 * (they would risk cycles — deferred to a later phase with cycle
 * detection). Because a data list is a leaf, no cycle is possible here.
 */

import type { DocumentContext, OpenCloseElementContext } from '../generated/TDCParser.js';
import { RESERVED_TEMPLATE_ATTRS } from '../sequence/build.js';
import { parse } from '../parser/index.js';
import { extractSequenceSpecs } from '../sequence/extract.js';
import type { CaseSpec, GenSpec, SequenceSpec, MixSpec, SwitchSpec } from '../sequence/types.js';
import {
  contentElements,
  elementKind,
  elementName,
  extractAttrs,
  extractDataText,
  findChildElement,
} from '../processor/walk.js';
import { childTagName } from '../validator/placement.js';

/** Generator types allowed as a self-contained primitive body. */
export const PRIMITIVE_GENERATOR_TYPES: readonly string[] = [
  'text',
  'number',
  'regex',
  'advanced_regex',
  'symbol',
  'date',
  'increment',
  'decrement',
];

/** Types allowed for a `<gen>` inside a composed generator's local sequences. */
const COMPOSED_GEN_TYPES: readonly string[] = [...PRIMITIVE_GENERATOR_TYPES, 'template'];

export type GeneratorBody =
  | { readonly kind: 'single'; readonly gen: GenSpec }
  | {
      readonly kind: 'composed';
      readonly sequences: readonly SequenceSpec[];
      readonly output: string;
      /**
       * Optional `<valid>` predicate for reject-and-retry (migration spec §4.2):
       * a row whose predicate is false has its base sequences redrawn (bounded)
       * before output. Absent for generators that never reject.
       */
      readonly validate?: OpenCloseElementContext;
      /**
       * Interpolation pattern for the `<data>` output template, e.g. `${{%}}`
       * (the default) or a custom delimiter like `<<%>>`. Lets a generator emit
       * literal `${{…}}`/`{{…}}` content (GitHub Actions, Vue, Handlebars…)
       * without it clashing with TDC's own interpolation. Set via the pack
       * file's `inject:` header; isolated per generator (never inherits the
       * consuming config's inject).
       */
      readonly inject: string;
    };

export interface ParsedGenerator {
  readonly body: GeneratorBody;
  /** Dotted addresses this generator references via `template` gens. */
  readonly references: readonly string[];
  /**
   * True when the body declares a share — a `<mix percent>` or a `percent=` on a
   * `<gen>`. Such a generator is only correct across a WHOLE column: the quota is
   * apportioned over the row count, so running it a row at a time hands every row
   * to the largest share. The streaming engines resolve per row, so a config that
   * uses this pack must run on the in-memory engine — see `resolveRenderEngine`.
   */
  readonly needsWholeColumn: boolean;
}

export interface GeneratorParseResult {
  readonly generator?: ParsedGenerator;
  readonly error?: string;
}

/** A share declared anywhere in the body: `<mix percent>` or `<gen percent>`. */
function declaresShare(specs: readonly SequenceSpec[]): boolean {
  const share = (attrs: Readonly<Record<string, string | undefined>> | undefined): boolean =>
    (attrs?.['percent'] ?? '').trim() !== '';
  return specs.some(
    (s) =>
      share(s.mixSpec?.attrs) ||
      share(s.gen?.attrs) ||
      (s.gens ?? []).some((f) => share(f.gen.attrs)),
  );
}

export function parseGeneratorSpec(body: string, inject?: string): GeneratorParseResult {
  const wrapped = `<tdc><env count="1">${body}</env></tdc>`;
  const result = parse(wrapped);
  if (result.diagnostics.length > 0) {
    return { error: result.diagnostics[0]?.message ?? 'could not parse generator body' };
  }

  const env = findEnv(result.tree);
  if (!env) return { error: 'generator body did not parse' };

  const sequences = extractSequenceSpecs(env);
  const outputText = findOutputData(env);

  // Composed form: local sequences + a <data> output template.
  if (sequences.length > 0 || outputText !== undefined) {
    if (outputText === undefined) {
      return { error: 'a composed generator needs a <data>…</data> output template' };
    }
    const resolvedInject = inject ?? '${{%}}';
    if (!resolvedInject.includes('%')) {
      return {
        error: `inject pattern "${resolvedInject}" has no "%" placeholder — interpolation will never match`,
      };
    }
    const misplaced = firstMisplacedInSequence(env);
    if (misplaced !== undefined) return { error: misplaced };
    const wholeColumn = firstWholeColumnDeclaration(env);
    if (wholeColumn !== undefined) return { error: wholeColumn };
    const unreachable = firstUnreachableParameter(env);
    if (unreachable !== undefined) return { error: unreachable };
    // A `<compute>` sequence carries no <gen> (it derives its value), so it is
    // implicitly allowed here — this is how checksum generators (INN, IBAN,
    // Luhn) live as editable pack data. Its tree is validated at render time by
    // the compute evaluator; the whitelist below only constrains <gen> types.
    for (const spec of sequences) {
      const badType = firstDisallowedType(spec, COMPOSED_GEN_TYPES);
      if (badType !== undefined) {
        return {
          error: `generator uses <gen type="${badType}"> which is not allowed inside a pack generator`,
        };
      }
    }
    const validate = findChildElement(env.content(), 'valid');
    return {
      generator: {
        body: {
          kind: 'composed',
          sequences,
          output: outputText,
          inject: resolvedInject,
          ...(validate ? { validate } : {}),
        },
        references: collectRefs(sequences),
        needsWholeColumn: declaresShare(sequences),
      },
    };
  }

  // Single-primitive form: one bare <gen>.
  const gen = findBareGen(env);
  if (!gen) {
    return { error: 'generator body must contain a <gen> or <sequence>…</sequence> + <data>' };
  }
  const attrs = extractAttrs(gen.attr());
  const type = attrs['type'] ?? '';
  if (type.length === 0) {
    return { error: '<gen> in a generator body is missing a "type" attribute' };
  }
  if (!PRIMITIVE_GENERATOR_TYPES.includes(type)) {
    return {
      error:
        `generator type "${type}" is not supported as a single-<gen> body ` +
        `(supported: ${PRIMITIVE_GENERATOR_TYPES.join(', ')}); ` +
        'to reference data, use <sequence>…</sequence> + <data>',
    };
  }
  // A single `<gen percent="…">` apportions its own quota over the column too.
  return {
    generator: {
      body: { kind: 'single', gen: { type, attrs } },
      references: [],
      needsWholeColumn: (attrs['percent'] ?? '').trim() !== '',
    },
  };
}

/**
 * Constructs that belong somewhere other than directly inside a `<sequence>`.
 *
 * The same five the validator refuses in a config with TDC013, and refused here
 * for the same reason — except that in a pack body nothing was refusing them at
 * all. A `<mix>` written inside a pack's `<sequence>` produced no value and no
 * complaint: `${{p.m}}` reached the output as eight literal characters, which is
 * the one outcome worse than an error, because the run looks like it worked.
 *
 * Distribution is an env-level construct: a pack declares its own shares with a
 * `<mix>` at the top of its body, beside the sequences rather than inside one.
 */
const MISPLACED_IN_SEQUENCE: readonly string[] = ['mix', 'switch', 'case', 'default', 'map'];

function firstMisplacedInSequence(env: OpenCloseElementContext): string | undefined {
  for (const el of contentElements(env.content())) {
    const k = elementKind(el);
    // Only a paired `<sequence>…</sequence>` can hold anything at all, so a
    // self-closing one has nothing to be misplaced inside it.
    if (k?.kind !== 'open' || elementName(k.node) !== 'sequence') continue;

    for (const child of contentElements(k.node.content())) {
      const name = childTagName(child);
      if (name === null || !MISPLACED_IN_SEQUENCE.includes(name)) continue;
      return (
        `generator has <${name}> directly inside <sequence>, which is not allowed. ` +
        'A <mix> or <switch> is a named construct of its own — declare it beside the ' +
        'sequences in the pack body and reach it as ${{Name}}.'
      );
    }
  }
  return undefined;
}

/**
 * Whole-COLUMN declarations, which a pack body cannot honour.
 *
 * A pack describes how to build ONE value and is asked for one per row. These
 * two say something about the column as a whole — which values may repeat across
 * rows, and in what order they come out — and answering that needs the row count
 * and every other row, neither of which a pack has. Worse, one pack can be drawn
 * from by several sequences in one config, so there is no single column for the
 * pack to be speaking about.
 *
 * They were accepted and silently ignored, which is the failure that costs a
 * pack author the most time: the file says what they meant, the output does not
 * do it, and nothing anywhere says why. Uniqueness and order belong to the config
 * drawing from the pack, where `uniq=` and `order=` already work.
 *
 * `<distinct>` is deliberately NOT here. It reads like a sibling of `uniq=` and
 * is not one: it constrains fields against each other WITHIN one row, which is
 * exactly what a pack can answer on its own — and five shipped full-name packs
 * rely on it to keep a person's two surnames from coming out the same.
 */
const WHOLE_COLUMN_ATTRS: readonly string[] = ['uniq', 'order'];

function firstWholeColumnDeclaration(env: OpenCloseElementContext): string | undefined {
  for (const el of contentElements(env.content())) {
    const k = elementKind(el);
    if (!k || k.kind === 'data' || elementName(k.node) !== 'sequence') continue;

    const attrs = extractAttrs(k.node.attr());
    const named = attrs['name'];
    const where = named === undefined ? '<sequence>' : `<sequence name="${named}">`;
    for (const attr of WHOLE_COLUMN_ATTRS) {
      if ((attrs[attr] ?? '').trim() === '') continue;
      return (
        `generator declares ${attr}= on ${where}, which a pack cannot honour: a pack builds ` +
        `ONE value and is asked for one per row, while ${attr}= is a property of the whole ` +
        'column. Declare it on the sequence in the config that draws from this pack instead.'
      );
    }
  }
  return undefined;
}

/**
 * A `<sequence>` whose name the ENGINE reads off the calling `<gen>` first.
 *
 * A pack's parameters ARE its sequence names: `domain="example.test"` replaces
 * the sequence called `domain`. But a handful of names are read by the engine
 * before the pack ever runs — `local=` is the locale override, `order=` and
 * `case=` and `mask=` are wrappers around whatever the pack produces — so a
 * sequence called one of those can never be set from outside. The pack works;
 * the parameter simply does not exist, and the reference table generated from
 * the pack bodies listed it as if it did.
 *
 * Measured before this was added: 34 shipped packs were in that state.
 * `common.internet.email` declared `local`, so the documented `local=` silently
 * chose a LOCALE instead of the address's local part; 32 street-name packs
 * declared `type`, which cannot even be written twice on one tag; and
 * `france.docs.nir` declared `order`. All three were renamed — `user`, `kind`,
 * `serial` — and the output of every one of the 34 is byte-identical, because a
 * pack's internal sequence name reaches nothing outside the pack.
 *
 * An error rather than a warning: unlike a caller's mistake, this is the pack
 * author's, it is decidable from the file alone, and shipping it means shipping
 * a parameter nobody can use.
 */
function firstUnreachableParameter(env: OpenCloseElementContext): string | undefined {
  for (const el of contentElements(env.content())) {
    const k = elementKind(el);
    if (!k || k.kind === 'data' || elementName(k.node) !== 'sequence') continue;
    const name = extractAttrs(k.node.attr())['name'];
    if (name === undefined || !RESERVED_TEMPLATE_ATTRS.has(name)) continue;
    return (
      `generator declares <sequence name="${name}">, and "${name}" is read by the engine ` +
      'off the calling <gen> before this pack runs, so no caller can ever set it. Rename ' +
      "the sequence: a pack's parameters are its sequence names, and this one is taken."
    );
  }
  return undefined;
}

/** Collect all `template` addresses referenced by a set of sequence specs. */
function collectRefs(specs: readonly SequenceSpec[]): string[] {
  const refs: string[] = [];
  for (const spec of specs) {
    for (const g of allGensOfSpec(spec)) {
      if (g.type === 'template') {
        const v = g.attrs['value'];
        if (v !== undefined && v.length > 0) refs.push(v);
      }
    }
  }
  return refs;
}

function firstDisallowedType(spec: SequenceSpec, allowed: readonly string[]): string | undefined {
  for (const g of allGensOfSpec(spec)) {
    if (!allowed.includes(g.type)) return g.type;
  }
  return undefined;
}

/**
 * Every GenSpec reachable from a sequence spec — the simple/compound
 * `<gen>` children AND the `<gen>`s nested inside `<mix>`/`<case>`
 * (recursively through nested mixes). Used so the whitelist and
 * reference collection see gens hidden inside switch cases, not just
 * top-level fields.
 */
function* allGensOfSpec(spec: SequenceSpec): Generator<GenSpec> {
  if (spec.gen) yield spec.gen;
  for (const field of spec.gens ?? []) yield field.gen;
  for (const branch of spec.conditional ?? []) yield branch.gen;
  if (spec.mixSpec) yield* gensOfMix(spec.mixSpec);
  if (spec.switchSpec) yield* gensOfSwitch(spec.switchSpec);
}

function* gensOfCase(c: CaseSpec): Generator<GenSpec> {
  for (const part of c.parts) {
    if (part.kind === 'gen') yield part.gen;
    else if (part.kind === 'mix') yield* gensOfMix(part.mixSpec);
  }
}

function* gensOfMix(sw: MixSpec): Generator<GenSpec> {
  for (const c of sw.cases) yield* gensOfCase(c);
}

function* gensOfSwitch(sw: SwitchSpec): Generator<GenSpec> {
  for (const e of sw.entries) yield* gensOfCase(e.value);
  if (sw.fallback) yield* gensOfCase(sw.fallback);
}

function findOutputData(env: OpenCloseElementContext): string | undefined {
  for (const el of contentElements(env.content())) {
    const k = elementKind(el);
    if (k?.kind === 'data') return extractDataText(k.node);
  }
  return undefined;
}

function findBareGen(env: OpenCloseElementContext) {
  for (const el of contentElements(env.content())) {
    const k = elementKind(el);
    if (!k || k.kind === 'data') continue;
    if (elementName(k.node) === 'gen') return k.node;
  }
  return undefined;
}

function findEnv(doc: DocumentContext): OpenCloseElementContext | undefined {
  for (const el of doc.element()) {
    const k = elementKind(el);
    if (k?.kind !== 'open' || elementName(k.node) !== 'tdc') continue;
    return findChildElement(k.node.content(), 'env');
  }
  return undefined;
}
