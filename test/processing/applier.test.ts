import { describe, expect, it } from 'vitest';
import { convertCustomFieldValue, parseNumber, snapshotOf, truncateTitle } from '../../src/server/processing/applier.js';
import type { PaperlessCustomField, PaperlessDocument } from '../../src/server/paperless/types.js';

describe('parseNumber', () => {
  const cases: [string, number | null][] = [
    ['12', 12],
    ['12.50', 12.5],
    ['12,50', 12.5],
    ['12,50 €', 12.5],
    ['€ 12,50', 12.5],
    ['1.234,56', 1234.56],
    ['1,234.56', 1234.56],
    ['1.234.567,89', 1234567.89],
    ['1,234,567.89', 1234567.89],
    ['1.234.567', 1234567],
    ['1,234', 1234],
    ['1,234,567', 1234567],
    ['1 234,56', 1234.56],
    ['-5,5', -5.5],
    ['EUR 99', 99],
    ['USD 1,000.00', 1000],
    ['0,99', 0.99],
    ['abc', null],
    ['', null],
    ['-', null],
    ['€', null],
  ];
  for (const [input, expected] of cases) {
    it(`parses "${input}"`, () => expect(parseNumber(input)).toBe(expected));
  }
});

describe('convertCustomFieldValue', () => {
  const field = (data_type: PaperlessCustomField['data_type'], extra_data: PaperlessCustomField['extra_data'] = null): PaperlessCustomField => ({
    id: 1,
    name: 'F',
    data_type,
    extra_data,
  });

  it('string / longtext', () => {
    expect(convertCustomFieldValue(field('string'), '  hello ')).toBe('hello');
    expect(convertCustomFieldValue(field('string'), 'x'.repeat(200))).toHaveLength(128);
    expect(convertCustomFieldValue(field('string'), 'two\nlines')).toBe('two lines');
    expect(convertCustomFieldValue(field('longtext'), 'two\nlines')).toBe('two\nlines');
    expect(convertCustomFieldValue(field('longtext'), 'y'.repeat(500))).toHaveLength(500);
  });

  it('url', () => {
    expect(convertCustomFieldValue(field('url'), 'https://example.com/a')).toBe('https://example.com/a');
    expect(convertCustomFieldValue(field('url'), 'www.example.com')).toBe('https://www.example.com');
    expect(convertCustomFieldValue(field('url'), 'not a url')).toBeUndefined();
    expect(convertCustomFieldValue(field('url'), 'https://exa mple.com')).toBeUndefined();
    expect(convertCustomFieldValue(field('url'), 'https://')).toBeUndefined();
  });

  it('date', () => {
    expect(convertCustomFieldValue(field('date'), '15.03.2024')).toBe('2024-03-15');
    expect(convertCustomFieldValue(field('date'), 'soon')).toBeUndefined();
  });

  it('boolean', () => {
    for (const t of ['true', 'Yes', 'ja', '1', 'WAHR']) expect(convertCustomFieldValue(field('boolean'), t)).toBe(true);
    for (const f of ['false', 'no', 'Nein', '0', 'non']) expect(convertCustomFieldValue(field('boolean'), f)).toBe(false);
    expect(convertCustomFieldValue(field('boolean'), 'maybe')).toBeUndefined();
  });

  it('integer / float', () => {
    expect(convertCustomFieldValue(field('integer'), '1.234,56')).toBe(1235);
    expect(convertCustomFieldValue(field('integer'), '42 pcs')).toBe(42);
    expect(convertCustomFieldValue(field('integer'), 'many')).toBeUndefined();
    expect(convertCustomFieldValue(field('float'), '12,5')).toBe(12.5);
    expect(convertCustomFieldValue(field('float'), 'n/a')).toBeUndefined();
  });

  it('monetary uses the field currency, then the configured one, then one found in the value', () => {
    expect(convertCustomFieldValue(field('monetary', { default_currency: 'EUR' }), '1.234,56 €', 'USD')).toBe('EUR1234.56');
    expect(convertCustomFieldValue(field('monetary'), '12', 'USD')).toBe('USD12.00');
    expect(convertCustomFieldValue(field('monetary', { default_currency: null }), 'CHF 12.5')).toBe('CHF12.50');
    expect(convertCustomFieldValue(field('monetary'), '7,1')).toBe('7.10');
    expect(convertCustomFieldValue(field('monetary'), 'free')).toBeUndefined();
  });

  it('select matches option labels (object and legacy string options)', () => {
    const objects = field('select', { select_options: [{ id: 'aB3', label: 'Open' }, { id: 'zZ9', label: 'Paid' }] });
    expect(convertCustomFieldValue(objects, ' paid ')).toBe('zZ9');
    expect(convertCustomFieldValue(objects, 'Cancelled')).toBeUndefined();
    const strings = field('select', { select_options: ['Open', 'Paid'] });
    expect(convertCustomFieldValue(strings, 'PAID')).toBe(1);
    expect(convertCustomFieldValue(field('select'), 'Paid')).toBeUndefined();
  });

  it('unsupported types are ignored', () => {
    expect(convertCustomFieldValue(field('documentlink'), '12')).toBeUndefined();
  });
});

describe('snapshotOf / truncateTitle', () => {
  it('captures the undo-relevant fields (date part of created)', () => {
    const doc: PaperlessDocument = {
      id: 1,
      title: 'T',
      tags: [1, 2],
      correspondent: 3,
      document_type: null,
      created: '2024-03-15T00:00:00+01:00',
      custom_fields: [{ field: 9, value: 'x' }],
    };
    expect(snapshotOf(doc)).toEqual({
      title: 'T',
      tags: [1, 2],
      correspondent: 3,
      document_type: null,
      created: '2024-03-15',
      custom_fields: [{ field: 9, value: 'x' }],
    });
    expect(snapshotOf({ ...doc, created: '2024-03-15T23:30:00Z', created_date: '2024-03-16' }).created).toBe('2024-03-16');
  });

  it('limits titles to 128 characters', () => {
    expect(truncateTitle('  short ')).toBe('short');
    const long = truncateTitle('a'.repeat(300));
    expect(long).toHaveLength(128);
    expect(long.endsWith('…')).toBe(true);
  });
});
