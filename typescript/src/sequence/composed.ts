/**
 * Composed sequences: a body that builds one value out of several.
 *
 * A `<sequence>` whose children are not all named `<gen>`s composes. Every
 * unnamed `<gen>` and every `<data>` literal is concatenated, in declaration
 * order, into the sequence's own value; a named `<gen>` is a field beside it,
 * reached as `${{Name.Field}}` and contributing nothing to the concatenation.
 *
 * Both engines walk the body in ONE pass, because the order the gens draw in is
 * part of the cross-language contract: taking the named ones first and the
 * unnamed ones after would shift every column that follows.
 */

import type { Sequence, SequenceItem } from './types.js';
import { sequenceValueAt } from './types.js';

/** A body item that draws: a named field or an unnamed part. */
type DrawingItem = Extract<SequenceItem, { kind: 'field' | 'gen' }>;

/** What the in-memory engine needs from its caller to draw one gen's column. */
export type DrawColumn = (item: DrawingItem, n: number) => string[];

/** The composed value and the named fields, both over the applicable rows. */
export interface ComposedColumns {
  readonly composed: string[];
  readonly fields: Map<string, string[]>;
}

/**
 * Draw a composed body over `applicableCount` rows.
 *
 * The caller supplies the draw so this module stays out of the generator
 * machinery — it owns the ORDER, which is the part that matters, and nothing
 * else.
 */
export function drawComposed(
  items: readonly SequenceItem[],
  applicableCount: number,
  draw: DrawColumn,
): ComposedColumns {
  const composed = new Array<string>(applicableCount).fill('');
  const fields = new Map<string, string[]>();

  for (const item of items) {
    if (item.kind === 'text') {
      for (let i = 0; i < applicableCount; i++) composed[i] = (composed[i] ?? '') + item.text;
      continue;
    }
    // A constant costs no draw at all — that is the whole reason it exists.
    if (item.kind === 'constant') {
      fields.set(item.name, new Array<string>(applicableCount).fill(item.text));
      continue;
    }
    const values = applicableCount === 0 ? [] : draw(item, applicableCount);
    if (item.kind === 'field') {
      fields.set(item.name, values);
      continue;
    }
    for (let i = 0; i < applicableCount; i++) composed[i] = (composed[i] ?? '') + (values[i] ?? '');
  }

  return { composed, fields };
}

/** What the streaming engine needs: a per-row resolver for one gen. */
export type BuildPart = (
  streamId: string,
  item: SequenceItem & { kind: 'field' | 'gen' },
) => Sequence;

export interface ComposedStream {
  readonly sequence: Sequence;
  readonly fields: Map<string, Sequence>;
}

/**
 * The streaming counterpart: every part keeps a stream of its own, so a row is
 * a function of its index exactly as any other.
 *
 * Parts are numbered among the UNNAMED ones (`#p0`, `#p1`, …), so adding a
 * literal between two gens moves nothing.
 */
export function buildComposedStream(
  name: string,
  items: readonly SequenceItem[],
  build: BuildPart,
): ComposedStream {
  const parts: (Sequence | string)[] = [];
  const fields = new Map<string, Sequence>();
  let unnamed = 0;
  /**
   * A named field that draws, if the body has one.
   *
   * Only consulted when NO unnamed gen does. It answers the one question the
   * literals cannot — whether this row is inside the parent's filter — and it
   * is read at most once per row, so the ordinary path costs nothing.
   */
  let witness: Sequence | undefined;

  for (const item of items) {
    if (item.kind === 'text') {
      parts.push(item.text);
      continue;
    }
    if (item.kind === 'constant') {
      fields.set(item.name, { name: `${name}.${item.name}`, values: [], resolve: () => item.text });
      continue;
    }
    if (item.kind === 'field') {
      const field = build(`${name}.${item.name}`, item);
      fields.set(item.name, field);
      witness ??= field;
      continue;
    }
    parts.push(build(`${name}#p${String(unnamed++)}`, item));
  }

  const drawn = unnamed;
  return {
    fields,
    sequence: {
      name,
      values: [],
      resolve: (row: number) => {
        let text = '';
        let active = false;
        for (const part of parts) {
          if (typeof part === 'string') {
            text += part;
            continue;
          }
          const value = sequenceValueAt(part, row);
          // A row outside the parent's filter has no value in any part, and the
          // composed cell is absent rather than a string of bare literals.
          if (value === undefined) continue;
          active = true;
          text += value;
        }
        if (drawn > 0) return active ? text : undefined;
        // Nothing unnamed draws here, so the value is the literals alone —
        // constant, but still absent on a row this sequence does not apply to.
        // A named field draws for exactly those rows and is asked instead.
        if (witness && sequenceValueAt(witness, row) === undefined) return undefined;
        return text;
      },
    },
  };
}

/**
 * Whether the body composes a value of its own.
 *
 * A body of nothing but named items — fields and constants — has none, and
 * `${{Name}}` stays the literal marker that says you meant `${{Name.Field}}`.
 */
export function composesOwnValue(items: readonly SequenceItem[]): boolean {
  return items.some((item) => item.kind === 'gen' || item.kind === 'text');
}

/**
 * The one part of a composed body that a `uniq="true"` draw applies to.
 *
 * A composed value is a concatenation, so it is unique exactly when the join is
 * injective — true when ONE part is drawn and the rest are constants, because
 * appending a constant cannot make two different draws collide. Two drawn parts
 * is the variable-width trap (`9` + `15` and `91` + `5` join alike) and the
 * validator refuses it (TDC220), so this returns nothing rather than guessing.
 */
export function uniqDrawPart(
  items: readonly SequenceItem[],
  uniq: boolean,
): SequenceItem | undefined {
  if (!uniq) return undefined;
  const drawn = items.filter((item) => item.kind === 'gen');
  return drawn.length === 1 ? drawn[0] : undefined;
}
