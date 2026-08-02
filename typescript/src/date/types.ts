/**
 * Shared date runtime types.
 */

export interface PlainDateTime {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

export type DatePrecision = 'day' | 'second' | 'millisecond';

export class DateRuntimeError extends Error {
  public override readonly name = 'DateRuntimeError';
}
