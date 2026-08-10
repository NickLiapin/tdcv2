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

import { formatCandidates, type Diagnostic, nodeRange } from '../errors/index.js';
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
 * The two `<field>` names that arrive as NUMBERS rather than text.
 *
 * Everything else a `<field>` can name is a rendered value, which is text until
 * `<to_number>` says otherwise. These two are counts, so they go straight into
 * `<add>` or `<mod>` — and, for the same reason, they are not something
 * `<is_digit>` or `<encode>` can take. Their type is known before the run, which is
 * what makes a refusal a proof here and impossible for a `<field>` in general.
 */
const NUMERIC_BUILTIN_FIELDS = new Set(['_count', '_total']);

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
  'split',
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

/**
 * `<is_digit>` and `<encode>` both want ONE CHARACTER OF TEXT, and both were handed
 * a number without a word said.
 *
 * The two failures look nothing alike, which is why only one of them was ever
 * noticed. `<is_digit>` answered "no" on every row — including rows 1 to 9, where
 * the count plainly is a digit — and `check` called the config valid. `<encode>`
 * did stop the run, but with `<encode>: expected a single-character string` and no
 * file, no line and no code, on a config `check` had also called valid. Same cause,
 * so one refusal covers both.
 */
function checkNumericBuiltinArgument(
  children: readonly ElementContext[],
  tag: 'is_digit' | 'encode',
  diags: Diagnostic[],
): void {
  for (const child of children) {
    const c = cnode(child);
    const named = c?.name === 'field' ? (c.attrs['name'] ?? '') : '';
    if (!c || !NUMERIC_BUILTIN_FIELDS.has(named)) continue;
    report(
      diags,
      c.node,
      'TDC286',
      `<${tag}> asks about one character of text, and <field name="${named}"> is a number`,
      tag === 'is_digit'
        ? 'It would answer "no" on every row, including the rows where the count is a single ' +
            'digit. Compare the number itself with <equals> or <less_than>, or put the digit ' +
            'you mean into a <str>.'
        : 'The run would stop with "expected a single-character string", naming no file and no ' +
            'line. Wrap it in <concat> to turn the number into its digits — <encode> still needs ' +
            'exactly one of them — or put the character you mean into a <str>.',
    );
  }
}

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
 * A child in a SLOT position that names no slot this tag has.
 *
 * `<choose>`, `<when>`, `<each>`, `<reduce>` and `<at>` do not evaluate their
 * children in order — each looks up the slots it knows by name and ignores
 * everything else. So the walk below descended only into those slots, and a
 * misspelled slot name was never walked, never validated, and never run:
 *
 *     <choose>
 *       <wen> … </wen>          <- one dropped letter
 *       <otherwise><current/></otherwise>
 *     </choose>
 *
 * `check` called that valid. Measured on the compute overview's own Luhn
 * example, whose whole point is a correct check digit:
 *
 *     <when>   5651468319671434  4592454318080046  6795599553235471   all VALID
 *     <wen>    5651468319671431  4592454318080043  6795599553235476   all INVALID
 *
 * The `<otherwise>` won every row, so every card number was wrong — and nothing
 * anywhere said so. Worse, the dead subtree escaped every other check too: an
 * unknown tag or an unbound `<var>` inside it went unreported, because no walk
 * ever reached it.
 *
 * The refusal is a proof rather than a guess: the evaluator looks these slots up
 * by name, so an element that matches none of them is unreachable by
 * construction — it cannot be doing anything, whatever the author meant.
 */
