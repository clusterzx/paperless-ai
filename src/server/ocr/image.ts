/**
 * Minimal image operations for the OCR pipeline (no OpenCV): images are plain
 * 8-bit RGB buffers. Everything here is synchronous and runs in the OCR worker.
 */

export interface RawImage {
  /** Interleaved RGB, 3 bytes per pixel, row-major. */
  data: Uint8Array;
  width: number;
  height: number;
}

export type Point = [number, number];
/** Four corners: top-left, top-right, bottom-right, bottom-left. */
export type Quad = [Point, Point, Point, Point];

export function createImage(width: number, height: number): RawImage {
  return { data: new Uint8Array(width * height * 3), width, height };
}

/** Expand 1 (gray) or 4 (RGBA/BGRA) channel pixels to RGB. */
export function fromPixels(src: Uint8Array, width: number, height: number, channels: 1 | 3 | 4, bgr = false): RawImage {
  if (channels === 3 && !bgr) return { data: src, width, height };
  const out = createImage(width, height);
  const d = out.data;
  const n = width * height;
  if (channels === 1) {
    for (let i = 0, o = 0; i < n; i++, o += 3) d[o] = d[o + 1] = d[o + 2] = src[i];
  } else {
    const r = bgr ? 2 : 0;
    const b = bgr ? 0 : 2;
    for (let i = 0, s = 0, o = 0; i < n; i++, s += channels, o += 3) {
      d[o] = src[s + r];
      d[o + 1] = src[s + 1];
      d[o + 2] = src[s + b];
    }
  }
  return out;
}

/** Bilinear resize. */
export function resize(img: RawImage, width: number, height: number): RawImage {
  width = Math.max(1, Math.round(width));
  height = Math.max(1, Math.round(height));
  if (width === img.width && height === img.height) return img;
  const out = createImage(width, height);
  const { data: s, width: sw, height: sh } = img;
  const d = out.data;
  const sx = sw / width;
  const sy = sh / height;
  // Area-like sampling when shrinking a lot keeps thin strokes visible.
  if (sx >= 2 || sy >= 2) return boxDownscale(img, width, height);
  for (let y = 0; y < height; y++) {
    const fy = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), sh - 1);
    const y0 = Math.floor(fy);
    const y1 = Math.min(y0 + 1, sh - 1);
    const wy = fy - y0;
    for (let x = 0; x < width; x++) {
      const fx = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), sw - 1);
      const x0 = Math.floor(fx);
      const x1 = Math.min(x0 + 1, sw - 1);
      const wx = fx - x0;
      const a = (y0 * sw + x0) * 3;
      const b = (y0 * sw + x1) * 3;
      const c = (y1 * sw + x0) * 3;
      const e = (y1 * sw + x1) * 3;
      const o = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) {
        const top = s[a + k] + (s[b + k] - s[a + k]) * wx;
        const bottom = s[c + k] + (s[e + k] - s[c + k]) * wx;
        d[o + k] = top + (bottom - top) * wy + 0.5;
      }
    }
  }
  return out;
}

function boxDownscale(img: RawImage, width: number, height: number): RawImage {
  const out = createImage(width, height);
  const { data: s, width: sw, height: sh } = img;
  const d = out.data;
  for (let y = 0; y < height; y++) {
    const ys = Math.floor((y * sh) / height);
    const ye = Math.max(ys + 1, Math.floor(((y + 1) * sh) / height));
    for (let x = 0; x < width; x++) {
      const xs = Math.floor((x * sw) / width);
      const xe = Math.max(xs + 1, Math.floor(((x + 1) * sw) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      for (let yy = ys; yy < ye; yy++) {
        let i = (yy * sw + xs) * 3;
        for (let xx = xs; xx < xe; xx++, i += 3) {
          r += s[i];
          g += s[i + 1];
          b += s[i + 2];
        }
      }
      const n = (ye - ys) * (xe - xs);
      const o = (y * width + x) * 3;
      d[o] = r / n + 0.5;
      d[o + 1] = g / n + 0.5;
      d[o + 2] = b / n + 0.5;
    }
  }
  return out;
}

/** Rotate clockwise by 90° × k. */
export function rotate90(img: RawImage, k: number): RawImage {
  const turns = ((k % 4) + 4) % 4;
  if (turns === 0) return img;
  const { width: w, height: h, data: s } = img;
  const out = turns === 2 ? createImage(w, h) : createImage(h, w);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (turns === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      const i = (y * w + x) * 3;
      const o = (ny * out.width + nx) * 3;
      d[o] = s[i];
      d[o + 1] = s[i + 1];
      d[o + 2] = s[i + 2];
    }
  }
  return out;
}

export interface Normalization {
  mean: [number, number, number];
  std: [number, number, number];
  /** Feed channels as BGR (PaddleOCR models are trained on OpenCV images). */
  bgr: boolean;
}

export const IMAGENET: Normalization = { mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], bgr: true };
export const HALF: Normalization = { mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], bgr: true };

