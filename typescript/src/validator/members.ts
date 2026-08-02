/**
 * Walking a container of MEMBERS — a `<uniq>`/`<distinct>` group, or a `<pool>`.
 *
 * Both of them hold the same things `<env>` holds and want them checked the
 * same way, so neither can own the checks; but neither can import them either,
 * because `validate.ts` is where `checkSequence` and friends live and importing
 * back would be a cycle. The walk therefore lives here and the checks are
 * handed in. That keeps `validate.ts` under its line ceiling and, more usefully,
 * makes it impossible for a member inside a container to drift away from the
 * same member at the top level: there is one walk and it calls one set of
 * checks.
 */

import type { Diagnostic } from '../errors/index.js';
import type { OpenCloseElementContext, SelfClosingElementContext } from '../generated/TDCParser.js';
import {
  collectSequenceGens,
  contentElements,
  elementKind,
  elementName,
  extractAttrs,
} from '../processor/walk.js';

import { nodeRange } from '../errors/source-map.js';
import { checkGroupSize } from './group-size.js';
import { checkPool, checkPoolMemberRefs } from './pool.js';

/**
 * The top-level checks, passed in by the caller so this module never imports
 * them. Each one takes the node and reports into the caller's own context.
 */
export interface MemberCheckers {
  readonly sequence: (node: OpenCloseElementContext) => void;
  readonly mix: (node: OpenCloseElementContext) => void;
  readonly switchTag: (node: OpenCloseElementContext) => void;
}

/**
 * The body of a `<pool>`, checked exactly as the body of an `<env>` is.
 *
 * This function is short on purpose, and the shortness is the argument for the
 * whole construct: a pool holds the same members, means the same thing by them,
 * and therefore needs no checks of its own. Anything that would be an error one
 * level up is an error here, with the same code and the same wording — so an
 * author who has met the message before recognises it, and a port has nothing
 * extra to reimplement.
 */
/**
 * Everything a `<pool>` declaration is checked for, in one call.
 *
 * The env walk asks three separate questions of a pool — is its own shape sound,
 * may its members reach the pools they name, and does its body survive the
 * ordinary member checks — and they belong together: all three are "validate
 * this pool", and none of them means anything on its own. `above` grows as the
 * walk goes, which is what limits a member to the pools declared before it.
 */
export function checkPoolDeclaration(
  pool: OpenCloseElementContext,
  above: string[],
  diagnostics: Diagnostic[],
  checkers: MemberCheckers,
  declaredSequences: string[],
): void {
  checkPool(pool, diagnostics);
  checkPoolMemberRefs(pool, above, diagnostics);
  checkPoolMembers(pool, diagnostics, checkers, declaredSequences);
  const declared = extractAttrs(pool.attr())['name'];
  if (!declared) return;
  if (above.includes(declared)) {
    // Two pools under one name: the second quietly replaced the first, and the
    // only sign was a TDC193 in the block, pointing at a field that "does not
    // exist" — sending the reader to look in entirely the wrong place.
    // <sequence> has said this since TDC032; a pool is a declaration too.
    diagnostics.push({
      severity: 'error',
      source: 'validator',
      ...nodeRange(pool),
      message: `duplicate pool name "${declared}"`,
      hint: 'A pool is reached by name, so two of them cannot share one. Rename or remove the second.',
      code: 'TDC241',
    });
    return;
  }
  above.push(declared);
}

