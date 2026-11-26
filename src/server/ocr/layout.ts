/**
 * Turn recognised text boxes into plain text in reading order: boxes on the
 * same visual line are joined left to right, larger vertical gaps become
 * paragraph breaks. A slightly skewed scan is straightened first, otherwise
 * the words at the right end of a line drift into the next line.
 */
import type { Quad } from './image.js';

export interface OcrLine {
  text: string;
  score: number;
  /** Corners clockwise from the top left of the region (as found on the page). */
  quad: Quad;
  /**
   * Corners to move the start of `quad` by to get them in reading order (0…3): 1 for vertical text
   * (read turned by 90°), 2 for a line read upside down.
   */
  turn?: number;
}

interface Box {
  text: string;
  x0: number;
  x1: number;
  cy: number;
  h: number;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** Dominant text angle (radians) from the top edges of wide boxes. */
export function skewAngle(lines: OcrLine[]): number {
  const angles = lines
    .map((l) => {
      const [tl, tr, , bl] = l.quad;
      const w = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]);
      const h = Math.hypot(bl[0] - tl[0], bl[1] - tl[1]);
      return w > 2 * h ? Math.atan2(tr[1] - tl[1], tr[0] - tl[0]) : null;
    })
    .filter((a): a is number => a !== null && Math.abs(a) < Math.PI / 8);
  return angles.length ? median(angles) : 0;
}

export function linesToText(lines: OcrLine[]): string {
  const angle = skewAngle(lines);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const boxes: Box[] = lines
    .filter((l) => l.text.trim())
    .map((l) => {
      // Coordinates of the straightened page.
      const pts = l.quad.map(([x, y]) => [x * cos - y * sin, x * sin + y * cos]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      const y0 = Math.min(...ys);
      const y1 = Math.max(...ys);
      return { text: l.text.trim(), x0: Math.min(...xs), x1: Math.max(...xs), cy: (y0 + y1) / 2, h: Math.max(1, y1 - y0) };
    })
    .sort((a, b) => a.cy - b.cy);
  if (!boxes.length) return '';

  const lineHeight = median(boxes.map((b) => b.h));
  // A box belongs to a row when its centre is close to the row's centre (not to the row's full
  // extent: one tall box would otherwise swallow the neighbouring lines).
  const rows: { boxes: Box[]; cy: number; h: number }[] = [];
  for (const box of boxes) {
    let target: (typeof rows)[number] | null = null;
    for (let i = rows.length - 1; i >= Math.max(0, rows.length - 3); i--) {
      const row = rows[i];
      if (Math.abs(box.cy - row.cy) < 0.5 * Math.min(box.h, row.h)) {
        target = row;
        break;
      }
    }
    if (target) {
      target.boxes.push(box);
      target.cy = target.boxes.reduce((s, b) => s + b.cy, 0) / target.boxes.length;
      target.h = median(target.boxes.map((b) => b.h));
    } else rows.push({ boxes: [box], cy: box.cy, h: box.h });
  }
  rows.sort((a, b) => a.cy - b.cy);

  const out: string[] = [];
  let prev: (typeof rows)[number] | null = null;
  for (const row of rows) {
    row.boxes.sort((a, b) => a.x0 - b.x0);
    let text = '';
    let left: Box | null = null;
    for (const b of row.boxes) {
      if (left) text += b.x0 - left.x1 > 2 * lineHeight ? '   ' : ' ';
      text += b.text;
      left = b;
    }
    // A gap of more than about one empty line starts a new paragraph.
    if (prev && row.cy - prev.cy - (row.h + prev.h) / 2 > 0.8 * lineHeight) out.push('');
    out.push(text);
    prev = row;
  }
  return out.join('\n');
}
