import { describe, expect, it } from 'vitest';
import { normalizeSuggestion } from '../../src/server/processing/suggestion.js';

describe('normalizeSuggestion', () => {
  it('normalises a complete answer', () => {
    const s = normalizeSuggestion({
      title: '  Invoice   123\n from ACME ',
      correspondent: 'ACME',
      tags: ['Invoice', 'invoice', '#Energy', { name: 'Utilities' }, '', null, 'unknown'],
      document_type: 'Invoice',
      document_date: '15.03.2024',
      language: 'DE',
      custom_fields: [{ field_name: 'Amount', value: '12,50 €' }],
    });
    expect(s).toEqual({
      title: 'Invoice 123 from ACME',
      correspondent: 'ACME',
      tags: ['Invoice', 'Energy', 'Utilities'],
      document_type: 'Invoice',
      document_date: '2024-03-15',
      language: 'de',
      custom_fields: [{ field_name: 'Amount', value: '12,50 €' }],
    });
  });

  it('de-duplicates tags with and without leading #', () => {
    expect(normalizeSuggestion({ tags: ['#Energy', 'energy', 'Energy'] }).tags).toEqual(['Energy']);
  });

  it('treats placeholder values as empty', () => {
    const s = normalizeSuggestion({
      title: 'null',
      correspondent: 'Unbekannt',
      tags: 'n/a',
      document_type: 'N/A',
      document_date: 'unknown',
      language: 'und',
    });
    expect(s).toEqual({
      title: null,
      correspondent: null,
      tags: [],
      document_type: null,
      document_date: null,
      language: null,
      custom_fields: [],
    });
  });

  it('accepts tags as comma/semicolon separated string and caps the count', () => {
    expect(normalizeSuggestion({ tags: 'a, b; c ,' }).tags).toEqual(['a', 'b', 'c']);
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(normalizeSuggestion({ tags: many }).tags).toHaveLength(25);
  });

  it('accepts alternative key names', () => {
    const s = normalizeSuggestion({ title: 1234, documentType: 'Letter', documentDate: '2024-01-02', customFields: { IBAN: 'DE02' } });
    expect(s.title).toBe('1234');
    expect(s.document_type).toBe('Letter');
    expect(s.document_date).toBe('2024-01-02');
    expect(s.custom_fields).toEqual([{ field_name: 'IBAN', value: 'DE02' }]);
    const t = normalizeSuggestion({ type: 'Contract', date: 'March 1, 2024' });
    expect(t.document_type).toBe('Contract');
    expect(t.document_date).toBe('2024-03-01');
  });

  it('accepts custom fields as an index-keyed object (legacy prompt format)', () => {
    const s = normalizeSuggestion({
      title: 'x',
      custom_fields: {
        '0': { field_name: 'Amount', value: '99.90' },
        '1': { field_name: 'Invoice number', value: 'R-1' },
        '2': { field_name: 'Due date', value: 'Fill in the value based on your analysis' },
      },
    });
    expect(s.custom_fields).toEqual([
      { field_name: 'Amount', value: '99.90' },
      { field_name: 'Invoice number', value: 'R-1' },
    ]);
  });

  it('accepts custom fields as a name → value map with non-string values', () => {
    const s = normalizeSuggestion({ custom_fields: { Paid: true, Count: 3, Empty: '', Nothing: null } });
    expect(s.custom_fields).toEqual([
      { field_name: 'Paid', value: 'true' },
      { field_name: 'Count', value: '3' },
    ]);
  });

  it('drops invalid and duplicate custom field entries', () => {
    const s = normalizeSuggestion({
      custom_fields: [
        { field_name: 'Amount', value: '1' },
        { field_name: 'amount', value: '2' },
        { field_name: '', value: 'x' },
        { name: 'Alt', value: 'y' },
        'garbage',
        null,
      ],
    });
    expect(s.custom_fields).toEqual([
      { field_name: 'Amount', value: '1' },
      { field_name: 'Alt', value: 'y' },
    ]);
  });

  it('unwraps nested results', () => {
    expect(normalizeSuggestion({ document: { title: 'Nested', tags: ['a'] } }).title).toBe('Nested');
    expect(normalizeSuggestion({ result: { title: 'Result' } }).title).toBe('Result');
    expect(normalizeSuggestion({ analysis: { correspondent: 'X' } }).correspondent).toBe('X');
    // top-level fields win over a nested object
    expect(normalizeSuggestion({ title: 'Top', data: { title: 'Inner' } }).title).toBe('Top');
  });

  it('limits string lengths', () => {
    const s = normalizeSuggestion({ title: 'x'.repeat(1000), correspondent: 'y'.repeat(500) });
    expect(s.title).toHaveLength(512);
    expect(s.correspondent).toHaveLength(128);
  });
});
