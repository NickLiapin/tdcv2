/**
 * `uniq="true"` over an `advanced_regex` pattern: a column dealt exactly as the generator deals it,
 * that can redraw any one row without moving a single exact share.
 *
 * Its own module because the generator beside it is already at the ceiling a file here is held to,
 * and because this is a different question from generating: not "what does the pattern make" but
 * "how much can it make, per share, and how is one row made again along the branches it was dealt".
 * It reads the generator's parse tree and walks it the way the generator does, so the two share
 * their node types and their column walk — exported there for this module and nothing else.
 */
import { randomInt, randomPick } from '../prng/random.js';

import {
  type AdvancedRegexGenAttrs,
  type AdvancedRegexNode,
  type Dealt,
  type GenerateRow,
  generateInto,
  parseAdvancedRegex,
  type WeightedChoiceNode,
} from './advanced-regex.js';
import { parseRegexMaxLength, REGEX_SPACE_CAP } from './regex.js';

/**
 * The most different strings a pattern can make — what a unique column checks its row count
 * against first. Counted as `regexSpaceSize` counts a plain pattern, with the two constructs that
 * are this generator's own: a weighted choice adds its branches, and a conditional adds its
 * branches plus the empty string a row that matches none of them contributes (unless a `*`
 * branch leaves no such row). An upper bound, exact for what identifiers are made of.
 */
export function advancedRegexSpaceSize(attrs: AdvancedRegexGenAttrs): number {
  const program = parseAdvancedRegex(attrs.pattern, parseRegexMaxLength(attrs.regexMaxLength));
  return spaceOf(program.root, undefined);
}

/**
 * A column dealt exactly as the plain generator deals it, and able to redraw any one row without
 * moving a single exact share.
 *
 * A weighted choice is a promise about the COLUMN — `(?%{70:RU;30:US})` puts RU on exactly seven
 * rows in ten — and uniqueness is a promise about every row. They meet here: each row remembers
 * the branches it was dealt, and a row whose value repeats is walked again ALONG THOSE BRANCHES,
 * drawing everything else afresh. The shares never move. What moves is the part of each value the
 * weighted choice did not decide.
 *
 * That makes the question "is there room?" a question per share, not per pattern. The pattern
 * above at 2 000 rows can make 2 000 strings, exactly as many as asked for — and the RU share alone
 * needs 1 400 of them from the 1 000 that start `RU-`. `pathSpace` answers per share when every
 * weighted choice stands where every row passes it (see `weightedOnSpine`), which is where
 * weighted choices are written in practice. Where one sits under a repeat, an alternation or a
 * conditional, a row's branches depend on its free draws too, the share cannot be counted on its
 * own, and the pattern's whole space stands in for it.
 */
export interface PlannedAdvancedColumn {
  /** The column as dealt, row by row — the same values the plain generator would deal. */
  readonly values: string[];
  /** `advancedRegexSpaceSize` of the pattern. */
  readonly totalSpace: number;
  /** One key per row; rows with the same key were dealt the same branches. */
  readonly pathKeys: readonly string[];
  /** The strings a path can make, or `undefined` when the pattern's shares cannot be counted apart. */
  pathSpace(key: string): number | undefined;
  /** The branches a path took, for a refusal: `70% (branch 1 of 2)`, joined by ` → `. */
  describePath(key: string): string;
  /**
   * One more value for `row` along the branches it was dealt, or `undefined` when a free draw led
   * the walk past a different weighted choice than the row met the first time — which can only
   * happen when a weighted choice sits under something that is itself drawn.
   */
  redraw(row: number, prng: () => number): string | undefined;
}

