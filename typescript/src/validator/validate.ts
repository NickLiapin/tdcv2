/**
 * Semantic validator for a parsed TDC document.
 *
 * Runs AFTER the parser has produced a concrete tree. Finds problems
 * that the grammar accepts but that would otherwise only surface at
 * render time — things like:
 *
 *   - Missing or misspelled attribute names / values
 *   - Unknown `<gen type="…">` kinds
 *   - Unknown template paths (with "did you mean X?" suggestions)
 *   - Unknown / forward / malformed `parent="…"` references
 *   - Malformed `if="…"` expressions (jsep compile + supported-operator check)
 *   - Malformed numeric/date ranges, bad percent sums
 *   - Missing files for `<gen type="file" src="…">`
 *   - Duplicate `<sequence>` names
 *   - Unknown attributes / unknown child tags (warnings)
 *
 * Every finding is a `Diagnostic` with line/column pointing at the most
 * specific node possible (ideally the attribute value token). The
 * renderer no longer needs to produce friendly errors for these — it can
 * assume a validated tree.
 */

import type { DataSourceOptions } from '../data-source/index.js';
import { PercentMaskError, expandPercentMask } from '../distribution/index.js';
import {
  type Diagnostic,
  attrValueRange,
  closestMatch,
  formatCandidates,
  nodeRange,
} from '../errors/index.js';
import type {
  AttrContext,
  DocumentContext,
  OpenCloseElementContext,
  SelfClosingElementContext,
} from '../generated/TDCParser.js';
import {
  collectSequenceGens,
  contentElements,
  dataFieldNames,
  elementKind,
  elementName,
  extractAttrs,
  extractDataText,
  findAttr,
  findChildElement,
  hasDataLiteral,
} from '../processor/walk.js';
import { checkSequenceDataAttrs, type SequenceShape, sequenceShape } from './sequence-body.js';

import {
  BUILTIN_SEQUENCES,
  KNOWN_CASE_CHILDREN,
  KNOWN_DISTINCT_CHILDREN,
  KNOWN_ENV_GROUP_CHILDREN,
  KNOWN_ENV_CHILDREN,
  KNOWN_GEN_TYPES,
  KNOWN_MIX_CHILDREN,
  KNOWN_SEQUENCE_CHILDREN,
  KNOWN_TDC_CHILDREN,
} from './known.js';
import {
  childNode,
  childTagName,
  isKnownConstruct,
  reportMisplaced,
  reportUnknownChild,
} from './placement.js';
import { checkGenByType } from './gen-type.js';
import { checkIfExpression, type PendingExpression, runPendingExpressions } from './expr-check.js';
import { checkSwitchCaseAttrs, checkSwitchMap } from './switch-body.js';
import { checkRowLinkOrder } from './row-link-order.js';
import { checkSequentialRepeat } from './sequential-repeat.js';
import { checkCompute } from './compute.js';
import { checkGroupDerivedMember, checkGroupSize } from './group-size.js';
import { checkAssertTag } from './assert.js';
import { checkSmallShares } from './small-share.js';
import { checkGenBody, checkGroupBody, openChild } from './container-children.js';
import { checkOneEnvOneBlock } from './container-children.js';
import {
  checkPoolIsRead,
  checkPoolRefHasNoIf,
  collectPoolFieldValues,
  collectPoolFields,
  collectPoolReferences,
  registerPoolReference,
  runPendingPoolFilters,
  type PendingPoolFilter,
} from './pool.js';
import {
  checkEnvSequenceGroup,
  checkPoolDeclaration,
  checkSelfClosingSequence,
  type MemberCheckers,
} from './members.js';
import { checkUniqMemory } from './uniq-memory.js';
import {
  checkUniqDropsAttrs,
  checkUniqOnComposed,
  checkUniqUnsupported,
  checkUniqWithDistinct,
} from './uniq-shape.js';
import { checkMixFlag } from './mix-flag.js';
import { checkGenRepeat, checkMixRepeat } from './repeat.js';
import { checkLineConditionalColumns, checkLineEach } from './each.js';
import { EACH_BUILTINS } from '../processor/each.js';
import { checkGenWeight } from './weight.js';
import { checkGenMask } from './mask.js';
import { checkAnomalyFlag, checkGenIfInCase, checkGenImperfections } from './imperfections.js';
import { checkParentRef } from './parent-ref.js';
import { checkAllUnknownAttrs, checkUnknownAttrs } from './unknown-attrs.js';
import { checkAttrInterpolation } from './interpolation.js';
import { FIXTURE_TAGS, checkFixture } from './fixture.js';
import { checkData } from './data-element.js';
import { isCaseTransform } from '../format/transforms.js';
import { checkDocumentVersion } from './version.js';
import type { PackParams, PackParamWidths } from './pack-params.js';
import { checkRootRegexMaxLength } from './regex-max-length.js';
import { checkBlockDataRefs } from './data-refs.js';

export interface ValidationResult {
  readonly diagnostics: readonly Diagnostic[];
}

export interface ValidationOptions {
  readonly dataSources?: DataSourceOptions | undefined;
  /**
   * Dotted addresses of loaded data packs. Treated as valid `template`
   * values so pack addresses aren't flagged as unknown template paths.
   */
  readonly packAddresses?: readonly string[] | undefined;
  /**
   * Address → the parameter names a generator pack accepts (its `<sequence>`
   * names). Lets the validator catch an attribute the pack cannot act on.
   */
  readonly packParams?: PackParams | undefined;
  /**
   * Address → parameter → the width the pack's own sequence always produces.
   * Only the ones that can be PROVEN are here; the rest are simply absent.
   */
  readonly packParamWidths?: PackParamWidths | undefined;
}