/**
 * Write an image as normalized CHW floats into `out` (a batch tensor) at `offset`.
 * `targetWidth` > image width pads the right side with 0 (after normalization), as PaddleOCR does.
 */
export function writeTensor(img: RawImage, norm: Normalization, out: Float32Array, offset = 0, targetWidth = img.width): void {
  const { width: w, height: h, data } = img;
  const plane = targetWidth * h;
  const order = norm.bgr ? [2, 1, 0] : [0, 1, 2];
  for (let c = 0; c < 3; c++) {
    const src = order[c];
    const scale = 1 / (255 * norm.std[c]);
    const shift = norm.mean[c] / norm.std[c];
    const base = offset + c * plane;
    for (let y = 0; y < h; y++) {
      const row = base + y * targetWidth;
      let i = y * w * 3 + src;
      for (let x = 0; x < w; x++, i += 3) out[row + x] = data[i] * scale - shift;
      // Padding stays 0 (the Float32Array is zero-initialised).
    }
  }
}

export function toTensor(img: RawImage, norm: Normalization): Float32Array {
  const out = new Float32Array(3 * img.width * img.height);
  writeTensor(img, norm, out);
  return out;
}

/** Solve the 8 coefficients of the homography mapping `from` to `to`. */
function homography(from: Quad, to: Quad): number[] {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i];
    const [u, v] = to[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    const p = a[col][col] || 1e-12;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r][col] / p;
      if (!f) continue;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / (a[i][i] || 1e-12));
}

/**
 * Cut out a (rotated) text region and straighten it, like PaddleOCR's get_rotate_crop_image.
 * Tall crops (vertical text) are turned by 90° counter-clockwise.
 */
export function cropQuad(img: RawImage, quad: Quad): RawImage {
  const { width, height } = cropSize(quad);
  const dst: Quad = [
    [0, 0],
    [width, 0],
    [width, height],
    [0, height],
  ];
  // Map destination pixels back to the source.
  const [h0, h1, h2, h3, h4, h5, h6, h7] = homography(dst, quad);
  const out = createImage(width, height);
  const { data: s, width: sw, height: sh } = img;
  const d = out.data;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const den = h6 * px + h7 * py + 1;
      // Border replicate.
      const fx = Math.min(Math.max((h0 * px + h1 * py + h2) / den - 0.5, 0), sw - 1);
      const fy = Math.min(Math.max((h3 * px + h4 * py + h5) / den - 0.5, 0), sh - 1);
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(x0 + 1, sw - 1);
      const y1 = Math.min(y0 + 1, sh - 1);
      const wx = fx - x0;
      const wy = fy - y0;
      const a = (y0 * sw + x0) * 3;
      const b = (y0 * sw + x1) * 3;
      const c = (y1 * sw + x0) * 3;
      const e = (y1 * sw + x1) * 3;
      const o = (y * width + x) * 3;
      for (let k = 0; k < 3; k++) {
        const top = s[a + k] + (s[b + k] - s[a + k]) * wx;
        const bottom = s[c + k] + (s[e + k] - s[c + k]) * wx;
        d[o + k] = top + (bottom - top) * wy + 0.5;
      }
    }
  }
  return isTall(quad) ? rotate90(out, 3) : out;
}

/** Size of the straightened crop of a text region. */
function cropSize(quad: Quad): { width: number; height: number } {
  const dist = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  return {
    width: Math.max(1, Math.round(Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2])))),
    height: Math.max(1, Math.round(Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2])))),
  };
}

/** A region much taller than wide holds vertical text: its crop is read turned by 90°. */
export function isTall(quad: Quad): boolean {
  const { width, height } = cropSize(quad);
  return height / width >= 1.5;
}
