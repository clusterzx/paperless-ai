/**
 * Profile pictures (#1045). An uploaded picture is never kept as it is: it is decoded and drawn
 * again as a 256×256 WebP. That drops EXIF data (GPS position, camera), animation and anything
 * hidden in the file, and only ever serves an image this server made. SVG is not taken.
 */
import { createHash } from 'node:crypto';
import { HttpProblem } from './http/helpers.js';

export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 256;

type Sharp = (typeof import('sharp'))['default'];
let sharpModule: Promise<Sharp | null> | null = null;
const loadSharp = () => (sharpModule ??= import('sharp').then((m) => m.default).catch(() => null));

/** PNG, JPEG or WebP by their first bytes (the name and the content type a client sends do not count). */
export function avatarFormat(bytes: Uint8Array): 'png' | 'jpeg' | 'webp' | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** The picture as it is stored: a 256×256 WebP, cropped to a square around its middle. */
export async function normalizeAvatar(bytes: Buffer): Promise<{ image: Buffer; sha256: string }> {
  if (bytes.length > AVATAR_MAX_BYTES) throw new HttpProblem(413, 'The picture is larger than 2 MB');
  if (!avatarFormat(bytes)) throw new HttpProblem(415, 'Send a PNG, JPEG or WebP picture');
  const sharp = await loadSharp();
  if (!sharp) throw new HttpProblem(503, 'Profile pictures need the image library sharp, which is missing in this installation');
  let image: Buffer;
  try {
    image = await sharp(bytes, { limitInputPixels: 50_000_000, failOn: 'error' })
      .rotate() // the orientation of photos (EXIF), before it is dropped
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
      .flatten({ background: '#ffffff' })
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw new HttpProblem(422, 'The picture could not be read');
  }
  return { image, sha256: createHash('sha256').update(image).digest('hex') };
}

/** Where a picture is loaded from – with its version, so a new one is never taken from a cache. */
export function avatarUrl(userId: number, sha256: string | null | undefined): string | null {
  return sha256 ? `/api/users/${userId}/avatar?v=${sha256.slice(0, 12)}` : null;
}