export function validate(tree: DocumentContext, options: ValidationOptions = {}): ValidationResult {
  const diags: Diagnostic[] = [];

  const tdc = findTdc(tree);
  if (!tdc) {
    diags.push({
      severity: 'error',
      source: 'validator',
      line: 1,
      column: 0,
      message: 'document has no <tdc> root element',
      hint: 'Wrap your configuration in a single <tdc>…</tdc> root tag.',
      code: 'TDC001',
    });
    return { diagnostics: diags };
  }

  checkDocumentVersion(tdc, diags);
  const ctx = new Ctx(
    diags,
    checkRootRegexMaxLength(tdc, diags),
    options.dataSources ?? {},
    options.packAddresses ?? [],
    options.packParams,
    options.packParamWidths,
  );

  checkOneEnvOneBlock(tdc, diags);
  const envEl = findChildElement(tdc.content(), 'env');
  const blockEl = findChildElement(tdc.content(), 'block');

  if (!blockEl) {
    diags.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(tdc),
      message: '<tdc> has no <block> child — nothing to render',
      hint: '<block> describes the layout of each generated card. Add a <block>…</block> inside <tdc>.',
      code: 'TDC002',
    });
  }

  // <tdc> holds only <env> and <block>. Flag anything else.
  for (const child of contentElements(tdc.content())) {
    if (child.mapElement()) {
      reportMisplaced(child, 'map', 'tdc', ctx);
      continue;
    }
    const k = elementKind(child);
    if (!k || k.kind === 'data') continue;
    const childName = elementName(k.node);

    // `<env count="3" seed="demo"/>` parses, and then every attribute on it is
    // discarded: the run silently falls back to the default count on a random
    // seed. The self-closing spelling cannot carry the sequences and fixtures
    // that give <env> its purpose, so refuse it rather than honour half of it.
    // Same for <block/>, which would leave nothing to render.
    if (k.kind === 'self' && (childName === 'env' || childName === 'block')) {
      diags.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(k.node),
        message: `<${childName}/> cannot be self-closing — its attributes and children would be ignored`,
        hint: `Write <${childName}> … </${childName}>. A self-closing <${childName}/> silently discards count, seed and everything inside.`,
        code: 'TDC014',
      });
      continue;
    }

    if (!childName || KNOWN_TDC_CHILDREN.includes(childName)) continue;
    // Known constructs that just belong deeper → clear placement error.
    if (isKnownConstruct(childName)) {
      reportMisplaced(child, childName, 'tdc', ctx);
      continue;
    }
    // Otherwise it's an unknown/typo'd tag.
    const suggestion = closestMatch(childName, KNOWN_TDC_CHILDREN);
    diags.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(k.node),
      message: `unknown child of <tdc>: "<${childName}>"`,
      ...(suggestion ? { suggestion: `did you mean "<${suggestion}>"?` } : {}),
      hint: `Allowed inside <tdc>: ${formatCandidates([...KNOWN_TDC_CHILDREN].sort())}.`,
      code: 'TDC010',
    });
  }

  // One pass over the whole document: an attribute the engine never reads is a
  // silent no-op, and a near-miss spelling produces plausible, wrong data.
  checkAllUnknownAttrs([...contentElements(tdc.content())], diags);
  checkUnknownAttrs('tdc', tdc.attr(), diags);

  if (envEl) checkEnv(envEl, ctx);
  if (blockEl) checkBlock(blockEl, ctx);

  // Two second passes, pools before expressions. Both splice their complaints
  // back at the position the attribute was found, so the report still reads top
  // to bottom; running the pool pass first is what makes the two independent —
  // an expression's recorded position is relative to the walk, and re-splicing
  // it after another pass has inserted would need that pass's shifts as well.
  runPendingPoolFilters(
    ctx.pendingPoolFilters,
    diags,
    ctx.declaredSequences,
    ctx.finiteValues,
    ctx.poolFieldValues,
  );
  runPendingExpressions(
    ctx.pendingExpressions,
    diags,
    ctx.declaredSequences,
    ctx.valuelessSequences,
    ctx.finiteValues,
  );

  return { diagnostics: diags };
}

// -----------------------------------------------------------------------
// Internal walker state
// -----------------------------------------------------------------------

class Ctx {
  /** Names of sequences encountered in declaration order — for parent refs. */
  public readonly declaredSequences: string[] = [];

  /** Of those, the ones whose `<gen>` repeats — the only ones `each=` can walk. */
  public readonly repeatingSequences: string[] = [];

  /**
   * Field names declared by each `<pool>`, so a `<gen type="pool">` reference
   * can register `Ref.field` and every later check — a `<switch on=>`, an
   * interpolation, an `if=` — resolves it like any other field.
   */
  public poolFields: ReadonlyMap<string, readonly string[]> = new Map();

  /** Of those fields, the ones whose value list the config writes down — TDC225. */
  public poolFieldValues: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>> = new Map();

  /** Sequences that draw a whole member from a pool — records, not values. */
  public readonly poolReferences: string[] = [];

  /** Every `filter=` seen, checked once every column it may name is known. */
  public readonly pendingPoolFilters: PendingPoolFilter[] = [];

  /**
   * Every `if=` seen, and where its complaint belongs in the report.
   *
   * The names it uses cannot be checked as the walk passes: an expression may
   * name a sequence declared BELOW it, and the run resolves that happily, so
   * checking mid-walk would invent errors on configs that work. They are
   * checked once the walk is done and every name is known, and spliced back at
   * the position they were found, so the report still reads top to bottom.
   */
  public readonly pendingExpressions: PendingExpression[] = [];

  /** Put one aside, remembering where in the report it belongs. */
  public rememberExpression(
    attr: AttrContext,
    expr: string,
    eachBuiltins: readonly string[] = [],
  ): void {
    this.pendingExpressions.push({ at: this.diagnostics.length, attr, expr, eachBuiltins });
  }

  /**
   * Of those, the compounds — every `<gen>` named, so the sequence is a group of
   * fields and has no value of its own.
   *
   * Which matters to `parent=`: a parent is filtered on its VALUE, and a group
   * of fields has none to filter on.
   */
  public readonly valuelessSequences: string[] = [];

  /**
   * Sequences whose produced values are plainly the list in their `value=`.
   *
   * Which is what lets `if="Gender.Mail"` be caught: the dot on a plain sequence
   * asks about a VALUE, and here the values are known. Only recorded where
   * nothing rewrites them on the way out — see [[finiteTextValues]].
   */
  public readonly finiteValues = new Map<string, readonly string[]>();

  /** The env's interpolation pattern; interpolation-filter checks run only when
   * it is the default `${{%}}` (custom delimiters are left unvalidated). */
  public inject = '${{%}}';

  /**
   * The locale the run will use — `<env local="…">`, `en` when unset. A
   * template path is checked against THIS locale, not against "some locale
   * ships it".
   */
  public locale = 'en';

