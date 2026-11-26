/** OCR engine stand-in for tests: returns a configurable text instead of running PaddleOCR. */
import type { OcrEngine, OcrProgress, OcrResult } from '../../src/server/ocr/runner.js';
import type { RenderOptions } from '../../src/server/ocr/render.js';
import type { LayoutLine } from '../../src/server/ocr/textLayer.js';

/** One text line after the other from the top of the page, 3 % of the page high. */
export function fakeLayout(text: string): LayoutLine[] {
  return text
    .split('\n')
    .filter((t) => t.trim())
    .map((t, i) => {
      const top = 0.1 + i * 0.04;
      return { text: t.trim(), box: [0.1, top, 0.9, top, 0.9, top + 0.03, 0.1, top + 0.03] };
    });
}

export class FakeOcrEngine implements OcrEngine {
  /** Text returned for the next runs (a function gets the bytes of the file). */
  text: string | ((bytes: Uint8Array) => string) = 'Rechnung Nr. 4711 der Stadtwerke Musterstadt über 106,72 EUR vom 03.11.2026';
  /** Throw this instead of returning a result. */
  error: Error | null = null;
  pages = 1;
  /** Characters of the text layer each page already has. */
  textChars = 0;
  readonly calls: { bytes: Uint8Array; render: RenderOptions }[] = [];
  provider: string | null = null;
  disposed = 0;

  async run(bytes: Uint8Array, render: RenderOptions, onProgress?: OcrProgress): Promise<OcrResult> {
    this.calls.push({ bytes, render });
    for (let p = 1; p <= this.pages; p++) onProgress?.(p, this.pages);
    if (this.error) throw this.error;
    this.provider = 'cpu';
    const text = typeof this.text === 'function' ? this.text(bytes) : this.text;
    return {
      text,
      pages: Array.from({ length: this.pages }, () => ({
        text,
        lines: 3,
        layout: { lines: fakeLayout(text), textChars: this.textChars },
        meanScore: 0.97,
        rotation: 0,
        width: 1000,
        height: 1400,
        ms: 5,
      })),
      totalPages: this.pages,
      provider: 'cpu',
      durationMs: 12,
      meanScore: 0.97,
    };
  }

  async dispose(): Promise<void> {
    this.disposed++;
  }
}
