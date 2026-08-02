/**
 * `each=` end to end: one card holding a list becomes several output lines.
 *
 * The point of the feature is a normalized relational dump from ONE config, so
 * the assertions here are the ones a database would make — every child row
 * points at a real parent, and no two children share a key. The key check earns
 * its place: the first implementation gave two lists one shared counter and
 * produced 3501 rows carrying only 3071 distinct keys, which nothing in a
 * four-row demo revealed.
 */

import { describe, expect, it } from 'vitest';

import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { now: NOW, mode: 'memory' }],
  ['stream', { now: NOW, stream: true }],
  ['disk', { now: NOW, mode: 'disk' }],
];

const shop = (count: number) =>
  `<tdc><env count="${String(count)}" seed="each-e2e" inject="\${{%}}">` +
  `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
  `<sequence name="Tier"><gen type="text" value="VIP,std" percent="20,80"/></sequence>` +
  `<sequence name="Vip" parent="Tier.VIP"><gen type="number" value="1000..9999" repeat="5..10"/></sequence>` +
  `<sequence name="Std" parent="Tier.std"><gen type="number" value="100..999" repeat="0..2"/></sequence>` +
  `</env><block>` +
  `<line><data>C;\${{Id}};\${{Tier}}</data></line>` +
  `<line each="Vip"><data>O;\${{_item_id}};\${{Id}};\${{Vip}}</data></line>` +
  `<line each="Std"><data>O;\${{_item_id}};\${{Id}};\${{Std}}</data></line>` +
  `</block></tdc>`;

const lines = (src: string, opts: RenderOptions): string[] =>
  render(parseStrict(src), opts).split('\n').filter(Boolean);

describe('each — the shape', () => {
  const simple =
    `<tdc><env count="3" seed="shape" inject="\${{%}}">` +
    `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
    `<sequence name="L"><gen type="number" value="1..9" repeat="0..3"/></sequence>` +
    `</env><block>` +
    `<line><data>card \${{Id}}</data></line>` +
    `<line each="L"><data>  item \${{_item}} of card \${{Id}} = \${{L}}</data></line>` +
    `</block></tdc>`;

  for (const [label, opts] of ENGINES) {
    it(`emits one line per element and none for an empty list (${label})`, () => {
      const out = lines(simple, opts);
      const cards = out.filter((l) => l.startsWith('card'));
      expect(cards).toHaveLength(3); // the plain line is untouched

      for (const card of ['1', '2', '3']) {
        const items = out.filter((l) => l.includes(`of card ${card} =`));
        expect(items.length).toBeLessThanOrEqual(3);
        // Positions run 1..N with no gaps.
        items.forEach((line, k) => {
          expect(line).toContain(`item ${String(k + 1)} of card ${card}`);
        });
      }
    });
  }

  it('a zero-length list leaves nothing behind, not a blank row', () => {
    const out = lines(
      `<tdc><env count="20" seed="empty" inject="\${{%}}">` +
        `<sequence name="Id"><gen type="increment" value="1"/></sequence>` +
        `<sequence name="L"><gen type="number" value="1..9" repeat="0..1"/></sequence>` +
        `</env><block><line each="L"><data>[\${{L}}]</data></line></block></tdc>`,
      { now: NOW, mode: 'memory' },
    );
    // Some cards hold nothing; none of them produced "[]".
    expect(out.length).toBeLessThan(20);
    expect(out.every((l) => l !== '[]')).toBe(true);
  });

  it('the current element shadows the joined list only inside the loop', () => {
    const out = lines(
      `<tdc><env count="2" seed="shadow" inject="\${{%}}">` +
        `<sequence name="L"><gen type="number" value="1..9" repeat="3"/></sequence>` +
        `</env><block>` +
        `<line><data>whole=\${{L}}</data></line>` +
        `<line each="L"><data>one=\${{L}}</data></line>` +
        `</block></tdc>`,
      { now: NOW, mode: 'memory' },
    );
    // Outside: still the comma-joined list. Inside: a single value.
    expect(out.filter((l) => l.startsWith('whole=')).every((l) => l.includes(','))).toBe(true);
    expect(out.filter((l) => l.startsWith('one=')).every((l) => !l.includes(','))).toBe(true);
  });
});

describe('each — what a database would check', () => {
  for (const [label, opts] of ENGINES) {
    it(`every child key is unique and increases down the file (${label})`, () => {
      const out = lines(shop(2000), opts);
      const keys = out.filter((l) => l.startsWith('O;')).map((l) => Number(l.split(';')[1]));
      expect(keys.length).toBeGreaterThan(2000);
      expect(new Set(keys).size, `${label}: duplicate keys`).toBe(keys.length);
      expect(keys, `${label}: keys not ascending`).toEqual([...keys].sort((a, b) => a - b));
    });

    it(`every child points at a parent that exists (${label})`, () => {
      const out = lines(shop(500), opts);
      const parents = new Set(out.filter((l) => l.startsWith('C;')).map((l) => l.split(';')[1]));
      const orphans = out
        .filter((l) => l.startsWith('O;'))
        .filter((l) => !parents.has(l.split(';')[2]));
      expect(orphans, `${label}: orphaned child rows`).toEqual([]);
    });

    it(`the declared per-tier composition still holds (${label})`, () => {
      const out = lines(shop(1000), opts);
      const tierOf = new Map(
        out.filter((l) => l.startsWith('C;')).map((l) => [l.split(';')[1], l.split(';')[2]]),
      );
      const counts = new Map<string, number>();
      for (const l of out.filter((x) => x.startsWith('O;'))) {
        const parent = l.split(';')[2] ?? '';
        counts.set(parent, (counts.get(parent) ?? 0) + 1);
      }
      for (const [id, tier] of tierOf) {
        const n = counts.get(id ?? '') ?? 0;
        if (tier === 'VIP') {
          expect(n, `${label}: VIP ${String(id)} has ${String(n)} orders`).toBeGreaterThanOrEqual(
            5,
          );
          expect(n).toBeLessThanOrEqual(10);
        } else {
          expect(n, `${label}: std ${String(id)} has ${String(n)} orders`).toBeLessThanOrEqual(2);
        }
      }
      // Exactly 20% VIP, unchanged by the loop.
      expect([...tierOf.values()].filter((t) => t === 'VIP')).toHaveLength(200);
    });
  }
});

describe('each — refused where it cannot work', () => {
  const codes = (block: string, seqs: string): string[] =>
    validate(
      parse(
        `<tdc><env count="3" seed="v" inject="\${{%}}">${seqs}</env>` +
          `<block>${block}</block></tdc>`,
      ).tree,
    ).diagnostics.map((d) => d.code ?? '');

  const SEQS =
    '<sequence name="Plain"><gen type="number" value="1..9"/></sequence>' +
    '<sequence name="List"><gen type="number" value="1..9" repeat="2"/></sequence>';

  it('accepts a repeating sequence', () => {
    expect(codes('<line each="List"><data>${{List}}</data></line>', SEQS)).toEqual([]);
  });

  it('rejects an unknown name (TDC206)', () => {
    expect(codes('<line each="Nope"><data>x</data></line>', SEQS)).toContain('TDC206');
  });

  it('rejects a sequence that holds one value (TDC207)', () => {
    expect(codes('<line each="Plain"><data>x</data></line>', SEQS)).toContain('TDC207');
  });

  it('rejects a typed column inside the loop (TDC209)', () => {
    // The columnar path collects named <data> once per card and knows nothing
    // about a line rendered several times.
    expect(codes('<line each="List"><data name="c">${{List}}</data></line>', SEQS)).toContain(
      'TDC209',
    );
  });
});