  /**
   * The run length from `<env count="…">`, once it has parsed. Needed by checks
   * whose answer depends on SIZE rather than on shape — how much a `uniq` column
   * will cost, which is nothing at a hundred rows and gigabytes at ten million.
   */
  public count = 0;

  public constructor(
    public readonly diagnostics: Diagnostic[],
    public readonly regexMaxLength: number,
    public readonly dataSources: DataSourceOptions,
    public readonly packAddresses: readonly string[],
    public readonly packParams: PackParams | undefined,
    public readonly packParamWidths: PackParamWidths | undefined,
  ) {}

  public known(name: string): boolean {
    return this.declaredSequences.includes(name) || BUILTIN_SEQUENCES.includes(name);
  }
}

// -----------------------------------------------------------------------
// <env>
// -----------------------------------------------------------------------

function checkEnv(envEl: OpenCloseElementContext, ctx: Ctx): void {
  const attrs = envEl.attr();
  const attrMap = extractAttrs(attrs);

  // Recorded before anything else: the template check below resolves its
  // addresses against it.
  const declaredLocale = (attrMap['local'] ?? '').trim();
  if (declaredLocale !== '') ctx.locale = declaredLocale;

  // count: must parse as positive integer when present.
  const countAttr = findAttr(attrs, 'count');
  if (countAttr) {
    const raw = attrMap['count'] ?? '';
    const n = Number(raw);
    if (Number.isFinite(n) && Number.isInteger(n) && n >= 0) ctx.count = n;
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(countAttr),
        message: `invalid count "${raw}" — expected a non-negative integer`,
        code: 'TDC020',
      });
    }
  }

  // inject: the renderer splits on `(.+)%(.+)`, so the pattern needs a `%`
  // with something on BOTH sides of it. Counting the `%` alone let `"%%"` and
  // `"%x"` through: they have one, they cannot be split, and the renderer
  // quietly stopped interpolating — every `${{Name}}` in the file reached the
  // output verbatim with nothing said.
  const injectAttr = findAttr(attrs, 'inject');
  if (injectAttr) {
    ctx.inject = attrMap['inject'] ?? '${{%}}';
    const pattern = attrMap['inject'] ?? '';
    if (!/(.+)%(.+)/.test(pattern)) {
      const hasPct = pattern.includes('%');
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(injectAttr),
        message: hasPct
          ? `inject pattern "${pattern}" has nothing on both sides of its "%" — interpolation will never match`
          : `inject pattern "${pattern}" has no "%" placeholder — interpolation will never match`,
        hint:
          'The `%` is where the sequence name goes, and it needs an opening and a closing part ' +
          'around it: inject="${{%}}", inject="[%]", inject="%{%}%".',
        code: 'TDC021',
      });
    }
  }

  // Pools first, and only their shape: a reference may stand above the pool it
  // names, and complaining about an unknown field in that case would report a
  // problem the author does not have.
  ctx.poolFields = collectPoolFields(envEl);
  ctx.poolFieldValues = collectPoolFieldValues(envEl);
  const poolsRead = collectPoolReferences(envEl);

  // A share below one whole row: its own pass, because the denominator of a
  // <mix> in a switch branch belongs to the switch and not to the walk below.
  checkSmallShares(envEl, ctx.count, ctx.diagnostics);

  // Walk env children: sequences + mix/switch + fixtures.
  const poolsAbove: string[] = [];
  for (const child of contentElements(envEl.content())) {
    // A stray <map> is invisible to elementKind — catch it (only lives in <switch>).
    if (child.mapElement()) {
      reportMisplaced(child, 'map', 'env', ctx);
      continue;
    }
    const k = elementKind(child);
    if (!k || k.kind === 'data') continue;
    const name = elementName(k.node);
    if (!name) continue;

    if (name === 'sequence' && k.kind === 'self') {
      checkSelfClosingSequence(k.node, ctx.diagnostics);
      continue;
    }

    if (name === 'sequence' && k.kind === 'open') {
      checkSequence(k.node, ctx);
      continue;
    }

    if (name === 'mix' && k.kind === 'open') {
      checkMix(k.node, ctx);
      continue;
    }

    if (name === 'switch' && k.kind === 'open') {
      checkSwitch(k.node, ctx);
      continue;
    }

    if ((name === 'distinct' || name === 'uniq') && k.kind === 'open') {
      checkGroupBody({ node: k.node }, name, KNOWN_ENV_GROUP_CHILDREN, ctx);
      checkGroupSize(k.node, ctx.diagnostics, name);
      checkGroupDerivedMember(k.node, ctx.diagnostics, name);
      checkEnvSequenceGroup(k.node, ctx.diagnostics, name, memberCheckers(ctx));
      continue;
    }

    // A <pool> is a miniature <env>: its own attributes are checked here, and
    // its body goes through the very same member checks as the top level.
    if (name === 'pool' && k.kind === 'open') {
      // `poolsAbove` grows as the walk goes: a member may draw from a pool
      // already seen and from nothing else, which makes a cycle unwritable.
      const checkers = memberCheckers(ctx);
      // A pool's members read each other and nothing from the run — the table is
      // built before any row exists — so every `if=` written inside is checked
      // against the pool's own field names.
      checkPoolDeclaration(
        k.node,
        poolsAbove,
        ctx.diagnostics,
        checkers,
        ctx.declaredSequences,
        ctx.pendingExpressions,
      );
      checkPoolIsRead(k.node, poolsRead, ctx.diagnostics);
      continue;
    }

    // `that=` is the if= language, so it takes the same two passes: syntax now,
    // names once every sequence is known.
    if (name === 'assert' && k.kind === 'self') {
      checkAssertTag(k.node, ctx);
      continue;
    }

    if (FIXTURE_TAGS.includes(name)) {
      if (k.kind === 'open') checkFixture(k.node, name, ctx.diagnostics);
      continue;
    }

    if (KNOWN_ENV_CHILDREN.includes(name)) continue;

    // Known constructs that just belong somewhere else → clear placement error.
    if (name === 'gen' || name === 'case' || name === 'default' || name === 'line') {
      reportMisplaced(child, name, 'env', ctx);
      continue;
    }

    // Otherwise it's an unknown/typo'd tag.
    const suggestion = closestMatch(name, KNOWN_ENV_CHILDREN);
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(k.node),
      message: `unknown child of <env>: "<${name}>"`,
      ...(suggestion ? { suggestion: `did you mean "<${suggestion}>"?` } : {}),
      hint: `Allowed inside <env>: ${formatCandidates([...KNOWN_ENV_CHILDREN].sort())}.`,
      code: 'TDC010',
    });
  }
}