function checkSlotNames(n: CN, slots: readonly string[], diags: Diagnostic[]): void {
  const known = new Set(slots);
  for (const child of n.children) {
    const cn = cnode(child);
    if (!cn || known.has(cn.name)) continue;
    report(
      diags,
      cn.node,
      'TDC180',
      `<${n.name}> has no <${cn.name}> part`,
      `Inside <${n.name}> only ${slots.map((s) => `<${s}>`).join(' and ')} ` +
        'are read; anything else is silently ignored, so a misspelling here changes ' +
        'the result without any other sign.',
    );
    // Deliberately NOT walked. What the author meant is unknown, so every rule
    // that could be applied inside is a guess about the intended shape — and the
    // guess is wrong in the ordinary case. Walking the misspelled `<wen>` above
    // as a value slot reported its perfectly correct `<test><equals>` as a
    // predicate in a value position: a second error, on markup that needs no
    // change, which disappears once the FIRST one is fixed. One true error beats
    // a true one plus a false one.
  }
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

/**
 * The four tags that answer TRUE or FALSE rather than producing a value.
 *
 * They are compute tags, so the unknown-tag check waves them through wherever
 * they appear — and a `<result><greater_than>…</greater_than></result>` then
 * passed `check` and died mid-run with `unknown compute tag <greater_than>`:
 * no code, no line, no file. The evaluator's own message names the rule
 * ("valid only inside <test>"); it just arrived too late to be useful, and the
 * errors reference had been claiming TDC180 caught this all along.
 */
const PREDICATE_TAGS: ReadonlySet<string> = new Set([
  'equals',
  'greater_than',
  'less_than',
  'is_digit',
]);

function walkExpr(el: ElementContext, scope: VScope, diags: Diagnostic[]): void {
  const n = cnode(el);
  if (!n) return;
  if (PREDICATE_TAGS.has(n.name)) {
    report(
      diags,
      n.node,
      'TDC180',
      `<${n.name}> is a predicate, not a value — it is valid only inside <test>`,
      'A predicate answers true or false, and this position wants something to print. ' +
        'Wrap it: <choose><when><test><' +
        n.name +
        '>…</' +
        n.name +
        '></test></when><then>…</then></choose>.',
    );
    return;
  }
  if (!COMPUTE_TAGS.has(n.name)) {
    // A tag with a note of its own keeps it — those explain a real confusion.
    // Everything else gets the same "Allowed inside <X>" list every container
    // prints, truncated the way the long <env> list already is.
    report(
      diags,
      n.node,
      'TDC180',
      `unknown compute tag <${n.name}>`,
      HINTS_BY_TAG[n.name] ??
        `Allowed inside <compute>: ${formatCandidates([...COMPUTE_TAGS].sort())}.`,
    );
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
      // `<list>` has two spellings and reads only the first: with `v=` set, the
      // children are never evaluated. Writing both is not a choice anyone makes
      // on purpose — it means one was meant to replace the other, and the engine
      // kept whichever the author was not looking at.
      if (n.attrs['v'] !== undefined && n.children.some((c) => cnode(c))) {
        report(
          diags,
          n.node,
          'TDC189',
          '<list> has both v= and children',
          'Only v= is read; the children are silently dropped. Keep one spelling: ' +
            'v="1,2,3" for a literal list, or child elements for a computed one.',
        );
      }
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
      checkSlotNames(n, ['over', 'do'], diags);
      walkWrapper(n, 'over', scope, diags);
      walkWrapper(n, 'do', { ...scope, inIteration: true }, diags);
      return;
    case 'reduce':
      checkSlotNames(n, ['over', 'init', 'do'], diags);
      walkWrapper(n, 'over', scope, diags);
      walkWrapper(n, 'init', scope, diags);
      walkWrapper(n, 'do', { ...scope, inIteration: true, inReduce: true }, diags);
      return;
    case 'at':
      checkSlotNames(n, ['in', 'index'], diags);
      walkWrapper(n, 'in', scope, diags);
      walkWrapper(n, 'index', scope, diags);
      return;
    case 'encode': {
      const as = n.attrs['as'] ?? '';
      if (!ENCODINGS.has(as)) {
        report(diags, n.node, 'TDC186', `<encode>: unknown encoding "${as}"`);
      }
      checkNumericBuiltinArgument(n.children, 'encode', diags);
      walkSlot(n.children, scope, diags);
      return;
    }
    case 'group': {
      // A size the engine cannot use disables grouping entirely and says nothing,
      // so the column comes out ungrouped and looks like the tag was never
      // written. `size="2.5"` is worse: it groups by neither 2 nor 3.
      const size = n.attrs['size'];
      if (size !== undefined && !/^[1-9][0-9]*$/.test(size.trim())) {
        report(
          diags,
          n.node,
          'TDC188',
          `<group size="${size}"> is not a whole number of characters`,
          'Write a positive whole number. A size the engine cannot use would turn ' +
            'grouping off and leave the value unchanged, with nothing to show why.',
        );
      }
      walkSlot(n.children, scope, diags);
      return;
    }
    case 'choose':
      walkChoose(n, scope, diags);
      return;
    case 'mask': {
      // The filter form of the same fault is TDC256 in data-refs.ts. A mask with
      // no pattern has nothing to keep, and the engine answered that literally:
      // it returned the empty string, so the column came out blank.
      const pattern = (n.attrs['pattern'] ?? '').trim();
      if (pattern === '') {
        report(
          diags,
          n.node,
          'TDC256',
          '<mask> needs a pattern= — without one it returns the empty string',
        );
      }
      walkSlot(n.children, scope, diags);
      return;
    }
    case 'join':
    case 'split':
    case 'length':
    case 'to_number':
    case 'pad':
    case 'upper':
    case 'lower':
    case 'capitalize':
    case 'title':
    case 'slice':
    case 'replace':
    case 'trim':
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
  checkSlotNames(n, ['when', 'otherwise'], diags);
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
  checkSlotNames(n, ['test', 'then'], diags);
  const test = n.children.map(cnode).find((c) => c?.name === 'test');
  if (!test) {
    report(diags, n.node, 'TDC187', '<when> requires a <test> child');
  } else {
    const pred = test.children.map(cnode).find(Boolean);
    if (pred) walkPredicate(pred, scope, diags);
  }
  walkWrapper(n, 'then', scope, diags);
}

/**
 * A `<str>` literal under a comparison, holding something that is not a number.
 *
 * The three comparisons work on NUMBERS. A string of digits is accepted and read as
 * one — `<equals><str v="7"/><int v="7"/></equals>` is true — so the tag is not
 * "integers only", and refusing every `<str>` would break a config that works. What
 * cannot work is a `<str>` whose text is not a number: measured, the run stopped with
 * `expected an integer in <equals>, got the string "ab"`, naming no file, no line and
 * no code, on a config `check` had called valid.
 *
 * Only a LITERAL is checked. What a `<field>` or a `<var>` will hold is not known
 * before the run, and a refusal here has to be a proof.
 */
function checkComparisonLiterals(n: CN, diags: Diagnostic[]): void {
  for (const child of n.children) {
    const c = cnode(child);
    if (c?.name !== 'str') continue;
    const raw = (c.attrs['v'] ?? '').trim();
    if (/^-?\d+$/.test(raw)) continue;
    report(
      diags,
      c.node,
      'TDC287',
      `<${n.name}> compares numbers, and <str v="${c.attrs['v'] ?? ''}"> is not one`,
      'A <str> holding digits is read as the number it spells, so <str v="7"/> is fine. ' +
        'This one is not a number, so the run would stop on the first row. Use <int>, or ' +
        '<to_number> around the value you meant to compare.',
    );
  }
}

function walkPredicate(n: CN, scope: VScope, diags: Diagnostic[]): void {
  switch (n.name) {
    case 'equals':
    case 'greater_than':
    case 'less_than':
      if (n.children.length !== 2) {
        report(diags, n.node, 'TDC183', `<${n.name}> requires exactly 2 children`);
      }
      checkComparisonLiterals(n, diags);
      for (const c of n.children) walkExpr(c, scope, diags);
      return;
    case 'is_digit':
      checkNumericBuiltinArgument(n.children, 'is_digit', diags);
      for (const child of n.children) walkExpr(child, scope, diags);
      return;
    default:
      report(diags, n.node, 'TDC180', `unknown predicate <${n.name}> (valid only inside <test>)`);
  }
}
