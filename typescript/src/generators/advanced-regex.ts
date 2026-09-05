/**
 * Advanced finite regex generator.
 *
 * This intentionally lives beside, not inside, the stable `regex`
 * generator. It starts from the same finite regex subset, then adds
 * TDC-only generation constructs. The first extension is exact
 * weighted choice for sequence materialization:
 *
 *   (?%{70:RU;20:US;10:DE})
 *
 * Branches are full advanced-regex patterns, so weighted choices can
 * be nested. Exact percentages only make semantic sense when the
 * caller materializes a known `count` in sequence context.
 */

import { distributeByPercent } from '../distribution/hamilton.js';
import { randomInt, randomPick } from '../prng/random.js';
import { resolveAlphabetChars } from '../unicode/alphabets.js';

import type { Generator } from './generator.js';
import { parseRegexMaxLength } from './regex.js';

const DIGITS = charsBetween('0', '9');
const LOWER = charsBetween('a', 'z');
const UPPER = charsBetween('A', 'Z');
const WORD = [...UPPER, ...LOWER, ...DIGITS, '_'];
const SPACES = [' ', '\t'];
const PRINTABLE_ASCII = charsBetween(' ', '~');
const WEIGHTED_BRANCH_STOP = new Set<string>([';', '}']);

export interface AdvancedRegexGenAttrs {
  readonly pattern: string;
  readonly regexMaxLength?: number | string | undefined;
}

export interface AdvancedRegexProgram {
  readonly maxLength: number;
  readonly captureCount: number;
  readonly weightedChoiceCount: number;
}

type AdvancedRegexNode =
  | EmptyNode
  | LiteralNode
  | CharSetNode
  | SequenceNode
  | AlternationNode
  | RepeatNode
  | CaptureNode
  | BackrefNode
  | WeightedChoiceNode
  | ConditionalNode;

interface EmptyNode {
  readonly kind: 'empty';
}

interface LiteralNode {
  readonly kind: 'literal';
  readonly value: string;
}

interface CharSetNode {
  readonly kind: 'charSet';
  readonly chars: readonly string[];
}

interface SequenceNode {
  readonly kind: 'sequence';
  readonly parts: readonly AdvancedRegexNode[];
}

interface AlternationNode {
  readonly kind: 'alternation';
  readonly choices: readonly AdvancedRegexNode[];
}

interface RepeatNode {
  readonly kind: 'repeat';
  readonly node: AdvancedRegexNode;
  readonly min: number;
  readonly max: number;
}

interface CaptureNode {
  readonly kind: 'capture';
  readonly index: number;
  readonly node: AdvancedRegexNode;
  readonly maxLength: number;
  /** The `(?<name>…)` spelling, kept only so an error can name the group back. */
  readonly name?: string | undefined;
}

interface BackrefNode {
  readonly kind: 'backref';
  readonly index: number;
}

interface WeightedChoiceNode {
  readonly kind: 'weightedChoice';
  readonly choices: readonly WeightedBranch[];
}

interface WeightedBranch {
  readonly percent: number;
  readonly node: AdvancedRegexNode;
}

/**
 * `(?if{sex=male:MR;sex=female:MS})` — pick a branch from what an EARLIER named
 * group produced on this row.
 *
 * The one construct in this generator that reads rather than draws. Everything
 * else here decides a row from randomness alone, which is why a pattern could
 * describe an address or an identifier but never a title that agrees with a sex
 * chosen two characters earlier — the classic reason to abandon `advanced_regex`
 * and rebuild the column as a `<switch>`.
 */
interface ConditionalNode {
  readonly kind: 'conditional';
  readonly branches: readonly ConditionalBranch[];
}

interface ConditionalBranch {
  /**
   * Which capture to read and what it must equal; `undefined` is the `*` branch,
   * which always matches.
   *
   * Branches are tried in the order written and the first match wins, so a `*`
   * is an "otherwise" wherever it stands — and a row matching NO branch produces
   * nothing at all, which is what `*` exists to prevent.
   */
  readonly test: { readonly capture: number; readonly value: string } | undefined;
  readonly node: AdvancedRegexNode;
}

interface ParsedAdvancedRegexProgram extends AdvancedRegexProgram {
  readonly root: AdvancedRegexNode;
  readonly captureMaxLengths: ReadonlyMap<number, number>;
}

