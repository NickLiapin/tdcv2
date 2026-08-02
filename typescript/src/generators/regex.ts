/**
 * Finite regex generator.
 *
 * This is intentionally not a full JavaScript RegExp implementation.
 * It parses a deterministic, portable subset that is useful for data
 * construction and rejects patterns with unbounded output length.
 */

import { randomInt, randomPick } from '../prng/random.js';
import { resolveAlphabetChars } from '../unicode/alphabets.js';

import type { Generator } from './generator.js';

export const DEFAULT_REGEX_MAX_LENGTH = 32;

const DIGITS = charsBetween('0', '9');
const LOWER = charsBetween('a', 'z');
const UPPER = charsBetween('A', 'Z');
const WORD = [...UPPER, ...LOWER, ...DIGITS, '_'];
const SPACES = [' ', '\t'];
const PRINTABLE_ASCII = charsBetween(' ', '~');

export interface RegexGenAttrs {
  readonly pattern: string;
  readonly regexMaxLength?: number | string | undefined;
}

export interface RegexProgram {
  readonly maxLength: number;
  readonly captureCount: number;
}

type RegexNode =
  | EmptyNode
  | LiteralNode
  | CharSetNode
  | SequenceNode
  | AlternationNode
  | RepeatNode
  | CaptureNode
  | BackrefNode;

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
  readonly parts: readonly RegexNode[];
}

interface AlternationNode {
  readonly kind: 'alternation';
  readonly choices: readonly RegexNode[];
}

interface RepeatNode {
  readonly kind: 'repeat';
  readonly node: RegexNode;
  readonly min: number;
  readonly max: number;
}

interface CaptureNode {
  readonly kind: 'capture';
  readonly index: number;
  readonly node: RegexNode;
  readonly maxLength: number;
}

interface BackrefNode {
  readonly kind: 'backref';
  readonly index: number;
}

interface ParsedRegexProgram extends RegexProgram {
  readonly root: RegexNode;
  readonly captureMaxLengths: ReadonlyMap<number, number>;
}

interface ClassAtom {
  readonly chars: readonly string[];
  readonly single?: string | undefined;
}

interface GenerateContext {
  readonly captures: string[];
}

export class RegexGeneratorError extends Error {
  public override readonly name = 'RegexGeneratorError';
}

export function parseRegexMaxLength(
  raw: number | string | undefined,
  fallback = DEFAULT_REGEX_MAX_LENGTH,
): number {
  if (raw === undefined) return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RegexGeneratorError(
      `regex_max_length must be a positive integer, got "${String(raw)}"`,
    );
  }
  return value;
}

export function parseRegexProgram(
  pattern: string,
  attrs: Pick<RegexGenAttrs, 'regexMaxLength'> = {},
): RegexProgram {
  return parseRegex(pattern, parseRegexMaxLength(attrs.regexMaxLength));
}

export function regexGenerator(attrs: RegexGenAttrs): Generator {
  const program = parseRegex(attrs.pattern, parseRegexMaxLength(attrs.regexMaxLength));
  return (count, prng) => {
    const out: string[] = new Array<string>(count);
    for (let i = 0; i < count; i++) {
      out[i] = generateNode(program.root, { captures: [] }, prng);
    }
    return out;
  };
}

function parseRegex(pattern: string, regexMaxLength: number): ParsedRegexProgram {
  const parser = new RegexParser(pattern);
  const root = parser.parse();
  const maxLength = computeMaxLength(root, parser.captureMaxLengths);
  if (maxLength > regexMaxLength) {
    throw new RegexGeneratorError(
      `regex can produce ${String(maxLength)} characters, which exceeds regex_max_length=${String(
        regexMaxLength,
      )}`,
    );
  }
  return {
    root,
    maxLength,
    captureCount: parser.captureCount,
    captureMaxLengths: parser.captureMaxLengths,
  };
}

class RegexParser {
  private pos = 0;
  private closedCaptureCount = 0;
  private readonly mutableCaptureMaxLengths = new Map<number, number>();
  public captureCount = 0;

  public constructor(private readonly pattern: string) {}

  public get captureMaxLengths(): ReadonlyMap<number, number> {
    return this.mutableCaptureMaxLengths;
  }

  public parse(): RegexNode {
    const node = this.parseAlternation();
    if (!this.atEnd()) {
      throw this.error(`unexpected "${String(this.peek())}"`);
    }
    return node;
  }

