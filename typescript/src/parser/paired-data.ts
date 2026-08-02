import type { ParserDiagnostic } from './errors.js';

const DATA_CLOSE_SENTINEL = '\u0000/data\u0000';

interface PreprocessResult {
  readonly source: string;
  readonly diagnostics: readonly ParserDiagnostic[];
}

interface FoundClose {
  readonly start: number;
  readonly end: number;
  readonly pair: string | undefined;
}

interface Position {
  readonly line: number;
  readonly column: number;
}

export function preprocessPairedData(source: string): PreprocessResult {
  let out = '';
  let cursor = 0;
  const diagnostics: ParserDiagnostic[] = [];
  const seenPairs = new Map<string, Position>();

  while (cursor < source.length) {
    const openStart = source.indexOf('<data', cursor);
    if (openStart < 0) {
      out += source.slice(cursor);
      break;
    }
    if (!isDataOpenAt(source, openStart)) {
      out += source.slice(cursor, openStart + 5);
      cursor = openStart + 5;
      continue;
    }

    const openEnd = findTagEnd(source, openStart);
    if (openEnd < 0) {
      out += source.slice(cursor);
      break;
    }

    const openText = source.slice(openStart, openEnd + 1);
    const pair = extractPairValue(openText);
    if (pair === undefined || isSelfClosing(openText)) {
      out += source.slice(cursor, openEnd + 1);
      cursor = openEnd + 1;
      continue;
    }

    const pairPosition = indexToPosition(source, openStart + openText.indexOf(pair));
    const previous = seenPairs.get(pair);
    if (previous) {
      diagnostics.push({
        source: 'parser',
        line: pairPosition.line,
        column: pairPosition.column,
        message:
          `duplicate <data pair="${pair}"> value. ` +
          `First use was at line ${String(previous.line)}, column ${String(previous.column)}.`,
      });
    } else {
      seenPairs.set(pair, pairPosition);
    }

    const bodyStart = openEnd + 1;
    const close = findMatchingPairClose(source, bodyStart, pair);
    if (!close.match) {
      const pos = close.mismatch
        ? indexToPosition(source, close.mismatch.start)
        : indexToPosition(source, openStart);
      diagnostics.push({
        source: 'parser',
        line: pos.line,
        column: pos.column,
        message: close.mismatch
          ? `expected </data pair="${pair}">, got </data pair="${close.mismatch.pair ?? ''}">`
          : `unclosed <data pair="${pair}">`,
      });
      out += source.slice(cursor);
      break;
    }

    const body = source
      .slice(bodyStart, close.match.start)
      .replaceAll('</data>', DATA_CLOSE_SENTINEL);
    out += source.slice(cursor, bodyStart);
    out += body;
    out += '</data>';
    out += structuralWhitespace(
      source.slice(close.match.start + '</data>'.length, close.match.end + 1),
    );
    cursor = close.match.end + 1;
  }

  return { source: out, diagnostics };
}

export function restorePairedDataText(text: string): string {
  return text.replaceAll(DATA_CLOSE_SENTINEL, '</data>');
}

function isDataOpenAt(source: string, index: number): boolean {
  const next = source[index + '<data'.length];
  return next === undefined || next === '>' || next === '/' || /\s/.test(next);
}

function isSelfClosing(tagText: string): boolean {
  return /\/\s*>$/.test(tagText);
}

function findMatchingPairClose(
  source: string,
  start: number,
  expectedPair: string,
): { readonly match?: FoundClose; readonly mismatch?: FoundClose } {
  let searchAt = start;
  let firstMismatchedPair: FoundClose | undefined;

  while (searchAt < source.length) {
    const closeStart = source.indexOf('</data', searchAt);
    if (closeStart < 0) return firstMismatchedPair ? { mismatch: firstMismatchedPair } : {};
    const closeEnd = findTagEnd(source, closeStart);
    if (closeEnd < 0) return firstMismatchedPair ? { mismatch: firstMismatchedPair } : {};

    const closeText = source.slice(closeStart, closeEnd + 1);
    const closePair = extractPairValue(closeText);
    const found: FoundClose = { start: closeStart, end: closeEnd, pair: closePair };
    if (closePair === expectedPair) return { match: found };
    if (closePair !== undefined && !firstMismatchedPair) firstMismatchedPair = found;
    searchAt = closeStart + '</data'.length;
  }

  return firstMismatchedPair ? { mismatch: firstMismatchedPair } : {};
}

function findTagEnd(source: string, start: number): number {
  let quote: string | undefined;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '>') return i;
  }
  return -1;
}

function extractPairValue(tagText: string): string | undefined {
  return /\bpair\s*=\s*"([^"\r\n]*)"/.exec(tagText)?.[1];
}

function structuralWhitespace(text: string): string {
  let out = '';
  for (const ch of text) out += ch === '\n' || ch === '\r' ? ch : ' ';
  return out;
}

function indexToPosition(source: string, index: number): Position {
  let line = 1;
  let column = 0;
  for (let i = 0; i < index; i++) {
    if (source[i] === '\n') {
      line += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