interface ClassAtom {
  readonly chars: readonly string[];
  readonly single?: string | undefined;
}

interface GenerateRow {
  out: string;
  captures: string[];
}

export class AdvancedRegexGeneratorError extends Error {
  public override readonly name = 'AdvancedRegexGeneratorError';
}

export function parseAdvancedRegexProgram(
  pattern: string,
  attrs: Pick<AdvancedRegexGenAttrs, 'regexMaxLength'> = {},
): AdvancedRegexProgram {
  return parseAdvancedRegex(pattern, parseRegexMaxLength(attrs.regexMaxLength));
}

/**
 * Does this pattern contain a weighted choice `(?%{…})`? Used by the engine
 * router (`needsExactEngine`) and the streaming builder to decide routing: a
 * weighted choice hits its exact percentages only over the WHOLE column
 * (Hamilton over `count`), so it can't be produced lazily row-by-row and must
 * run on an exact engine. Parses only the tree — no `regex_max_length` gate —
 * and reports a malformed pattern as `false`, letting the real parse error
 * surface when the generator actually runs.
 */
export function advancedRegexHasWeightedChoice(pattern: string): boolean {
  try {
    const parser = new AdvancedRegexParser(pattern);
    parser.parse();
    return parser.weightedChoiceCount > 0;
  } catch {
    return false;
  }
}

export function advancedRegexGenerator(attrs: AdvancedRegexGenAttrs): Generator {
  const program = parseAdvancedRegex(attrs.pattern, parseRegexMaxLength(attrs.regexMaxLength));
  return (count, prng) => generateRows(program.root, count, prng);
}

function parseAdvancedRegex(pattern: string, regexMaxLength: number): ParsedAdvancedRegexProgram {
  const parser = new AdvancedRegexParser(pattern);
  const root = parser.parse();
  const maxLength = computeMaxLength(root, parser.captureMaxLengths);
  if (maxLength > regexMaxLength) {
    throw new AdvancedRegexGeneratorError(
      `advanced_regex can produce ${String(
        maxLength,
      )} characters, which exceeds regex_max_length=${String(regexMaxLength)}`,
    );
  }
  return {
    root,
    maxLength,
    captureCount: parser.captureCount,
    weightedChoiceCount: parser.weightedChoiceCount,
    captureMaxLengths: parser.captureMaxLengths,
  };
}

class AdvancedRegexParser {
  private pos = 0;
  private closedCaptureCount = 0;
  private readonly mutableCaptureMaxLengths = new Map<number, number>();
  /**
   * `(?<name>…)` → its capture index, filled as each named group CLOSES.
   *
   * Closing rather than opening, so `(?<a>(?if{a=x:y}))` cannot read the group it
   * is inside: at that point the group has produced nothing, and the condition
   * would compare against the empty string on every row.
   */
  private readonly groupNames = new Map<string, number>();
  public captureCount = 0;
  public weightedChoiceCount = 0;

  public constructor(private readonly pattern: string) {}

  public get captureMaxLengths(): ReadonlyMap<number, number> {
    return this.mutableCaptureMaxLengths;
  }

  public parse(): AdvancedRegexNode {
    const node = this.parseAlternation(new Set<string>());
    if (!this.atEnd()) {
      throw this.error(`unexpected "${String(this.peek())}"`);
    }
    return node;
  }

  private parseAlternation(stopChars: ReadonlySet<string>): AdvancedRegexNode {
    const choices: AdvancedRegexNode[] = [this.parseSequence(stopChars)];
    while (this.peek() === '|') {
      this.pos += 1;
      choices.push(this.parseSequence(stopChars));
    }
    return choices.length === 1 ? (choices[0] ?? emptyNode()) : { kind: 'alternation', choices };
  }

