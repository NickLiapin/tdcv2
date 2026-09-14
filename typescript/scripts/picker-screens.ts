/**
 * Driving the pack picker with no terminal at all.
 *
 * The picker is the least-tested file in the project — 303 of its 354 branches were reached by
 * nothing — and the reason is that it wants a terminal: raw mode, a keypress stream, a width and
 * a height. None of that is available to a test runner, so none of it was ever run.
 *
 * It does not actually want a terminal. It wants `process.stdin`, `process.stdout` and four
 * environment variables, and all six can be handed to it. This module puts a fake terminal in
 * their place, replays a script of keys through the real `runPicker`, and collects the screen it
 * drew after each one. Nothing in the picker is modified or stubbed: the bytes go in the way a
 * terminal sends them, through readline's own decoding, and the lines come out of the same
 * `process.stdout.write` a user's terminal receives.
 *
 * Two details earned their comments the hard way:
 *
 *   - `UNICODE` and `COLOUR` are module constants, settled once when the module is first
 *     imported. A run that wants a different terminal therefore needs a different MODULE, which
 *     is what the `?run=` on the import specifier buys — Node keys its module cache on the whole
 *     specifier, query included.
 *   - A lone ESC does not arrive until readline's escape timeout expires, half a second later,
 *     because until then it could still be the beginning of an arrow key. Waiting a few
 *     milliseconds and reading the screen gets the screen from BEFORE the key.
 */
import { EventEmitter } from 'node:events';
import { emitKeypressEvents } from 'node:readline';
import { PassThrough } from 'node:stream';

import type { PickerBundle, PickerResult } from '../src/cli/pack-picker.js';

const PICKER = new URL('../src/cli/pack-picker.ts', import.meta.url).href;

const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);

/**
 * What a terminal sends for each key the scripts name.
 *
 * The names are the ones the hand-written decoders in Python, Java and Rust produce, pinned in
 * `pack-picker-keys.json`. Anything not named here is sent as itself, one character at a time,
 * which is how a letter typed into the search box arrives.
 */
export const KEY_BYTES: Readonly<Record<string, string>> = {
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  right: `${ESC}[C`,
  left: `${ESC}[D`,
  home: `${ESC}[1~`,
  end: `${ESC}[4~`,
  pageup: `${ESC}[5~`,
  pagedown: `${ESC}[6~`,
  enter: '\r',
  space: ' ',
  backspace: DEL,
  escape: ESC,
};

/** A bundle as the fixture carries it: absent values are `null`, which JSON can actually hold. */
export interface FixtureBundle {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly bytes: number;
  readonly locale: string | null;
  readonly country: string | null;
  readonly regions: readonly string[] | null;
  readonly point: readonly [number, number] | null;
}

/** `null` is what the file says; `undefined` is what the picker's own type asks for. */
export const bundlesFromFixture = (raw: readonly FixtureBundle[]): PickerBundle[] =>
  raw.map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    bytes: b.bytes,
    locale: b.locale ?? undefined,
    country: b.country ?? undefined,
    regions: b.regions ?? undefined,
    point: b.point ?? undefined,
  }));

export interface PickerTerminal {
  readonly columns: number;
  readonly rows: number;
  /** Half-blocks and box drawing. False is the old Windows console, and `TDCV2_ASCII`. */
  readonly unicode: boolean;
  readonly colour: boolean;
}

export interface PickerRun {
  readonly name: string;
  readonly terminal: PickerTerminal;
  readonly installed: readonly string[];
  readonly keys: readonly string[];
}

export interface PlayedRun {
  /** One entry per key, plus the opening draw at index 0. Each is the screen split into lines. */
  readonly screens: readonly (readonly string[])[];
  readonly result: PickerResult | null;
}

class FakeOut extends EventEmitter {
  readonly written: string[] = [];
  constructor(
    readonly columns: number,
    readonly rows: number,
    readonly isTTY: boolean,
  ) {
    super();
  }
  write(text: string): boolean {
    this.written.push(text);
    return true;
  }
}

class FakeIn extends PassThrough {
  isTTY = false;
}

