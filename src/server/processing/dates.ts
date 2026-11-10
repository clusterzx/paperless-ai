/**
 * Date normalisation for AI output. Returns YYYY-MM-DD or null – never a
 * made-up fallback date (the old implementation used 1990-01-01).
 */

export const MONTHS: Record<string, number> = {
  jan: 1, january: 1, januar: 1, jänner: 1, janvier: 1, enero: 1, gennaio: 1,
  feb: 2, february: 2, februar: 2, février: 2, fevrier: 2, febrero: 2, febbraio: 2,
  mar: 3, march: 3, märz: 3, maerz: 3, mars: 3, marzo: 3,
  apr: 4, april: 4, avril: 4, abril: 4, aprile: 4,
  may: 5, mai: 5, mayo: 5, maggio: 5,
  jun: 6, june: 6, juni: 6, juin: 6, junio: 6, giugno: 6,
  jul: 7, july: 7, juli: 7, juillet: 7, julio: 7, luglio: 7,
  aug: 8, august: 8, août: 8, aout: 8, agosto: 8,
  sep: 9, sept: 9, september: 9, septembre: 9, septiembre: 9, settembre: 9,
  oct: 10, okt: 10, october: 10, oktober: 10, octobre: 10, octubre: 10, ottobre: 10,
  nov: 11, november: 11, novembre: 11, noviembre: 11,
  dec: 12, dez: 12, december: 12, dezember: 12, décembre: 12, decembre: 12, diciembre: 12, dicembre: 12,
};

function valid(y: number, m: number, d: number): string | null {
  if (y < 100) y += y >= 70 ? 1900 : 2000;
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function normalizeDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.trim().toLowerCase();
  if (!s || /^(null|none|unknown|n\/a|-|und)$/.test(s)) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s); // ISO, also with time part
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s);
  if (m) return valid(+m[1], +m[2], +m[3]);
  // European day-first formats (dd.mm.yyyy, dd-mm-yyyy, dd/mm/yyyy)
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(s);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    // Only treat as month-first when day-first is impossible (e.g. 12/31/2024).
    return a > 12 && b <= 12 ? valid(+m[3], b, a) : b > 12 ? valid(+m[3], a, b) : valid(+m[3], b, a);
  }
  // "1. März 2024", "March 1, 2024", "1 Mar 2024"
  m = /^(\d{1,2})\.?\s+([a-zäéû]+)\.?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[2]]) return valid(+m[3], MONTHS[m[2]], +m[1]);
  m = /^([a-zäéû]+)\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m && MONTHS[m[1]]) return valid(+m[3], MONTHS[m[1]], +m[2]);
  return null;
}

/** Extract the date part of a Paperless `created` value (date or datetime). */
export function datePart(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0] ?? null;
}