/** The top-level member checks, handed to whatever walks a container of them. */
function memberCheckers(ctx: Ctx): MemberCheckers {
  return {
    sequence: (node) => {
      checkSequence(node, ctx);
    },
    mix: (node) => {
      checkMix(node, ctx);
    },
    switchTag: (node) => {
      checkSwitch(node, ctx);
    },
  };
}

// -----------------------------------------------------------------------
// <sequence>
// -----------------------------------------------------------------------

/**
 * Validate the `name` (required, unique, non-builtin, non-`_`-prefixed) and
 * `parent` (declared earlier) attributes shared by `<sequence>` and `<mix>` —
 * both declare a named env-level value. Pushes diagnostics only; the caller
 * registers the name into `ctx.declaredSequences` afterwards.
 */
function checkDeclName(
  el: OpenCloseElementContext,
  ctx: Ctx,
  tag: 'sequence' | 'mix' | 'switch',
): void {
  const attrs = el.attr();
  const attrMap = extractAttrs(attrs);
  const name = attrMap['name'];
  const nameAttr = findAttr(attrs, 'name');

  if (!name) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(el),
      message: `<${tag}> is missing a required "name" attribute`,
      hint: `Every ${tag} needs a unique name for interpolation, e.g. <${tag} name="Gender">.`,
      code: 'TDC030',
    });
  } else if (nameAttr) {
    if (ctx.declaredSequences.includes(name)) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(nameAttr),
        message: `duplicate sequence name "${name}"`,
        hint: 'Each <sequence>/<mix> must declare a unique name; rename or remove the duplicate.',
        code: 'TDC032',
      });
    } else if (BUILTIN_SEQUENCES.includes(name)) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(nameAttr),
        message: `sequence name "${name}" collides with a builtin`,
        hint: `Builtins: ${formatCandidates(BUILTIN_SEQUENCES)}. Pick a different name.`,
        code: 'TDC033',
      });
    } else if (name.startsWith('_')) {
      // Only warn about reserved prefix when it isn't already a harder
      // error (collision / duplicate) — avoid double-reporting the same token.
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(nameAttr),
        message: `sequence name "${name}" starts with "_" — reserved for builtins`,
        hint: `Builtin names: ${formatCandidates(BUILTIN_SEQUENCES)}. User sequences should avoid the leading underscore.`,
        code: 'TDC031',
      });
    }
  }

  checkParentRef(el, {
    diagnostics: ctx.diagnostics,
    declared: ctx.declaredSequences,
    valueless: ctx.valuelessSequences,
    finiteValues: ctx.finiteValues,
  });
}

/**
 * The values a sequence will actually produce, when the config says so outright.
 *
 * Only a body that is one unnamed `<gen type="text" value="a,b,c">` qualifies —
 * a text generator's list is always literal, never a file or a pack, so what is
 * written is what comes out.
 *
 * Unless something rewrites it. `case="upper"` turns `Male` into `MALE` and
 * `mask="xxxx"` turns `Female` into `Fema`, so a comparison against the written
 * word would then be wrong in both directions — flagging a config that works and
 * accepting one that never matches. `repeat=` makes the value a list rather than
 * a word. Any of the three, and the values stop being knowable from here.
 */
function finiteTextValues(
  shape: SequenceShape,
  gens: readonly (OpenCloseElementContext | SelfClosingElementContext)[],
): readonly string[] | undefined {
  if (shape !== 'simple' || gens.length !== 1) return undefined;
  const only = gens[0];
  if (!only) return undefined;
  const attrs = extractAttrs(only.attr());
  if (attrs['type'] !== 'text') return undefined;
  if (attrs['case'] !== undefined || attrs['mask'] !== undefined) return undefined;
  if (attrs['repeat'] !== undefined) return undefined;
  const raw = attrs['value'];
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw.split(',').map((v) => v.trim());
}

