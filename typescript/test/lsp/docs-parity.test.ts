/**
 * Every attribute autocomplete offers has something to say when hovered.
 *
 * The completion map is derived from the validator and so cannot drift — that
 * is what `attribute-parity.test.ts` guards. The hover texts are hand-written
 * and had no such guard, so they drifted instead: thirty-two of the eighty-six
 * `<gen>` attributes had no doc at all, and the missing ones were the new
 * ones — `of`, `plus`, `expr`, `op`, `reset` and the whole statistical
 * distribution family. The attribute was suggested, accepted by the validator,
 * and silent on hover.
 *
 * `type` had drifted in the other direction: its text listed the generators by
 * hand and had stopped at `http`, so `pool`, `running`, `stat` and `formula`
 * were missing from the sentence that claims to list them all.
 */

import { describe, expect, it } from 'vitest';

import { ATTR_DOCS, TAG_DOCS } from '../../src/lsp/docs.js';
import {
  ATTRIBUTE_OWNERS,
  COMPUTE_TAGS,
  GEN_ATTRIBUTES,
  KNOWN_GEN_TYPES,
} from '../../src/validator/index.js';

describe('hover docs cover what the validator accepts', () => {
  it('every <gen> attribute has a hover doc', () => {
    const undocumented = [...GEN_ATTRIBUTES].filter((a) => ATTR_DOCS[a] === undefined);
    expect(undocumented, `undocumented <gen> attributes: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('every attribute any tag owns has a hover doc', () => {
    const owned = new Set<string>();
    for (const attrs of Object.values(ATTRIBUTE_OWNERS)) {
      for (const a of attrs as Iterable<string>) owned.add(a);
    }
    const undocumented = [...owned].filter((a) => ATTR_DOCS[a] === undefined);
    expect(undocumented, `undocumented attributes: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('no doc is an empty string — a blank hover is worse than none', () => {
    for (const [name, text] of Object.entries(ATTR_DOCS)) {
      expect(text.trim().length, `${name} has an empty doc`).toBeGreaterThan(0);
    }
    for (const [name, text] of Object.entries(TAG_DOCS)) {
      expect(text.trim().length, `${name} has an empty doc`).toBeGreaterThan(0);
    }
  });

  it('the type= doc names every generator the engine implements', () => {
    // The one doc that enumerates something the engine owns, so the one that
    // can be checked rather than merely reviewed.
    const text = ATTR_DOCS['type'] ?? '';
    const unlisted = [...KNOWN_GEN_TYPES].filter((t) => !text.includes(`\`${t}\``));
    expect(unlisted, `type= does not mention: ${unlisted.join(', ')}`).toEqual([]);
  });

  it('every compute tag has a hover doc', () => {
    const undocumented = [...COMPUTE_TAGS].filter((t) => TAG_DOCS[t] === undefined);
    // Compute tags are a large, growing family; this fails loudly when one
    // arrives without a word of explanation rather than quietly shipping it.
    expect(undocumented, `undocumented compute tags: ${undocumented.join(', ')}`).toEqual([]);
  });
});