export function planAdvancedRegexColumn(
  attrs: AdvancedRegexGenAttrs,
  count: number,
  prng: () => number,
): PlannedAdvancedColumn {
  const program = parseAdvancedRegex(attrs.pattern, parseRegexMaxLength(attrs.regexMaxLength));
  const root = program.root;
  const rows: GenerateRow[] = Array.from({ length: count }, () => ({
    out: '',
    captures: [],
    dealt: [],
  }));
  generateInto(root, rows, prng);

  // Weighted choices numbered in the order they are written, so a path has a name that does not
  // depend on object identity.
  const ids = new Map<WeightedChoiceNode, number>();
  numberWeighted(root, ids);
  const spine = weightedOnSpine(root, false);

  const keyOf = (dealt: readonly Dealt[]): string =>
    spine ? dealt.map((d) => `${String(ids.get(d.node))}.${String(d.branch)}`).join('/') : '';
  const pathKeys = rows.map((row) => keyOf(row.dealt ?? []));
  const firstDealt = new Map<string, readonly Dealt[]>();
  rows.forEach((row, i) => {
    const key = pathKeys[i] ?? '';
    if (!firstDealt.has(key)) firstDealt.set(key, row.dealt ?? []);
  });
  const spaces = new Map<string, number>();

  return {
    values: rows.map((row) => row.out),
    totalSpace: spaceOf(root, undefined),
    pathKeys,
    pathSpace(key) {
      if (!spine) return undefined;
      const cached = spaces.get(key);
      if (cached !== undefined) return cached;
      const along = new Map<WeightedChoiceNode, number>();
      for (const d of firstDealt.get(key) ?? []) along.set(d.node, d.branch);
      const space = spaceOf(root, along);
      spaces.set(key, space);
      return space;
    },
    describePath(key) {
      // Where the shares are not counted apart every row is in one group, and naming the branches
      // its first row happened to take would describe a share nobody is being held to.
      if (!spine) return '';
      return (firstDealt.get(key) ?? [])
        .map((d) => {
          const branch = d.node.choices[d.branch];
          return `${String(branch?.percent ?? 0)}% (branch ${String(d.branch + 1)} of ${String(
            d.node.choices.length,
          )})`;
        })
        .join(' → ');
    },
    redraw(row, draw) {
      const dealt = rows[row]?.dealt ?? [];
      const fresh: GenerateRow = { out: '', captures: [] };
      const cursor = { at: 0 };
      if (!drawAlong(root, fresh, dealt, cursor, draw)) return undefined;
      return cursor.at === dealt.length ? fresh.out : undefined;
    },
  };
}

/**
 * One row, walked the way `generateInto` walks a bucket of one — the same draws in the same order
 * for everything that is drawn — except that a weighted choice takes the branch the row was dealt
 * instead of dealing again. Returns `false` the moment the walk reaches a weighted choice the row
 * did not meet at this point the first time: that candidate is off the row's branches, and is
 * thrown away like a repeat.
 */
function drawAlong(
  node: AdvancedRegexNode,
  row: GenerateRow,
  dealt: readonly Dealt[],
  cursor: { at: number },
  prng: () => number,
): boolean {
  switch (node.kind) {
    case 'empty':
      return true;
    case 'literal':
      row.out += node.value;
      return true;
    case 'charSet':
      row.out += randomPick(prng, node.chars);
      return true;
    case 'sequence':
      for (const part of node.parts) {
        if (!drawAlong(part, row, dealt, cursor, prng)) return false;
      }
      return true;
    case 'alternation': {
      const choice = node.choices[randomInt(prng, 0, node.choices.length)];
      return choice === undefined || drawAlong(choice, row, dealt, cursor, prng);
    }
    case 'repeat': {
      const times = randomInt(prng, node.min, node.max + 1);
      for (let step = 0; step < times; step++) {
        if (!drawAlong(node.node, row, dealt, cursor, prng)) return false;
      }
      return true;
    }
    case 'capture': {
      const start = row.out.length;
      if (!drawAlong(node.node, row, dealt, cursor, prng)) return false;
      row.captures[node.index] = row.out.slice(start);
      return true;
    }
    case 'backref':
      row.out += row.captures[node.index] ?? '';
      return true;
    case 'weightedChoice': {
      const decision = dealt[cursor.at];
      if (decision?.node !== node) return false;
      cursor.at += 1;
      const branch = node.choices[decision.branch];
      return branch === undefined || drawAlong(branch.node, row, dealt, cursor, prng);
    }
    case 'conditional': {
      for (const branch of node.branches) {
        const test = branch.test;
        if (test === undefined || (row.captures[test.capture] ?? '') === test.value) {
          return drawAlong(branch.node, row, dealt, cursor, prng);
        }
      }
      return true;
    }
  }
}

