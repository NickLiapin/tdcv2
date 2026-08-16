import { describe, expect, it } from 'vitest';

import { bundledPacks } from '../../src/data-pack/load.js';
import { TDC } from '../../src/lib/tdc.js';

/**
 * A pack generator that DRAWS from a weighted list is a whole-column quota.
 *
 * A weighted list is laid out to an exact Hamilton quota over the run, so each
 * value takes its measured share of the rows. That is a plan for a COLUMN.
 * Asked for a single row, the plan is computed over a column of one and that
 * row goes to the largest share — every time, for every seed.
 *
 * `percent=` written INSIDE a pack body was already marked whole-column and
 * routed accordingly. A weighted list the body merely draws FROM was not: the
 * body says `<gen type="template" value="hu.person.lastName"/>` and nothing in
 * that line says the list on the other end carries weights. So the pack ran a
 * row at a time and returned rank 1 for ever.
 *
 * Twelve shipped full-name packs across six locales were in that state —
 * Czech, Dutch, Hungarian, Serbian, Persian, Hebrew — plus one Chinese street
 * name. German, Spanish and Polish were fine, and the only difference was that
 * their name lists carry no weights, which is why nothing looked wrong.
 */

const LOCALE_FULL_NAMES: [string, string][] = [
  ['hu', 'hu.person.male.fullName'],
  ['cs', 'cs.person.male.fullName'],
  ['nl', 'nl.person.male.fullName'],
  ['sr', 'sr.person.male.fullName'],
  ['fa', 'fa.person.male.fullName'],
  ['he', 'he.person.female.fullName'],
];

function draw(locale: string, address: string, count: number, seed = 'weighted-in-pack'): string[] {
  const config =
    `<tdc><env count="${String(count)}" seed="${seed}" local="${locale}">` +
    `<sequence name="P"><gen type="template" value="${address}"/></sequence>` +
    '</env><block><line><data>${{P}}</data></line></block></tdc>';
  return new TDC({ configString: config }).toString().trim().split('\n');
}

describe('a pack generator drawing from a weighted list', () => {
  it.each(LOCALE_FULL_NAMES)('varies across rows in %s', (locale, address) => {
    const rows = draw(locale, address, 40);
    expect(rows).toHaveLength(40);
    expect(
      new Set(rows).size,
      `${address} returned "${rows[0] ?? ''}" on every row — the whole-column quota ran over one row`,
    ).toBeGreaterThan(5);
  });

  /**
   * The load-time flag itself. The engines already know what to do with
   * `needsWholeColumn`; the bug was that nothing ever set it here, so this is
   * the assertion that actually pins the fix.
   */
  it.each(LOCALE_FULL_NAMES)('is marked whole-column at load time in %s', (_locale, address) => {
    const entry = bundledPacks().get(address);
    expect(entry?.generator, `${address} is not a pack generator`).toBeDefined();
    expect(entry?.needsWholeColumn, `${address} draws a weighted list and is not flagged`).toBe(
      true,
    );
  });

  /**
   * The counter-case, so the flag is not simply true for everything. German
   * name lists carry no weights, the generator body is otherwise identical to
   * the Hungarian one, and it must stay per-row buildable — being marked would
   * cost it the streaming engines for nothing.
   */
  it('leaves a generator over unweighted lists alone', () => {
    for (const address of ['de.person.male.fullName', 'pl.person.male.fullName']) {
      const entry = bundledPacks().get(address);
      expect(entry?.generator, `${address} is not a pack generator`).toBeDefined();
      expect(entry?.needsWholeColumn ?? false, `${address} was flagged and draws no weights`).toBe(
        false,
      );
      expect(new Set(draw(address.slice(0, 2), address, 40)).size).toBeGreaterThan(5);
    }
  });

  /**
   * And the ORDER the weights describe is honoured, not merely varied — a fix
   * that shuffled the values would pass the test above and still be wrong.
   *
   * Deliberately not a share: `hu/person/lastName.txt` says in its own header
   * that its weights are a rank-decay curve rather than measured bearer counts,
   * so the top five come out near 2%, not the ~11% real Hungarian data would
   * give. Asserting a share here would be testing the curve, and would go red
   * the day someone replaces it with real counts. What the engine owes the file
   * is that rank 1 beats rank 300, whatever the spread.
   */
  it('honours the ranking the weights describe', () => {
    const rows = draw('hu', 'hu.person.lastName', 2000, 'eloszlas');
    const count = (name: string): number => rows.filter((v) => v === name).length;
    const head = ['Nagy', 'Kovács', 'Tóth', 'Szabó'].reduce((s, n) => s + count(n), 0);
    const tail = ['Szűcs', 'Papp'].reduce((s, n) => s + count(n), 0);
    expect(head, `head=${String(head)} tail=${String(tail)}`).toBeGreaterThan(tail);
  });

  /**
   * A streaming engine cannot apportion a quota row by row, so a config that
   * FORCES one must be told, not quietly handed a repeated value. This is the
   * backstop the flag switches on.
   */
  it('refuses a forced streaming engine rather than repeating one name', () => {
    const config =
      '<tdc><env count="40" seed="stream" local="hu" mode="disk">' +
      '<sequence name="P"><gen type="template" value="hu.person.male.fullName"/></sequence>' +
      '</env><block><line><data>${{P}}</data></line></block></tdc>';
    let rows: string[] = [];
    let refused = '';
    try {
      rows = new TDC({ configString: config }).toString().trim().split('\n');
    } catch (error) {
      refused = String(error);
    }
    // Either answer is correct — what must NOT happen is forty identical rows.
    if (refused === '') expect(new Set(rows).size).toBeGreaterThan(5);
    else expect(refused).toMatch(/column|quota|memory/i);
  });
});