function checkSequence(seqEl: OpenCloseElementContext, ctx: Ctx): void {
  checkDeclName(seqEl, ctx, 'sequence');
  const name = extractAttrs(seqEl.attr())['name'];

  // Size, not shape: what this column will COST. The shape checks below decide
  // whether uniq can be kept at all; this one asks what keeping it is worth in
  // memory, which only the run length can answer.
  if ((extractAttrs(seqEl.attr())['uniq'] ?? '').trim().toLowerCase() === 'true') {
    checkUniqMemory(seqEl, name ?? '?', ctx.count, ctx.diagnostics);
  }

  // Compute sequence: the producer is a `<compute>` tree. Validate the tree
  // statically (checkCompute) with the set of names it may reference — the
  // sequences declared before it, plus the built-ins — mirroring how parent
  // references must precede their use. Then register the name and stop; the
  // <gen>-oriented checks below do not apply.
  const computeEl = findChildElement(seqEl.content(), 'compute');
  if (computeEl && collectSequenceGens(seqEl).nodes.length > 0) {
    // One <sequence>, two producers. The engine cannot honour both, and the five
    // implementations did not even agree on which one to drop: the reference kept
    // the <gen> and threw the computation away, the four ports kept the <compute>
    // and threw the draw away. Same config, different data — refuse instead.
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(computeEl),
      message: `<compute> cannot sit beside a <gen> in <sequence name="${name ?? '?'}"> — one of the two would be dropped`,
      hint: 'A sequence either DERIVES its value with <compute> or DRAWS it with <gen>. Move the <compute> into its own <sequence> and read the drawn one from it with <field name="…"/>.',
      code: 'TDC219',
    });
  }
  if (computeEl && collectSequenceGens(seqEl).nodes.length === 0) {
    const knownFields = new Set<string>([...ctx.declaredSequences, ...BUILTIN_SEQUENCES]);
    checkCompute(computeEl, ctx.diagnostics, knownFields);
    checkUniqUnsupported(
      seqEl,
      name,
      '<compute> processes the values it reads rather than drawing any of its own, so it cannot promise uniqueness',
      ctx.diagnostics,
    );
    if (name) ctx.declaredSequences.push(name);
    return;
  }

  // Sequence body. Supported shapes today:
  //   - simple: exactly one unnamed <gen>
  //   - compound: two+ named <gen name="…">
  //   - conditional: <gen if="…"> branches (first truthy wins)
  // Distribution lives in a standalone env-level <mix>, not in a <sequence>.
  // `<gen>` children include those wrapped in `<distinct>` (collected by
  // the shared helper so extraction and validation agree on what counts).
  const gens: (OpenCloseElementContext | SelfClosingElementContext)[] = [
    ...collectSequenceGens(seqEl).nodes,
  ];

  // A <sequence> holds only <gen> (optionally wrapped in <distinct>). A <mix>,
  // <switch>, <case>, <map> here is a placement mistake — say so clearly rather
  // than letting it fall through to a confusing "no <gen>".
  let misplaced = 0;
  for (const el of contentElements(seqEl.content())) {
    const cn = childTagName(el);
    // A `<distinct>`/`<uniq>` wrapper is allowed here, but its own body was
    // never looked at — the gens inside were collected and everything else
    // dropped on the floor.
    if (cn === 'distinct' || cn === 'uniq') {
      checkGroupBody(openChild(el), cn, KNOWN_DISTINCT_CHILDREN, ctx);
      continue;
    }
    if (cn === null || KNOWN_SEQUENCE_CHILDREN.includes(cn)) continue;
    if (isKnownConstruct(cn) || cn === 'map') {
      // A construct that exists but lives elsewhere: say where.
      reportMisplaced(el, cn, 'sequence', ctx);
      misplaced += 1;
      continue;
    }
    // Anything else is invented or mistyped, and used to pass in SILENCE — the
    // config validated, exit 0, and the run went ahead as if the tag had done
    // something. The same mistake inside <env> has always been TDC010 with the
    // allowed names; a sequence answers the same way now.
    const node = childNode(el);
    if (!node) continue;
    reportUnknownChild(node, 'sequence', cn, 'TDC010', ctx);
    misplaced += 1;
  }

  if (gens.length === 0) {
    if (misplaced === 0) {
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(seqEl),
        message: `<sequence name="${name ?? '?'}"> has no <gen> child`,
        hint: 'A sequence needs at least one <gen type="…"/> describing how values are produced. For a percentage distribution use a standalone <mix name="…"> in <env>.',
        code: 'TDC036',
      });
    }
  } else if (gens.some((g) => genAttrIf(g) !== undefined)) {
    // Conditional sequence: `<gen if="…">` branches (+ an optional bare fallback
    // gen with no `if`). Each gen is just a generator — no `name` required — so
    // it must NOT be treated as a compound, which reads a name as a field.
    for (const g of gens) checkGen(g, ctx);
    checkUniqUnsupported(
      seqEl,
      name,
      'its value is picked per row from <gen if="…"> branches rather than drawn as one pool, so it cannot promise uniqueness',
      ctx.diagnostics,
    );
  } else {
    checkSequenceDataAttrs(seqEl, ctx.diagnostics);
    checkUniqOnComposed(seqEl, name, gens, ctx.diagnostics);
    checkUniqDropsAttrs(seqEl, name, gens, hasDataLiteral(seqEl), ctx.diagnostics);
    checkUniqWithDistinct(seqEl, name, collectSequenceGens(seqEl).distinctGroups, ctx.diagnostics);
    checkRowLinkOrder(gens, ctx.diagnostics);

    const shape = sequenceShape(
      gens.map((g) => genAttrName(g) !== undefined),
      hasDataLiteral(seqEl),
    );

    // One loop for both readings. They differ only in what an UNNAMED gen is —
    // a part of the value when the body composes, and impossible otherwise —
    // and a duplicate field name is the same mistake either way.
    const seenNames = new Set<string>();
    for (const g of gens) {
      const fieldName = genAttrName(g);
      if (fieldName === undefined) {
        if (shape !== 'compound') checkGen(g, ctx, false, shape !== 'simple');
        continue;
      }
      if (seenNames.has(fieldName)) {
        const nameAttrCtx = findAttr(g.attr(), 'name');
        ctx.diagnostics.push({
          severity: 'error',
          source: 'validator',
          ...(nameAttrCtx ? attrValueRange(nameAttrCtx) : nodeRange(g)),
          message: `duplicate field name "${fieldName}" inside compound <sequence name="${name ?? '?'}">`,
          hint: 'Each <gen name="…"> within a compound sequence must have a unique name.',
          code: 'TDC111',
        });
        continue;
      }
      seenNames.add(fieldName);
      // A named gen is a FIELD, so the sequence's own value is built from parts
      // whatever the rest of the body looks like.
      checkGen(g, ctx, false, true);
      // Register `Parent.Field` so a later reference to the field resolves.
      if (name) ctx.declaredSequences.push(`${name}.${fieldName}`);
    }

    // A named `<data>` is a field too — a constant one. It is not a `<gen>`, so
    // the loop above never sees it, and without this a reference to a constant
    // would read as a typo.
    if (name) {
      for (const fieldName of dataFieldNames(seqEl)) {
        ctx.declaredSequences.push(`${name}.${fieldName}`);
      }
      if (shape === 'compound') ctx.valuelessSequences.push(name);
      const values = finiteTextValues(shape, gens);
      if (values) ctx.finiteValues.set(name, values);
    }
  }

  if (name) {
    ctx.declaredSequences.push(name);
    registerPoolReference(name, collectSequenceGens(seqEl).nodes, ctx);
    // A pool reference hands the row a whole MEMBER from a table built before
    // the run. It draws no column of its own, so there is nothing to take
    // without replacement and nothing to rearrange — `uniq="true"` sat on it
    // doing nothing, and six rows over a four-member pool came out byte-identical
    // with and without it. `uniq` INSIDE the <pool> is the working spelling: it
    // makes the members themselves distinct.
    if (collectSequenceGens(seqEl).nodes.some((g) => extractAttrs(g.attr())['type'] === 'pool')) {
      checkUniqUnsupported(
        seqEl,
        name,
        'it draws a whole member from a <pool> rather than a column of its own, so there is ' +
          'nothing to draw without replacement — put uniq= on a <sequence> inside the <pool> ' +
          'to make the members distinct',
        ctx.diagnostics,
      );
    }
    // A column DERIVED from other columns — running, stat, formula, a date
    // offset. Same reason as the pool reference above: nothing is drawn, so
    // there is nothing to take without replacement. Measured, all three silently
    // ignoring `uniq="true"`: `running` over a column of zeros gave 0,0,0,0; a
    // `stat` gave one value on every row, which is what a statistic IS; a
    // formula over 1,1,2,2 gave 1,2,1,2.
    if (
      collectSequenceGens(seqEl).nodes.some((g) => {
        const a = extractAttrs(g.attr());
        const t = a['type'];
        return (
          t === 'running' ||
          t === 'stat' ||
          t === 'formula' ||
          (t === 'date' && (a['of'] ?? '').trim() !== '')
        );
      })
    ) {
      checkUniqUnsupported(
        seqEl,
        name,
        'it is computed from other columns rather than drawn, so there is nothing to draw ' +
          'without replacement — put uniq= on the columns it reads',
        ctx.diagnostics,
      );
    }
    // `<gen>` is usually self-closing, so collect it the way the rest of the
    // validator does rather than looking for a paired tag. A sequence whose gen
    // repeats is the only kind `each=` can walk.
    const repeats = collectSequenceGens(seqEl).nodes.some(
      (g) => (extractAttrs(g.attr())['repeat'] ?? '').trim() !== '',
    );
    if (repeats) ctx.repeatingSequences.push(name);
  }
}

