import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parse, parseStrict } from '../../src/parser/index.js';
import { render, type RenderOptions } from '../../src/processor/render.js';
import { validate } from '../../src/validator/index.js';

const NOW = new Date('2026-04-23T12:00:00Z').getTime();

// The subject (Country) is a text-percent sequence — its per-row values differ
// between engines, but a <switch> is a PURE FUNCTION of the subject, so the
// invariant "Currency == lookup(Country)" must hold in every engine.
const ENGINES: readonly (readonly [string, RenderOptions])[] = [
  ['memory', { mode: 'memory' }],
  ['stream', { stream: true }],
  ['disk', { mode: 'disk' }],
];

const config = (switchBody: string, count = 25) =>
  `<tdc>
    <env count="${String(count)}" seed="sw" inject="\${{%}}">
      <sequence name="Country">
        <gen type="text" value="US,FR,DE,JP,ZZ" percent="20,20,20,20,20"/>
      </sequence>
      <switch name="Currency" on="Country">
        ${switchBody}
      </switch>
    </env>
    <block><line><data>\${{Country}}|\${{Currency}}</data></line></block>
  </tdc>`;

function pairs(dsl: string, opts: RenderOptions): [string, string][] {
  return render(parseStrict(dsl), { now: NOW, ...opts })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('|') as [string, string]);
}

describe('<switch> — deterministic lookup by subject', () => {
  it('resolves a <map> table with a <default>, in every engine', () => {
    const dsl = config(
      '<map>US:USD, FR:EUR, DE:EUR, JP:JPY</map><default><data>OTHER</data></default>',
    );
    const lookup: Record<string, string> = { US: 'USD', FR: 'EUR', DE: 'EUR', JP: 'JPY' };
    for (const [label, opts] of ENGINES) {
      const rows = pairs(dsl, opts);
      expect(rows, label).toHaveLength(25);
      for (const [country, currency] of rows) {
        expect(currency, `${label}: ${country}`).toBe(lookup[country] ?? 'OTHER');
      }
      // 20% of 25 = 5 unmatched ZZ rows, all → OTHER.
      expect(
        rows.filter(([, c]) => c === 'OTHER'),
        label,
      ).toHaveLength(5);
    }
  });

  it('supports multi-key map rows (US|CA|MX:USD)', () => {
    // Give the subject a CA value so the multi-key entry is exercised.
    const dsl = `<tdc>
      <env count="20" seed="mk" inject="\${{%}}">
        <sequence name="C"><gen type="text" value="CA,MX,FR" percent="40,40,20"/></sequence>
        <switch name="Cur" on="C"><map>CA|MX:USD, FR:EUR</map></switch>
      </env>
      <block><line><data>\${{C}}|\${{Cur}}</data></line></block>
    </tdc>`;
    for (const [label, opts] of ENGINES) {
      for (const [c, cur] of pairs(dsl, opts)) {
        expect(cur, `${label}: ${c}`).toBe(c === 'FR' ? 'EUR' : 'USD');
      }
    }
  });

  it('resolves a <case is="…"> with a generator value', () => {
    const dsl = config(
      '<map>US:USD</map>' +
        '<case is="ZZ"><data>X-</data><gen type="regex" value="[0-9]{3}"/></case>' +
        '<default><data>?</data></default>',
    );
    for (const [label, opts] of ENGINES) {
      for (const [country, currency] of pairs(dsl, opts)) {
        if (country === 'US') expect(currency, label).toBe('USD');
        else if (country === 'ZZ') expect(currency, label).toMatch(/^X-[0-9]{3}$/);
        else expect(currency, label).toBe('?');
      }
    }
  });

  it('leaves unmatched rows empty when there is no <default>', () => {
    const dsl = config('<map>US:USD, FR:EUR</map>');
    for (const [label, opts] of ENGINES) {
      for (const [country, currency] of pairs(dsl, opts)) {
        if (country === 'US') expect(currency, label).toBe('USD');
        else if (country === 'FR') expect(currency, label).toBe('EUR');
        else expect(currency, label).toBe(''); // DE / JP / ZZ → empty
      }
    }
  });

  it('picks the FIRST matching entry (map before <case>)', () => {
    const dsl = config(
      '<map>US:FROM_MAP</map><case is="US"><data>FROM_CASE</data></case><default><data>?</data></default>',
    );
    for (const [label, opts] of ENGINES) {
      for (const [country, currency] of pairs(dsl, opts)) {
        if (country === 'US') expect(currency, label).toBe('FROM_MAP');
      }
    }
  });

  it('splits a map row on the FIRST colon (colons survive in the value)', () => {
    const dsl = config('<map>US:Test : Down</map><default><data>?</data></default>');
    for (const [label, opts] of ENGINES) {
      for (const [country, currency] of pairs(dsl, opts)) {
        if (country === 'US') expect(currency, label).toBe('Test : Down');
      }
    }
  });

  it('supports multi-key <case is="A|B">', () => {
    const dsl = config(
      '<case is="US|FR"><data>WEST</data></case><default><data>?</data></default>',
    );
    for (const [label, opts] of ENGINES) {
      for (const [country, currency] of pairs(dsl, opts)) {
        expect(currency, `${label}: ${country}`).toBe(
          country === 'US' || country === 'FR' ? 'WEST' : '?',
        );
      }
    }
  });
});

describe('<switch> — validator', () => {
  function run(source: string) {
    const result = parse(source);
    expect(result.diagnostics).toEqual([]);
    return validate(result.tree);
  }
  const wrap = (switchTag: string) =>
    `<tdc><env count="4" seed="v">` +
    `<sequence name="Country"><gen type="text" value="US,FR"/></sequence>` +
    `${switchTag}</env><block><line><data>x</data></line></block></tdc>`;

  it('accepts a well-formed switch', () => {
    const r = run(
      wrap(
        '<switch name="Cur" on="Country"><map>US:USD, FR:EUR</map>' +
          '<default><data>?</data></default></switch>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors when "on" is missing (TDC133)', () => {
    const r = run(wrap('<switch name="Cur"><map>US:USD</map></switch>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC133')).toBeDefined();
  });

  it('errors when "on" refers to an unknown sequence (TDC134)', () => {
    const r = run(wrap('<switch name="Cur" on="Nope"><map>US:USD</map></switch>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC134')).toBeDefined();
  });

  it('errors when the switch has no entries (TDC135)', () => {
    const r = run(wrap('<switch name="Cur" on="Country"></switch>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC135')).toBeDefined();
  });

  it('errors when a <case> is missing "is" (TDC137)', () => {
    const r = run(wrap('<switch name="Cur" on="Country"><case><data>x</data></case></switch>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC137')).toBeDefined();
  });

  it('warns on a malformed <map> row (TDC136)', () => {
    const r = run(wrap('<switch name="Cur" on="Country"><map>US:USD, OOPS</map></switch>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC136')).toBeDefined();
  });

  it('errors on `if` on a switch <case> (TDC128)', () => {
    const r = run(
      wrap(
        '<switch name="Cur" on="Country"><case is="US" if="_first"><data>x</data></case></switch>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC128')).toBeDefined();
  });

  it('rejects a <switch> inside a <line> (TDC132)', () => {
    const src =
      '<tdc><env count="2" seed="v"><sequence name="C"><gen type="text" value="a,b"/></sequence></env>' +
      '<block><line><switch name="X" on="C"><map>a:1</map></switch></line></block></tdc>';
    const r = run(src);
    expect(r.diagnostics.find((d) => d.code === 'TDC132')).toBeDefined();
  });
});
