import { describe, expect, it } from 'vitest';
import { isCountQuestion, mentionedNames } from '../../src/server/rag/facts.js';

describe('isCountQuestion', () => {
  it('recognises counting questions in several languages', () => {
    for (const q of ['How many invoices do I have?', 'Wie viele Rechnungen gibt es?', 'Wieviele Briefe?', 'Anzahl der Verträge', 'Combien de factures ?', '¿Cuántas facturas tengo?', 'Hoeveel facturen?']) {
      expect(isCountQuestion(q), q).toBe(true);
    }
    for (const q of ['What is my IBAN?', 'How much was the electricity bill?', 'Show the account number']) {
      expect(isCountQuestion(q), q).toBe(false);
    }
  });
});

describe('mentionedNames', () => {
  const items = [{ name: 'Invoice' }, { name: 'Rechnung' }, { name: 'ACME Corp' }, { name: 'AB' }, { name: 'Car' }];
  it('finds names as words, also in simple plural forms', () => {
    expect(mentionedNames('How many invoices from acme corp?', items).map((i) => i.name)).toEqual(['Invoice', 'ACME Corp']);
    expect(mentionedNames('Wie viele Rechnungen?', items).map((i) => i.name)).toEqual(['Rechnung']);
  });

  it('ignores very short names and parts of other words', () => {
    expect(mentionedNames('AB tests about my cartoon collection', items)).toEqual([]);
  });
});