/** Read the `name` attribute from a <gen>; undefined if absent. */
function genAttrName(gen: OpenCloseElementContext | SelfClosingElementContext): string | undefined {
  const attrs = extractAttrs(gen.attr());
  return attrs['name'];
}

function genAttrIf(gen: OpenCloseElementContext | SelfClosingElementContext): string | undefined {
  const attrs = extractAttrs(gen.attr());
  return attrs['if'];
}

// -----------------------------------------------------------------------
// <gen>  (used inside <sequence> and inside a <mix>'s <case>)
// -----------------------------------------------------------------------

function checkGen(
  gen: OpenCloseElementContext | SelfClosingElementContext,
  ctx: Ctx,
  inCase = false,
  inJoinedBody = false,
): void {
  checkGenBody(gen, ctx);
  const attrs = gen.attr();
  const attrMap = extractAttrs(attrs);
  const type = attrMap['type'] ?? '';
  const typeAttr = findAttr(attrs, 'type');

  // `repeat`/`separator` apply to every gen type, so they are checked up front.
  checkGenRepeat(gen, ctx.diagnostics);
  checkGenWeight(gen, ctx.diagnostics);
  checkGenMask(gen, ctx.diagnostics);
  checkGenImperfections(gen, ctx.diagnostics);
  checkPoolRefHasNoIf(gen, ctx.diagnostics);

  if (!type) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(gen),
      message: '<gen> is missing a required "type" attribute',
      hint: `Allowed types: ${formatCandidates(KNOWN_GEN_TYPES)}.`,
      code: 'TDC040',
    });
  } else if (!KNOWN_GEN_TYPES.includes(type) && typeAttr) {
    // Unknown or typo'd gen type.
    const suggestion = closestMatch(type, KNOWN_GEN_TYPES);
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(typeAttr),
      message: `unknown gen type "${type}"`,
      ...(suggestion ? { suggestion: `did you mean "${suggestion}"?` } : {}),
      hint: `Allowed types: ${formatCandidates(KNOWN_GEN_TYPES)}.`,
      code: 'TDC041',
    });
    return;
  }

  // Cross-cutting output modifiers (any gen type): validate case=/order= values.
  const caseAttr = findAttr(attrs, 'case');
  if (caseAttr && !isCaseTransform(attrMap['case'] ?? '')) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(caseAttr),
      message: `unknown case "${attrMap['case'] ?? ''}"`,
      hint: 'Supported: upper, lower, capitalize, title.',
      code: 'TDC190',
    });
  }
  const orderAttr = findAttr(attrs, 'order');
  const orderVal = attrMap['order'];
  if (orderAttr && orderVal !== 'random' && orderVal !== 'sequential') {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(orderAttr),
      message: `unknown order "${orderVal ?? ''}"`,
      hint: 'Supported: random (default), sequential.',
      code: 'TDC191',
    });
  }
  checkAnomalyFlag(gen, ctx.diagnostics, ctx.declaredSequences, inCase, inJoinedBody);
  checkGenIfInCase(gen, ctx.diagnostics, inCase);
  // Type-independent: text, file and date all take order="sequential".
  checkSequentialRepeat(gen, ctx.diagnostics);
  // Before the per-type checks, and INSTEAD of them when it fires: a value
  // holding ${{…}} is not the value its generator will try to parse, so letting
  // the generator also complain would put a wrong explanation beside the right
  // one. Five generators used to each blame what they happened to be parsing.
  if (checkAttrInterpolation(attrs, ctx.diagnostics)) return;

  checkGenByType(gen, type, ctx);

  // A conditional-sequence gen carries `if` as its branch condition; a
  // plain gen may also have one. Just validate the expression if present.
  const ifAttr = findAttr(attrs, 'if');
  if (ifAttr) {
    checkIfExpression(ifAttr, attrMap['if'] ?? '', ctx);
    ctx.rememberExpression(ifAttr, attrMap['if'] ?? '');
  }
}

// -----------------------------------------------------------------------
// <block> and descendants
// -----------------------------------------------------------------------

function checkBlock(blockEl: OpenCloseElementContext, ctx: Ctx): void {
  for (const el of contentElements(blockEl.content())) {
    const name = childTagName(el);
    if (name === null || name === 'data') continue; // whitespace / stray text ignored
    if (name === 'line') {
      const k = elementKind(el);
      if (k?.kind === 'open') {
        checkLineEach(
          k.node,
          { declared: ctx.declaredSequences, repeating: ctx.repeatingSequences },
          ctx.diagnostics,
        );
        checkLine(k.node, ctx);
      }
      continue;
    }
    // A <block> holds only <line>s — anything else (a loose <gen>, <case>,
    // <sequence>, <map>…) is misplaced.
    reportMisplaced(el, name, 'block', ctx);
  }
}

