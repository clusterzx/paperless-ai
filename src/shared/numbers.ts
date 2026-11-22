/**
 * Numbers and amounts as people write them – shared by the server (AI values, manual edits) and
 * the browser (custom field inputs).
 */

/** Parse numbers written in German or English notation ("1.234,56", "1,234.56", "12,50 €"). */
export function parseNumber(input: string): number | null {
  let t = input.replace(/[^\d,.-]/g, '');
  if (!t || !/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(',');
  const lastDot = t.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    t = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma > -1) {
    t = /^-?\d{1,3}(,\d{3})+$/.test(t) ? t.replace(/,/g, '') : t.replace(',', '.');
  } else if (/^-?\d{1,3}(\.\d{3}){2,}$/.test(t)) {
    t = t.replace(/\./g, '');
  }
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const SYMBOLS: Record<string, string> = { '€': 'EUR', $: 'USD', '£': 'GBP', '¥': 'JPY', '₣': 'CHF', '₹': 'INR', '₽': 'RUB', zł: 'PLN', Kč: 'CZK' };

/** The currency named in a value: an ISO code ("EUR134.89", "12 CHF") or a symbol ("12,50 €"); null if none. */
export function currencyIn(value: string): string | null {
  const code = /(?<![A-Za-z])([A-Z]{3})(?![A-Za-z])/.exec(value);
  if (code) return code[1];
  for (const [symbol, iso] of Object.entries(SYMBOLS)) if (value.includes(symbol)) return iso;
  return null;
}

/** A monetary custom field value ("EUR134.89", Paperless-ngx's format) split into currency and amount. */
export function parseMonetary(value: string | null | undefined): { currency: string | null; amount: number | null } {
  const v = (value ?? '').trim();
  if (!v) return { currency: null, amount: null };
  return { currency: currencyIn(v), amount: parseNumber(v.replace(/[A-Za-z]{3}/g, '')) };
}

/** The stored form of an amount: "EUR134.89" (without a currency: "134.89"). */
export function formatMonetaryValue(currency: string | null | undefined, amount: number): string {
  return `${(currency ?? '').toUpperCase()}${amount.toFixed(2)}`;
}
