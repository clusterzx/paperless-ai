/**
 * Splits document text into overlapping passages along natural boundaries
 * (paragraphs → lines → sentences → words).
 */
import { normalizeContent } from '../ai/tokens.js';

export interface ChunkOptions {
  /** Target size in characters (~4 chars per token). */
  size?: number;
  /** Overlap between consecutive chunks in characters. */
  overlap?: number;
  /** Hard cap for the number of chunks per document (very long documents). */
  maxChunks?: number;
}

const DEFAULTS: Required<ChunkOptions> = { size: 1200, overlap: 200, maxChunks: 400 };

const SEPARATORS = ['\n\n', '\n', '. ', '? ', '! ', '; ', ', ', ' '];

function splitRecursive(text: string, size: number, level = 0): string[] {
  if (text.length <= size) return [text];
  const sep = SEPARATORS[level];
  if (sep === undefined) {
    const out: string[] = [];
    for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
    return out;
  }
  const parts = text.split(sep);
  if (parts.length === 1) return splitRecursive(text, size, level + 1);
  const pieces: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const piece = i < parts.length - 1 ? parts[i] + sep : parts[i];
    if (piece.length > size) pieces.push(...splitRecursive(piece, size, level + 1));
    else if (piece) pieces.push(piece);
  }
  return pieces;
}

export function chunkText(input: string, options: ChunkOptions = {}): string[] {
  const { size, overlap, maxChunks } = { ...DEFAULTS, ...options };
  const text = normalizeContent(input);
  if (!text) return [];
  if (text.length <= size * 1.25) return [text];

  const pieces = splitRecursive(text, size);
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + piece.length > size) {
      chunks.push(current.trim());
      if (chunks.length >= maxChunks) return chunks;
      // Start the next chunk with the tail of the previous one for context continuity.
      let tail = overlap > 0 ? current.slice(-overlap) : '';
      const cut = tail.search(/\s/);
      if (cut > 0 && cut < tail.length - 1) tail = tail.slice(cut + 1);
      current = tail + piece;
    } else {
      current += piece;
    }
  }
  if (current.trim()) {
    // Merge a tiny trailing chunk into the previous one.
    if (chunks.length && current.trim().length < size * 0.25) chunks[chunks.length - 1] = `${chunks[chunks.length - 1]} ${current.trim()}`;
    else chunks.push(current.trim());
  }
  return chunks.slice(0, maxChunks);
}
