/**
 * Work out a column's type from the GENERATOR that feeds it, when `type=` was
 * not declared.
 *
 * This is the reliable middle step of the resolution order: we know a column
 * came from `type="number"` without decimals, so it is an int64 — far safer
 * than guessing from the rendered text, which is how `007` silently becomes 7.
 * When we cannot tell, we return undefined and the caller falls back to string,
 * which never corrupts data.
 * Spec: docs/specs/2026-07-19-typed-output-and-parquet-writer.md §4.
 */

import type { SequenceSpec } from '../sequence/types.js';

import { parseColumnType, type ColumnType, type OutputColumnType } from './column-type.js';

/**
 * The single sequence a template refers to, if it is exactly one substitution
 * and nothing else (`${{Id}}`). Composite text has no single source type.
 */
export function soleReference(template: string, inject: string): string | undefined {
  const marker = inject.indexOf('%');
  if (marker < 0) return undefined;
  const prefix = inject.slice(0, marker);
  const suffix = inject.slice(marker + 1);
  const text = template.trim();
  if (!text.startsWith(prefix) || !text.endsWith(suffix)) return undefined;
  const inner = text.slice(prefix.length, text.length - suffix.length);
  // A second marker means more than one substitution (or literal text between).
  if (inner.length === 0 || inner.includes(prefix) || inner.includes('|')) return undefined;
  return inner.trim();
}

function withNullable(type: string, nullable: boolean): ColumnType {
  return parseColumnType(nullable ? `${type}|null` : type);
}

/**
 * A `<mix>` column's type, when every branch agrees on one.
 *
 * Deliberately strict: each `<case>` must be exactly one `<gen>` (no literal
 * text, no nested mix) and all of them must derive to the same type. A mix of
 * a number and a word is text, and any doubt falls back to string — the rule
 * that keeps `007` from becoming 7.
 */
function deriveMixType(
  mixSpec: NonNullable<SequenceSpec['mixSpec']>,
  specs: readonly SequenceSpec[],
): ColumnType | undefined {
  if (mixSpec.cases.length === 0) return undefined;
  let agreed: ColumnType | undefined;
  for (const caseSpec of mixSpec.cases) {
    const only = caseSpec.parts.length === 1 ? caseSpec.parts[0] : undefined;
    if (only?.kind !== 'gen') return undefined;
    // Reuse the single-gen rules by asking about a throwaway spec of that gen.
    const type = deriveColumnType('\u0000mix', [{ name: '\u0000mix', gen: only.gen }, ...specs]);
    if (!type) return undefined;
    if (!agreed) {
      agreed = type;
      continue;
    }
    if (agreed.kind !== type.kind || agreed.nullable !== type.nullable) return undefined;
  }
  return agreed;
}

/**
 * Derive a column type for `name` from the sequence specs, or undefined when it
 * cannot be told confidently.
 */
export function deriveColumnType(
  name: string,
  specs: readonly SequenceSpec[],
): ColumnType | undefined {
  // A ground-truth flag column is minted by a gen's `anomaly_flag` or a
  // `<mix flag="…">`, not declared as its own <sequence> — find it by scanning.
  for (const spec of specs) {
    if (spec.mixSpec?.attrs['flag']?.trim() === name) return parseColumnType('bool');
    const gens = [spec.gen, ...(spec.gens ?? []).map((g) => g.gen)];
    for (const gen of gens) {
      if (gen?.attrs['anomaly_flag']?.trim() === name) return parseColumnType('bool');
    }
  }

  const spec = specs.find((s) => s.name === name);
  if (spec?.mixSpec) return deriveMixType(spec.mixSpec, specs);
  const gen = spec?.gen;
  if (!gen) return undefined;

  // Output formatting rewrites the text, so the value is no longer its raw type.
  if (gen.attrs['mask'] !== undefined || gen.attrs['case'] !== undefined) return undefined;

  const missing = gen.attrs['missing'];
  const nullable = missing !== undefined && missing.trim() !== '' && Number(missing) > 0;

  switch (gen.type) {
    case 'number': {
      const decimals = Number(gen.attrs['decimals'] ?? '0');
      return withNullable(Number.isFinite(decimals) && decimals > 0 ? 'double' : 'int64', nullable);
    }
    case 'increment':
    case 'decrement':
      return withNullable('int64', nullable);
    case 'timeseries':
      return withNullable(Number(gen.attrs['decimals'] ?? '0') > 0 ? 'double' : 'int64', nullable);
    case 'date':
      // The default rendering is locale-shaped (e.g. 05/25/1996), NOT ISO, so a
      // date column is only safe to infer when the config asked for ISO output.
      // Otherwise fall through to text; the user can still declare type="date".
      return gen.attrs['format'] === 'YYYY-MM-DD' ? withNullable('date', nullable) : undefined;
    case 'template':
      return gen.attrs['value']?.endsWith('.uuid') === true
        ? withNullable('uuid', nullable)
        : undefined;
    default:
      return undefined;
  }
}

/**
 * The type of a column fed by `name`, as a LIST when the generator repeats.
 *
 * A repeating gen puts several values in one cell, so the column is a list of
 * whatever a single value would have been. If the element type cannot be told
 * confidently the whole thing stays text — same safety rule as everywhere else.
 */
export function deriveOutputColumnType(
  name: string,
  specs: readonly SequenceSpec[],
): OutputColumnType | undefined {
  const element = deriveColumnType(name, specs);
  if (repeatSeparatorOf(name, specs) === undefined) return element;
  // `repeat` says this IS a list, whatever the elements turn out to be. Falling
  // back to a comma-joined string here would throw away structure we know for
  // certain — so an untellable element becomes []string, not a flat string.
  return { kind: 'list', element: element ?? parseColumnType(elementFallback(name, specs)) };
}

/**
 * The element type for a repeating gen whose values we cannot type. Text stays
 * text; `missing=` still makes the ELEMENT nullable, because that is what
 * blanks individual elements.
 */
function elementFallback(name: string, specs: readonly SequenceSpec[]): string {
  const missing = specs.find((s) => s.name === name)?.gen?.attrs['missing'];
  const nullable = missing !== undefined && missing.trim() !== '' && Number(missing) > 0;
  return nullable ? 'string|null' : 'string';
}

/**
 * The `separator` of the generator feeding `name`, or undefined when it does
 * not repeat. This is what a list column splits its rendered text on, so the
 * text view and the typed view can never disagree about where a value ends.
 */
export function repeatSeparatorOf(
  name: string,
  specs: readonly SequenceSpec[],
): string | undefined {
  const gen = specs.find((s) => s.name === name)?.gen;
  const repeat = gen?.attrs['repeat'];
  if (gen === undefined || repeat === undefined || repeat.trim() === '') return undefined;
  return gen.attrs['separator'] ?? ',';
}