function checkLine(lineEl: OpenCloseElementContext, ctx: Ctx): void {
  const attrs = lineEl.attr();
  const attrMap = extractAttrs(attrs);
  const ifAttr = findAttr(attrs, 'if');
  if (ifAttr) {
    checkIfExpression(ifAttr, attrMap['if'] ?? '', ctx);
    ctx.rememberExpression(
      ifAttr,
      attrMap['if'] ?? '',
      attrMap['each'] === undefined ? [] : EACH_BUILTINS,
    );
  }

  if (ifAttr) checkLineConditionalColumns(lineEl, ifAttr, ctx.diagnostics);

  for (const el of contentElements(lineEl.content())) {
    const name = childTagName(el);
    if (name === null) continue;
    if (name === 'data') {
      const k = elementKind(el);
      if (k?.kind === 'data') {
        checkData(k.node, ctx, attrMap['each'] === undefined ? [] : EACH_BUILTINS);
        checkBlockDataRefs(
          extractDataText(k.node),
          k.node,
          ctx.inject,
          ctx.declaredSequences,
          ctx.diagnostics,
          attrMap['each'] === undefined ? [] : EACH_BUILTINS,
          ctx.poolReferences,
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

// -----------------------------------------------------------------------
// <mix>/<case>
// -----------------------------------------------------------------------

/** Validate a standalone env-level `<mix name="…">` distribution. */
function checkMix(mixEl: OpenCloseElementContext, ctx: Ctx): void {
  checkDeclName(mixEl, ctx, 'mix');
  checkMixBody(mixEl, ctx);
  // Register the mix's name so ${{Name}} and later parent="Name" resolve —
  // and its `flag="…"` companion, which is a sequence in its own right.
  const mixAttrs = extractAttrs(mixEl.attr());
  const name = mixAttrs['name'];
  if (name) ctx.declaredSequences.push(name);
  const flag = mixAttrs['flag'];
  if (flag) ctx.declaredSequences.push(flag);
}

/**
 * Validate the body of a `<mix>` — its `<case>` children and `percent` mask.
 * Shared by the env-level `checkMix` and by a nested (anonymous) `<mix>` inside
 * a `<case>`, which contributes a value fragment and has no name of its own.
 */
function checkMixBody(mixEl: OpenCloseElementContext, ctx: Ctx, named = true): void {
  const attrs = mixEl.attr();
  const attrMap = extractAttrs(attrs);
  const cases: OpenCloseElementContext[] = [];

  for (const el of contentElements(mixEl.content())) {
    if (el.mapElement()) {
      reportMisplaced(el, 'map', 'mix', ctx);
      continue;
    }
    const k = elementKind(el);
    if (!k) continue;
    const childName = k.kind === 'data' ? 'data' : elementName(k.node);
    if (k.kind === 'open' && childName === 'case') {
      cases.push(k.node);
      continue;
    }
    const suggestion = closestMatch(childName, KNOWN_MIX_CHILDREN);
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(k.node),
      message: `unknown child of <mix>: "<${childName}>"`,
      ...(suggestion ? { suggestion: `did you mean "<${suggestion}>"?` } : {}),
      hint: `Allowed inside <mix>: ${formatCandidates([...KNOWN_MIX_CHILDREN].sort())}.`,
      code: 'TDC124',
    });
  }

  if (cases.length === 0) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(mixEl),
      message: '<mix> has no <case> children',
      hint: 'Add at least one <case>...</case> inside <mix>.',
      code: 'TDC120',
    });
  }

  const percentAttr = findAttr(attrs, 'percent');
  if (percentAttr && cases.length > 0) {
    try {
      expandPercentMask(attrMap['percent'] ?? '', cases.length);
    } catch (err) {
      if (!(err instanceof PercentMaskError)) throw err;
      const code = err.kind === 'length' ? 'TDC121' : err.kind === 'number' ? 'TDC122' : 'TDC123';
      ctx.diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...attrValueRange(percentAttr),
        message: err.message,
        hint:
          err.kind === 'length'
            ? 'The mix percent mask must have no more entries than there are <case> children.'
            : 'Filled positions must be non-negative numbers. Empty positions split the remaining percent equally.',
        code,
      });
    }
  }

  checkMixFlag(mixEl, cases, ctx.diagnostics, named);
  checkMixRepeat(mixEl, ctx.diagnostics);

  for (const c of cases) checkCase(c, ctx);
}

function checkCase(caseEl: OpenCloseElementContext, ctx: Ctx): void {
  // <case> selection is purely percentage-based: <mix> distributes its cases
  // across the rows via the Hamilton method.
  // Conditional attributes like `if` or `default` are NOT honored — the
  // runtime never reads them. Writing `<case if="Age < 18">` would look like
  // if/elif/else but silently produces randomly-distributed cases — wrong data
  // that looks plausible. Flag these as errors so the trap surfaces instead of
  // corrupting output. (Condition-driven values live in a <sequence> with
  // <gen if="…"> branches.)
  const caseAttrList = caseEl.attr();
  for (const badName of ['if', 'default'] as const) {
    const bad = findAttr(caseAttrList, badName);
    if (!bad) continue;
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(bad),
      message: `"${badName}" on <case> is not supported — <mix> picks cases by percentage, not by condition`,
      hint:
        'Case selection is random (Hamilton distribution over `percent`), not conditional. ' +
        'For condition-driven values use a <sequence> with <gen if="…"> branches. ' +
        'See the <mix> page in the documentation.',
      code: 'TDC128',
    });
  }

  checkCaseContent(caseEl, ctx);
}

