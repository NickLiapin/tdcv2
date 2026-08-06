import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { hasErrors } from '../../src/errors/diagnostic.js';
import { parse } from '../../src/parser/index.js';
import { validate } from '../../src/validator/validate.js';

function run(source: string) {
  const result = parse(source);
  expect(result.diagnostics).toEqual([]); // ensure parser is happy
  return validate(result.tree);
}

describe('validator — structural checks', () => {
  it('flags a document without <tdc>', () => {
    const r = run('<!-- nothing here -->');
    expect(hasErrors(r.diagnostics)).toBe(true);
    expect(r.diagnostics[0]?.message).toMatch(/has no <tdc>/);
    expect(r.diagnostics[0]?.code).toBe('TDC001');
  });

  it('flags a <tdc> with no <block>', () => {
    const r = run('<tdc><env count="3"></env></tdc>');
    const err = r.diagnostics.find((d) => d.code === 'TDC002');
    expect(err).toBeDefined();
    expect(err?.severity).toBe('error');
  });

  it('accepts a minimal valid document', () => {
    const r = run('<tdc><block><line><data>hi</data></line></block></tdc>');
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts compatible root document versions', () => {
    const r = run('<tdc version="0.01"><block><line><data>hi</data></line></block></tdc>');
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts the short root version attribute alias', () => {
    const r = run('<tdc v="0.1"><block><line><data>hi</data></line></block></tdc>');
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on invalid root regex_max_length', () => {
    const r = run('<tdc regex_max_length="bad"><block><line><data>hi</data></line></block></tdc>');
    expect(r.diagnostics.find((d) => d.code === 'TDC096')).toBeDefined();
  });

  it('errors when the document version is newer than this runtime', () => {
    const r = run('<tdc version="0.2"><block><line><data>hi</data></line></block></tdc>');
    const err = r.diagnostics.find((d) => d.code === 'TDC005');
    expect(err?.severity).toBe('error');
    expect(err?.message).toMatch(/newer than this runtime/);
  });

  it('errors on malformed document version values', () => {
    const r = run('<tdc version="0.1-beta"><block><line><data>hi</data></line></block></tdc>');
    const err = r.diagnostics.find((d) => d.code === 'TDC004');
    expect(err?.severity).toBe('error');
  });

  it('errors when both root version attributes are present', () => {
    const r = run('<tdc version="0.1" v="0.1"><block><line><data>hi</data></line></block></tdc>');
    const err = r.diagnostics.find((d) => d.code === 'TDC003');
    expect(err?.severity).toBe('error');
  });
});

describe('validator — <env> checks', () => {
  it('flags a non-numeric count', () => {
    const r = run('<tdc><env count="lots"></env><block><line><data>x</data></line></block></tdc>');
    expect(r.diagnostics.find((d) => d.code === 'TDC020')).toBeDefined();
  });

  it('flags an inject without a placeholder', () => {
    const r = run(
      '<tdc><env inject="no_placeholder"></env><block><line><data>x</data></line></block></tdc>',
    );
    const err = r.diagnostics.find((d) => d.code === 'TDC021');
    expect(err).toBeDefined();
    expect(err?.message).toMatch(/no "%"/);
  });

  it('errors on unknown child of <env> — the child would be silently dropped', () => {
    const r = run(
      '<tdc><env><fooinstead></fooinstead></env><block><line><data>x</data></line></block></tdc>',
    );
    const w = r.diagnostics.find((d) => d.code === 'TDC010' && d.severity === 'error');
    expect(w).toBeDefined();
  });
});