function numberWeighted(node: AdvancedRegexNode, ids: Map<WeightedChoiceNode, number>): void {
  switch (node.kind) {
    case 'sequence':
      for (const part of node.parts) numberWeighted(part, ids);
      return;
    case 'alternation':
      for (const choice of node.choices) numberWeighted(choice, ids);
      return;
    case 'repeat':
    case 'capture':
      numberWeighted(node.node, ids);
      return;
    case 'weightedChoice':
      ids.set(node, ids.size);
      for (const choice of node.choices) numberWeighted(choice.node, ids);
      return;
    case 'conditional':
      for (const branch of node.branches) numberWeighted(branch.node, ids);
      return;
    default:
      return;
  }
}

/**
 * True when every weighted choice stands where each row that reaches its parent passes it
 * exactly once — reached through sequences, groups and other weighted branches only. Then a row's
 * branches are decided by weighted choices alone, and the strings a share can make can be counted
 * on their own. Under a repeat, an alternation or a conditional, whether and how often a row
 * passes a weighted choice is itself drawn, so it cannot.
 */
function weightedOnSpine(node: AdvancedRegexNode, underDraw: boolean): boolean {
  switch (node.kind) {
    case 'weightedChoice':
      return !underDraw && node.choices.every((choice) => weightedOnSpine(choice.node, false));
    case 'sequence':
      return node.parts.every((part) => weightedOnSpine(part, underDraw));
    case 'capture':
      return weightedOnSpine(node.node, underDraw);
    case 'alternation':
      return node.choices.every((choice) => weightedOnSpine(choice, true));
    case 'repeat':
      return weightedOnSpine(node.node, true);
    case 'conditional':
      return node.branches.every((branch) => weightedOnSpine(branch.node, true));
    default:
      return true;
  }
}

const cap = (n: number): number => (n > REGEX_SPACE_CAP ? REGEX_SPACE_CAP : n);
const times = (a: number, b: number): number => cap(a * b);
const plus = (a: number, b: number): number => cap(a + b);

/**
 * The strings `node` can make — along the branches in `along` where it names a weighted choice,
 * across all of them where it does not. Saturates at `REGEX_SPACE_CAP` the way the plain count
 * does, and counts a class by its distinct characters for the same reason: five languages have
 * to arrive at one number.
 */
function spaceOf(
  node: AdvancedRegexNode,
  along: ReadonlyMap<WeightedChoiceNode, number> | undefined,
): number {
  switch (node.kind) {
    case 'empty':
    case 'literal':
    case 'backref':
      return 1;
    case 'charSet':
      return new Set(node.chars).size;
    case 'sequence':
      return node.parts.reduce((n, part) => times(n, spaceOf(part, along)), 1);
    case 'alternation':
      return node.choices.reduce((n, choice) => plus(n, spaceOf(choice, along)), 0);
    case 'capture':
      return spaceOf(node.node, along);
    case 'repeat': {
      const inner = spaceOf(node.node, along);
      let term = 1;
      for (let i = 0; i < node.min; i++) term = times(term, inner);
      let total = 0;
      for (let i = node.min; i <= node.max; i++) {
        total = plus(total, term);
        term = times(term, inner);
      }
      return total;
    }
    case 'weightedChoice': {
      const forced = along?.get(node);
      if (forced !== undefined) {
        const branch = node.choices[forced];
        return branch === undefined ? 1 : spaceOf(branch.node, along);
      }
      return node.choices.reduce((n, choice) => plus(n, spaceOf(choice.node, along)), 0);
    }
    case 'conditional': {
      const total = node.branches.reduce((n, branch) => plus(n, spaceOf(branch.node, along)), 0);
      // A row that matches no branch appends nothing: one more outcome, unless `*` catches it.
      return node.branches.some((branch) => branch.test === undefined) ? total : plus(total, 1);
    }
  }
}