  private parseSequence(stopChars: ReadonlySet<string>): AdvancedRegexNode {
    const parts: AdvancedRegexNode[] = [];
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === undefined || ch === ')' || ch === '|' || stopChars.has(ch)) break;
      parts.push(this.parseRepeatedAtom());
    }
    if (parts.length === 0) return emptyNode();
    return parts.length === 1 ? (parts[0] ?? emptyNode()) : { kind: 'sequence', parts };
  }

  private parseRepeatedAtom(): AdvancedRegexNode {
    const atom = this.parseAtom();
    const ch = this.peek();
    if (ch === undefined) return atom;

    if (ch === '?') {
      this.pos += 1;
      return this.finishRepeat(atom, 0, 1);
    }
    if (ch === '*') {
      throw this.error('unbounded "*" quantifier is not allowed; use "{0,n}"');
    }
    if (ch === '+') {
      throw this.error('unbounded "+" quantifier is not allowed; use "{1,n}"');
    }
    if (ch === '{') {
      return this.parseBoundedRepeat(atom);
    }
    return atom;
  }

  private finishRepeat(node: AdvancedRegexNode, min: number, max: number): AdvancedRegexNode {
    if (max < min) {
      throw this.error(`invalid quantifier bounds {${String(min)},${String(max)}}`);
    }
    const next = this.peek();
    if (next === '?') {
      throw this.error('lazy quantifiers are not supported');
    }
    if (next === '*' || next === '+' || next === '{') {
      throw this.error('stacked quantifiers are not supported');
    }
    return { kind: 'repeat', node, min, max };
  }

  private parseBoundedRepeat(node: AdvancedRegexNode): AdvancedRegexNode {
    this.expect('{');
    const minText = this.readDigits();
    if (minText.length === 0) {
      throw this.error('quantifier must start with a number');
    }
    const min = parseSafeInteger(minText, () =>
      this.error(`invalid quantifier number "${minText}"`),
    );

    if (this.peek() === '}') {
      this.pos += 1;
      return this.finishRepeat(node, min, min);
    }

    this.expect(',');
    const maxText = this.readDigits();
    if (maxText.length === 0) {
      throw this.error('unbounded "{n,}" quantifier is not allowed; use "{n,m}"');
    }
    const max = parseSafeInteger(maxText, () =>
      this.error(`invalid quantifier number "${maxText}"`),
    );
    this.expect('}');
    return this.finishRepeat(node, min, max);
  }

  private parseAtom(): AdvancedRegexNode {
    const ch = this.peek();
    if (ch === undefined) return emptyNode();
    if (ch === '(') return this.parseGroup();
    if (ch === '[') return this.parseCharClass();
    if (ch === '\\') return this.parseEscape();
    if (ch === '.') {
      this.pos += 1;
      return charSet(PRINTABLE_ASCII);
    }
    if (ch === '^' || ch === '$') {
      this.pos += 1;
      return emptyNode();
    }
    if (ch === '*' || ch === '+' || ch === '?' || ch === '{') {
      throw this.error(`quantifier "${ch}" has no target`);
    }
    this.pos += 1;
    return { kind: 'literal', value: ch };
  }

  private parseGroup(): AdvancedRegexNode {
    this.expect('(');
    if (this.peek() === '?' && this.pattern.startsWith('?%{', this.pos)) {
      this.pos += 3;
      const node = this.parseWeightedChoice();
      this.expect(')');
      return node;
    }
    if (this.peek() === '?' && this.pattern.startsWith('?if{', this.pos)) {
      this.pos += 4;
      const node = this.parseConditional();
      this.expect(')');
      return node;
    }

    let capturing = true;
    let name: string | undefined;
    if (this.peek() === '?') {
      if (this.pattern.startsWith('?:', this.pos)) {
        this.pos += 2;
        capturing = false;
      } else if (
        this.pattern.startsWith('?<', this.pos) &&
        // `(?<=…)` and `(?<!…)` are LOOKBEHIND, not a group called "=" or "!".
        this.peekAt(2) !== '=' &&
        this.peekAt(2) !== '!'
      ) {
        this.pos += 2;
        name = this.parseGroupName();
      } else {
        throw this.error(
          'this group is not supported — advanced_regex has (?:…), (?<name>…), (?%{…}) ' +
            'and (?if{…}). Lookaround and numbered conditionals decide what a pattern ' +
            'MATCHES, and nothing here is matching anything',
        );
      }
    }

    const index = capturing ? this.captureCount + 1 : undefined;
    if (index !== undefined) this.captureCount = index;

    const node = this.parseAlternation(new Set<string>());
    this.expect(')');

    if (index === undefined) return node;

    this.closedCaptureCount = Math.max(this.closedCaptureCount, index);
    const groupMax = computeMaxLength(node, this.mutableCaptureMaxLengths);
    this.mutableCaptureMaxLengths.set(index, groupMax);
    if (name !== undefined) this.groupNames.set(name, index);
    return { kind: 'capture', index, node, maxLength: groupMax, name };
  }

  /** The `name` of `(?<name>…)`, up to the closing `>`. */
  private parseGroupName(): string {
    const start = this.pos;
    while (!this.atEnd() && this.peek() !== '>') this.pos += 1;
    const name = this.pattern.slice(start, this.pos);
    this.expect('>');
    if (name.length === 0) throw this.error('a named group needs a name: (?<sex>…)');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw this.error(
        `group name "${name}" must start with a letter or "_" and hold only letters, digits and "_"`,
      );
    }
    // Two groups under one name would make `(?if{name=…})` a coin toss between
    // them, decided by whichever the parser happened to record last.
    if (this.groupNames.has(name)) throw this.error(`group name "${name}" is already used`);
    return name;
  }

  /**
   * `?if{sex=male:MR;sex=female:MS}` — the `(?if{` is already consumed.
   *
   * Each branch is a full pattern, so weighted choices and further conditionals
   * nest inside them exactly as they do inside a weighted branch.
   */
  private parseConditional(): AdvancedRegexNode {
    const branches: ConditionalBranch[] = [];
    while (!this.atEnd()) {
      this.skipControlWhitespace();
      if (this.peek() === '}') throw this.error('conditional must contain at least one branch');
      const test = this.parseConditionalTest();
      const node = this.parseAlternation(WEIGHTED_BRANCH_STOP);
      branches.push({ test, node });

      const ch = this.peek();
      if (ch === ';') {
        this.pos += 1;
        continue;
      }
      if (ch === '}') {
        this.pos += 1;
        return { kind: 'conditional', branches };
      }
      throw this.error('expected ";" or "}" in conditional');
    }
    throw this.error('unterminated conditional');
  }

  /** `name=value` before a branch's `:`, or `*` for the branch that always matches. */
  private parseConditionalTest(): ConditionalBranch['test'] {
    const start = this.pos;
    while (!this.atEnd() && this.peek() !== ':' && this.peek() !== '}') this.pos += 1;
    const raw = this.pattern.slice(start, this.pos);
    this.expect(':');
    if (raw === '*') return undefined;

    const split = raw.indexOf('=');
    if (split < 0) {
      throw this.error(
        `conditional branch "${raw}" must read a group: name=value, or "*" for every other row`,
      );
    }
    const name = raw.slice(0, split).trim();
    const capture = this.groupNames.get(name);
    if (capture === undefined) {
      // Declared LATER is the same as not declared at all here: the pattern is
      // generated left to right, so a group further along has produced nothing
      // to compare against and the branch could never be taken.
      throw this.error(
        `conditional reads "${name}", which no (?<${name}>…) group before it declares`,
      );
    }
    return { capture, value: raw.slice(split + 1) };
  }

  private parseWeightedChoice(): AdvancedRegexNode {
    const choices: WeightedBranch[] = [];
    while (!this.atEnd()) {
      this.skipControlWhitespace();
      if (this.peek() === '}') {
        throw this.error('weighted choice must contain at least one branch');
      }
      const percent = this.parseWeight();
      this.skipControlWhitespace();
      this.expect(':');
      const node = this.parseAlternation(WEIGHTED_BRANCH_STOP);
      choices.push({ percent, node });

      const ch = this.peek();
      if (ch === ';') {
        this.pos += 1;
        continue;
      }
      if (ch === '}') {
        this.pos += 1;
        this.validateWeightedPercents(choices);
        this.weightedChoiceCount += 1;
        return { kind: 'weightedChoice', choices };
      }
      throw this.error('expected ";" or "}" in weighted choice');
    }
    throw this.error('unterminated weighted choice');
  }

  private parseWeight(): number {
    const start = this.pos;
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === undefined || (!isDigit(ch) && ch !== '.')) break;
      this.pos += 1;
    }
    const raw = this.pattern.slice(start, this.pos);
    const value = Number(raw);
    if (raw.length === 0 || !Number.isFinite(value) || value < 0) {
      throw this.error(`invalid weighted choice percent "${raw}"`);
    }
    return value;
  }

  private validateWeightedPercents(choices: readonly WeightedBranch[]): void {
    const sum = choices.reduce((acc, choice) => acc + choice.percent, 0);
    if (Math.abs(sum - 100) > 0.0001) {
      throw this.error(`weighted choice percentages sum to ${String(sum)}, expected 100`);
    }
  }

  private parseCharClass(): AdvancedRegexNode {
    this.expect('[');
    const negated = this.peek() === '^';
    if (negated) this.pos += 1;

    const chars: string[] = [];
    let sawAtom = false;
    while (!this.atEnd() && this.peek() !== ']') {
      sawAtom = true;
      const start = this.readClassAtom();
      if (this.peek() === '-' && this.peekNext() !== ']' && this.peekNext() !== undefined) {
        this.pos += 1;
        const end = this.readClassAtom();
        if (start.single === undefined || end.single === undefined) {
          throw this.error('character class ranges must use single-character endpoints');
        }
        chars.push(...charsBetween(start.single, end.single));
      } else {
        chars.push(...start.chars);
      }
    }

    this.expect(']');
    if (!sawAtom) {
      throw this.error('empty character classes are not supported');
    }

    const uniqueChars = unique(chars);
    const finalChars = negated
      ? PRINTABLE_ASCII.filter((char) => !uniqueChars.includes(char))
      : uniqueChars;
    if (finalChars.length === 0) {
      throw this.error('character class has no available characters');
    }
    return charSet(finalChars);
  }

  private readClassAtom(): ClassAtom {
    const ch = this.peek();
    if (ch === undefined) throw this.error('unterminated character class');
    if (ch === '\\') return this.readClassEscape();
    this.pos += 1;
    return { chars: [ch], single: ch };
  }

  private readClassEscape(): ClassAtom {
    this.expect('\\');
    const ch = this.consumeEscapedChar();
    switch (ch) {
      case 'd':
        return { chars: DIGITS };
      case 'D':
        return { chars: inverse(DIGITS) };
      case 'w':
        return { chars: WORD };
      case 'W':
        return { chars: inverse(WORD) };
      case 's':
        return { chars: SPACES };
      case 'S':
        return { chars: inverse(SPACES) };
      case 'a': {
        if (this.peek() !== '{') return { chars: [ch], single: ch };
        return { chars: this.readNamedAlphabet() };
      }
      case 'n':
      case 'r':
        throw this.error('multiline escapes are not supported');
      case 't':
        return { chars: ['\t'], single: '\t' };
      case 'p':
      case 'P':
        throw this.error('Unicode property classes are not supported');
      default:
        return { chars: [ch], single: ch };
    }
  }

  private parseEscape(): AdvancedRegexNode {
    this.expect('\\');
    const ch = this.consumeEscapedChar();
    if (isDigit(ch)) {
      const indexText = ch + this.readDigits();
      const index = parseSafeInteger(indexText, () =>
        this.error(`invalid backreference "\\${indexText}"`),
      );
      if (index <= 0 || index > this.closedCaptureCount) {
        throw this.error(
          `backreference "\\${indexText}" points to a group that is not generated yet`,
        );
      }
      return { kind: 'backref', index };
    }

    switch (ch) {
      case 'd':
        return charSet(DIGITS);
      case 'D':
        return charSet(inverse(DIGITS));
      case 'w':
        return charSet(WORD);
      case 'W':
        return charSet(inverse(WORD));
      case 's':
        return charSet(SPACES);
      case 'S':
        return charSet(inverse(SPACES));
      case 'a':
        if (this.peek() !== '{') return { kind: 'literal', value: ch };
        return charSet(this.readNamedAlphabet());
      case 'n':
      case 'r':
        throw this.error('multiline escapes are not supported');
      case 't':
        return { kind: 'literal', value: '\t' };
      case 'p':
      case 'P':
        throw this.error('Unicode property classes are not supported');
      default:
        return { kind: 'literal', value: ch };
    }
  }

  private readNamedAlphabet(): readonly string[] {
    this.expect('{');
    let name = '';
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === undefined || ch === '}') break;
      name += ch;
      this.pos += 1;
    }
    this.expect('}');
    if (name.length === 0) {
      throw this.error('alphabet escape "\\a{...}" requires a non-empty name');
    }
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw this.error(`invalid alphabet name "${name}"`);
    }
    const chars = resolveAlphabetChars(name);
    if (chars === undefined) {
      throw this.error(`unknown alphabet "${name}"`);
    }
    return chars;
  }

  private consumeEscapedChar(): string {
    const ch = this.peek();
    if (ch === undefined) throw this.error('dangling escape at end of pattern');
    this.pos += 1;
    return ch;
  }

  private readDigits(): string {
    let out = '';
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === undefined || !isDigit(ch)) break;
      out += ch;
      this.pos += 1;
    }
    return out;
  }

  private skipControlWhitespace(): void {
    while (this.peek() === ' ' || this.peek() === '\t') this.pos += 1;
  }

  private expect(expected: string): void {
    const actual = this.peek();
    if (actual !== expected) {
      throw this.error(`expected "${expected}" but found "${actual ?? 'end of pattern'}"`);
    }
    this.pos += 1;
  }

  private atEnd(): boolean {
    return this.pos >= this.pattern.length;
  }

  private peek(): string | undefined {
    return this.pattern[this.pos];
  }

  private peekNext(): string | undefined {
    return this.pattern[this.pos + 1];
  }

  private peekAt(offset: number): string | undefined {
    return this.pattern[this.pos + offset];
  }

  private error(message: string): AdvancedRegexGeneratorError {
    return new AdvancedRegexGeneratorError(
      `advanced_regex: ${message} at offset ${String(this.pos)}`,
    );
  }
}

