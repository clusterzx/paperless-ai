import { describe, expect, it } from 'vitest';
import { buildIcs, escapeText, foldLine, type IcsEvent } from '../../src/server/calendar/ics.js';

const base: IcsEvent = { id: 7, documentId: 42, documentTitle: 'Stromrechnung März', title: 'Pay invoice SR-0412', date: '2024-04-30', time: null, kind: 'due', url: 'http://paperless/documents/42/details' };

describe('iCal feed', () => {
  it('writes all-day and timed events with reminders for payments and deadlines', () => {
    const ics = buildIcs(
      [base, { ...base, id: 8, title: 'Termin Hautarzt, Dr. Weiß; Raum 2', date: '2024-05-02', time: '09:30', kind: 'appointment' }],
      { now: Date.UTC(2024, 3, 1, 12, 0, 0) },
    );
    const lines = ics.split('\r\n');
    expect(lines[0]).toBe('BEGIN:VCALENDAR');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(lines).toContain('PRODID:-//Paperless-AI//Calendar//EN');
    expect(lines).toContain('UID:paperless-ai-event-7@paperless-ai');
    expect(lines).toContain('DTSTAMP:20240401T120000Z');
    // all day: DTEND is the next day (exclusive)
    expect(lines).toContain('DTSTART;VALUE=DATE:20240430');
    expect(lines).toContain('DTEND;VALUE=DATE:20240501');
    expect(lines).toContain('TRIGGER:-P1D');
    // timed: floating local time, one hour, no reminder for appointments
    expect(lines).toContain('DTSTART:20240502T093000');
    expect(lines).toContain('DURATION:PT1H');
    expect(lines).toContain(String.raw`SUMMARY:Termin Hautarzt\, Dr. Weiß\; Raum 2`);
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(1);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain('URL:http://paperless/documents/42/details');
  });

  it('escapes text and folds long lines without splitting characters', () => {
    expect(escapeText('a\\b;c,d\ne')).toBe(String.raw`a\\b\;c\,d\ne`);
    // A lone CR (or another control character) never starts a property of its own.
    expect(escapeText('Rechnung\rATTENDEE:mailto:x@example.org\u0000\u2028Ende')).toBe(String.raw`Rechnung\nATTENDEE:mailto:x@example.org\nEnde`);
    const long = `SUMMARY:${'ä'.repeat(60)}`;
    const folded = foldLine(long);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.split('\r\n').map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(long);
    expect(foldLine('short')).toBe('short');
  });

  it('is an empty but valid calendar without events', () => {
    expect(buildIcs([])).toMatch(/^BEGIN:VCALENDAR\r\n[\s\S]*END:VCALENDAR\r\n$/);
  });
});
