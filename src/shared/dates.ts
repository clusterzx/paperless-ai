/**
 * Calendar days in the local time zone – the TZ of the server, the time zone of the browser.
 * `toISOString().slice(0, 10)` gives the day in UTC: east of Greenwich that is still the previous
 * day for an hour or two after local midnight (#1036). Use it only to reckon with date-only values.
 */

const pad = (n: number) => String(n).padStart(2, '0');

/** The local calendar day of a point in time (default: now), YYYY-MM-DD. */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