/**
 * The screen as the user sees it.
 *
 * Clearing the screen, homing the cursor and hiding it are COMMANDS — they carry no content and
 * every implementation spells them in its own order. Colour is not: an SGR code is part of what
 * was drawn, so it stays in and the five have to agree on it. The screen a leaving picker draws
 * is nothing but commands, which is why a script that quits ends on one empty line.
 */
const toLines = (text: string): string[] =>
  text
    .replace(new RegExp(`${ESC}\\[(?:2J|H|\\?25[lh])`, 'g'), '')
    .replace(/\n$/, '')
    .split('\n');

/** Everything the picker's terminal detection reads, and so everything a run has to put back. */
const TERMINAL_ENV = ['TDCV2_ASCII', 'LANG', 'LC_ALL', 'LC_CTYPE', 'NO_COLOR', 'TERM'] as const;

let serial = 0;

/**
 * Replay one run and return the screen after every key.
 *
 * `import()` is given a fresh query each time so the picker's terminal detection runs again; the
 * globals it reads are put back afterwards whatever happens, because a test runner keeps using
 * them long after this returns.
 */
export async function playRun(
  bundles: readonly PickerBundle[],
  run: PickerRun,
): Promise<PlayedRun> {
  const realOut = process.stdout;
  const realIn = process.stdin;
  const realEnv: Record<string, string | undefined> = {};
  for (const key of TERMINAL_ENV) realEnv[key] = process.env[key];

  const out = new FakeOut(run.terminal.columns, run.terminal.rows, run.terminal.colour);
  const input = new FakeIn();

  try {
    if (run.terminal.unicode) {
      delete process.env['TDCV2_ASCII'];
      process.env['LANG'] = 'en_US.UTF-8';
      delete process.env['LC_ALL'];
      delete process.env['LC_CTYPE'];
    } else {
      process.env['TDCV2_ASCII'] = '1';
    }
    if (run.terminal.colour) {
      delete process.env['NO_COLOR'];
      process.env['TERM'] = 'xterm-256color';
    } else {
      process.env['NO_COLOR'] = '1';
    }

    Object.defineProperty(process, 'stdout', { value: out, configurable: true });
    Object.defineProperty(process, 'stdin', { value: input, configurable: true });
    emitKeypressEvents(input);

    serial += 1;
    const picker = (await import(`${PICKER}?run=${String(serial)}`)) as {
      runPicker: (
        bundles: readonly PickerBundle[],
        installed: ReadonlySet<string>,
      ) => Promise<PickerResult | null>;
    };

    const done = picker.runPicker(bundles, new Set(run.installed));
    const screens: string[][] = [];

    /** Wait for the next draw, then a beat more in case the key draws twice. */
    const settle = async (drawn: number): Promise<void> => {
      const until = Date.now() + 1000;
      while (out.written.length === drawn && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2));
      }
      await new Promise((r) => setTimeout(r, 5));
    };

    await settle(0);
    screens.push(toLines(out.written[out.written.length - 1] ?? ''));

    for (const key of run.keys) {
      const drawn = out.written.length;
      input.write(KEY_BYTES[key] ?? key);
      await settle(drawn);
      screens.push(toLines(out.written[out.written.length - 1] ?? ''));
    }

    // Every script ends with the key that leaves — `q`, or the enter on Apply — so the promise
    // has already settled by here. A script that forgets is a script that would hang.
    const stillRunning = Symbol('running');
    const result = await Promise.race([
      done,
      new Promise((r) =>
        setTimeout(() => {
          r(stillRunning);
        }, 2000),
      ),
    ]);
    if (result === stillRunning) {
      throw new Error(`run "${run.name}" never left the picker; its last key must quit or apply`);
    }
    return { screens, result: result as PickerResult | null };
  } finally {
    Object.defineProperty(process, 'stdout', { value: realOut, configurable: true });
    Object.defineProperty(process, 'stdin', { value: realIn, configurable: true });
    for (const key of TERMINAL_ENV) {
      const was = realEnv[key];
      if (was === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = was;
    }
  }
}
