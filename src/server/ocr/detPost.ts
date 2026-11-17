/**
 * Post-processing of the DB (Differentiable Binarization) text detection
 * model, equivalent to PaddleOCR's DBPostProcess but without OpenCV:
 * threshold → connected regions → minimum-area rectangle → box score →
 * unclip (grow the box) → scale back to the source image.
 */
import type { Point, Quad } from './image.js';

export interface DetBox {
  quad: Quad;
  score: number;
}

export interface DbOptions {
  /** Pixel probability threshold for the text mask. */
  thresh: number;
  /** Minimum mean probability inside a box. */
  boxThresh: number;
  /** How much the shrunk text kernels are grown again. */
  unclipRatio: number;
  maxCandidates: number;
  minSize: number;
}

export const DB_DEFAULTS: DbOptions = { thresh: 0.3, boxThresh: 0.6, unclipRatio: 1.5, maxCandidates: 1000, minSize: 3 };

interface Rect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Direction of the `w` side (radians). */
  angle: number;
}

function cross(o: Point, a: Point, b: Point): number {
  return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/** Convex hull (Andrew's monotone chain), counter-clockwise. */
export function convexHull(points: Point[]): Point[] {
  if (points.length < 3) return points.slice();
  const pts = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/** Minimum-area enclosing rectangle of a convex hull (rotating calipers). */
export function minAreaRect(hull: Point[]): Rect {
  if (hull.length === 1) return { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, angle: 0 };
  let best: Rect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const p = hull[i];
    const q = hull[(i + 1) % hull.length];
    const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (len === 0) continue;
    const ux = (q[0] - p[0]) / len;
    const uy = (q[1] - p[1]) / len;
    let minU = Infinity;
    let maxU = -Infinity;
    let minV = Infinity;
    let maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy;
      const v = -x * uy + y * ux;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const w = maxU - minU;
    const h = maxV - minV;
    const area = w * h;
    if (area < bestArea - 1e-9) {
      bestArea = area;
      const cu = (minU + maxU) / 2;
      const cv = (minV + maxV) / 2;
      best = { cx: cu * ux - cv * uy, cy: cu * uy + cv * ux, w, h, angle: Math.atan2(uy, ux) };
    }
  }
  return best ?? { cx: hull[0][0], cy: hull[0][1], w: 0, h: 0, angle: 0 };
}

function rectCorners(r: Rect): Point[] {
  const ux = Math.cos(r.angle);
  const uy = Math.sin(r.angle);
  const hw = r.w / 2;
  const hh = r.h / 2;
  return [
    [r.cx - ux * hw + uy * hh, r.cy - uy * hw - ux * hh],
    [r.cx + ux * hw + uy * hh, r.cy + uy * hw - ux * hh],
    [r.cx + ux * hw - uy * hh, r.cy + uy * hw + ux * hh],
    [r.cx - ux * hw - uy * hh, r.cy - uy * hw + ux * hh],
  ];
}

/** Order four corners as top-left, top-right, bottom-right, bottom-left (PaddleOCR get_mini_boxes). */
export function orderQuad(points: Point[]): Quad {
  const p = points.slice().sort((a, b) => a[0] - b[0]);
  const [tl, bl] = p[1][1] > p[0][1] ? [p[0], p[1]] : [p[1], p[0]];
  const [tr, br] = p[3][1] > p[2][1] ? [p[2], p[3]] : [p[3], p[2]];
  return [tl, tr, br, bl];
}

function insideConvex(quad: Quad, x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(quad[i], quad[(i + 1) % 4], [x, y]);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Mean probability inside the box (PaddleOCR box_score_fast). */
function boxScore(prob: Float32Array, w: number, h: number, quad: Quad): number {
  const xs = quad.map((p) => p[0]);
  const ys = quad.map((p) => p[1]);
  const x0 = Math.max(0, Math.floor(Math.min(...xs)));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  let sum = 0;
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!insideConvex(quad, x, y)) continue;
      sum += prob[y * w + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Turn the probability map (`w`×`h`, as returned by the detection model) into text boxes in the
 * coordinates of the source image (`srcW`×`srcH`).
 */
export function dbPostprocess(prob: Float32Array, w: number, h: number, srcW: number, srcH: number, options: Partial<DbOptions> = {}): DetBox[] {
  const opts = { ...DB_DEFAULTS, ...options };
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = prob[i] > opts.thresh ? 1 : 0;

  // Connected regions (8-neighbourhood); keep their boundary pixels.
  const visited = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const regions: { boundary: Point[]; size: number }[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let top = 0;
    stack[top++] = start;
    visited[start] = 1;
    const boundary: Point[] = [];
    let size = 0;
    while (top) {
      const i = stack[--top];
      size++;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) boundary.push([x, y]);
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= w) continue;
          const j = ny * w + nx;
          if (mask[j] && !visited[j]) {
            visited[j] = 1;
            stack[top++] = j;
          }
        }
      }
    }
    if (size >= 4) regions.push({ boundary, size });
  }
  regions.sort((a, b) => b.size - a.size);

  const sx = srcW / w;
  const sy = srcH / h;
  const boxes: DetBox[] = [];
  for (const region of regions.slice(0, opts.maxCandidates)) {
    const rect = minAreaRect(convexHull(region.boundary));
    if (Math.min(rect.w, rect.h) < opts.minSize) continue;
    const score = boxScore(prob, w, h, orderQuad(rectCorners(rect)));
    if (score < opts.boxThresh) continue;
    // Unclip: growing a rectangle by d on every side (pyclipper with round joins + minAreaRect).
    const d = (rect.w * rect.h * opts.unclipRatio) / (2 * (rect.w + rect.h));
    const grown = { ...rect, w: rect.w + 2 * d, h: rect.h + 2 * d };
    if (Math.min(grown.w, grown.h) < opts.minSize + 2) continue;
    const quad = orderQuad(rectCorners(grown)).map(([x, y]) => [
      Math.min(Math.max(Math.round(x * sx), 0), srcW),
      Math.min(Math.max(Math.round(y * sy), 0), srcH),
    ]) as Quad;
    boxes.push({ quad, score });
  }
  return boxes;
}