function generateRows(root: AdvancedRegexNode, count: number, prng: () => number): string[] {
  const rows: GenerateRow[] = Array.from({ length: count }, () => ({ out: '', captures: [] }));
  generateInto(root, rows, prng);
  return rows.map((row) => row.out);
}

function generateInto(
  node: AdvancedRegexNode,
  rows: readonly GenerateRow[],
  prng: () => number,
): void {
  if (rows.length === 0) return;

  switch (node.kind) {
    case 'empty':
      return;
    case 'literal':
      for (const row of rows) row.out += node.value;
      return;
    case 'charSet':
      for (const row of rows) row.out += randomPick(prng, node.chars);
      return;
    case 'sequence':
      for (const part of node.parts) generateInto(part, rows, prng);
      return;
    case 'alternation':
      generateAlternation(node, rows, prng);
      return;
    case 'repeat':
      generateRepeat(node, rows, prng);
      return;
    case 'capture':
      generateCapture(node, rows, prng);
      return;
    case 'backref':
      for (const row of rows) row.out += row.captures[node.index] ?? '';
      return;
    case 'weightedChoice':
      generateWeightedChoice(node, rows, prng);
      return;
    case 'conditional':
      generateConditional(node, rows, prng);
  }
}

function generateAlternation(
  node: AlternationNode,
  rows: readonly GenerateRow[],
  prng: () => number,
): void {
  const buckets = node.choices.map((): GenerateRow[] => []);
  for (const row of rows) {
    const index = randomInt(prng, 0, node.choices.length);
    const bucket = buckets[index];
    if (bucket) bucket.push(row);
  }
  for (let i = 0; i < node.choices.length; i++) {
    const choice = node.choices[i];
    const bucket = buckets[i];
    if (choice && bucket && bucket.length > 0) generateInto(choice, bucket, prng);
  }
}

