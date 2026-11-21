/**
 * Search syntax of the document list: tokens, aliases, quotes, negation, dates.
 */
import { describe, expect, it } from 'vitest';
import { hasSearchSyntax, parseDateRange, parseSearch, searchValue, tokenAt } from '../../src/shared/searchSyntax.js';

describe('search syntax', () => {
  it('splits free words, phrases, excluded words and key:value terms', () => {
    expect(parseSearch('rechnung title:"Strom 2024" tag:steuer -tag:erledigt from:adac "genau so" -werbung')).toEqual({
      text: 'rechnung "genau so"',
      exclude: ['werbung'],
      terms: [
        { key: 'title', value: 'Strom 2024', negate: false },
        { key: 'tag', value: 'steuer', negate: false },
        { key: 'tag', value: 'erledigt', negate: true },
        { key: 'correspondent', value: 'adac', negate: false },
      ],
    });
    // German aliases, any case; unknown keys and lone dashes stay text
    expect(parseSearch('Titel:Miete Typ:Vertrag Datum:2024').terms.map((t) => t.key)).toEqual(['title', 'type', 'created']);
    expect(parseSearch('https://example.com Strom - Gas')).toEqual({ text: 'https://example.com Strom - Gas', exclude: [], terms: [] });
    expect(parseSearch('tag:').terms).toEqual([]);
  });

  it('knows when the syntax is used', () => {
    expect(hasSearchSyntax('strom rechnung')).toBe(false);
    expect(hasSearchSyntax('E-Mail https://x.de')).toBe(false);
    expect(hasSearchSyntax('tag:steuer')).toBe(true);
    expect(hasSearchSyntax('strom -gas')).toBe(true);
  });

  it('finds the token at the cursor for the autocomplete', () => {
    expect(tokenAt('strom tag:ste', 13)).toMatchObject({ start: 6, end: 13, key: 'tag', value: 'ste', negate: false });
    expect(tokenAt('-corr', 5)).toMatchObject({ negate: true, value: 'corr', key: undefined });
    expect(tokenAt('a  b', 2)).toBeNull();
    expect(searchValue('ADAC Versicherung')).toBe('"ADAC Versicherung"');
    expect(searchValue('Steuer')).toBe('Steuer');
  });

  it('reads dates, months, years, comparisons and ranges', () => {
    const today = new Date('2026-11-21T12:00:00Z');
    expect(parseDateRange('2024')).toEqual({ from: '2024-01-01', to: '2024-12-31' });
    expect(parseDateRange('2024-02')).toEqual({ from: '2024-02-01', to: '2024-02-29' });
    expect(parseDateRange('15.03.2024')).toEqual({ from: '2024-03-15', to: '2024-03-15' });
    expect(parseDateRange('03.2024')).toEqual({ from: '2024-03-01', to: '2024-03-31' });
    expect(parseDateRange('>2024-01-31')).toEqual({ from: '2024-02-01' });
    expect(parseDateRange('>=2024')).toEqual({ from: '2024-01-01' });
    expect(parseDateRange('<2024-03')).toEqual({ to: '2024-02-29' });
    expect(parseDateRange('2023..2024-06')).toEqual({ from: '2023-01-01', to: '2024-06-30' });
    expect(parseDateRange('..2020')).toEqual({ to: '2020-12-31' });
    expect(parseDateRange('heute', today)).toEqual({ from: '2026-11-21', to: '2026-11-21' });
    expect(parseDateRange('2024-13')).toBeNull();
    expect(parseDateRange('31.02.2024')).toBeNull();
    expect(parseDateRange('soon')).toBeNull();
  });
});
