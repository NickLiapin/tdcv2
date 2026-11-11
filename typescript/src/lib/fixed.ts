/**
 * `decimals=` applied: `value` rounded to `decimals` places, the way the whole engine prints it.
 *
 * `toFixed`, with one difference. JavaScript keeps the sign of a value that rounds to zero —
 * `(-0.001).toFixed(2)` is `"-0.00"` — so a column of small negative amounts printed `-0.00`,
 * a string that is not equal to `0.00`, sorts apart from it, and reads as a bug in a report.
 * Java's port printed `0.00` all along, so the five already disagreed. A value that rounds to
 * zero is printed as zero now, in all five. Found by the article agent.
 */
export function toFixedText(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  return /^-0(?:\.0+)?$/.test(text) ? text.slice(1) : text;
}
