/**
 * Suggestions for merging tags, correspondents and document types that mean the same.
 */
import { describe, expect, it } from 'vitest';
import { entityKey, similarGroups, withinOne, type NamedItem, type SimilarKind } from '../../src/server/backend/similarNames.js';

const items = (...names: (string | [string, number])[]): NamedItem[] =>
  names.map((n, i) => (Array.isArray(n) ? { id: i + 1, name: n[0], document_count: n[1] } : { id: i + 1, name: n, document_count: 1 }));
const groups = (kind: SimilarKind, ...names: (string | [string, number])[]) => similarGroups(items(...names), kind).map((g) => ({ names: [...g.names].sort(), suggested: g.suggested, reason: g.reason }));

describe('similar names', () => {
  it('normalises correspondents: case, umlauts, punctuation, legal forms and region words', () => {
    expect(entityKey('ADAC Versicherung AG', 'correspondent')).toBe('adac versicherung');
    expect(entityKey('Abuniverse Europe', 'correspondent')).toBe('abuniverse');
    expect(entityKey('Amazon EU S.à r.l., German branch', 'correspondent')).toBe('amazon');
    expect(entityKey('Müller GmbH & Co. KG', 'correspondent')).toBe('mueller');
    expect(entityKey('Sportverein Blau-Weiß e.V.', 'correspondent')).toBe('sportverein blau weiss');
    expect(entityKey('1&1 Telecom GmbH', 'correspondent')).toBe('1 und 1 telecom');
    // A name is never stripped to nothing, and tags keep their words.
    expect(entityKey('GmbH', 'correspondent')).toBe('gmbh');
    expect(entityKey('Versicherung AG', 'tag')).toBe('versicherung ag');
  });

  it('groups correspondents of the same organisation and keeps the clean, most used name', () => {
    expect(groups('correspondent', ['ABUniverse', 3], ['Abuniverse Europe', 5], ['ADAC Versicherung', 2], ['ADAC Versicherung AG', 9], 'Telekom')).toEqual([
      { names: ['ADAC Versicherung', 'ADAC Versicherung AG'], suggested: 'ADAC Versicherung', reason: 'same' },
      { names: ['ABUniverse', 'Abuniverse Europe'], suggested: 'ABUniverse', reason: 'same' },
    ]);
    expect(groups('correspondent', 'Amazon EU S.à r.l.', 'Amazon', 'Amazon EU S.a.r.l., German branch', 'Telekom Deutschland GmbH', 'Telekom')).toEqual([
      { names: ['Amazon', 'Amazon EU S.a.r.l., German branch', 'Amazon EU S.à r.l.'], suggested: 'Amazon', reason: 'same' },
      { names: ['Telekom', 'Telekom Deutschland GmbH'], suggested: 'Telekom', reason: 'same' },
    ]);
  });

  it('joins a name with its only continuation and typos, but not different organisations', () => {
    expect(groups('correspondent', 'Sparkasse', 'Sparkasse KölnBonn')).toEqual([{ names: ['Sparkasse', 'Sparkasse KölnBonn'], suggested: 'Sparkasse', reason: 'extends' }]);
    // Two continuations: "Stadtwerke" alone says nothing.
    expect(groups('correspondent', 'Stadtwerke', 'Stadtwerke Köln', 'Stadtwerke München')).toEqual([]);
    expect(groups('correspondent', 'Telekom', 'Telecom')).toEqual([{ names: ['Telecom', 'Telekom'], suggested: 'Telecom', reason: 'spelling' }]);
    // Short words differ by one letter all the time: Bank/Bahn, Meier/Meyer.
    expect(groups('correspondent', 'Deutsche Bank', 'Deutsche Bahn', 'Meier', 'Meyer', 'Praxis 12', 'Praxis 13')).toEqual([]);
  });

  it('never mixes a continuation into certain groups: "ADAC" and "ADAC Versicherung" are two companies', () => {
    expect(groups('correspondent', ['ADAC', 5], 'ADAC e.V.', ['ADAC Versicherung', 3], 'ADAC Versicherung AG')).toEqual([
      { names: ['ADAC', 'ADAC e.V.'], suggested: 'ADAC', reason: 'same' },
      { names: ['ADAC Versicherung', 'ADAC Versicherung AG'], suggested: 'ADAC Versicherung', reason: 'same' },
      // to check, last
      { names: ['ADAC', 'ADAC Versicherung', 'ADAC Versicherung AG', 'ADAC e.V.'], suggested: 'ADAC', reason: 'extends' },
    ]);
  });

  it('groups tags and document types by case and plural endings', () => {
    expect(groups('tag', 'Rechnung', 'Rechnungen', 'rechnung', 'Auto', 'Autos', 'Steuer', 'Steuern', 'Bank', 'Bahn', 'Versicherung', 'Versicherung Auto').map((g) => g.names)).toEqual([
      ['Rechnung', 'Rechnungen', 'rechnung'],
      ['Auto', 'Autos'],
      ['Steuer', 'Steuern'],
    ]);
    expect(groups('documentType', 'Invoice', 'Invoices', 'Contract')).toEqual([{ names: ['Invoice', 'Invoices'], suggested: 'Invoice', reason: 'spelling' }]);
  });

  it('compares with one edit at most', () => {
    expect(withinOne('telekom', 'telecom')).toBe(true);
    expect(withinOne('vertrag', 'vertraeg')).toBe(true);
    expect(withinOne('abcd', 'abdc')).toBe(true);
    expect(withinOne('vodafone', 'vodaphone')).toBe(false);
  });

  it('handles thousands of names quickly', () => {
    const many = Array.from({ length: 6000 }, (_, i) => ({ id: i + 1, name: `Firma ${(i * 7919).toString(36)} ${i % 3 ? 'GmbH' : 'AG'}`, document_count: i % 5 }));
    const started = Date.now();
    similarGroups(many, 'correspondent');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
