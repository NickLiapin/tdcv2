import { describe, expect, it } from 'vitest';

import { TDC } from '../../src/index.js';

const FIXED_NOW = new Date('2026-05-04T12:00:00Z').getTime();

/** Render a config to trimmed output lines. */
function run(config: string, engine?: 1 | 2 | 3): string[] {
  const tdc = new TDC({ configString: config, now: FIXED_NOW, ...(engine ? { engine } : {}) });
  return tdc.toString().trim().split('\n');
}

const GENDER = `<sequence name="Gender"><gen type="text" value="Man,Woman" percent="50,50"/></sequence>`;

describe('conditional sequence: <gen if> inside <sequence>', () => {
  it('sugar `if="Gender.Man"` picks the branch matching the current value', () => {
    const lines = run(`<tdc><env count="40" seed="cond-sugar">
        ${GENDER}
        <sequence name="Pick">
          <gen if="Gender.Man"   type="text" value="MALE"/>
          <gen if="Gender.Woman" type="text" value="FEMALE"/>
        </sequence>
      </env>
      <block><line><data>\${{Gender}}=\${{Pick}}</data></line></block></tdc>`);

    // Every row must be internally consistent — never Man=FEMALE.
    for (const line of lines) {
      expect(line === 'Man=MALE' || line === 'Woman=FEMALE').toBe(true);
    }
    // Both genders actually occur (50/50 over 40 rows).
    expect(lines).toContain('Man=MALE');
    expect(lines).toContain('Woman=FEMALE');
  });

  it('explicit `if="Gender == Man"` works too', () => {
    const lines = run(`<tdc><env count="40" seed="cond-eq">
        ${GENDER}
        <sequence name="Pick">
          <gen if="Gender == Man"   type="text" value="MALE"/>
          <gen if="Gender == Woman" type="text" value="FEMALE"/>
        </sequence>
      </env>
      <block><line><data>\${{Gender}}=\${{Pick}}</data></line></block></tdc>`);
    for (const line of lines) {
      expect(line === 'Man=MALE' || line === 'Woman=FEMALE').toBe(true);
    }
  });

  it('a bare <gen> with no `if` is the fallback (else)', () => {
    const lines = run(`<tdc><env count="40" seed="cond-else">
        ${GENDER}
        <sequence name="Pick">
          <gen if="Gender.Man" type="text" value="MALE"/>
          <gen type="text" value="OTHER"/>
        </sequence>
      </env>
      <block><line><data>\${{Gender}}=\${{Pick}}</data></line></block></tdc>`);
    for (const line of lines) {
      expect(line === 'Man=MALE' || line === 'Woman=OTHER').toBe(true);
    }
    expect(lines).toContain('Woman=OTHER');
  });

  it('no branch matches → the sequence is empty on that row', () => {
    const lines = run(`<tdc><env count="40" seed="cond-empty">
        ${GENDER}
        <sequence name="Pick">
          <gen if="Gender.Man" type="text" value="MALE"/>
        </sequence>
      </env>
      <block><line><data>\${{Gender}}=[\${{Pick}}]</data></line></block></tdc>`);
    for (const line of lines) {
      expect(line === 'Man=[MALE]' || line === 'Woman=[]').toBe(true);
    }
    expect(lines).toContain('Woman=[]');
  });

  it('logic lives in <env>: the value is referenced as a plain ${{Name}}', () => {
    const [first] = run(`<tdc><env count="1" seed="ref">
        <sequence name="Gender"><gen type="text" value="Man" percent="100"/></sequence>
        <sequence name="Name">
          <gen if="Gender.Man"   type="text" value="Bob"/>
          <gen if="Gender.Woman" type="text" value="Alice"/>
        </sequence>
      </env>
      <block><line><data>\${{Name}}</data></line></block></tdc>`);
    expect(first).toBe('Bob');
  });

  it('gives gender-consistent output on every engine (1, 2, 3)', () => {
    const config = `<tdc><env count="20" seed="cond-engines">
        ${GENDER}
        <sequence name="Pick">
          <gen if="Gender.Man"   type="text" value="MALE"/>
          <gen if="Gender.Woman" type="text" value="FEMALE"/>
        </sequence>
      </env>
      <block><line><data>\${{Gender}}=\${{Pick}}</data></line></block></tdc>`;
    for (const engine of [1, 2, 3] as const) {
      for (const line of run(config, engine)) {
        expect(line === 'Man=MALE' || line === 'Woman=FEMALE').toBe(true);
      }
    }
  });
});

describe('value-check sugar `X.Value` in the if expression language', () => {
  it('works in a block <data if> too, not only in sequences', () => {
    const lines = run(`<tdc><env count="30" seed="block-sugar">
        ${GENDER}
      </env>
      <block><line>
        <data>\${{Gender}}:</data>
        <data if="Gender.Man">M</data>
        <data if="!Gender.Man">not-M</data>
      </line></block></tdc>`);
    for (const line of lines) {
      expect(line === 'Man:M' || line === 'Woman:not-M').toBe(true);
    }
  });
});