function generateRepeat(node: RepeatNode, rows: readonly GenerateRow[], prng: () => number): void {
  const counts = rows.map(() => randomInt(prng, node.min, node.max + 1));
  for (let step = 0; step < node.max; step++) {
    const active: GenerateRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const count = counts[i];
      if (row && count !== undefined && count > step) active.push(row);
    }
    generateInto(node.node, active, prng);
  }
}

function generateCapture(
  node: CaptureNode,
  rows: readonly GenerateRow[],
  prng: () => number,
): void {
  const starts = rows.map((row) => row.out.length);
  generateInto(node.node, rows, prng);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const start = starts[i];
    if (row !== undefined && start !== undefined) {
      row.captures[node.index] = row.out.slice(start);
    }
  }
}

function generateWeightedChoice(
  node: WeightedChoiceNode,
  rows: readonly GenerateRow[],
  prng: () => number,
): void {
  const branchIndexes = node.choices.map((_, index) => index);
  const percents = node.choices.map((choice) => choice.percent);
  const selected = distributeByPercent({
    count: rows.length,
    values: branchIndexes,
    percents,
    prng,
  });
  const buckets = node.choices.map((): GenerateRow[] => []);

  for (let i = 0; i < selected.length; i++) {
    const index = selected[i];
    const row = rows[i];
    if (index !== undefined && row !== undefined) buckets[index]?.push(row);
  }
  for (let i = 0; i < node.choices.length; i++) {
    const choice = node.choices[i];
    const bucket = buckets[i];
    if (choice && bucket && bucket.length > 0) generateInto(choice.node, bucket, prng);
  }
}

