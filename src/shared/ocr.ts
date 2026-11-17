/**
 * OCR options shared by the server (configuration schema) and the web UI.
 * Plain constants only – no server code.
 */

export const OCR_LANGUAGES = ['latin', 'en', 'multi', 'cyrillic', 'eslav', 'greek', 'arabic', 'devanagari', 'korean', 'thai', 'tamil', 'telugu'] as const;
export type OcrLanguage = (typeof OCR_LANGUAGES)[number];

export const OCR_LANGUAGE_LABELS: Record<OcrLanguage, string> = {
  latin: 'Latin script – German, English, French, Spanish, Italian, Dutch, Polish, … (30+ languages)',
  en: 'English only',
  multi: 'Chinese, English, Japanese',
  cyrillic: 'Cyrillic – Russian, Bulgarian, Serbian, …',
  eslav: 'East Slavic – Russian, Ukrainian, Belarusian',
  greek: 'Greek',
  arabic: 'Arabic script',
  devanagari: 'Devanagari – Hindi, Marathi, Nepali, …',
  korean: 'Korean',
  thai: 'Thai',
  tamil: 'Tamil',
  telugu: 'Telugu',
};

/**
 * When OCR runs on its own:
 * - manual: only when started on the OCR page (or via API)
 * - missing: before the AI analysis when a document has no text
 * - poor: before the AI analysis when the text is missing or looks garbled
 * - always: before every AI analysis
 */
export const OCR_MODES = ['manual', 'missing', 'poor', 'always'] as const;
export type OcrMode = (typeof OCR_MODES)[number];

export const OCR_QUALITY = ['fast', 'balanced', 'accurate'] as const;
export type OcrQuality = (typeof OCR_QUALITY)[number];

/** Rendering resolution, detector size and detection model per quality preset. */
export const OCR_QUALITY_PRESETS: Record<OcrQuality, { dpi: number; detMaxSide: number; detector: 'mobile' | 'server'; label: string }> = {
  fast: { dpi: 150, detMaxSide: 1280, detector: 'mobile', label: 'Fast – good for clean scans and large print' },
  balanced: { dpi: 200, detMaxSide: 1920, detector: 'mobile', label: 'Balanced – recommended' },
  accurate: { dpi: 300, detMaxSide: 2560, detector: 'server', label: 'Accurate – small print and difficult scans (larger model, slow on CPU)' },
};

export const OCR_DEVICES = ['auto', 'cpu', 'cuda'] as const;
export type OcrDevice = (typeof OCR_DEVICES)[number];

/**
 * When the OCR models are unloaded – the OCR process ends and gives all of its memory back:
 * - auto: on the GPU right after each document (before the AI analysis, so that a local model on
 *   the same GPU gets the memory), on the CPU after 10 minutes without OCR
 * - document: right after each document
 * - idle: after 10 minutes without OCR (fastest for many documents)
 */
export const OCR_RELEASE = ['auto', 'document', 'idle'] as const;
export type OcrRelease = (typeof OCR_RELEASE)[number];

export const OCR_RELEASE_LABELS: Record<OcrRelease, string> = {
  auto: 'Automatic – GPU: after each document',
  document: 'After each document',
  idle: 'After 10 idle minutes',
};
