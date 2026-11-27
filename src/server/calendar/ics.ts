/**
 * iCalendar (RFC 5545) feed of the dates found in documents – for Google Calendar, Apple Calendar,
 * Outlook, Thunderbird and every other app that can subscribe to a calendar by URL.
 */
import type { EventKind } from '../../shared/api.js';

export interface IcsEvent {
  id: number;
  documentId: number;
  documentTitle: string | null;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM or null (all day) */
  time: string | null;
  kind: EventKind;
  url: string;
}

const KIND_LABEL: Record<EventKind, string> = {
  appointment: 'Appointment',
  due: 'Payment due',
  deadline: 'Deadline',
  expiry: 'Expiry / renewal',
  other: 'Date',
};

/**
 * Text values: backslash, semicolon, comma and line breaks (also a lone CR, which some readers take
 * as the end of the line) are escaped; other control characters are dropped – a text from a
 * document can never start a property of its own.
 */
export function escapeText(value: string): string {
  return (
    value
      .replace(/\\/g, '\\\\')
      .replace(/;/g, String.raw`\;`)
      .replace(/,/g, '\\,')
      .replace(/\r\n|\r|\n|\u2028|\u2029/g, '\\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  );
}

/** Lines longer than 75 octets are folded (continuation lines start with a space), never inside a UTF-8 character. */
export function foldLine(line: string): string {
  const out: string[] = [];
  let current = '';
  let size = 0;
  for (const ch of line) {
    const bytes = Buffer.byteLength(ch);
    if (size + bytes > (out.length ? 74 : 75)) {
      out.push(current);
      current = '';
      size = 0;
    }
    current += ch;
    size += bytes;
  }
  out.push(current);
  return out.join('\r\n ');
}

const compactDate = (date: string) => date.replace(/-/g, '');
const utcStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

export function buildIcs(events: IcsEvent[], opts: { name?: string; now?: number } = {}): string {
  const stamp = utcStamp(opts.now ?? Date.now());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Paperless-AI//Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(opts.name ?? 'Paperless-AI')}`,
    'X-WR-CALDESC:Appointments and deadlines found in your documents',
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];
  for (const e of events) {
    const description = [`${KIND_LABEL[e.kind]} – from document #${e.documentId}${e.documentTitle ? ` “${e.documentTitle}”` : ''}`, e.url].join('\n');
    lines.push('BEGIN:VEVENT', `UID:paperless-ai-event-${e.id}@paperless-ai`, `DTSTAMP:${stamp}`);
    if (e.time) {
      // Floating local time: shown at the time written in the document, wherever the calendar is.
      const start = `${compactDate(e.date)}T${e.time.replace(':', '')}00`;
      lines.push(`DTSTART:${start}`, 'DURATION:PT1H');
    } else {
      lines.push(`DTSTART;VALUE=DATE:${compactDate(e.date)}`, `DTEND;VALUE=DATE:${compactDate(nextDay(e.date))}`, 'TRANSP:TRANSPARENT');
    }
    lines.push(`SUMMARY:${escapeText(e.title)}`, `DESCRIPTION:${escapeText(description)}`, `URL:${e.url}`, `CATEGORIES:${escapeText(KIND_LABEL[e.kind])}`);
    // A reminder one day before payments, deadlines and expiry dates (apps may ignore alarms of subscribed calendars).
    if (e.kind === 'due' || e.kind === 'deadline' || e.kind === 'expiry') {
      lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${escapeText(e.title)}`, 'TRIGGER:-P1D', 'END:VALARM');
    }
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}
