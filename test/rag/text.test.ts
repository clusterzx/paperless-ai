import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from '../../src/server/db/database.js';
import { RagStore } from '../../src/server/rag/store.js';
import {
  asksForRecency,
  buildFtsQuery,
  makeSnippet,
  mentionedYears,
  overlapScore,
  queryTerms,
  tokenize,
} from '../../src/server/rag/text.js';

let db: Db | null = null;
afterEach(() => {
  db?.close();
  db = null;
});

describe('tokenize / queryTerms', () => {
  it('tokenises unicode words and numbers', () => {
    expect(tokenize('Grüße, Müller-Lüdenscheidt! Rechnung #2024-17 l’été')).toEqual(['grüße', 'müller-lüdenscheidt', 'rechnung', '2024-17', 'l’été']);
  });

  it('removes stop words (en/de/fr) and duplicates', () => {
    expect(queryTerms('What is the amount of my latest electricity invoice from ACME? The invoice!')).toEqual([
      'amount',
      'latest',
      'electricity',
      'invoice',
      'acme',
    ]);
    expect(queryTerms('Wie hoch war die letzte Stromrechnung von Vattenfall?')).toEqual(['hoch', 'letzte', 'stromrechnung', 'vattenfall']);
    expect(queryTerms('Quelle est la facture de EDF')).toEqual(['quelle', 'facture', 'edf']);
  });

  it('drops single characters and limits the number of terms', () => {
    expect(queryTerms('a b c dd')).toEqual(['dd']);
    const many = Array.from({ length: 50 }, (_, i) => `term${i}`).join(' ');
    expect(queryTerms(many)).toHaveLength(24);
    expect(queryTerms(many, 5)).toHaveLength(5);
  });

  it('removes apostrophes', () => {
    expect(queryTerms("O'Brien's policy")).toEqual(['obriens', 'policy']);
  });
});

describe('buildFtsQuery', () => {
  it('quotes every term and uses prefix search for longer words', () => {
    expect(buildFtsQuery(['invoice', 'acme', 'tax', '2024', '12345'])).toBe('"invoice"* OR "acme"* OR "tax" OR "2024" OR "12345"');
  });

  it('returns null without terms', () => {
    expect(buildFtsQuery([])).toBeNull();
    expect(buildFtsQuery(['""', '"'])).toBeNull();
  });

  it('cannot inject FTS5 syntax', () => {
    db = openDatabase(':memory:');
    const store = new RagStore(db);
    store.upsertDocument(
      { id: 1, modified: null, contentHash: 'h', title: 'Doc', correspondent: null, documentType: null, tags: [], created: null },
      ['hello world near column'],
    );
    const nasty = [
      'hello" OR world',
      'NEAR(hello world)',
      'meta:hello',
      'body : world *',
      '^hello',
      '-world',
      'AND OR NOT',
      '(((',
      '"unbalanced',
      'col"umn',
      "it's",
    ];
    for (const input of nasty) {
      const q = buildFtsQuery(queryTerms(input));
      if (!q) continue;
      expect(() => db!.prepare('SELECT rowid FROM rag_fts WHERE rag_fts MATCH ?').all(q)).not.toThrow();
    }
    // raw terms (not only those from queryTerms) are safe as well
    const raw = buildFtsQuery(['he"llo', 'wor*ld', 'a:b', 'NEAR(x'])!;
    expect(() => db!.prepare('SELECT rowid FROM rag_fts WHERE rag_fts MATCH ?').all(raw)).not.toThrow();
    expect(store.ftsSearch(buildFtsQuery(['hello', 'column'])!, 10).map((h) => h.id)).toHaveLength(1);
  });
});

describe('makeSnippet', () => {
  const long =
    'Introduction text that is not relevant at all. '.repeat(10) +
    'The total amount of the electricity invoice is 123.45 EUR, payable until March. ' +
    'Closing remarks that are not relevant either. '.repeat(10);

  it('returns short text unchanged (whitespace collapsed)', () => {
    expect(makeSnippet('  short\n\ntext ', ['short'])).toBe('short text');
  });

  it('centres the snippet on the query terms', () => {
    const s = makeSnippet(long, ['electricity', 'amount'], 200);
    expect(s).toContain('electricity invoice');
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(202);
  });

  it('starts at the beginning without matching terms', () => {
    const s = makeSnippet(long, ['nomatch'], 100);
    expect(s.startsWith('Introduction')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
  });
});

describe('overlapScore / recency / years', () => {
  it('scores lexical overlap', () => {
    expect(overlapScore('invoice invoice tax', ['invoice', 'tax'])).toBeGreaterThan(overlapScore('invoice', ['invoice', 'tax']));
    expect(overlapScore('nothing', ['invoice'])).toBe(0);
    expect(overlapScore('anything', [])).toBe(0);
  });

  it('detects questions about the most recent document', () => {
    expect(asksForRecency('What was my latest invoice?')).toBe(true);
    expect(asksForRecency('Wie hoch war die letzte Stromrechnung?')).toBe(true);
    expect(asksForRecency('Show the most recent letter')).toBe(true);
    expect(asksForRecency('Was ist im Vertrag geregelt?')).toBe(false);
    // no false positives inside other words
    expect(asksForRecency('the lastname field')).toBe(false);
  });

  it('extracts years', () => {
    expect(mentionedYears('Steuer 2023 und 2024, nicht 1850 oder 12024')).toEqual([2023, 2024]);
    expect(mentionedYears('no year')).toEqual([]);
  });
});
