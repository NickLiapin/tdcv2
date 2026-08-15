export class PercentMaskError extends Error {
  public constructor(
    message: string,
    public readonly kind: 'length' | 'number' | 'sum',
  ) {
    super(message);
    this.name = 'PercentMaskError';
  }
}

export function expandPercentMask(mask: string, valueCount: number): number[] {
  if (valueCount <= 0) {
    throw new PercentMaskError('percent mask requires at least one value', 'length');
  }

  const parts = normalizeMaskParts(mask, valueCount);
  const fixed: number[] = [];
  const emptyIndexes: number[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part === '') {
      emptyIndexes.push(i);
      fixed[i] = 0;
      continue;
    }
    const n = Number(part);
    if (!Number.isFinite(n) || n < 0) {
      throw new PercentMaskError(`percent contains a non-numeric or negative value`, 'number');
    }
    fixed[i] = n;
  }

  const fixedSum = fixed.reduce((a, b) => a + b, 0);
  if (fixedSum > 100 + 0.0001) {
    throw new PercentMaskError(`percent values sum to ${String(fixedSum)}, expected <= 100`, 'sum');
  }

  if (emptyIndexes.length === 0) {
    if (Math.abs(fixedSum - 100) > 0.0001) {
      throw new PercentMaskError(`percent values sum to ${String(fixedSum)}, expected 100`, 'sum');
    }
    return fixed;
  }

  const remainder = (100 - fixedSum) / emptyIndexes.length;
  for (const idx of emptyIndexes) fixed[idx] = remainder;
  return fixed;
}

/**
 * The positions the mask left for the engine to fill that came out at ZERO —
 * values that are declared and can never be drawn.
 *
 * A mask shorter than the list is legal on purpose: what is left over goes to
 * the positions nobody wrote. `value="a,b,c" percent="30,40"` gives `c` the
 * remaining 30, which is the whole point. But when the written shares already
 * total 100 there is nothing left, and `c` silently stops existing —
 * `percent="50,50"` over 300 rows came out 150 `a`, 150 `b`, no `c`, and
 * `check` called the config valid.
 *
 * A zero the author WROTE is not reported: `percent="50,0,50"` says "never this
 * one" in as many words, and answering a clear statement with a warning is how
 * a gate teaches people to ignore it. Only an inferred zero is a surprise.
 *
 * Call it after `expandPercentMask` has succeeded — it assumes the parts parse.
 */
export function inferredZeros(mask: string, valueCount: number): number[] {
  const parts = normalizeMaskParts(mask, valueCount);
  const empty: number[] = [];
  let written = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? '';
    if (part === '') empty.push(i);
    else written += Number(part);
  }
  if (empty.length === 0) return [];
  return (100 - written) / empty.length > 0.0001 ? [] : empty;
}

function normalizeMaskParts(mask: string, valueCount: number): string[] {
  const parts = mask.split(',').map((s) => s.trim());
  if (parts.length > valueCount) {
    throw new PercentMaskError(
      `percent has ${String(parts.length)} entries but value has ${String(valueCount)}`,
      'length',
    );
  }

  const missing = valueCount - parts.length;
  if (missing === 0) return parts;

  const padding = new Array<string>(missing).fill('');
  return mask.trimStart().startsWith(',')
    ? [parts[0] ?? '', ...padding, ...parts.slice(1)]
    : [...parts, ...padding];
}
