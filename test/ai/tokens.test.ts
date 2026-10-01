import { describe, expect, it } from 'vitest';
import { estimateTokens, normalizeContent, truncateToTokens } from '../../src/server/ai/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~3.6 characters per token for latin text', () => {
    expect(estimateTokens('a'.repeat(36))).toBe(10);
    expect(estimateTokens('abcd')).toBe(2);
  });

  it('counts CJK characters more expensively', () => {
    const cjk = '漢字かなカナ한국어'; // 9 CJK chars
    expect(estimateTokens(cjk)).toBe(Math.ceil(9 / 1.5));
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens('abcdefghi'));
  });

  it('is monotonic in the text length', () => {
    let prev = 0;
    for (let n = 0; n < 200; n += 7) {
      const t = estimateTokens('x'.repeat(n));
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});

describe('truncateToTokens', () => {
  const text = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');

  it('keeps short text unchanged', () => {
    expect(truncateToTokens('short text', 100)).toEqual({ text: 'short text', truncated: false });
  });

  it('truncates to the token budget', () => {
    for (const budget of [1, 10, 50, 333]) {
      const res = truncateToTokens(text, budget);
      expect(res.truncated).toBe(true);
      expect(estimateTokens(res.text)).toBeLessThanOrEqual(budget);
      expect(text.startsWith(res.text)).toBe(true);
    }
  });

  it('does not cut in the middle of a word', () => {
    const res = truncateToTokens(text, 100);
    expect(res.text.endsWith(' ')).toBe(false);
    const lastWord = res.text.split(' ').pop()!;
    expect(text.split(' ')).toContain(lastWord);
  });

  it('returns empty text for a zero budget', () => {
    expect(truncateToTokens('abc', 0)).toEqual({ text: '', truncated: true });
    expect(truncateToTokens('', 0)).toEqual({ text: '', truncated: false });
  });
});

describe('normalizeContent', () => {
  it('collapses whitespace, blank lines and control characters', () => {
    expect(normalizeContent('  a \t b\u0000c \n\n\n\n d  \n e ')).toBe('a b c\n\nd\ne');
  });

  it('handles null-ish input', () => {
    expect(normalizeContent(undefined as unknown as string)).toBe('');
  });
});