/** Validate the content of a `<case>` / `<default>`: data, gens, nested mixes. */
function checkCaseContent(caseEl: OpenCloseElementContext, ctx: Ctx): void {
  for (const el of contentElements(caseEl.content())) {
    if (el.mapElement()) {
      reportMisplaced(el, 'map', 'case', ctx);
      continue;
    }
    const k = elementKind(el);
    if (!k) continue;
    if (k.kind === 'data') {
      checkData(k.node, ctx);
      continue;
    }
    if (k.kind === 'self' && elementName(k.node) === 'gen') {
      checkGen(k.node, ctx, true);
      continue;
    }
    if (k.kind === 'open' && elementName(k.node) === 'gen') {
      checkGen(k.node, ctx, true);
      continue;
    }
    if (k.kind === 'open' && elementName(k.node) === 'mix') {
      checkMixBody(k.node, ctx, false);
      continue;
    }
    if (k.kind === 'open' && elementName(k.node) === 'switch') {
      // A `<switch>` inside a `<case>` looks its subject up over the rows of
      // that branch. It is held to every rule the env-level form is held to,
      // except that it has no name of its own to declare.
      checkSwitch(k.node, ctx, false);
      continue;
    }

    const name = elementName(k.node);
    const suggestion = closestMatch(name, KNOWN_CASE_CHILDREN);
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(k.node),
      message: `unknown child of <case>: "<${name}>"`,
      ...(suggestion ? { suggestion: `did you mean "<${suggestion}>"?` } : {}),
      hint: `Allowed inside <case>: ${formatCandidates([...KNOWN_CASE_CHILDREN].sort())}.`,
      code: 'TDC125',
    });
  }
}

// -----------------------------------------------------------------------
// <switch>  — deterministic lookup by subject value
// -----------------------------------------------------------------------

/**
 * Validate a `<switch on="…">` lookup.
 *
 * `named` is false for the form written inside a `<case>`: it contributes a
 * value to that branch rather than a column of its own, so it has no name to
 * declare and nothing can interpolate it. Everything else — the subject, the
 * entries, the fallback — is held to exactly the same rules, from this one
 * function, so the two spellings cannot drift apart.
 */
function checkSwitch(switchEl: OpenCloseElementContext, ctx: Ctx, named = true): void {
  if (named) checkDeclName(switchEl, ctx, 'switch');

  const attrs = switchEl.attr();
  const attrMap = extractAttrs(attrs);

  const nameAttr = findAttr(attrs, 'name');
  if (!named && nameAttr) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(nameAttr),
      message:
        '"name" on a nested <switch> is not supported — only an env-level <switch> becomes a column',
      hint: 'A nested <switch> contributes its value to the <case> around it. Nothing can interpolate it, so a name would name nothing. Move it to <env> if you want ${{Name}}.',
      code: 'TDC245',
    });
  }

  // `on` — the subject sequence, required and must be declared already.
  const onAttr = findAttr(attrs, 'on');
  const on = attrMap['on'];
  if (!on) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(switchEl),
      message: '<switch> is missing a required "on" attribute',
      hint: 'Name the subject sequence to look up, e.g. <switch name="Currency" on="Country">.',
      code: 'TDC133',
    });
  } else if (onAttr && !ctx.known(on)) {
    // A dot with a known root is a field mistake. Reporting it as an unknown
    // sequence sends the reader to check a name that is declared right above.
    const dot = on.indexOf('.');
    const root = dot < 0 ? on : on.slice(0, dot);
    const fieldMistake = dot >= 0 && ctx.known(root);
    const fields = ctx.declaredSequences
      .filter((n) => n.startsWith(`${root}.`))
      .map((n) => n.slice(root.length + 1));
    const suggestion = fieldMistake
      ? closestMatch(on.slice(dot + 1), fields)
      : closestMatch(on, [...ctx.declaredSequences, ...BUILTIN_SEQUENCES]);
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...attrValueRange(onAttr),
      message: fieldMistake
        ? `<switch on="${on}"> refers to "${on.slice(dot + 1)}", which is not a field of "${root}"`
        : `<switch on="${on}"> refers to an unknown sequence`,
      ...(suggestion
        ? { suggestion: `did you mean "${fieldMistake ? `${root}.${suggestion}` : suggestion}"?` }
        : {}),
      hint: fieldMistake
        ? fields.length === 0
          ? `"${root}" has no fields — switch on it directly, or on a sequence that has some.`
          : `Fields of "${root}": ${fields.join(', ')}.`
        : 'The `on` subject must be a sequence declared earlier in the same <env>.',
      code: 'TDC134',
    });
  }

  // Body: <map> rows + <case is="…"> entries + optional <default>.
  let entryCount = 0;
  for (const el of contentElements(switchEl.content())) {
    const mapEl = el.mapElement();
    if (mapEl) {
      entryCount += checkSwitchMap(
        mapEl,
        ctx,
        on === undefined ? undefined : ctx.finiteValues.get(on),
      );
      continue;
    }
    const k = elementKind(el);
    // `kind !== 'open'` used to skip the child entirely, so `<bogus/>` written
    // self-closing slipped through while `<bogus></bogus>` was caught — the same
    // invention accepted or refused depending on how it was punctuated.
    if (!k || k.kind === 'data') continue;
    const childName = elementName(k.node);
    if (childName === 'case' && k.kind === 'open') {
      checkSwitchEntry(k.node, ctx, on === undefined ? undefined : ctx.finiteValues.get(on));
      entryCount += 1;
    } else if (childName === 'default' && k.kind === 'open') {
      checkCaseContent(k.node, ctx);
    } else {
      reportUnknownChild(k.node, 'switch', childName, 'TDC124', ctx);
    }
  }

  if (entryCount === 0) {
    ctx.diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(switchEl),
      message: '<switch> has no entries',
      hint: 'Add a <map>KEY:VALUE, …</map> table and/or <case is="…">…</case> entries.',
      code: 'TDC135',
    });
  }

  // Register the switch's name so ${{Name}} resolves. A nested switch has none:
  // registering one would let a later reference resolve to a value no column
  // holds.
  const name = attrMap['name'];
  if (named && name) ctx.declaredSequences.push(name);
}

/** Validate one `<case is="…">` inside a `<switch>`; returns nothing. */
function checkSwitchEntry(
  caseEl: OpenCloseElementContext,
  ctx: Ctx,
  subjectValues?: readonly string[],
): void {
  checkSwitchCaseAttrs(caseEl, ctx, subjectValues);
  checkCaseContent(caseEl, ctx);
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function findTdc(doc: DocumentContext): OpenCloseElementContext | undefined {
  for (const el of doc.element()) {
    const k = elementKind(el);
    if (k?.kind === 'open' && elementName(k.node) === 'tdc') return k.node;
  }
  return undefined;
}
