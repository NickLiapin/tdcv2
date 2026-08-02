import { describe, expect, it } from 'vitest';

import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

/** Engine 2 — the streaming (lazy, disk-friendly) engine via mode="stream". */
describe('Engine 2 — mode="stream"', () => {
  it('renders, is deterministic, and gives exact percentages with no array', () => {
    const dsl = `
      <tdc>
        <env count="200" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
          <sequence name="Id"><gen type="increment" value="1"/></sequence>
        </env>
        <block><line><data>\${{Id}}|\${{G}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic

    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(200);

    const tally: Record<string, number> = {};
    for (const l of lines) {
      const g = l.split('|')[1]!;
      tally[g] = (tally[g] ?? 0) + 1;
    }
    expect(tally).toEqual({ M: 140, F: 60 }); // EXACT 70/30, no array

    // counter is sequential 1..200
    expect(lines[0]!.split('|')[0]).toBe('1');
    expect(lines[199]!.split('|')[0]).toBe('200');
  });

  it('resolves independent generators (number range) per row', () => {
    const dsl = `
      <tdc>
        <env count="50" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="Age"><gen type="number" value="18..65"/></sequence>
        </env>
        <block><line><data>\${{Age}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean);
    expect(lines).toHaveLength(50);
    for (const l of lines) {
      const n = Number(l);
      expect(n).toBeGreaterThanOrEqual(18);
      expect(n).toBeLessThanOrEqual(65);
    }
  });

  it('handles compound sequences', () => {
    const dsl = `
      <tdc>
        <env count="4" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="P">
            <gen name="a" type="text" value="x,y" percent="50,50"/>
            <gen name="b" type="increment" value="0"/>
          </sequence>
        </env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    // b is a sequential counter 0..3
    expect(lines.map((l) => l.slice(1))).toEqual(['0', '1', '2', '3']);
  });

  it('errors clearly on features not yet supported in stream mode', () => {
    // A parent that is NOT a finite-value (text) sequence can't be nested under.
    const badParentDsl = `
      <tdc>
        <env count="10" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="N"><gen type="number" value="1..100"/></sequence>
          <sequence name="C" parent="N.50"><gen type="text" value="x,y"/></sequence>
        </env>
        <block><line><data>\${{C}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(badParentDsl), { now: NOW })).toThrow(/stream mode/i);

    // percent on a uniq column: streaming uniq is UNIFORM-only.
    const pctUniqDsl = `
      <tdc>
        <env count="4" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="P" uniq="true">
            <gen name="a" type="text" value="x,y" percent="70,30"/>
            <gen name="b" type="text" value="m,n"/>
          </sequence>
        </env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(pctUniqDsl), { now: NOW })).toThrow(/percent/i);

    // env-level <uniq> with percent on a member: uniform-only in stream mode.
    const pctEnvUniqDsl = `
      <tdc>
        <env count="4" seed="s" inject="\${{%}}" mode="stream">
          <uniq>
            <sequence name="A"><gen type="text" value="x,y" percent="70,30"/></sequence>
            <sequence name="B"><gen type="text" value="m,n"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}\${{B}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(pctEnvUniqDsl), { now: NOW })).toThrow(/percent/i);
  });

  it('the { stream: true } render option (CLI --stream) forces Engine 2', () => {
    // No mode attr — the option overrides.
    const dsl = `
      <tdc>
        <env count="100" seed="s" inject="\${{%}}">
          <sequence name="G"><gen type="text" value="M,F" percent="70,30"/></sequence>
        </env>
        <block><line><data>\${{G}}</data></line></block>
      </tdc>`;
    const tally: Record<string, number> = {};
    for (const l of render(parseStrict(dsl), { now: NOW, stream: true })
      .split('\n')
      .filter(Boolean)) {
      tally[l] = (tally[l] ?? 0) + 1;
    }
    expect(tally).toEqual({ M: 70, F: 30 }); // exact 70/30 → streaming engine ran
  });

  it('the same config without mode="stream" still uses the in-memory engine', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="s" inject="\${{%}}">
          <sequence name="G"><gen type="text" value="M,F" percent="50,50"/></sequence>
        </env>
        <block><line><data>\${{G}}</data></line></block>
      </tdc>`;
    // (in-memory path unchanged) — just confirm it renders 6 rows.
    expect(render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean)).toHaveLength(6);
  });
});

/** Engine 2 — parent-child (nesting): nested exact distributions. */
describe('Engine 2 — parent-child in stream mode', () => {
  it('a child is active only on matching rows, exact within its subset', () => {
    const dsl = `
      <tdc>
        <env count="100" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="Gender"><gen type="text" value="M,F" percent="70,30"/></sequence>
          <sequence name="MaleName" parent="Gender.M"><gen type="text" value="Ivan,Pavel" percent="50,50"/></sequence>
          <sequence name="FemaleName" parent="Gender.F"><gen type="text" value="Anna,Olga" percent="50,50"/></sequence>
        </env>
        <block><line><data>\${{Gender}}:\${{MaleName}}\${{FemaleName}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic

    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(100);
    const gender: Record<string, number> = {};
    const name: Record<string, number> = {};
    for (const l of lines) {
      const [g, nm] = l.split(':');
      gender[g!] = (gender[g!] ?? 0) + 1;
      name[nm!] = (name[nm!] ?? 0) + 1;
      if (g === 'M')
        expect(['Ivan', 'Pavel']).toContain(nm); // no female name leaked
      else expect(['Anna', 'Olga']).toContain(nm);
    }
    expect(gender).toEqual({ M: 70, F: 30 }); // parent exact
    // children exact WITHIN their subset: 50/50 of 70 → 35/35; of 30 → 15/15
    expect(name).toEqual({ Ivan: 35, Pavel: 35, Anna: 15, Olga: 15 });
  });

  it('nests to a grandchild (matryoshka)', () => {
    const dsl = `
      <tdc>
        <env count="200" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="A"><gen type="text" value="p,q" percent="50,50"/></sequence>
          <sequence name="B" parent="A.p"><gen type="text" value="x,y" percent="50,50"/></sequence>
          <sequence name="C" parent="B.x"><gen type="text" value="m,n" percent="50,50"/></sequence>
        </env>
        <block><line><data>\${{A}}\${{B}}\${{C}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean);
    // A: 100 p / 100 q. B on p (100): 50 x / 50 y. C on B.x (50): 25 m / 25 n.
    const cTally: Record<string, number> = {};
    for (const l of lines) {
      const c = l.charAt(2); // third char = C's value (empty when inactive)
      if (c) cTally[c] = (cTally[c] ?? 0) + 1;
    }
    expect(cTally).toEqual({ m: 25, n: 25 }); // grandchild exact over its subset
  });
});

/** Engine 2 — uniq (mixed-radix over a Feistel-permuted combination index). */
describe('Engine 2 — uniq in stream mode', () => {
  const seq = `
    <sequence name="P" uniq="true">
      <gen name="a" type="text" value="x,y,z"/>
      <gen name="b" type="text" value="m,n"/>
    </sequence>`;
  const product = new Set(['xm', 'xn', 'ym', 'yn', 'zm', 'zn']);

  it('gives all-distinct tuples — the full product when count = capacity', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="s" inject="\${{%}}" mode="stream">${seq}</env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic

    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(new Set(lines).size).toBe(6); // no repeated tuple
    expect(new Set(lines)).toEqual(product); // exactly the 3×2 product
  });

  it('count < capacity still yields all-distinct tuples', () => {
    const dsl = `
      <tdc>
        <env count="4" seed="s" inject="\${{%}}" mode="stream">${seq}</env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean);
    expect(lines).toHaveLength(4);
    expect(new Set(lines).size).toBe(4);
    for (const l of lines) expect(product).toContain(l);
  });

  it('errors before rendering when count exceeds capacity (infeasible)', () => {
    const dsl = `
      <tdc>
        <env count="7" seed="s" inject="\${{%}}" mode="stream">${seq}</env>
        <block><line><data>\${{P.a}}\${{P.b}}</data></line></block>
      </tdc>`;
    // Only 6 distinct combinations exist; 7 unique rows is impossible.
    expect(() => render(parseStrict(dsl), { now: NOW })).toThrow(/infeasible|combination/i);
  });

  it('env-level <uniq> (Form B) makes the tuple of separate sequences distinct', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="s" inject="\${{%}}" mode="stream">
          <uniq>
            <sequence name="A"><gen type="text" value="x,y,z"/></sequence>
            <sequence name="B"><gen type="text" value="m,n"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}\${{B}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(6);
    expect(new Set(lines)).toEqual(product); // exactly the 3×2 product, no repeats
  });

  it('env-level <uniq> also errors before rendering when infeasible', () => {
    const dsl = `
      <tdc>
        <env count="7" seed="s" inject="\${{%}}" mode="stream">
          <uniq>
            <sequence name="A"><gen type="text" value="x,y,z"/></sequence>
            <sequence name="B"><gen type="text" value="m,n"/></sequence>
          </uniq>
        </env>
        <block><line><data>\${{A}}\${{B}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(dsl), { now: NOW })).toThrow(/infeasible|combination/i);
  });
});

/** Engine 2 — in-sequence <distinct> (row-local: fields differ within a row). */
describe('Engine 2 — <distinct> in stream mode', () => {
  it('two fields from the same 2-value list never coincide in a row', () => {
    const dsl = `
      <tdc>
        <env count="40" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="P">
            <distinct>
              <gen name="A" type="text" value="X,Y"/>
              <gen name="B" type="text" value="X,Y"/>
            </distinct>
          </sequence>
        </env>
        <block><line><data>\${{P.A}}|\${{P.B}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(40);
    for (const l of lines) {
      const [a, b] = l.split('|');
      expect(a).not.toBe(b); // never X|X or Y|Y
      expect(['X', 'Y']).toContain(a);
      expect(['X', 'Y']).toContain(b);
    }
  });

  it('errors when a group cannot be satisfied (3 distinct from a 2-value list)', () => {
    const dsl = `
      <tdc>
        <env count="5" seed="s" inject="\${{%}}" mode="stream">
          <sequence name="P">
            <distinct>
              <gen name="A" type="text" value="X,Y"/>
              <gen name="B" type="text" value="X,Y"/>
              <gen name="C" type="text" value="X,Y"/>
            </distinct>
          </sequence>
        </env>
        <block><line><data>\${{P.A}}\${{P.B}}\${{P.C}}</data></line></block>
      </tdc>`;
    expect(() => render(parseStrict(dsl), { now: NOW })).toThrow(/distinct/i);
  });

  it('env-level <distinct> around separate sequences differ within a row', () => {
    const dsl = `
      <tdc>
        <env count="40" seed="s" inject="\${{%}}" mode="stream">
          <distinct>
            <sequence name="Birth"><gen type="text" value="A,B"/></sequence>
            <sequence name="Live"><gen type="text" value="A,B"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{Birth}}|\${{Live}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic
    const lines = out.split('\n').filter(Boolean);
    expect(lines).toHaveLength(40);
    for (const l of lines) {
      const [birth, live] = l.split('|');
      expect(birth).not.toBe(live); // city of birth != city of residence
      expect(['A', 'B']).toContain(birth);
      expect(['A', 'B']).toContain(live);
    }
  });
});

/** Engine 2 — <mix>: exact case percentages + nested cases assembled per row. */
describe('Engine 2 — <mix> in stream mode', () => {
  it('splits rows across cases with exact percentages', () => {
    const dsl = `
      <tdc>
        <env count="100" seed="s" inject="\${{%}}" mode="stream">
          <mix name="Code" percent="30,70">
            <case><data>A</data></case>
            <case><data>B</data></case>
          </mix>
        </env>
        <block><line><data>\${{Code}}</data></line></block>
      </tdc>`;
    const out = render(parseStrict(dsl), { now: NOW });
    expect(out).toBe(render(parseStrict(dsl), { now: NOW })); // deterministic
    const tally: Record<string, number> = {};
    for (const l of out.split('\n').filter(Boolean)) tally[l] = (tally[l] ?? 0) + 1;
    expect(tally).toEqual({ A: 30, B: 70 }); // exact
  });

  it('runs a case generator only within its case (counter counts within the case)', () => {
    const dsl = `
      <tdc>
        <env count="6" seed="s" inject="\${{%}}" mode="stream">
          <mix name="Code" percent="50,50">
            <case><data>A</data><gen type="increment" value="1"/></case>
            <case><data>B</data></case>
          </mix>
        </env>
        <block><line><data>\${{Code}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean);
    expect(lines.filter((l) => l === 'B')).toHaveLength(3);
    // The counter runs over the 3 A-rows only → A1, A2, A3.
    expect(lines.filter((l) => l.startsWith('A')).sort()).toEqual(['A1', 'A2', 'A3']);
  });

  it('nests a mix inside a case with exact sub-percentages', () => {
    const dsl = `
      <tdc>
        <env count="40" seed="s" inject="\${{%}}" mode="stream">
          <mix name="Code" percent="50,50">
            <case>
              <data>A</data>
              <mix percent="25,75">
                <case><data>X</data></case>
                <case><data>Y</data></case>
              </mix>
            </case>
            <case><data>B</data></case>
          </mix>
        </env>
        <block><line><data>\${{Code}}</data></line></block>
      </tdc>`;
    const tally: Record<string, number> = {};
    for (const l of render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean)) {
      tally[l] = (tally[l] ?? 0) + 1;
    }
    // 20 A / 20 B; within the 20 A: 25/75 → 5 AX, 15 AY.
    expect(tally).toEqual({ AX: 5, AY: 15, B: 20 });
  });

  // `length="2,10-12" percent="85,15"` picks a length GROUP by exact quota over
  // the whole column. The streaming path resolves one row at a time, and a
  // Hamilton quota over a single cell always awards it to the largest share —
  // so this used to come out winner-take-all (1000/0, not 850/150), correct
  // only under mode="memory". Pinned across every engine, because the bug was
  // invisible unless you compared them.
  it('honours percent across length groups identically on every engine', () => {
    const dsl = (mode: string) => `
      <tdc>
        <env count="1000" seed="audit" inject="\${{%}}"${mode}>
          <sequence name="Num"><gen type="number" length="2,10-12" percent="85,15"/></sequence>
        </env>
        <block><line><data>\${{Num}}</data></line></block>
      </tdc>`;

    for (const mode of ['', ' mode="stream"', ' mode="memory"', ' mode="disk"']) {
      const lines = render(parseStrict(dsl(mode)), { now: NOW })
        .split('\n')
        .filter(Boolean);
      const short = lines.filter((l) => l.length === 2).length;
      const long = lines.filter((l) => l.length >= 10 && l.length <= 12).length;
      expect({ mode, short, long }).toEqual({ mode, short: 850, long: 150 });
    }
  });

  it('splits three length groups by exact quota, not by argmax', () => {
    const dsl = `
      <tdc>
        <env count="4000" seed="demo" inject="\${{%}}">
          <sequence name="N"><gen type="number" length="2,6,12" percent="70,20,10"/></sequence>
        </env>
        <block><line><data>\${{N}}</data></line></block>
      </tdc>`;
    const lines = render(parseStrict(dsl), { now: NOW }).split('\n').filter(Boolean);
    const by = (n: number) => lines.filter((l) => l.length === n).length;
    expect([by(2), by(6), by(12)]).toEqual([2800, 800, 400]);
  });
});
