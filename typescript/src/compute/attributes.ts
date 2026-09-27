/**
 * Every tag of the compute language, and the attributes each one reads.
 *
 * ONE list, with two readers: the evaluator reads an attribute only through
 * `attrOf`, whose type admits the names listed here and no other, and the
 * validator refuses any name that is not listed. A tag cannot learn to read an
 * attribute without this table knowing — the build fails first — so the
 * validator's idea of what a tag accepts cannot drift from what it reads.
 *
 * It exists because nothing checked these names at all. `<gen>` refuses an
 * attribute it does not have (TDC015); a compute tag took any name, and an
 * attribute it does not read changed the output without a word:
 *
 *     <join sep="-">        ->  a-b-c
 *     <join seperator="-">  ->  abc
 *
 * Measured by the Studio agent over sixteen attributes: nine misspellings
 * passed `check`, and eight of those produced a different file. The seven that
 * were refused were refused for the wrong reason — the value the attribute
 * carried had gone missing, and the complaint pointed at whatever needed it,
 * one tag further down.
 *
 * The keys are also the tag vocabulary: `COMPUTE_TAGS` is read off this table
 * rather than kept beside it.
 */

import type { AttrMap } from '../processor/attrs.js';

export const COMPUTE_ATTRIBUTES = {
  // literals & references
  int: ['v'],
  str: ['v'],
  list: ['v'],
  field: ['name'],
  use: ['name'],
  current: [],
  current_index: [],
  acc: [],
  // binding
  let: ['name'],
  // collections
  each: [],
  reduce: [],
  join: ['sep'],
  split: ['sep'],
  at: ['default'],
  length: [],
  // arithmetic
  add: [],
  subtract: [],
  multiply: [],
  divide: [],
  mod: [],
  // encoding / conversion
  encode: ['as'],
  to_number: [],
  pad: ['width', 'fill'],
  concat: [],
  upper: [],
  lower: [],
  capitalize: [],
  title: [],
  mask: ['pattern'],
  slice: ['from', 'to'],
  replace: ['from', 'to'],
  trim: [],
  group: ['size', 'sep'],
  // conditional + role wrappers
  choose: [],
  when: [],
  otherwise: [],
  test: [],
  then: [],
  result: [],
  over: [],
  do: [],
  init: [],
  in: [],
  index: [],
  // predicates
  equals: [],
  greater_than: [],
  less_than: [],
  is_digit: [],
} as const satisfies Record<string, readonly string[]>;

export type ComputeTag = keyof typeof COMPUTE_ATTRIBUTES;

/** The attributes `T` reads. */
export type ComputeAttr<T extends ComputeTag> = (typeof COMPUTE_ATTRIBUTES)[T][number];

/**
 * Accepted on every compute tag and read by none: a note for the reader, the
 * same as on every other tag. Refusing it on the one tag that happens not to
 * list it would be a pointless trap.
 */
export const ANY_COMPUTE_TAG_ATTRIBUTE = 'comment';

/** The attributes a compute tag accepts, or `undefined` for a tag the language does not have. */
export function computeAttributesOf(tag: string): readonly string[] | undefined {
  return Object.hasOwn(COMPUTE_ATTRIBUTES, tag) ? COMPUTE_ATTRIBUTES[tag as ComputeTag] : undefined;
}

/**
 * Read attribute `name` of a `<tag>` node. `tag` is there for the type only:
 * it is what makes reading an unlisted attribute a compile error.
 */
export function attrOf<T extends ComputeTag>(
  attrs: AttrMap,
  _tag: T,
  name: ComputeAttr<T>,
): string | undefined {
  return attrs[name];
}