/**
 * Send each row to the FIRST branch whose test it passes, then build the branches
 * in the order they were written.
 *
 * Rows that pass no branch are left untouched — nothing is appended — which is
 * the only honest answer when the pattern says nothing about the value the row
 * actually holds. Writing a `*` branch is how a config says what to do instead.
 *
 * The order matters and is the alternation's: branch by branch, not row by row,
 * so the draws a branch makes depend on how many rows CHOSE it rather than on
 * where those rows sit in the column.
 */
function generateConditional(
  node: ConditionalNode,
  rows: readonly GenerateRow[],
  prng: () => number,
): void {
  const buckets = node.branches.map((): GenerateRow[] => []);
  for (const row of rows) {
    for (let i = 0; i < node.branches.length; i++) {
      const test = node.branches[i]?.test;
      if (test === undefined || (row.captures[test.capture] ?? '') === test.value) {
        buckets[i]?.push(row);
        break;
      }
    }
  }
  for (let i = 0; i < node.branches.length; i++) {
    const branch = node.branches[i];
    const bucket = buckets[i];
    if (branch && bucket && bucket.length > 0) generateInto(branch.node, bucket, prng);
  }
}

function computeMaxLength(
  node: AdvancedRegexNode,
  captureMaxLengths: ReadonlyMap<number, number>,
): number {
  switch (node.kind) {
    case 'empty':
      return 0;
    case 'literal':
    case 'charSet':
      return 1;
    case 'sequence':
      return sumSafe(node.parts.map((part) => computeMaxLength(part, captureMaxLengths)));
    case 'alternation':
      return Math.max(...node.choices.map((choice) => computeMaxLength(choice, captureMaxLengths)));
    case 'repeat':
      return multiplySafe(computeMaxLength(node.node, captureMaxLengths), node.max);
    case 'capture':
      return node.maxLength;
    case 'backref':
      return captureMaxLengths.get(node.index) ?? 0;
    case 'weightedChoice':
      return Math.max(
        ...node.choices.map((choice) => computeMaxLength(choice.node, captureMaxLengths)),
      );
    case 'conditional':
      // The longest branch: a row takes exactly one of them, so the widest the
      // conditional can be is the widest branch — never their sum.
      return Math.max(
        ...node.branches.map((branch) => computeMaxLength(branch.node, captureMaxLengths)),
      );
  }
}

