import { describe, expect, it } from 'vitest';
import { chunkText } from '../../src/server/rag/chunker.js';

function paragraphText(paragraphs: number, sentencesPer = 6): string {
  let n = 0;
  return Array.from({ length: paragraphs }, () =>
    Array.from({ length: sentencesPer }, () => `Sentence number ${++n} talks about topic ${n % 7} in some detail.`).join(' '),
  ).join('\n\n');
}

describe('chunkText', () => {
  it('returns nothing for empty text', () => {
    expect(chunkText('')).toEqual([]);
    expect(chunkText('  \n\n \t ')).toEqual([]);
  });

  it('keeps short text as a single normalised chunk', () => {
    expect(chunkText('  Hello   world \n\n\n\n second  ')).toEqual(['Hello world\n\nsecond']);
    const almost = 'x '.repeat(700); // 1400 chars < 1.25 × 1200
    expect(chunkText(almost)).toHaveLength(1);
  });

  it('splits long text into bounded, overlapping chunks covering everything', () => {
    const text = paragraphText(30);
    const size = 1200;
    const overlap = 200;
    const chunks = chunkText(text, { size, overlap });
    expect(chunks.length).toBeGreaterThan(5);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(size + overlap + size * 0.25 + 2);
      expect(c).toBe(c.trim());
    }
    // every sentence ends up in at least one chunk
    const sentences = text.split(/(?<=\.)\s+/);
    for (const s of sentences) expect(chunks.some((c) => c.includes(s.trim()))).toBe(true);
    // consecutive chunks share some text (overlap)
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-60).split(' ').slice(1, 4).join(' ');
      expect(chunks[i].includes(tail)).toBe(true);
    }
  });

  it('prefers paragraph boundaries', () => {
    const paragraphs = Array.from({ length: 6 }, (_, i) => `Paragraph ${i}: ${'lorem ipsum '.repeat(40).trim()}.`);
    const chunks = chunkText(paragraphs.join('\n\n'), { size: 1000, overlap: 0 });
    for (const c of chunks) expect(c.startsWith('Paragraph')).toBe(true);
  });

  it('splits text without separators by size', () => {
    const blob = 'a'.repeat(5000);
    const chunks = chunkText(blob, { size: 1000, overlap: 0 });
    expect(chunks.join('')).toBe(blob);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
  });

  it('respects maxChunks', () => {
    const chunks = chunkText(paragraphText(100), { size: 300, overlap: 50, maxChunks: 7 });
    expect(chunks).toHaveLength(7);
  });

  it('merges a tiny trailing piece into the previous chunk', () => {
    const text = `${'word '.repeat(400).trim()}.\n\nEnd.`;
    const chunks = chunkText(text, { size: 1000, overlap: 100 });
    expect(chunks[chunks.length - 1].endsWith('End.')).toBe(true);
    expect(chunks[chunks.length - 1].length).toBeGreaterThan(100);
  });
});
