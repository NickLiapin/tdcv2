import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { validate } from '../../src/validator/validate.js';

const FIXED_NOW = new Date('2026-04-23T12:00:00Z').getTime();

/**
 * `<distinct>` around references to a `<pool>`.
 *
 * A reference holds a whole MEMBER, not a value, so the group keeps its promise
 * by identity: no two of them hand one row the same member. Before this worked
 * the config was accepted and did nothing at all — 2,000 rows came out byte for
 * byte identical to the same config without the group.
 *
 * Every test runs all three engines, because the repair happens at pick time
 * and a pick is seekable: if the three ever disagree the mechanism is wrong,
 * not the numbers.
 */

function clinic(body: string, count = 200, poolCount = 6): string {
  return `
    <tdc>
      <env count="${String(count)}" seed="clinic">
        <pool name="Doctors" count="${String(poolCount)}">
          <sequence name="name" uniq="true">
            <gen type="text" value="Adams,Brooks,Chase,Dunn,Ellis,Frost,Gray,Hale"/>
          </sequence>
        </pool>
        ${body}
      </env>
      <block><line><data>\${{A.name}}|\${{B.name}}</data></line></block>
    </tdc>`;
}

const PAIR = `
  <distinct>
    <sequence name="A"><gen type="pool" value="Doctors"/></sequence>
    <sequence name="B"><gen type="pool" value="Doctors"/></sequence>
  </distinct>`;

const LOOSE = `
  <sequence name="A"><gen type="pool" value="Doctors"/></sequence>
  <sequence name="B"><gen type="pool" value="Doctors"/></sequence>`;

const ENGINES = [1, 2, 3] as const;

function run(config: string, engine: number): string[] {
  return render(parseStrict(config), { now: FIXED_NOW, engine }).split('\n').filter(Boolean);
}

function errorsFor(config: string): string[] {
  return validate(parseStrict(config))
    .diagnostics.filter((d) => d.severity === 'error')
    .map((d) => `${d.code ?? '?'}: ${d.message}`);
}

describe('<distinct> over pool references', () => {
  it('the same pool twice in one row never repeats a member', () => {
    for (const engine of ENGINES) {
      const lines = run(clinic(PAIR), engine);
      expect(lines).toHaveLength(200);
      for (const line of lines) {
        const [left, right] = line.split('|');
        expect(left).not.toBe(right);
      }
    }
  });

  it('without the group the same config DOES repeat — the test would pass vacuously otherwise', () => {
    const lines = run(clinic(LOOSE), 1);
    const collisions = lines.filter((l) => l.split('|')[0] === l.split('|')[1]);
    expect(collisions.length).toBeGreaterThan(0);
  });

  it('all three engines produce the same bytes', () => {
    const [one, two, three] = ENGINES.map((e) => run(clinic(PAIR), e).join('\n'));
    expect(two).toBe(one);
    expect(three).toBe(one);
  });

  it('three references to a pool of five all differ', () => {
    const config = `
      <tdc>
        <env count="300" seed="clinic">
          <pool name="Doctors" count="5">
            <sequence name="name" uniq="true"><gen type="text" value="Adams,Brooks,Chase,Dunn,Ellis"/></sequence>
          </pool>
          <distinct>
            <sequence name="A"><gen type="pool" value="Doctors"/></sequence>
            <sequence name="B"><gen type="pool" value="Doctors"/></sequence>
            <sequence name="C"><gen type="pool" value="Doctors"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{A.name}}|\${{B.name}}|\${{C.name}}</data></line></block>
      </tdc>`;
    for (const engine of ENGINES) {
      for (const line of run(config, engine)) {
        const [a, b, c] = line.split('|');
        expect(new Set([a, b, c]).size).toBe(3);
      }
    }
  });

  it('keeps a filter= as well as the group — both promises at once', () => {
    const config = `
      <tdc>
        <env count="200" seed="clinic">
          <pool name="Doctors" count="6">
            <sequence name="name" uniq="true"><gen type="text" value="Adams,Brooks,Chase,Dunn,Ellis,Frost"/></sequence>
            <sequence name="dept"><gen type="text" value="cardio,neuro" order="sequential"/></sequence>
          </pool>
          <sequence name="Want"><gen type="text" value="cardio,neuro"/></sequence>
          <distinct>
            <sequence name="A"><gen type="pool" value="Doctors" filter="dept == Want"/></sequence>
            <sequence name="B"><gen type="pool" value="Doctors" filter="dept == Want"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{Want}}|\${{A.name}}/\${{A.dept}}|\${{B.name}}/\${{B.dept}}</data></line></block>
      </tdc>`;
    for (const engine of ENGINES) {
      for (const line of run(config, engine)) {
        const [want, a, b] = line.split('|');
        expect(a?.split('/')[0]).not.toBe(b?.split('/')[0]);
        expect(a?.split('/')[1]).toBe(want);
        expect(b?.split('/')[1]).toBe(want);
      }
    }
  });
});

describe('<distinct> over pool references — the shapes it cannot mean', () => {
  it('refuses a reference beside an ordinary sequence', () => {
    const config = `
      <tdc>
        <env count="10" seed="s">
          <pool name="Doctors" count="4">
            <sequence name="name" uniq="true"><gen type="text" value="Adams,Brooks,Chase,Dunn"/></sequence>
          </pool>
          <distinct>
            <sequence name="A"><gen type="pool" value="Doctors"/></sequence>
            <sequence name="Plain"><gen type="text" value="Adams,Brooks"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{A.name}}|\${{Plain}}</data></line></block>
      </tdc>`;
    const errors = errorsFor(config);
    expect(errors.join('\n')).toContain('TDC302');
    expect(errors.join('\n')).toContain('nothing the two can be compared on');
  });

  it('refuses references to two different pools', () => {
    const config = `
      <tdc>
        <env count="10" seed="s">
          <pool name="Doctors" count="4"><sequence name="name" uniq="true"><gen type="text" value="Adams,Brooks,Chase,Dunn"/></sequence></pool>
          <pool name="Wards" count="4"><sequence name="no" uniq="true"><gen type="text" value="101,102,103,104"/></sequence></pool>
          <distinct>
            <sequence name="A"><gen type="pool" value="Doctors"/></sequence>
            <sequence name="W"><gen type="pool" value="Wards"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{A.name}}|\${{W.no}}</data></line></block>
      </tdc>`;
    expect(errorsFor(config).join('\n')).toContain('different pools');
  });

  it('refuses more references than the pool has members', () => {
    const config = `
      <tdc>
        <env count="10" seed="s">
          <pool name="Doctors" count="2"><sequence name="name" uniq="true"><gen type="text" value="Adams,Brooks"/></sequence></pool>
          <distinct>
            <sequence name="A"><gen type="pool" value="Doctors"/></sequence>
            <sequence name="B"><gen type="pool" value="Doctors"/></sequence>
            <sequence name="C"><gen type="pool" value="Doctors"/></sequence>
          </distinct>
        </env>
        <block><line><data>\${{A.name}}|\${{B.name}}|\${{C.name}}</data></line></block>
      </tdc>`;
    const errors = errorsFor(config).join('\n');
    expect(errors).toContain('3 references on pool "Doctors", which has 2 members');
  });

  it('a group that fits is not refused', () => {
    expect(hasErrors(validate(parseStrict(clinic(PAIR))).diagnostics)).toBe(false);
  });
});
