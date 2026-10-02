/**
 * Fast, dependency-free token estimation.
 *
 * Exact tokenisation differs per model family anyway (OpenAI, Llama, Qwen,
 * Mistral, Gemma …), so every character is weighted by its class. The weights
 * are on the safe side for the common local models: many of them (Qwen,
 * Mistral, Gemma) split numbers into single digits and need about one token
 * per CJK character, which a flat "4 characters per token" rule undercounts
 * by a factor of two – and an overflowing prompt is silently cut by the server.
 */

const LETTER = 1 / 3.4; // ASCII letters – words incl. the space in front of them
const DIGIT = 1;
const PUNCT = 0.6;
const SPACE = 0.05;
const NEWLINE = 0.5;
const ACCENTED = 1 / 2.5; // other alphabets: Latin with diacritics, Cyrillic, Greek, Hebrew, Arabic …
const DENSE = 0.8; // Thai, Indic scripts
const CJK = 1;
const SYMBOL = 1; // typographic punctuation, currency signs, arrows, box drawing …

/** Estimated tokens for one UTF-16 code unit. */
function cost(c: number): number {
  if (c < 0x80) {
    if ((c >= 0x61 && c <= 0x7a) || (c >= 0x41 && c <= 0x5a)) return LETTER;
    if (c >= 0x30 && c <= 0x39) return DIGIT;
    if (c === 0x20) return SPACE;
    if (c === 0x0a) return NEWLINE;
    if (c === 0x09 || c === 0x0d) return SPACE;
    return PUNCT;
  }
  if (c < 0x0900) return c >= 0xa0 && c < 0xc0 ? SYMBOL : ACCENTED;
  if (c < 0x0e80) return DENSE;
  if (c >= 0x2000 && c < 0x2c00) return SYMBOL;
  if ((c >= 0x3000 && c < 0xa000) || (c >= 0xac00 && c < 0xd7b0) || (c >= 0xf900 && c < 0xfb00) || (c >= 0xff00 && c < 0xfff0)) return CJK;
  if (c >= 0xd800 && c < 0xdc00) return CJK; // first half of an emoji / rare CJK character
  if (c >= 0xdc00 && c < 0xe000) return 0.5;
  return ACCENTED;
}

/** Round up, ignoring floating point noise (34 × 1/3.4 = 10.000000000000002). */
const round = (sum: number) => Math.ceil(sum - 1e-9);

export function estimateTokens(text: string): number {
  if (!text) return 0;
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum += cost(text.charCodeAt(i));
  return round(sum);
}

/** Truncate text so that it fits into roughly `maxTokens` tokens. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 };
  // Single pass: stop at the first character that no longer fits.
  let sum = 0;
  let end = text.length;
  for (let i = 0; i < text.length; i++) {
    sum += cost(text.charCodeAt(i));
    if (round(sum) > maxTokens) {
      end = i;
      break;
    }
  }
  if (end === text.length) return { text, truncated: false };
  // Do not split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code < 0xdc00) end--;
  // Avoid cutting in the middle of a word.
  let cut = text.slice(0, end);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (lastBreak > end * 0.9) cut = cut.slice(0, lastBreak);
  return { text: cut, truncated: true };
}

/** Normalise OCR text: collapse runs of whitespace, drop control chars. */
export function normalizeContent(text: string): string {
  return (text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