describe('validator — <sequence> checks', () => {
  const wrap = (seq: string) =>
    `<tdc><env>${seq}</env><block><line><data>x</data></line></block></tdc>`;

  it('flags a <sequence> missing name', () => {
    const r = run(wrap('<sequence><gen type="text" value="a,b"/></sequence>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC030')).toBeDefined();
  });

  it('errors on leading-underscore name — it would collide with a builtin', () => {
    const r = run(wrap('<sequence name="_foo"><gen type="text" value="a,b"/></sequence>'));
    const w = r.diagnostics.find((d) => d.code === 'TDC031');
    expect(w?.severity).toBe('error');
  });

  it('errors on colliding builtin name', () => {
    const r = run(wrap('<sequence name="_count"><gen type="text" value="a,b"/></sequence>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC033')).toBeDefined();
  });

  it('errors on duplicate sequence names', () => {
    const r = run(
      wrap(
        '<sequence name="X"><gen type="text" value="a,b"/></sequence>' +
          '<sequence name="X"><gen type="text" value="c,d"/></sequence>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC032')).toBeDefined();
  });

  it('errors on missing <gen>', () => {
    const r = run(wrap('<sequence name="X"></sequence>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC036')).toBeDefined();
  });

  it('composed: a named <gen> beside an unnamed one is a field, not an error', () => {
    // The unnamed gen builds the sequence's own value; the named one is a field
    // beside it. This used to be TDC110 — a body nobody could write — and the
    // rule now gives it the reading people expect.
    const r = run(
      wrap(
        '<sequence name="X">' +
          '<gen name="A" type="text" value="a,b"/>' +
          '<gen type="text" value="c,d"/>' +
          '</sequence>',
      ),
    );
    expect(r.diagnostics).toEqual([]);
  });

  it('composed: <data> between gens is a literal, not something dropped', () => {
    const r = run(
      wrap(
        '<sequence name="X">' +
          '<gen type="text" value="a,b"/>' +
          '<data> </data>' +
          '<gen type="text" value="c,d"/>' +
          '</sequence>',
      ),
    );
    expect(r.diagnostics).toEqual([]);
  });

  it('compound: errors on duplicate field names', () => {
    const r = run(
      wrap(
        '<sequence name="X">' +
          '<gen name="A" type="text" value="a,b"/>' +
          '<gen name="A" type="text" value="c,d"/>' +
          '</sequence>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC111')).toBeDefined();
  });

  it('compound: accepts two named <gen> children as a valid compound', () => {
    const r = run(
      wrap(
        '<sequence name="Person">' +
          '<gen name="FirstName" type="text" value="Alice,Bob"/>' +
          '<gen name="Age" type="number" value="18..30"/>' +
          '</sequence>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts a standalone <mix> as a scalar sequence source', () => {
    const r = run(
      wrap(
        '<mix name="Code" percent="50,50">' +
          '<case><data>A</data><gen type="increment" value="1"/></case>' +
          '<case><data>B</data></case>' +
          '</mix>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on forward parent reference', () => {
    const r = run(
      wrap(
        '<sequence name="Child" parent="Parent.Male"><gen type="text" value="a,b"/></sequence>' +
          '<sequence name="Parent"><gen type="text" value="Male,Female"/></sequence>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC035')).toBeDefined();
  });

  it('accepts parent reference to a previously declared sequence', () => {
    const r = run(
      wrap(
        '<sequence name="Parent"><gen type="text" value="Male,Female"/></sequence>' +
          '<sequence name="Child" parent="Parent.Male"><gen type="text" value="a,b"/></sequence>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts parent reference to a builtin', () => {
    const r = run(
      wrap('<sequence name="X" parent="_count"><gen type="text" value="a,b"/></sequence>'),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });
});

describe('validator — <gen> checks', () => {
  const wrap = (gen: string) =>
    `<tdc><env><sequence name="S">${gen}</sequence></env><block><line><data>x</data></line></block></tdc>`;
  const writeTempDataFile = (name: string, content: string): string => {
    const dir = mkdtempSync(join(tmpdir(), 'tdc-validator-file-'));
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  it('errors on missing type', () => {
    const r = run(wrap('<gen value="a,b"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC040')).toBeDefined();
  });

  it('errors on unknown type with suggestion', () => {
    const r = run(wrap('<gen type="txt" value="a,b"/>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC041');
    expect(err).toBeDefined();
    expect(err?.suggestion).toMatch(/"text"/);
  });

  it('errors on text without value', () => {
    const r = run(wrap('<gen type="text"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC050')).toBeDefined();
  });

  it('accepts file generator CSV columns that exist', () => {
    const path = writeTempDataFile('users.csv', 'first,email\nAlice,a@example.test\n');
    const r = run(wrap(`<gen type="file" src="${path}" column="email"/>`));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts a tab-separated (TSV) file column via delimiter="tab"', () => {
    // Regression: a real tab delimiter must survive option normalization end
    // to end, otherwise the header row is treated as a single cell and the
    // column lookup wrongly fails with TDC062.
    const path = writeTempDataFile(
      'users.tsv',
      'first_name\tlast_name\temail\nAnna\tOrlova\ta@example.test\n',
    );
    const r = run(wrap(`<gen type="file" src="${path}" column="email" delimiter="tab"/>`));
    expect(hasErrors(r.diagnostics)).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'TDC062')).toBeUndefined();
  });

  it('errors on file generator CSV columns that do not exist', () => {
    const path = writeTempDataFile('users.csv', 'first,email\nAlice,a@example.test\n');
    const r = run(wrap(`<gen type="file" src="${path}" column="phone"/>`));
    const err = r.diagnostics.find((d) => d.code === 'TDC062');
    expect(err).toBeDefined();
    expect(err?.message).toContain('was not found');
  });

  it('errors on row-linked file generators without a CSV column', () => {
    const path = writeTempDataFile('users.csv', 'first,email\nAlice,a@example.test\n');
    const r = run(wrap(`<gen type="file" src="${path}" row="person"/>`));
    const err = r.diagnostics.find((d) => d.code === 'TDC064');
    expect(err).toBeDefined();
    expect(err?.message).toContain('column');
  });

  it('rejects a <gen> inside a <line> — the block is formatting only (TDC131)', () => {
    const r = run(
      `<tdc><env></env><block><line><gen type="file" src="x.csv" column="email" row="person"/></line></block></tdc>`,
    );
    const err = r.diagnostics.find((d) => d.code === 'TDC131');
    expect(err).toBeDefined();
    expect(err?.message).toContain('for formatting only');
  });

  it('errors on percent entries that are not numbers', () => {
    const r = run(wrap('<gen type="text" value="a,b" percent="50,nope"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC052')).toBeDefined();
  });

  it('errors on mismatched percent length', () => {
    const r = run(wrap('<gen type="text" value="a,b" percent="50,30,20"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC051')).toBeDefined();
  });

  it('errors on percent sum != 100', () => {
    const r = run(wrap('<gen type="text" value="a,b" percent="30,40"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC053')).toBeDefined();
  });

  it('accepts short percent masks', () => {
    const r = run(wrap('<gen type="text" value="a,b,c,d" percent=",10,10"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on unknown template path with suggestion', () => {
    const r = run(wrap('<gen type="template" value="person.male.first_name"/>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC071');
    expect(err).toBeDefined();
    expect(err?.suggestion).toMatch(/person\.male\.firstName/);
  });

  it('accepts known template paths', () => {
    const r = run(wrap('<gen type="template" value="person.gender"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on date.range without range attr', () => {
    const r = run(wrap('<gen type="template" value="date.range"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC072')).toBeDefined();
  });

  it('errors on malformed date.range', () => {
    const r = run(wrap('<gen type="template" value="date.range" range="2020-01-01"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC073')).toBeDefined();
  });

  it('errors on calendar-invalid date.range endpoints', () => {
    const r = run(
      wrap('<gen type="template" value="date.range" range="2024.02.30 - 2024.03.01"/>'),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC073')).toBeDefined();
  });

  it('accepts a valid date.range template', () => {
    const r = run(
      wrap('<gen type="template" value="date.range" range="2020.01.01 - 2020.12.31"/>'),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts number without value or length as one random digit', () => {
    const r = run(wrap('<gen type="number"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on bad number range', () => {
    const r = run(wrap('<gen type="number" value="abc"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC081')).toBeDefined();
  });

  it('errors on pre-release hyphen number ranges', () => {
    const r = run(wrap('<gen type="number" value="10-20"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC081')).toBeDefined();
  });

  it('accepts number bit shorthand', () => {
    const r = run(wrap('<gen type="number" value="bit"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts number ranges with encoded leading-zero width', () => {
    const r = run(wrap('<gen type="number" value="0000..9999"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts unambiguous dot-dot number ranges with negative bounds', () => {
    const r = run(wrap('<gen type="number" value="-500..-200"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts number digit-string mode with length but without value', () => {
    const r = run(wrap('<gen type="number" length="10" first_zero="true"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts number multi-range syntax', () => {
    const r = run(wrap('<gen type="number" value="[0..100],[345..678],[1934..2026]"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on malformed number multi-range syntax', () => {
    const r = run(wrap('<gen type="number" value="[0..100],oops"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC081')).toBeDefined();
  });

  it('errors on bad first_zero', () => {
    const r = run(wrap('<gen type="number" value="1..9" first_zero="maybe"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC082')).toBeDefined();
  });

  it('errors on invalid number length', () => {
    const r = run(wrap('<gen type="number" value="1..9" length="0"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC083')).toBeDefined();
  });

  it('accepts number length ranges and percent groups', () => {
    const r = run(wrap('<gen type="number" length="2,10-12" percent="85,15"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors when number percent does not match length groups', () => {
    const r = run(wrap('<gen type="number" length="2,10-12" percent="85,10,5"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC084')).toBeDefined();
  });

  it('accepts number length and first_zero when valid', () => {
    const r = run(wrap('<gen type="number" value="1..9" length="3" first_zero="false"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts finite regex generators', () => {
    const r = run(wrap('<gen type="regex" value="([0-9]{3})-[A-Z]{2}-\\1"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on regex without value', () => {
    const r = run(wrap('<gen type="regex"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC095')).toBeDefined();
  });

  it('errors on unbounded regex generators', () => {
    const r = run(wrap('<gen type="regex" value="[a-z]+"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC097')).toBeDefined();
  });

  it('errors when regex exceeds the default max length', () => {
    const r = run(wrap('<gen type="regex" value="[a-z]{33}"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC097')).toBeDefined();
  });

  it('accepts local regex_max_length overrides', () => {
    const r = run(wrap('<gen type="regex" value="[a-z]{33}" regex_max_length="33"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts regex named alphabet escapes', () => {
    const r = run(wrap('<gen type="regex" value="\\a{kana.hiragana}{8}"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on unknown regex named alphabets', () => {
    const r = run(wrap('<gen type="regex" value="\\a{kana.hiraganaa}{8}"/>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC097');
    expect(err).toBeDefined();
    expect(err?.message).toContain('unknown alphabet');
  });

  it('accepts global regex_max_length on <tdc>', () => {
    const r = run(
      '<tdc regex_max_length="40"><env><sequence name="S">' +
        '<gen type="regex" value="[a-z]{33}"/>' +
        '</sequence></env><block><line><data>x</data></line></block></tdc>',
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts advanced_regex weighted choices inside sequences', () => {
    const r = run(wrap('<gen type="advanced_regex" value="(?%{70:RU;30:US})-[0-9]{2}"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts symbol generators with known Unicode alphabets', () => {
    const r = run(wrap('<gen type="symbol" alphabet="cyrillic.ru.letters" length="12"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts date generators', () => {
    const r = run(wrap('<gen type="date" value="2020-01-01..2025-12-31" format="YYYY-MM-DD"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on invalid date generator ranges and attrs', () => {
    const badDate = run(wrap('<gen type="date" value="2023-02-29"/>'));
    expect(badDate.diagnostics.find((d) => d.code === 'TDC151')).toBeDefined();

    const badRange = run(wrap('<gen type="date" from="2020-01-01"/>'));
    expect(badRange.diagnostics.find((d) => d.code === 'TDC150')).toBeDefined();

    const badLocale = run(wrap('<gen type="date" value="today" local="zz"/>'));
    expect(badLocale.diagnostics.find((d) => d.code === 'TDC153')).toBeDefined();

    const badPrecision = run(wrap('<gen type="date" value="today" precision="week"/>'));
    expect(badPrecision.diagnostics.find((d) => d.code === 'TDC154')).toBeDefined();
  });

  it('errors on symbol generators without an alphabet', () => {
    const r = run(wrap('<gen type="symbol" length="4"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC098')).toBeDefined();
  });

  it('errors on unknown symbol alphabets with suggestions', () => {
    const r = run(wrap('<gen type="symbol" alphabet="kana.hiraganaa" length="4"/>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC099');
    expect(err).toBeDefined();
    expect(err?.suggestion).toContain('kana.hiragana');
  });

  it('errors on invalid symbol length', () => {
    const r = run(wrap('<gen type="symbol" alphabet="roman.upper" length="0"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC099')).toBeDefined();
  });

  it('errors on advanced_regex without value', () => {
    const r = run(wrap('<gen type="advanced_regex"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC128')).toBeDefined();
  });

  it('errors on invalid advanced_regex patterns', () => {
    const r = run(wrap('<gen type="advanced_regex" value="(?%{70:A;20:B})"/>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC130');
    expect(err).toBeDefined();
    expect(err?.message).toContain('invalid advanced_regex generator pattern');
  });

  it('accepts advanced_regex local regex_max_length overrides', () => {
    const r = run(
      wrap(
        '<gen type="advanced_regex" value="(?%{50:A;50:B})[A-Z0-9]{40}" regex_max_length="41"/>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors on invalid advanced_regex local regex_max_length', () => {
    const r = run(
      wrap('<gen type="advanced_regex" value="(?%{50:A;50:B})" regex_max_length="nope"/>'),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC096')).toBeDefined();
  });

  it('errors on invalid regex_max_length', () => {
    const r = run(wrap('<gen type="regex" value="[a-z]{2}" regex_max_length="nope"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC096')).toBeDefined();
  });

  it('errors on unsupported regex syntax with a regex diagnostic', () => {
    const badPatterns = ['(?=a)a', '\\1([0-9])', '[z-a]', '[abc', 'A{2,1}', '\\p{L}'];
    for (const pattern of badPatterns) {
      const r = run(wrap(`<gen type="regex" value="${pattern}"/>`));
      const err = r.diagnostics.find((d) => d.code === 'TDC097');
      expect(err, pattern).toBeDefined();
      expect(err?.message).toContain('invalid regex generator pattern');
      expect(err?.hint).toContain('Use finite regex');
    }
  });

  it('errors on missing file src', () => {
    const r = run(wrap('<gen type="file"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC060')).toBeDefined();
  });

  it('errors on non-existent file src', () => {
    const r = run(wrap('<gen type="file" src="/nonexistent/path/to/file.txt"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC061')).toBeDefined();
  });

  it('errors on non-numeric counter step', () => {
    const r = run(wrap('<gen type="increment" value="1" step="huge"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC090')).toBeDefined();
  });

  it('errors on non-numeric counter value', () => {
    const r = run(wrap('<gen type="decrement" value="bad"/>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC090')).toBeDefined();
  });

  it('accepts numeric counter value and step', () => {
    const r = run(wrap('<gen type="increment" value="1" step="2"/>'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });
});

describe('validator — if-expression checks', () => {
  const wrap = (lineAttr: string) =>
    `<tdc><block><line ${lineAttr}><data>x</data></line></block></tdc>`;

  it('errors on a malformed expression', () => {
    const r = run(wrap('if="x &&"'));
    expect(r.diagnostics.find((d) => d.code === 'TDC100')).toBeDefined();
  });

  it('accepts % — the row-parity operator every author reaches for first', () => {
    const r = run(wrap('if="_count % 2 == 0"'));
    expect(r.diagnostics.find((d) => d.code === 'TDC101')).toBeUndefined();
  });

  it('errors on an operator that is still unsupported (bitwise)', () => {
    const r = run(wrap('if="x & 1 == 0"'));
    expect(r.diagnostics.find((d) => d.code === 'TDC101')).toBeDefined();
  });

  it('errors on unsupported expression constructs', () => {
    // Two expressions with nothing joining them — jsep calls it a Compound, and
    // there is no one value for the condition to be.
    const r = run(wrap('if="Gender Male"'));
    expect(r.diagnostics.find((d) => d.code === 'TDC103')).toBeDefined();
  });

  it('accepts the ternary and a list on the right of in', () => {
    const r = run(wrap('if="(x > 1 ? x : 0) in [1, 2, 3]"'));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('refuses a list standing on its own', () => {
    const r = run(wrap('if="[1, 2]"'));
    expect(r.diagnostics.find((d) => d.code === 'TDC259')).toBeDefined();
  });

  it('names an unknown function, and suggests the near one', () => {
    const r = run(wrap('if="abz(x) > 1"'));
    const d = r.diagnostics.find((x) => x.code === 'TDC257');
    expect(d).toBeDefined();
    expect(d?.suggestion).toMatch(/abs/);
  });

  it('answers a not-yet-implemented name with the reason, not a bogus suggestion', () => {
    const r = run(wrap('if="atanh(x) > 1"'));
    const d = r.diagnostics.find((x) => x.code === 'TDC257');
    expect(d?.message).toMatch(/not available yet/);
    expect(d?.suggestion).toBeUndefined();
  });

  it('counts the arguments', () => {
    const r = run(wrap('if="abs(x, 2) > 1"'));
    expect(r.diagnostics.find((x) => x.code === 'TDC258')).toBeDefined();
  });

  it('accepts the functions it ships', () => {
    const r = run(wrap('if="max(abs(x), 3) % 2 == 0"'));
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('accepts well-formed expressions', () => {
    const r = run(wrap('if="_count > 5 && _first"'));
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('validates if expressions on <data> and on a conditional sequence <gen>', () => {
    const r = run(
      '<tdc><env><sequence name="G">' +
        '<gen type="template" value="person.gender" if="_count >= 1"/>' +
        '</sequence></env>' +
        '<block><line><data if="_count == 1">x</data></line></block></tdc>',
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('accepts numeric and counter gen types in a sequence', () => {
    const r = run(
      '<tdc><env><sequence name="s">' +
        '<gen name="a" type="number" value="1..9"/>' +
        '<gen name="b" type="regex" value="[A-Z]{2}[0-9]{2}"/>' +
        '<gen name="c" type="advanced_regex" value="[A-Z]{2}[0-9]{2}"/>' +
        '<gen name="d" type="symbol" alphabet="roman.upper" length="4"/>' +
        '<gen name="e" type="date" value="today" format="YYYY-MM-DD"/>' +
        '<gen name="f" type="increment" value="1" step="2"/>' +
        '<gen name="g" type="decrement" value="9" step="2"/>' +
        '</sequence></env>' +
        '<block><line><data>_</data></line></block></tdc>',
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
    expect(r.diagnostics.find((d) => d.code === 'TDC042')).toBeUndefined();
  });
});

describe('validator — <mix>/<case> checks', () => {
  const wrap = (body: string) =>
    `<tdc><env count="4" seed="mix-check">${body}</env>` +
    `<block><line><data>x</data></line></block></tdc>`;

  it('accepts a valid mix with a nested mix', () => {
    const r = run(
      wrap(
        '<mix name="M" percent=",25">' +
          '<case><data>A</data></case>' +
          '<case><mix><case><data>B</data></case></mix></case>' +
          '</mix>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('errors when a mix has no cases', () => {
    const r = run(wrap('<mix name="M"></mix>'));
    const err = r.diagnostics.find((d) => d.code === 'TDC120');
    expect(err?.severity).toBe('error');
  });

  it('errors on mix percent masks longer than case count', () => {
    const r = run(
      wrap(
        '<mix name="M" percent="50,30,20">' +
          '<case><data>A</data></case>' +
          '<case><data>B</data></case>' +
          '</mix>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC121')).toBeDefined();
  });

  it('errors on non-numeric mix percent entries', () => {
    const r = run(
      wrap(
        '<mix name="M" percent="50,nope">' +
          '<case><data>A</data></case>' +
          '<case><data>B</data></case>' +
          '</mix>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC122')).toBeDefined();
  });

  it('errors on mix percent sums over 100', () => {
    const r = run(
      wrap(
        '<mix name="M" percent="80,40">' +
          '<case><data>A</data></case>' +
          '<case><data>B</data></case>' +
          '</mix>',
      ),
    );
    expect(r.diagnostics.find((d) => d.code === 'TDC123')).toBeDefined();
  });

  it('validates data if and gens inside cases', () => {
    const r = run(
      wrap(
        '<mix name="M"><case>' +
          '<data if="_first">A</data>' +
          '<gen type="number" value="1..9"/>' +
          '<gen type="regex" value="[A-Z]{2}[0-9]{2}"/>' +
          '</case></mix>',
      ),
    );
    expect(hasErrors(r.diagnostics)).toBe(false);
  });

  it('validates regex errors inside cases', () => {
    const r = run(wrap('<mix name="M"><case><gen type="regex" value="[a-z]+"/></case></mix>'));
    expect(r.diagnostics.find((d) => d.code === 'TDC097')).toBeDefined();
  });
});

describe('validator — position accuracy', () => {
  it('points at the attribute value, not the tag', () => {
    const src = [
      '<tdc>',
      '    <env count="5">',
      '        <sequence name="X">',
      '            <gen type="template" value="person.bad.path"/>',
      '        </sequence>',
      '    </env>',
      '    <block><line><data>x</data></line></block>',
      '</tdc>',
    ].join('\n');
    const r = run(src);
    const err = r.diagnostics.find((d) => d.code === 'TDC071');
    expect(err).toBeDefined();
    expect(err?.line).toBe(4); // 1-based
    // The value "person.bad.path" starts right after the opening quote;
    // column accounts for whitespace and the `value="` prefix.
    expect(err?.column).toBeGreaterThan(0);
  });
});
