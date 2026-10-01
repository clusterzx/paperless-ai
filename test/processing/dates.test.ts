import { describe, expect, it } from 'vitest';
import { datePart, normalizeDate } from '../../src/server/processing/dates.js';

describe('normalizeDate', () => {
  const valid: [string, string][] = [
    ['2024-03-15', '2024-03-15'],
    ['2024-3-5', '2024-03-05'],
    ['2024-03-15T10:22:00Z', '2024-03-15'],
    ['2024-03-15 10:22', '2024-03-15'],
    ['  2024-03-15  ', '2024-03-15'],
    ['2024/03/15', '2024-03-15'],
    ['2024.03.15', '2024-03-15'],
    ['15.03.2024', '2024-03-15'],
    ['15/03/2024', '2024-03-15'],
    ['15-03-2024', '2024-03-15'],
    ['5.3.2024', '2024-03-05'],
    // ambiguous → day first (European)
    ['03/04/2024', '2024-04-03'],
    // impossible as day-first → month first
    ['12/31/2024', '2024-12-31'],
    // two-digit years
    ['15.03.24', '2024-03-15'],
    ['01.01.70', '1970-01-01'],
    ['31.12.69', '2069-12-31'],
    // written months (de, en, fr, es, it)
    ['1. März 2024', '2024-03-01'],
    ['1 März 2024', '2024-03-01'],
    ['15. Dezember 2023', '2023-12-15'],
    ['March 1, 2024', '2024-03-01'],
    ['march 1 2024', '2024-03-01'],
    ['Sept. 5, 2023', '2023-09-05'],
    ['1 Mar 2024', '2024-03-01'],
    ['1 mar. 2024', '2024-03-01'],
    ['15 août 2024', '2024-08-15'],
    ['5 décembre 2024', '2024-12-05'],
    ['3 enero 2022', '2022-01-03'],
    ['20 ottobre 2021', '2021-10-20'],
    // leap day
    ['2024-02-29', '2024-02-29'],
    ['29.02.2024', '2024-02-29'],
  ];
  for (const [input, expected] of valid) {
    it(`parses "${input}"`, () => expect(normalizeDate(input)).toBe(expected));
  }

  const invalid: unknown[] = [
    '',
    '   ',
    'null',
    'None',
    'unknown',
    'N/A',
    '-',
    'und',
    'yesterday',
    '2024-02-30',
    '2023-02-29',
    '31.04.2024',
    '2024-13-01',
    '13/13/2024',
    '00.01.2024',
    '1899-12-31',
    '2101-01-01',
    '32 März 2024',
    '1 Foo 2024',
    20240315,
    null,
    undefined,
    { date: '2024-01-01' },
  ];
  for (const input of invalid) {
    it(`rejects ${JSON.stringify(input) ?? 'undefined'}`, () => expect(normalizeDate(input)).toBeNull());
  }
});

describe('datePart', () => {
  it('extracts the date of a date or datetime', () => {
    expect(datePart('2024-03-15')).toBe('2024-03-15');
    expect(datePart('2024-03-15T00:00:00+01:00')).toBe('2024-03-15');
  });

  it('returns null for empty or invalid values', () => {
    expect(datePart(null)).toBeNull();
    expect(datePart(undefined)).toBeNull();
    expect(datePart('')).toBeNull();
    expect(datePart('15.03.2024')).toBeNull();
  });
});
