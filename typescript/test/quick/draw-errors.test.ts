/**
 * What the quick API says when a draw fails.
 *
 * Every case here is a message the layer produces INSTEAD of the engine's, so
 * each one is a chance to replace a true sentence with a false one. The four
 * ports carry the same tests; the reference did not, which is how four separate
 * ways of lying to the caller survived here.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { QuickDraw } from '../../src/quick/draw.js';

/** The message a draw fails with, or a failure if it does not fail at all. */
function messageOf(draw: QuickDraw, attrs: Record<string, string>): string {
  try {
    draw.draw({ type: 'template', attrs }, 1);
  } catch (error) {
    return (error as Error).message;
  }
  expect.unreachable('the draw should have failed');
}

const here = process.cwd();
afterEach(() => {
  process.chdir(here);
});

/** A project directory, entered, with a `tdcv2.config.json` of the given text. */
function enterProject(config: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tdcdraw-'));
  writeFileSync(join(dir, 'tdcv2.config.json'), config);
  process.chdir(dir);
  return dir;
}

describe('an address whose leading segment names no pack', () => {
  it('reports the pack, never another language', () => {
    // The head is in no table of locale codes, which used to mean "not a pack
    // name, so it must be a typo" — and the typo path proposed
    // `ar.person.lastName`: a different LANGUAGE, offered to someone who named
    // one explicitly. That is the single answer this message exists to avoid.
    const message = messageOf(new QuickDraw('a', 'en'), { value: 'zz.person.lastName' });
    expect(message).toContain('the "zz" pack is not installed');
    expect(message).toContain('tdcv2 pack add zz');
    expect(message).not.toContain('Did you mean');
  });

  it('still reads a tail typo as a typo when the pack is there', () => {
    // The other side of the fork: `usa` resolves, so the fault is in the tail.
    const message = messageOf(new QuickDraw('a', 'en'), { value: 'usa.docs.sn' });
    expect(message).toContain('Did you mean "usa.docs.ssn"');
  });
});

describe('a failure the address cannot explain', () => {
  it('arrives as what it is', () => {
    // `common.internet.email` resolves, so "unknown address" cannot be true of
    // it. Rewriting every template failure produced the sentence that names
    // this test: `unknown address "common.internet.email". Did you mean
    // "common.internet.email"?` — nonsense, and it buried the one line saying
    // which attribute was refused.
    const message = messageOf(new QuickDraw('p', 'en'), {
      value: 'common.internet.email',
      nosuch: 'x',
    });
    expect(message).toContain('not a parameter');
    expect(message).not.toContain('unknown address');
  });
});

describe('a project config that cannot be read', () => {
  it('does not replace the message being formatted', () => {
    // The address lookup reads `tdcv2.config.json` WHILE a diagnostic is being
    // written. A second failure thrown from inside that handler is not the
    // caller's problem — they typed an address, and what they get back has to
    // be about the address.
    enterProject('{ this is not json');
    const message = messageOf(new QuickDraw('c', 'en'), { value: 'usa.docs.sn' });
    expect(message).toContain('unknown address "usa.docs.sn"');
    expect(message).not.toContain('not valid JSON');
  });
});

describe('the project’s own packs', () => {
  it('are offered as a near miss, not only the bundled ones', () => {
    // One list, or the two halves of one sentence disagree about what exists:
    // "did you mean" scanned bundled packs while "that pack is not installed"
    // scanned bundled plus the project's, so an address installed HERE could
    // never be proposed as the near miss it is.
    const dir = enterProject(JSON.stringify({ dataPaths: ['./packs'] }));
    mkdirSync(join(dir, 'packs', 'en', 'mythings'), { recursive: true });
    writeFileSync(join(dir, 'packs', 'en', 'mythings', 'widget.txt'), 'cog\nsprocket\n');

    const message = messageOf(new QuickDraw('d', 'en'), { value: 'en.mythings.widgt' });
    expect(message).toContain('Did you mean "en.mythings.widget"');
  });
});
