import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

function writeCsvFixture(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdc-row-link-'));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

/**
 * Integration tests for compound sequences — `<sequence>` with multiple
 * named `<gen name="…">` children, accessed via `${{Parent.Field}}`.
 *
 * These exercise the full pipeline (parser → validator → build → render)
 * rather than poking at internals, because compound semantics cross all
 * of those layers.
 */
describe('compound sequences — ${{Parent.Field}} access', () => {
  it('renders multiple named fields from one compound sequence', () => {
    const dsl = `
      <tdc>
        <env count="3" seed="compound-1" inject="\${{%}}">
          <sequence name="Person">
            <gen name="FirstName" type="text" value="Alice,Bob,Carol"/>
            <gen name="Age"       type="number" value="20..30"/>
          </sequence>
        </env>
        <block>
          <line><data>\${{Person.FirstName}} / \${{Person.Age}}</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      // "Name / Age" — Name from the value list, Age from the number range.
      expect(line).toMatch(/^(Alice|Bob|Carol) \/ \d{2}$/);
    }
  });

  it('bare ${{Compound}} without a field resolves as the literal string', () => {
    // Without a field accessor, the registry has no `Person` entry
    // (only `Person.FirstName` etc.), so the interpolation leaves
    // `${{Person}}` in place.
    const dsl = `
      <tdc>
        <env count="1" seed="compound-2" inject="\${{%}}">
          <sequence name="Person">
            <gen name="FirstName" type="text" value="Alice"/>
            <gen name="Age"       type="text" value="42"/>
          </sequence>
        </env>
        <block>
          <line><data>\${{Person}}</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    expect(out).toContain('${{Person}}');
  });

  it('compound respects parent filter — fields undefined on filtered rows', () => {
    const dsl = `
      <tdc>
        <env count="4" seed="compound-3" inject="\${{%}}">
          <sequence name="Gender">
            <gen type="text" value="Male,Female" percent="50,50"/>
          </sequence>
          <sequence name="Male" parent="Gender.Male">
            <gen name="FirstName" type="text" value="Alice,Bob"/>
            <gen name="Rank"      type="text" value="Private,Captain" percent="50,50"/>
          </sequence>
        </env>
        <block>
          <line><data>\${{Gender}}: \${{Male.FirstName}} (\${{Male.Rank}})</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    // On Female rows, Male.FirstName and Male.Rank must be empty.
    // On Male rows, both must be non-empty.
    for (const line of lines) {
      const isFemale = line.startsWith('Female:');
      const isMale = line.startsWith('Male:');
      expect(isFemale || isMale).toBe(true);
      if (isFemale) {
        expect(line).toBe('Female:  ()');
      } else {
        expect(line).toMatch(/^Male: (Alice|Bob) \((Private|Captain)\)$/);
      }
    }
  });

  it('if expressions can reference Parent.Field via MemberExpression', () => {
    const dsl = `
      <tdc>
        <env count="3" seed="compound-4" inject="\${{%}}">
          <sequence name="Person">
            <gen name="Age" type="text" value="17,25,50"/>
          </sequence>
        </env>
        <block>
          <line><data>row: \${{Person.Age}}</data><data if="Person.Age >= 18"> ADULT</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    for (const line of lines) {
      const age = Number(/row: (\d+)/.exec(line)?.[1] ?? '0');
      const hasAdult = line.includes('ADULT');
      expect(hasAdult).toBe(age >= 18);
    }
  });

  it('Hamilton exact allocation still applies inside compound fields', () => {
    // With count=10 and percent="60,40" on a text field, we expect
    // exactly 6 "A" and 4 "B" across the 10 rows — regardless of the
    // fact that this field is one of many in a compound.
    const dsl = `
      <tdc>
        <env count="10" seed="compound-5" inject="\${{%}}">
          <sequence name="Person">
            <gen name="FirstName" type="text" value="x"/>
            <gen name="Class"     type="text" value="A,B" percent="60,40"/>
          </sequence>
        </env>
        <block>
          <line><data>\${{Person.Class}}</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    const lines = out.split('\n').filter(Boolean);
    const countA = lines.filter((l) => l === 'A').length;
    const countB = lines.filter((l) => l === 'B').length;
    expect(countA).toBe(6);
    expect(countB).toBe(4);
  });

  it('compound fields consume PRNG in declaration order (deterministic)', () => {
    // Swapping two fields changes the PRNG consumption order, so the
    // resulting values should differ even with the same seed.
    const DSL_ORDER_1 = `
      <tdc>
        <env count="2" seed="compound-6" inject="\${{%}}">
          <sequence name="P">
            <gen name="A" type="number" value="10..99"/>
            <gen name="B" type="number" value="100..999"/>
          </sequence>
        </env>
        <block><line><data>\${{P.A}}|\${{P.B}}</data></line></block>
      </tdc>`;
    const DSL_ORDER_2 = `
      <tdc>
        <env count="2" seed="compound-6" inject="\${{%}}">
          <sequence name="P">
            <gen name="B" type="number" value="100..999"/>
            <gen name="A" type="number" value="10..99"/>
          </sequence>
        </env>
        <block><line><data>\${{P.A}}|\${{P.B}}</data></line></block>
      </tdc>`;
    // Declaration-order PRNG consumption is an Engine 1 semantic (it draws
    // sequentially); Engine 2 keys each field's seekable stream independently, so
    // reordering wouldn't change output. Pin memory to test the Engine-1 rule.
    const out1 = render(parseStrict(DSL_ORDER_1), { now: FIXED_NOW, mode: 'memory' });
    const out2 = render(parseStrict(DSL_ORDER_2), { now: FIXED_NOW, mode: 'memory' });
    // Same seed, different field order → different output.
    expect(out1).not.toBe(out2);
  });

  it('same seed + same config reproduces byte-for-byte', () => {
    const dsl = `
      <tdc>
        <env count="5" seed="compound-7" inject="\${{%}}">
          <sequence name="P">
            <gen name="First" type="text" value="a,b,c"/>
            <gen name="Last"  type="text" value="x,y,z"/>
          </sequence>
        </env>
        <block><line><data>\${{P.First}}-\${{P.Last}}</data></line></block>
      </tdc>`;
    const a = render(parseStrict(dsl), { now: FIXED_NOW });
    const b = render(parseStrict(dsl), { now: FIXED_NOW });
    expect(a).toBe(b);
  });
});

describe('compound sequences — MemberExpression in if expressions', () => {
  it('handles Parent.Field in a comparison', () => {
    const dsl = `
      <tdc>
        <env count="2" seed="mx-1" inject="\${{%}}">
          <sequence name="P">
            <gen name="X" type="text" value="hello,world"/>
          </sequence>
        </env>
        <block>
          <line if="P.X == hello"><data>yes</data></line>
          <line if="P.X == world"><data>no</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    // One of each over the two rows (Hamilton on text w/o percent
    // takes a uniform random, but with seed "mx-1" it's deterministic).
    const lines = out.split('\n').filter(Boolean);
    expect(lines.every((l) => l === 'yes' || l === 'no')).toBe(true);
    expect(lines).toHaveLength(2);
  });

  it('unknown compound reference in if expression falls back to literal string', () => {
    // P.Unknown is not in the registry; MemberExpression returns the
    // dotted name as a string literal ("P.Unknown"), and that compared
    // against a literal becomes a simple string equality.
    const dsl = `
      <tdc>
        <env count="1" seed="mx-2" inject="\${{%}}">
          <sequence name="P"><gen name="X" type="text" value="a"/></sequence>
        </env>
        <block>
          <line><data>before </data><data if="P.Unknown == P.Unknown">both equal</data></line>
        </block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: FIXED_NOW });
    expect(out).toContain('both equal');
  });
});

describe('compound sequences — row-linked CSV file fields', () => {
  it('preserves CSV row pairs across compound fields with the same row key', () => {
    const csvPath = writeCsvFixture(
      'people.csv',
      'first,last,email\nAlice,Smith,a@example.test\nBob,Brown,b@example.test\nCarol,Jones,c@example.test\n',
    );
    const dsl = `
      <tdc>
        <env count="30" seed="row-link-1" inject="\${{%}}">
          <sequence name="Person">
            <gen name="First" type="file" src="${csvPath}" column="first" row="person"/>
            <gen name="Last"  type="file" src="${csvPath}" column="last"  row="person"/>
          </sequence>
        </env>
        <block><line><data>\${{Person.First}}|\${{Person.Last}}</data></line></block>
      </tdc>`;
    const validPairs = new Set(['Alice|Smith', 'Bob|Brown', 'Carol|Jones']);
    const lines = render(parseStrict(dsl), { now: FIXED_NOW }).split('\n').filter(Boolean);

    expect(lines).toHaveLength(30);
    for (const line of lines) {
      expect(validPairs.has(line)).toBe(true);
    }
  });

  it('preserves CSV row pairs across separate sequences with the same row key', () => {
    const csvPath = writeCsvFixture(
      'separate.csv',
      'first,last\nAlice,Smith\nBob,Brown\nCarol,Jones\n',
    );
    const dsl = `
      <tdc>
        <env count="20" seed="row-link-2" inject="\${{%}}">
          <sequence name="First"><gen type="file" src="${csvPath}" column="first" row="person"/></sequence>
          <sequence name="Last"><gen type="file" src="${csvPath}" column="last" row="person"/></sequence>
        </env>
        <block><line><data>\${{First}}|\${{Last}}</data></line></block>
      </tdc>`;
    const validPairs = new Set(['Alice|Smith', 'Bob|Brown', 'Carol|Jones']);
    const lines = render(parseStrict(dsl), { now: FIXED_NOW }).split('\n').filter(Boolean);

    expect(lines).toHaveLength(20);
    for (const line of lines) {
      expect(validPairs.has(line)).toBe(true);
    }
  });

  it('redraws the linked CSV row per card (variety) while keeping columns coherent', () => {
    // Regression: the streaming engines resolve one card at a time, so the
    // row-link plan was built with count=1, cached under the row key, then
    // broadcast to every card — the whole dataset collapsed to one CSV row.
    // A correct link redraws the row per card while all same-key columns still
    // come from ONE real CSV row. Checked on every engine (1 = in-memory,
    // 2 = streaming, 3 = exact-on-disk) since 2 and 3 were both broken.
    const csvPath = writeCsvFixture(
      'people6.csv',
      'first,last,city\n' +
        'Anna,Ivanova,Moscow\n' +
        'John,Smith,London\n' +
        'Maria,Garcia,Madrid\n' +
        'Pavel,Novak,Prague\n' +
        'Lena,Costa,Lisbon\n' +
        'Yuki,Tanaka,Tokyo\n',
    );
    const validRows = new Set([
      'Anna|Ivanova|Moscow',
      'John|Smith|London',
      'Maria|Garcia|Madrid',
      'Pavel|Novak|Prague',
      'Lena|Costa|Lisbon',
      'Yuki|Tanaka|Tokyo',
    ]);
    const dsl = `
      <tdc>
        <env count="12" seed="row-variety" inject="\${{%}}">
          <sequence name="Person">
            <gen name="First" type="file" src="${csvPath}" column="first" row="p"/>
            <gen name="Last"  type="file" src="${csvPath}" column="last"  row="p"/>
            <gen name="City"  type="file" src="${csvPath}" column="city"  row="p"/>
          </sequence>
        </env>
        <block><line><data>\${{Person.First}}|\${{Person.Last}}|\${{Person.City}}</data></line></block>
      </tdc>`;

    for (const engine of [1, 2, 3] as const) {
      const lines = render(parseStrict(dsl), { now: FIXED_NOW, engine })
        .split('\n')
        .filter(Boolean);
      expect(lines).toHaveLength(12);
      // Coherence: every card's three columns come from one real CSV row.
      for (const line of lines) expect(validRows.has(line)).toBe(true);
      // Variety: more than one distinct linked row across the cards.
      expect(new Set(lines).size).toBeGreaterThan(1);
    }
  });

  it('does not advance PRNG again for additional fields on the same row key', () => {
    const csvPath = writeCsvFixture(
      'stable.csv',
      'first,last,email\nAlice,Smith,a@example.test\nBob,Brown,b@example.test\nCarol,Jones,c@example.test\n',
    );
    const baseDsl = `
      <tdc>
        <env count="12" seed="row-link-3" inject="\${{%}}">
          <sequence name="Person">
            <gen name="First" type="file" src="${csvPath}" column="first" row="person"/>
            <gen name="Last"  type="file" src="${csvPath}" column="last"  row="person"/>
          </sequence>
        </env>
        <block><line><data>\${{Person.First}}|\${{Person.Last}}</data></line></block>
      </tdc>`;
    const extendedDsl = `
      <tdc>
        <env count="12" seed="row-link-3" inject="\${{%}}">
          <sequence name="Person">
            <gen name="First" type="file" src="${csvPath}" column="first" row="person"/>
            <gen name="Email" type="file" src="${csvPath}" column="email" row="person"/>
            <gen name="Last"  type="file" src="${csvPath}" column="last"  row="person"/>
          </sequence>
        </env>
        <block><line><data>\${{Person.First}}|\${{Person.Last}}</data></line></block>
      </tdc>`;

    expect(render(parseStrict(extendedDsl), { now: FIXED_NOW })).toBe(
      render(parseStrict(baseDsl), { now: FIXED_NOW }),
    );
  });
});
