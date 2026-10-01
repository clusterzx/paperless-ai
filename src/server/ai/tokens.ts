/**
 * Fast, dependency-free token estimation.
 *
 * Exact tokenisation differs per model family anyway (OpenAI, Llama, Mistral,
 * Gemma …), so we use a calibrated character heuristic: ~4 chars/token for
 * Latin text, ~1.5 for CJK. The truncation helpers use a conservative ratio so
 * prompts never overflow the context window.
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/g;

export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = text.match(CJK)?.length ?? 0;
  const rest = text.length - cjk;
  // Whitespace-heavy OCR output tokenises more efficiently; numbers/punctuation less.
  return Math.ceil(rest / 3.6 + cjk / 1.5);
}

/** Truncate text so that it fits into roughly `maxTokens` tokens. */
export function truncateToTokens(text: string, maxTokens: number): { text: string; truncated: boolean } {
  if (maxTokens <= 0) return { text: '', truncated: text.length > 0 };
  if (estimateTokens(text) <= maxTokens) return { text, truncated: false };
  // Binary search on the character length (estimate is monotonic).
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  // Avoid cutting in the middle of a word.
  let cut = text.slice(0, lo);
  const lastBreak = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf(' '));
  if (lastBreak > lo * 0.9) cut = cut.slice(0, lastBreak);
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
