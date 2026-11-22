import { describe, expect, it } from 'vitest';
import { currencyIn, formatMonetaryValue, parseMonetary } from '../../src/shared/numbers.js';

describe('amounts', () => {
  it('reads the stored form, written amounts and symbols', () => {
    expect(parseMonetary('EUR134.89')).toEqual({ currency: 'EUR', amount: 134.89 });
    expect(parseMonetary('134,89 €')).toEqual({ currency: 'EUR', amount: 134.89 });
    expect(parseMonetary('1.234,50 CHF')).toEqual({ currency: 'CHF', amount: 1234.5 });
    expect(parseMonetary('12.5')).toEqual({ currency: null, amount: 12.5 });
    expect(parseMonetary('')).toEqual({ currency: null, amount: null });
  });

  it('finds currency codes only as words of their own', () => {
    expect(currencyIn('USD99')).toBe('USD');
    expect(currencyIn('MwSt 19 %')).toBeNull();
    expect(currencyIn('$ 12')).toBe('USD');
  });

  it('writes the stored form', () => {
    expect(formatMonetaryValue('eur', 7.1)).toBe('EUR7.10');
    expect(formatMonetaryValue(null, 3)).toBe('3.00');
  });
});