export function checkPoolMembers(
  pool: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  checkers: MemberCheckers,
  declaredSequences: string[],
): void {
  // A pool's members are ITS columns, not the run's. They have to see each
  // other while the pool is walked — `if="Gender.Male"` inside a pool reads
  // exactly as it does outside — and have to be gone afterwards, or a pool
  // holding an `id` would collide with the run's own `id` and be refused for a
  // clash that does not exist. Reading one from a row is what `${{Ref.field}}`
  // is for, and that name is registered by the reference instead.
  const outerNames = declaredSequences.length;
  for (const child of contentElements(pool.content())) {
    const k = elementKind(child);
    if (k?.kind === 'self') {
      checkSelfClosingSequence(k.node, diagnostics);
      continue;
    }
    if (k?.kind !== 'open') continue;
    const name = elementName(k.node);
    if (name === 'sequence') checkers.sequence(k.node);
    else if (name === 'mix') checkers.mix(k.node);
    else if (name === 'switch') checkers.switchTag(k.node);
    else if (name === 'distinct' || name === 'uniq') {
      checkGroupSize(k.node, diagnostics, name);
      checkEnvSequenceGroup(k.node, diagnostics, name, checkers);
    }
  }
  declaredSequences.length = outerNames;
}

/**
 * Config-level `<distinct>` / `<uniq>` (wrapping whole `<sequence>`s).
 * Validate each wrapped sequence in declaration order — and reject a compound
 * sequence, which has no single value to participate in the per-row (distinct)
 * or cross-row (uniq) comparison.
 */
export function checkEnvSequenceGroup(
  wrapperEl: OpenCloseElementContext,
  diagnostics: Diagnostic[],
  tag: string,
  checkers: MemberCheckers,
): void {
  for (const el of contentElements(wrapperEl.content())) {
    const k = elementKind(el);
    if (k?.kind === 'self') {
      checkSelfClosingSequence(k.node, diagnostics);
      continue;
    }
    if (k?.kind !== 'open') continue;
    // A <mix> inside the group is a member and a declaration: check it the way
    // it would be checked at the top level, or its name never exists and every
    // reference to it reads as undeclared.
    if (elementName(k.node) === 'mix') {
      checkers.mix(k.node);
      continue;
    }
    if (elementName(k.node) === 'switch') {
      checkers.switchTag(k.node);
      continue;
    }
    if (elementName(k.node) !== 'sequence') continue;
    const seq = k.node;
    const gens = collectSequenceGens(seq).nodes;
    const isCompound =
      gens.filter((g) => genAttrName(g) !== undefined).length > 0 || gens.length > 1;
    if (isCompound) {
      const nm = extractAttrs(seq.attr())['name'];
      diagnostics.push({
        severity: 'error',
        source: 'validator',
        ...nodeRange(seq),
        message: `<sequence name="${nm ?? '?'}"> inside a config-level <${tag}> must produce a single value`,
        hint: `A <${tag}> around sequences uses one value per sequence. Use a simple <gen> or a <switch> sequence, not a compound (multi-field) one.`,
        code: 'TDC129',
      });
    }
    checkers.sequence(seq);
  }
}

/**
 * A `<sequence name="X"/>` written with no body at all.
 *
 * It looks like it declares a column and it declares nothing: a self-closing
 * tag cannot hold the `<gen>` that says how values are produced. Until this
 * check existed the tag was skipped by every walker, so the config ran with the
 * column simply missing — and inside a `<uniq>` that meant the group silently
 * constrained nothing while the warning above it said the group "wraps no
 * sequences", which is true and reads as a lie.
 *
 * It is not made to mean "the sequence X declared elsewhere joins this group".
 * That would give one tag two jobs — declare here, refer there — which is the
 * defect this codebase keeps paying to remove. A group holds its members.
 */
export function checkSelfClosingSequence(
  node: SelfClosingElementContext,
  diagnostics: Diagnostic[],
): void {
  if (elementName(node) !== 'sequence') return;
  const name = extractAttrs(node.attr())['name'];
  diagnostics.push({
    severity: 'error',
    source: 'validator',
    ...nodeRange(node),
    message: `<sequence name="${name ?? '?'}"> has no <gen> child`,
    hint: 'A sequence needs at least one <gen type="…"/> describing how values are produced. For a percentage distribution use a standalone <mix name="…"> in <env>.',
    code: 'TDC036',
  });
}

/** Read the `name` attribute from a <gen>; undefined if absent. */
function genAttrName(gen: OpenCloseElementContext | SelfClosingElementContext): string | undefined {
  return extractAttrs(gen.attr())['name'];
}