  private parseAlternation(): RegexNode {
    const choices: RegexNode[] = [this.parseSequence()];
    while (this.peek() === '|') {
      this.pos += 1;
      choices.push(this.parseSequence());
    }
    return choices.length === 1 ? (choices[0] ?? emptyNode()) : { kind: 'alternation', choices };
  }

  private parseSequence(): RegexNode {
    const parts: RegexNode[] = [];
    while (!this.atEnd()) {
      const ch = this.peek();
      if (ch === ')' || ch === '|') break;
      parts.push(this.parseRepeatedAtom());
    }
    if (parts.length === 0) return emptyNode();
    return parts.length === 1 ? (parts[0] ?? emptyNode()) : { kind: 'sequence', parts };
  }

  private parseRepeatedAtom(): RegexNode {
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

  private finishRepeat(node: RegexNode, min: number, max: number): RegexNode {
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

  private parseBoundedRepeat(node: RegexNode): RegexNode {
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

  private parseAtom(): RegexNode {
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

  private parseGroup(): RegexNode {
    this.expect('(');
    let capturing = true;
    if (this.peek() === '?') {
      if (this.pattern.startsWith('?:', this.pos)) {
        this.pos += 2;
        capturing = false;
      } else {
        throw this.error('lookaround, named, and conditional groups are not supported');
      }
    }

    const index = capturing ? this.captureCount + 1 : undefined;
    if (index !== undefined) this.captureCount = index;

    const node = this.parseAlternation();
    this.expect(')');

    if (index === undefined) return node;

    this.closedCaptureCount = Math.max(this.closedCaptureCount, index);
    const groupMax = computeMaxLength(node, this.mutableCaptureMaxLengths);
    this.mutableCaptureMaxLengths.set(index, groupMax);
    return { kind: 'capture', index, node, maxLength: groupMax };
  }

  private parseCharClass(): RegexNode {
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
      ? PRINTABLE_ASCII.filter((ch) => !uniqueChars.includes(ch))
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

  private parseEscape(): RegexNode {
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

  private error(message: string): RegexGeneratorError {
    return new RegexGeneratorError(`regex: ${message} at offset ${String(this.pos)}`);
  }
}

function generateNode(node: RegexNode, ctx: GenerateContext, prng: () => number): string {
  switch (node.kind) {
    case 'empty':
      return '';
    case 'literal':
      return node.value;
    case 'charSet':
      return randomPick(prng, node.chars);
    case 'sequence':
      return node.parts.map((part) => generateNode(part, ctx, prng)).join('');
    case 'alternation':
      return generateNode(randomPick(prng, node.choices), ctx, prng);
    case 'repeat': {
      const times = randomInt(prng, node.min, node.max + 1);
      let out = '';
      for (let i = 0; i < times; i++) out += generateNode(node.node, ctx, prng);
      return out;
    }
    case 'capture': {
      const value = generateNode(node.node, ctx, prng);
      ctx.captures[node.index] = value;
      return value;
    }
    case 'backref':
      return ctx.captures[node.index] ?? '';
  }
}

function computeMaxLength(node: RegexNode, captureMaxLengths: ReadonlyMap<number, number>): number {
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
  for (const ch of chars) {
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

function inverse(chars: readonly string[]): string[] {
  const exclude = new Set(chars);
  return PRINTABLE_ASCII.filter((ch) => !exclude.has(ch));
}

function charsBetween(start: string, end: string): string[] {
  const a = start.codePointAt(0);
  const b = end.codePointAt(0);
  if (a === undefined || b === undefined || a > b) {
    throw new RegexGeneratorError(`regex: invalid character range "${start}-${end}"`);
  }
  const out: string[] = [];
  for (let code = a; code <= b; code++) out.push(String.fromCodePoint(code));
  return out;
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function parseSafeInteger(text: string, onError: () => RegexGeneratorError): number {
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value < 0) throw onError();
  return value;
}

function sumSafe(values: readonly number[]): number {
  let out = 0;
  for (const value of values) {
    out += value;
    if (!Number.isSafeInteger(out)) {
      throw new RegexGeneratorError('regex: maximum length is too large');
    }
  }
  return out;
}

function multiplySafe(a: number, b: number): number {
  const out = a * b;
  if (!Number.isSafeInteger(out)) {
    throw new RegexGeneratorError('regex: maximum length is too large');
  }
  return out;
}
