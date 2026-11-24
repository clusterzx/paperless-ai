import { afterEach, describe, expect, it } from 'vitest';
import { localDay } from '../../src/shared/dates.js';
import { parseDateRange } from '../../src/shared/searchSyntax.js';
import { takeDateRanges } from '../../src/server/ngx/format.js';

// 00:30 in Berlin on 25 November is 23:30 UTC on the 24th – the hour that showed the wrong day (#1036).
const AFTER_MIDNIGHT_BERLIN = new Date('2026-11-24T23:30:00Z');
const original = process.env.TZ;
const inZone = (tz: string) => {
  process.env.TZ = tz;
};
afterEach(() => {
  if (original === undefined) delete process.env.TZ;
  else process.env.TZ = original;
});

describe('local calendar days', () => {
  it('gives the day of the time zone, not of UTC', () => {
    inZone('Europe/Berlin');
    expect(localDay(AFTER_MIDNIGHT_BERLIN)).toBe('2026-11-25');
    inZone('UTC');
    expect(localDay(AFTER_MIDNIGHT_BERLIN)).toBe('2026-11-24');
    inZone('America/New_York');
    expect(localDay(AFTER_MIDNIGHT_BERLIN)).toBe('2026-11-24');
    expect(localDay(new Date('2026-01-05T03:00:00Z'))).toBe('2026-01-04');
  });

  it('reads today and yesterday of the search syntax in the local day', () => {
    inZone('Europe/Berlin');
    expect(parseDateRange('today', AFTER_MIDNIGHT_BERLIN)).toEqual({ from: '2026-11-25', to: '2026-11-25' });
    expect(parseDateRange('gestern', AFTER_MIDNIGHT_BERLIN)).toEqual({ from: '2026-11-24', to: '2026-11-24' });
  });

  it('reads now and relative days of the Paperless-ngx apps in the local day', () => {
    inZone('Europe/Berlin');
    expect(takeDateRanges('created:[-1 day to now]', AFTER_MIDNIGHT_BERLIN).created).toEqual({ from: '2026-11-24', to: '2026-11-25' });
    expect(takeDateRanges('added:[-1 month to today]', AFTER_MIDNIGHT_BERLIN).added).toEqual({ from: '2026-10-25', to: '2026-11-25' });
  });
});
