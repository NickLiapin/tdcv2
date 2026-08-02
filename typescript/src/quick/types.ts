/**
 * The shapes the quick API hands back.
 *
 * Kept apart from the facade so the generated address tree can import them
 * without pulling in the engine.
 */

/** Parameters written on the call, e.g. `{ domain: 'example.test' }`. */
export type QuickParams = Readonly<Record<string, string | number | boolean>>;

/**
 * One address. Calling it draws a value; `many` draws several.
 *
 * Every node in the generated tree is callable, including the ones that only
 * exist to hold other names: `tdc.person` is not an address anybody can draw,
 * and asking for it fails at the call with the same "unknown address" message
 * a typo gets. Making the middle of a path uncallable would double the size of
 * the generated types to prevent a mistake the error already explains.
 */
export interface QuickAddress {
  (params?: QuickParams): string;
  many: (count: number, params?: QuickParams) => string[];
}

/** One engine generator: `tdc.gen.number('20..30')`. */
export interface QuickGenCall {
  (arg?: string | QuickParams): string;
  many: (count: number, arg?: string | QuickParams) => string[];
}

/**
 * The `gen` namespace, one entry per `<gen type="…">`.
 *
 * Spelled out rather than generated: there are thirteen, they change with the
 * engine and not with the packs, and a reader deserves to see the list.
 */
export interface QuickGen {
  readonly text: QuickGenCall;
  readonly file: QuickGenCall;
  readonly template: QuickGenCall;
  readonly number: QuickGenCall;
  readonly regex: QuickGenCall;
  readonly advanced_regex: QuickGenCall;
  readonly symbol: QuickGenCall;
  readonly date: QuickGenCall;
  readonly increment: QuickGenCall;
  readonly decrement: QuickGenCall;
  readonly timeseries: QuickGenCall;
  readonly pattern: QuickGenCall;
  readonly http: QuickGenCall;
}
