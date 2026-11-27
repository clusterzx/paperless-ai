import { describe, expect, it } from 'vitest';
import { globMatch, regexTest } from '../../src/server/util/patterns.js';

describe('globMatch', () => {
  it('matches * and ? like before, case-insensitive', () => {
    expect(globMatch('scan-*.pdf', 'Scan-2024-01.PDF')).toBe(true);
    expect(globMatch('scan-*.pdf', 'scan-1.pdf.txt')).toBe(false);
    expect(globMatch('rechnung_??.pdf', 'Rechnung_07.pdf')).toBe(true);
    expect(globMatch('rechnung_??.pdf', 'Rechnung_7.pdf')).toBe(false);
    expect(globMatch('*', '')).toBe(true);
    expect(globMatch('a.b(c)[d]+', 'A.B(C)[D]+')).toBe(true);
    expect(globMatch('*.pdf', 'x.pdfx')).toBe(false);
    expect(globMatch('*a*b*', 'xxaxxbxx')).toBe(true);
  });

  it('takes no time for patterns with many stars', () => {
    const started = Date.now();
    expect(globMatch(`${'*a'.repeat(40)}*b`, 'a'.repeat(5000))).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('regexTest', () => {
  it('tests like RegExp.test', () => {
    expect(regexTest(/rechnung\s+\d+/iu, 'Die RECHNUNG 42 ist da')).toBe(true);
    expect(regexTest(/rechnung\s+\d+/iu, 'Keine')).toBe(false);
    const g = /a/g;
    expect(regexTest(g, 'a')).toBe(true);
    expect(regexTest(g, 'a')).toBe(true);
  });

  it('gives up on catastrophic expressions instead of blocking the server', () => {
    const started = Date.now();
    expect(() => regexTest(/^(a+)+$/u, `${'a'.repeat(40)}!`, 200)).toThrow(/longer than 200 ms/);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
