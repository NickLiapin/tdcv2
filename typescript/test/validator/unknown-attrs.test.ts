import { describe, expect, it } from 'vitest';

import type { Diagnostic } from '../../src/errors/index.js';
import { parse, parseStrict } from '../../src/parser/index.js';
import { render } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

/**
 * An attribute the engine does not read is a silent no-op — see
 * src/validator/unknown-attrs.ts. These pin both halves: it must fire on a name
 * the engine ignores, and it must stay silent on every legitimate one, because
 * a false warning on a working config is worse than the silence being fixed.
 */
describe('unknown attributes on closed tags', () => {
  const diag = (body: string): Diagnostic[] => [...validate(parse(body).tree).diagnostics];
  const codes = (body: string): string[] => diag(body).map((d) => d.code ?? '');
  const wrap = (env: string, block = '<line><data>x</data></line>'): string =>
    `<tdc><env count="2" seed="s">${env}</env><block>${block}</block></tdc>`;

  describe('fires where the engine would say nothing', () => {
    it('catches if= on <sequence> — the case this was written for', () => {
      const d = diag(
        wrap('<sequence name="T" if="X == 1"><gen type="text" value="a"/></sequence>'),
      );
      const found = d.find((x) => x.code === 'TDC015');
      expect(found).toBeDefined();
      expect(found?.message).toContain('"if"');
      expect(found?.message).toContain('<sequence>');
    });

    it('suggests the near miss', () => {
      const d = diag(
        `<tdc><env cuont="8" seed="s"><sequence name="A"><gen type="text" value="x"/></sequence></env>` +
          `<block><line><data>x</data></line></block></tdc>`,
      );
      const found = d.find((x) => x.code === 'TDC015');
      expect(found?.suggestion).toContain('count');
    });

    it('is an error, so the run stops rather than handing back wrong data', () => {
      const d = diag(wrap('<sequence name="A" bogus="1"><gen type="text" value="x"/></sequence>'));
      const found = d.find((x) => x.code === 'TDC015');
      expect(found?.severity).toBe('error');
    });

    it('reaches tags nested anywhere, not just the ones the walker visits', () => {
      const d = diag(
        wrap(
          '<mix name="M" percent="50,50"><case is="a" nonsense="y"><gen type="text" value="a"/></case>' +
            '<case is="b"><gen type="text" value="b"/></case></mix>',
        ),
      );
      expect(d.some((x) => x.code === 'TDC015' && x.message.includes('nonsense'))).toBe(true);
    });

    it('checks <tdc> itself, which no child walk reaches', () => {
      const d = diag(
        `<tdc verzion="2"><env count="2" seed="s"><sequence name="A"><gen type="text" value="x"/></sequence></env>` +
          `<block><line><data>x</data></line></block></tdc>`,
      );
      expect(d.some((x) => x.code === 'TDC015' && x.message.includes('verzion'))).toBe(true);
    });
  });

  describe('stays silent on everything the engine really reads', () => {
    it('accepts the full <env> surface, engine switches included', () => {
      const src =
        `<tdc><env count="2" seed="s" local="en" inject="[[%]]" mode="memory" comment="c">` +
        `<sequence name="A"><gen type="text" value="x"/></sequence></env>` +
        `<block><line><data>x</data></line></block></tdc>`;
      expect(codes(src)).not.toContain('TDC015');
    });

    it('accepts sequence, line and data attributes', () => {
      const src = wrap(
        '<sequence name="G"><gen type="text" value="a,b"/></sequence>' +
          '<sequence name="A" parent="G.a" uniq="true"><gen type="text" value="x"/></sequence>',
        '<line if="G == a" comment="note"><data name="col" type="string" if="G == a">x</data></line>',
      );
      expect(codes(src)).not.toContain('TDC015');
    });

    it('accepts mix, switch, case and map', () => {
      const src = wrap(
        '<sequence name="S"><gen type="text" value="a,b"/></sequence>' +
          '<mix name="M" percent="50,50" flag="Bad">' +
          '<case is="a" anomaly="true"><gen type="text" value="a"/></case>' +
          '<case is="b"><gen type="text" value="b"/></case></mix>' +
          '<switch name="W" on="S"><map>a:1, b:2</map></switch>',
      );
      expect(codes(src)).not.toContain('TDC015');
    });

    it('says nothing about a template generator, whose parameters its pack declares', () => {
      // Deliberately out of scope: pack-params.ts judges those with the
      // registry in hand. Guessing without it is how false errors get invented.
      const src = wrap(
        '<sequence name="A"><gen type="template" value="person.lastName" country="mx" tax_office="7712"/></sequence>',
      );
      expect(codes(src)).not.toContain('TDC015');
    });

    /**
     * The wrappers plus one type's own parameters, all at once.
     *
     * This used to pile `value=` and `order="sequential"` onto a distribution
     * as well, which made it two invalid configs in a trench coat — `value`
     * with `distribution` is TDC088, and `order` needs a list to walk, so a
     * number ignores it. The per-family rules now say so, which is the point.
     */
    it('accepts the generator surface — wrappers and distribution params', () => {
      const src = wrap(
        '<sequence name="A"><gen type="number" distribution="normal" mean="5" sd="2"' +
          ' decimals="1" missing="0.1" missing_as="N/A" anomaly="0.05"' +
          ' mask="xx" case="upper" repeat="2" separator=";"/></sequence>',
      );
      expect(codes(src)).not.toContain('TDC015');
    });

    it('accepts a list-walking generator with the wrappers it can carry', () => {
      const src = wrap(
        '<sequence name="A"><gen type="text" value="a,b,c" order="sequential" cycle="true"' +
          ' missing="0.1" mask="x" case="upper" repeat="2" separator=";"/></sequence>',
      );
      expect(codes(src)).not.toContain('TDC015');
    });
  });

  describe('generators', () => {
    it('catches a misspelled generator attribute — the 90/10 that silently became 50/50', () => {
      const d = diag(
        wrap('<sequence name="A"><gen type="text" value="ok,fail" persent="90,10"/></sequence>'),
      );
      const found = d.find((x) => x.code === 'TDC015');
      expect(found?.message).toContain('persent');
      expect(found?.suggestion).toContain('percent');
    });

    /**
     * The warning is only worth having because the data really does change.
     * Pinning the consequence, not just the message: if a future engine made
     * the typo harmless, this test would say so instead of leaving a warning
     * that no longer means anything.
     */
    it('and the misspelling really does change the data', () => {
      const run = (attr: string): { ok: number; fail: number } => {
        const src =
          `<tdc><env count="100" seed="s"><sequence name="A">` +
          `<gen type="text" value="ok,fail" ${attr}/></sequence></env>` +
          `<block><line><data>\${{A}}</data></line></block></tdc>`;
        const tally = { ok: 0, fail: 0 };
        for (const line of render(parseStrict(src)).split('\n')) {
          if (line === 'ok') tally.ok += 1;
          else if (line === 'fail') tally.fail += 1;
        }
        return tally;
      };
      expect(run('percent="90,10"')).toEqual({ ok: 90, fail: 10 });
      expect(run('persent="90,10"')).toEqual({ ok: 50, fail: 50 });
    });
  });

  describe('the remaining closed tags, one typo each', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['line', 'iff', '<line iff="never"><data>x</data></line>'],
      ['data', 'pare', '<line><data pare="q">x</data></line>'],
    ];
    for (const [tag, typo, block] of cases) {
      it(`catches ${typo}= on <${tag}>`, () => {
        const d = diag(wrap('<sequence name="A"><gen type="text" value="x"/></sequence>', block));
        expect(d.some((x) => x.code === 'TDC015' && x.message.includes(typo))).toBe(true);
      });
    }

    it('catches a typo on <mix> and on <switch>', () => {
      const d = diag(
        wrap(
          '<sequence name="S"><gen type="text" value="a,b"/></sequence>' +
            '<mix name="M" persent="50,50"><case is="a"><gen type="text" value="a"/></case>' +
            '<case is="b"><gen type="text" value="b"/></case></mix>' +
            '<switch name="W" onn="S"><map>a:1, b:2</map></switch>',
        ),
      );
      const hit = d.filter((x) => x.code === 'TDC015').map((x) => x.message);
      expect(hit.some((m) => m.includes('persent'))).toBe(true);
      expect(hit.some((m) => m.includes('onn'))).toBe(true);
    });

    /**
     * The subtle one: `percent` is a real attribute — on <mix> and on <gen> —
     * but <sequence> does not read it. A check that only knew "is this a TDC
     * attribute at all" would pass this straight through.
     */
    it('catches an attribute that is real elsewhere but ignored here', () => {
      const d = diag(
        wrap('<sequence name="A" percent="50,50"><gen type="text" value="x"/></sequence>'),
      );
      expect(d.some((x) => x.code === 'TDC015' && x.message.includes('percent'))).toBe(true);
    });

    /**
     * A misspelling is the easy half. The harder one is a REAL attribute on
     * the wrong generator: nothing looks odd, every name is in the reference,
     * and the column quietly comes out wrong.
     */
    it('catches a real attribute that belongs to another generator', () => {
      const cases: readonly (readonly [string, string])[] = [
        ['order', '<gen type="number" value="1..100" order="sequential"/>'],
        ['range', '<gen type="number" value="1..100" range="1..100"/>'],
        ['points', '<gen type="text" value="a,b" points="0,0 100,100"/>'],
        ['alphabet', '<gen type="text" value="a,b" alphabet="latin.lower"/>'],
        ['base', '<gen type="text" value="a,b" base="100"/>'],
        ['column', '<gen type="text" value="a,b" column="2"/>'],
      ];
      for (const [attr, gen] of cases) {
        const d = diag(wrap(`<sequence name="A">${gen}</sequence>`));
        expect(
          d.some((x) => x.code === 'TDC015' && x.message.includes(`"${attr}"`)),
          `${attr} should be reported on ${gen}`,
        ).toBe(true);
      }
    });

    /**
     * The second wave of the same class, found by auditing the engine against
     * the docs rather than the other way round. Each of these ran, validated
     * clean, and produced a column nobody asked for:
     *
     *     <gen type="number" from="1000" to="9999"/>   ->  3 4 4 6
     *     <gen type="text" value="a,b" length="5"/>    ->  a
     *     <gen type="number" value="1..100" format="YYYY-MM-DD"/>  ->  42
     *
     * `from`/`to` is the worst of them: they are the natural words for a
     * numeric range, they are real attributes, and the ids came out one digit
     * wide.
     */
    it('catches the date vocabulary and the number shape on the wrong type', () => {
      const cases: readonly (readonly [string, string])[] = [
        ['from', '<gen type="number" from="1000" to="9999"/>'],
        ['to', '<gen type="text" value="a,b" to="9999"/>'],
        ['format', '<gen type="number" value="1..100" format="YYYY-MM-DD"/>'],
        ['precision', '<gen type="number" value="1..100" precision="second"/>'],
        ['oldest', '<gen type="text" value="a,b" oldest="80"/>'],
        ['youngest', '<gen type="text" value="a,b" youngest="20"/>'],
        ['length', '<gen type="text" value="a,b" length="5"/>'],
        ['length', '<gen type="regex" value="[a-z]" length="8"/>'],
        ['include', '<gen type="text" value="a,b" include="5"/>'],
        ['exclude', '<gen type="date" range="2020-01-01..2020-12-31" exclude="5"/>'],
        ['decimals', '<gen type="text" value="a,b" decimals="3"/>'],
        ['distribution', '<gen type="text" value="a,b" distribution="normal"/>'],
        ['regex_max_length', '<gen type="text" value="a,b" regex_max_length="3"/>'],
        ['mode', '<gen type="text" value="a,b" mode="density"/>'],
      ];
      for (const [attr, gen] of cases) {
        const d = diag(wrap(`<sequence name="A">${gen}</sequence>`));
        expect(
          d.some((x) => x.code === 'TDC015' && x.message.includes(`"${attr}"`)),
          `${attr} should be reported on ${gen}`,
        ).toBe(true);
      }
    });

    /** And stays silent everywhere the engine really does read the name. */
    it('says nothing where the type reads it', () => {
      const fine: readonly string[] = [
        '<gen type="number" value="1..100" length="4"/>',
        '<gen type="number" value="1..100" decimals="2"/>',
        '<gen type="number" value="1..100" include="5"/>',
        '<gen type="symbol" value="[a-z]" length="4"/>',
        '<gen type="symbol" value="[a-z]" exclude="q"/>',
        '<gen type="date" from="1990-01-01" to="1999-12-31" format="YYYY"/>',
        '<gen type="date" value="birth" oldest="80" youngest="20" precision="day"/>',
        '<gen type="regex" value="[a-z]+" regex_max_length="8"/>',
        '<gen type="advanced_regex" value="[a-z]+" regex_max_length="8"/>',
        '<gen type="timeseries" base="100" trend="1" decimals="2"/>',
      ];
      for (const gen of fine) {
        const d = diag(wrap(`<sequence name="A">${gen}</sequence>`));
        expect(
          d.filter((x) => x.code === 'TDC015'),
          `nothing should be reported on ${gen}`,
        ).toStrictEqual([]);
      }
    });

    /**
     * `percent` is the one that must NOT be owned. Only `text` and `number`
     * read it as a share of their own values, but a `<gen>` inside a `<mix>`
     * carries it whatever its type, to apportion the mix.
     */
    it('leaves percent alone, because a mix gives it to any generator', () => {
      const d = diag(
        wrap(
          '<mix name="A"><gen type="regex" value="[a-z]{3}" percent="70"/>' +
            '<gen type="date" range="2020-01-01..2020-12-31" percent="30"/></mix>',
        ),
      );
      expect(d.filter((x) => x.code === 'TDC015')).toStrictEqual([]);
    });

    /**
     * `min`/`max` shape a named distribution's draw. Without `distribution=`
     * they mean nothing, and `<gen type="number" min="10" max="20"/>` — the
     * obvious thing to write — silently produced single digits.
     */
    it('catches a distribution parameter with no distribution asked for', () => {
      const d = diag(
        wrap('<sequence name="A"><gen type="number" value="1..100" min="10" max="20"/></sequence>'),
      );
      const found = d.find((x) => x.code === 'TDC015');
      expect(found?.message).toContain('"min"');
      expect(found?.hint).toContain('distribution=');
    });

    it('and says nothing once a distribution is actually named', () => {
      const src = wrap(
        '<sequence name="A"><gen type="number" distribution="normal" mean="170" sd="10"/></sequence>',
      );
      expect(codes(src)).not.toContain('TDC015');
    });

    /**
     * `person.b_day` and `date.range` are the two template paths no pack
     * declares, so `pack-params.ts` never saw them and nothing checked them.
     * `oldst` instead of `oldest` moved the ages from 20–30 to 20–80 in
     * silence — the same shape as `persent`.
     */
    it('catches a typo in a builtin template parameter', () => {
      const d = diag(
        wrap(
          '<sequence name="B"><gen type="template" value="person.b_day" oldst="30" youngest="20"/></sequence>',
        ),
      );
      const found = d.find((x) => x.code === 'TDC015');
      expect(found?.message).toContain('"oldst"');
      expect(found?.suggestion).toContain('oldest');
    });

    it('accepts the builtin templates spelled correctly, wrappers included', () => {
      for (const gen of [
        '<gen type="template" value="person.b_day" oldest="30" youngest="20" format="YYYY" case="upper"/>',
        '<gen type="template" value="date.range" range="2001.01.01 - 2001.12.31" format="L"/>',
      ]) {
        expect(codes(wrap(`<sequence name="B">${gen}</sequence>`))).not.toContain('TDC015');
      }
    });

    /**
     * A drawn curve is loaded with `src=`, exactly like a CSV. Measuring the
     * attribute in isolation said otherwise — the probe file did not exist, so
     * the load threw — and the corpus sweep caught the false error before it
     * shipped. Pinned so the next tightening cannot reintroduce it.
     */
    it('leaves the attributes each type genuinely reads alone', () => {
      for (const gen of [
        '<gen type="pattern" src="curve.svg" y_range="0..40"/>',
        '<gen type="pattern" points="0,5 100,40" y_range="0..40" interp="step" spread="0.5"/>',
        '<gen type="text" value="a,b,c" order="sequential" cycle="false"/>',
        '<gen type="file" src="x.csv" column="2" header="true" delimiter="semicolon"/>',
        '<gen type="symbol" alphabet="latin.lower" length="6"/>',
        '<gen type="timeseries" base="100" trend="2" period="7" amplitude="5" noise="0.3"/>',
        '<gen type="date" value="2020-01-01..2020-12-31" format="YYYY" precision="month"/>',
        '<gen type="number" value="100..999" first_zero="true"/>',
      ]) {
        expect(codes(wrap(`<sequence name="A">${gen}</sequence>`)), gen).not.toContain('TDC015');
      }
    });

    it('reports every typo in one config, not just the first', () => {
      const d = diag(
        `<tdc verzion="2"><env cuont="2" seed="s">` +
          `<sequence name="A" iff="x"><gen type="text" value="v" persent="1"/></sequence>` +
          `</env><block><line><data>x</data></line></block></tdc>`,
      );
      const names = d.filter((x) => x.code === 'TDC015').map((x) => x.message);
      for (const typo of ['verzion', 'cuont', 'iff', 'persent']) {
        expect(names.some((m) => m.includes(typo))).toBe(true);
      }
    });
  });
});
