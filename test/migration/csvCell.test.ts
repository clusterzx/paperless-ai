import { describe, expect, it } from 'vitest';
import { csvCell } from '../../src/server/migration/export.js';

describe('csvCell', () => {
  it('quotes separators and keeps plain values', () => {
    expect(csvCell('Stromrechnung März')).toBe('Stromrechnung März');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell(['A', 'B'])).toBe('"A; B"');
    expect(csvCell(null)).toBe('');
  });

  it('never lets a spreadsheet run a value as a formula', () => {
    expect(csvCell('=HYPERLINK("https://evil.example","Klick")')).toBe(`"'=HYPERLINK(""https://evil.example"",""Klick"")"`);
    expect(csvCell('+1+cmd')).toBe("'+1+cmd");
    expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(csvCell('-2+3')).toBe("'-2+3");
    // Numbers stay numbers.
    expect(csvCell('-12.50')).toBe('-12.50');
    expect(csvCell(42)).toBe('42');
  });
});
