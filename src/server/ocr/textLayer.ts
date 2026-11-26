/**
 * Where the OCR found each line, for the invisible text layer of a searchable PDF: corners in
 * fractions of the page as it is shown (0…1, origin top left, y down), in reading order. This is
 * independent of the render resolution and of the rotation the OCR applied to read the page.
 */
import type { Quad } from './image.js';
import type { OcrLine } from './layout.js';

/** x0,y0 … x3,y3: top left, top right, bottom right, bottom left of the line as it is read. */
export type LineBox = [number, number, number, number, number, number, number, number];

export interface LayoutLine {
  text: string;
  box: LineBox;
}

export interface PageLayout {
  lines: LayoutLine[];
  /** Characters (without white space) of the text the page already had (PDF text layer). */
  textChars: number;
}

/**
 * Map the lines of a page read by the pipeline back onto the page as rendered: the pipeline turned
 * the page by `rotation`° clockwise before reading it, `width`×`height` is the size of the rendered
 * page (before that turn).
 */
export function layoutLines(lines: OcrLine[], rotation: number, width: number, height: number): LayoutLine[] {
  const turns = ((Math.round(rotation / 90) % 4) + 4) % 4;
  // Inverse of rotate90: a point of the turned image → the same point of the rendered page.
  const back = ([x, y]: [number, number]): [number, number] => {
    if (turns === 1) return [y, height - x];
    if (turns === 2) return [width - x, height - y];
    if (turns === 3) return [width - y, x];
    return [x, y];
  };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  const out: LayoutLine[] = [];
  for (const line of lines) {
    const text = line.text.trim();
    if (!text) continue;
    const k = line.turn ?? 0;
    const corners = [0, 1, 2, 3].map((i) => line.quad[(i + k) % 4]) as Quad;
    const box = corners.flatMap((p) => {
      const [x, y] = back(p);
      return [clamp(x / width), clamp(y / height)];
    }) as LineBox;
    out.push({ text, box });
  }
  return out;
}
