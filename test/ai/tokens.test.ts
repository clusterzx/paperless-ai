import { describe, expect, it } from 'vitest';
import { estimateTokens, normalizeContent, truncateToTokens } from '../../src/server/ai/tokens.js';

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('estimates ~3.4 letters per token for latin text', () => {
    expect(estimateTokens('a'.repeat(34))).toBe(10);
    expect(estimateTokens('abcd')).toBe(2);
    // prose: within a few tokens of real tokenizers (cl100k: 10, Llama 3: 10)
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBeGreaterThanOrEqual(10);
    expect(estimateTokens('The quick brown fox jumps over the lazy dog.')).toBeLessThanOrEqual(12);
  });

  it('counts digits, CJK characters and symbols as roughly one token each', () => {
    const cjk = '漢字かなカナ한국어'; // 9 CJK chars
    expect(estimateTokens(cjk)).toBe(9);
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens('abcdefghi') * 2);
    // many local models split numbers into single digits
    expect(estimateTokens('1234567890')).toBe(10);
    expect(estimateTokens('IBAN DE89 3704 0044 0532 0130 00')).toBeGreaterThanOrEqual(22);
    expect(estimateTokens('€€€')).toBe(3);
    // other alphabets need more tokens than ASCII
    expect(estimateTokens('Привет мир')).toBeGreaterThan(estimateTokens('Hello wrld'));
  });

  it('handles emoji and other astral characters', () => {
    expect(estimateTokens('👍')).toBe(2);
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

  it('never splits a surrogate pair', () => {
    const res = truncateToTokens('ab👍👍👍👍', 3);
    expect(res.truncated).toBe(true);
    expect(res.text).toBe('ab👍');
  });

  it('truncates CJK text by its own weight', () => {
    const res = truncateToTokens('漢'.repeat(100), 40);
    expect(res.text).toHaveLength(40);
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
