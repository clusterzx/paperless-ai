import { describe, expect, it } from 'vitest';
import { logTimestamp } from '../../src/server/logger.js';

describe('log time stamps (#1036)', () => {
  const d = new Date('2026-11-24T23:30:00Z');

  it('takes date and time from one clock and gives the offset', () => {
    // Europe/Berlin in winter: already the next day.
    expect(logTimestamp(d, 60)).toBe('2026-11-25 00:30:00 +01:00');
    expect(logTimestamp(d, 0)).toBe('2026-11-24 23:30:00 +00:00');
    expect(logTimestamp(d, -300)).toBe('2026-11-24 18:30:00 -05:00');
    expect(logTimestamp(d, 330)).toBe('2026-11-25 05:00:00 +05:30');
    expect(logTimestamp(new Date('2026-07-01T22:15:09Z'), 120)).toBe('2026-07-02 00:15:09 +02:00');
  });

  it('uses the time zone of the process by default', () => {
    const offset = -d.getTimezoneOffset();
    expect(logTimestamp(d)).toBe(logTimestamp(d, offset));
    // Date and time agree: shifting back by the offset gives the instant again.
    const [date, time] = logTimestamp(d).split(' ');
    expect(new Date(`${date}T${time}Z`).getTime() - offset * 60_000).toBe(d.getTime());
  });
});
