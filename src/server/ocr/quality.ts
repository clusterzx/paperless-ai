/**
 * Heuristic quality score of a document's text (as delivered by Paperless).
 * It flags documents whose text is missing, too thin for the number of pages
 * or full of OCR garbage, so they can be re-read with PaddleOCR.
 */
import type { TextQuality } from '../../shared/api.js';

/** Fewer visible characters than this means "no text". */
export const MISSING_CHARS = 20;

const WORD = /^[(["'„“‚‘«]*[\p{L}][\p{L}\p{M}'’-]*[\p{L}\p{M}][.,:;!?)\]"'“”‘’»]*$/u;
const NUMBER = /^[([]*[-+]?[€$£¥]?\d[\d.,:/'%€$£¥-]*[)\].,:;]*$/u;
const CODE = /^[\p{L}\d][\p{L}\d./_@#&+-]*[\p{L}\d]$/u;
const VOWELS = /[aeiouyäöüàáâãåæèéêëìíîïòóôõøùúûýÿœ]/i;
const LATIN = /\p{Script=Latin}/u;

/** Score 0–100 and a level for the text of a document. `pages` improves the "too little text" check. */
export function assessText(content: string | null | undefined, pages?: number | null, poorBelow = 50): TextQuality {
  const text = (content ?? '').replaceAll('\u0000', '');
  const visible = text.replace(/\s+/g, '');
  const chars = visible.length;
  if (chars < MISSING_CHARS) {
    return { score: 0, level: 'missing', reasons: [chars ? 'Almost no text' : 'No text'], chars, words: 0 };
  }
  const tokens = text.split(/\s+/).filter(Boolean);
  let words = 0;
  let plausible = 0;
  let singles = 0;
  let noVowel = 0;
  let latinWords = 0;
  for (const t of tokens) {
    if (t.length === 1) {
      // Single letters/digits are normal in moderation (initials, "a", "&", list numbers).
      singles++;
      if (/[\p{L}\d&§%€$]/u.test(t)) plausible += 0.5;
      continue;
    }
    if (WORD.test(t)) {
      words++;
      const letters = t.replace(/[^\p{L}]/gu, '');
      if (LATIN.test(letters)) {
        latinWords++;
        if (letters.length >= 4 && !VOWELS.test(letters)) {
          noVowel++;
          continue;
        }
      }
      plausible++;
    } else if (NUMBER.test(t) || CODE.test(t)) plausible++;
  }
  const n = tokens.length;
  const plausibleRatio = plausible / n;
  const singleRatio = singles / n;
  const noVowelRatio = latinWords ? noVowel / latinWords : 0;
  const odd = visible.replace(/[\p{L}\p{M}\p{N}.,:;!?()[\]"'„“”‚‘’«»/&%€$£§@#+*=_-]/gu, '').length;
  const oddRatio = odd / chars;
  const replacement = (text.match(/�/g) ?? []).length / chars;

  let score = 100 * plausibleRatio;
  const reasons: string[] = [];
  if (plausibleRatio < 0.7) reasons.push(`${Math.round((1 - plausibleRatio) * 100)} % of the words look garbled`);
  if (singleRatio > 0.25) {
    score -= (singleRatio - 0.25) * 80;
    reasons.push('Many stray single characters');
  }
  if (noVowelRatio > 0.15) {
    score -= (noVowelRatio - 0.15) * 60;
    reasons.push('Many words without vowels');
  }
  if (oddRatio > 0.08 || replacement > 0.01) {
    score -= Math.min(40, (oddRatio - 0.08) * 150 + replacement * 500);
    reasons.push('Many unusual symbols');
  }
  if (pages && pages > 0) {
    const perPage = chars / pages;
    if (perPage < 150) {
      score -= Math.min(40, (150 - perPage) / 3);
      reasons.push(`Little text for ${pages} page${pages === 1 ? '' : 's'} (${Math.round(perPage)} characters per page)`);
    }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const level = score < poorBelow ? 'poor' : score < 75 ? 'fair' : 'good';
  return { score, level, reasons, chars, words };
}