function emptyNode(): EmptyNode {
  return { kind: 'empty' };
}

function charSet(chars: readonly string[]): CharSetNode {
  return { kind: 'charSet', chars: unique(chars) };
}

function unique(chars: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const char of chars) {
    if (seen.has(char)) continue;
    seen.add(char);
    out.push(char);
  }
  return out;
}

function inverse(chars: readonly string[]): string[] {
  const exclude = new Set(chars);
  return PRINTABLE_ASCII.filter((char) => !exclude.has(char));
}

function charsBetween(start: string, end: string): string[] {
  const a = start.codePointAt(0);
  const b = end.codePointAt(0);
  if (a === undefined || b === undefined || a > b) {
    throw new AdvancedRegexGeneratorError(
      `advanced_regex: invalid character range "${start}-${end}"`,
    );
  }
  const out: string[] = [];
  for (let code = a; code <= b; code++) out.push(String.fromCodePoint(code));
  return out;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function parseSafeInteger(text: string, onError: () => AdvancedRegexGeneratorError): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw onError();
  return value;
}

function sumSafe(values: readonly number[]): number {
  let out = 0;
  for (const value of values) {
    out += value;
    if (!Number.isSafeInteger(out)) {
      throw new AdvancedRegexGeneratorError('advanced_regex: maximum length is too large');
    }
  }
  return out;
}

function multiplySafe(a: number, b: number): number {
  const out = a * b;
  if (!Number.isSafeInteger(out)) {
    throw new AdvancedRegexGeneratorError('advanced_regex: maximum length is too large');
  }
  return out;
}
