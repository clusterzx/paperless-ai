/**
 * Profile pictures: only PNG, JPEG and WebP are taken (recognised by their first bytes, never by the
 * name or the content type the client sends – an SVG could carry scripts). With sharp installed the
 * picture is turned upright, cut to a square of 256×256 and stored as WebP without its metadata
 * (camera, GPS position); without sharp it is stored as it came.
 */
import { createHash } from 'node:crypto';
import { logger } from '../logger.js';

const log = logger.child({ module: 'avatar' });

/** Largest file taken (before resizing). */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
/** Width and height of a resized picture. */
export const AVATAR_SIZE = 256;
/** Larger pictures are refused before they are decoded (a small file can unpack to a huge bitmap). */
const MAX_INPUT_PIXELS = 50_000_000;

export type AvatarMime = 'image/png' | 'image/jpeg' | 'image/webp';

export class AvatarError extends Error {}

/** The type of the picture from its first bytes; null for anything else. */
export function sniffAvatar(data: Buffer): AvatarMime | null {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 12 && data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

type Sharp = (typeof import('sharp'))['default'];
let sharpModule: Promise<Sharp | null> | null = null;

function sharp(): Promise<Sharp | null> {
  sharpModule ??= import('sharp')
    .then((m) => m.default)
    .catch(() => {
      log.warn('sharp is not available – profile pictures are stored as uploaded (not resized)');
      return null;
    });
  return sharpModule;
}

export interface Avatar {
  data: Buffer;
  mime: AvatarMime;
  hash: string;
}

/** Check an uploaded picture and make it the stored one; AvatarError with a message for the user. */
export async function prepareAvatar(upload: Buffer): Promise<Avatar> {
  if (!upload.length) throw new AvatarError('The file is empty');
  if (upload.length > AVATAR_MAX_BYTES) throw new AvatarError(`The picture is larger than ${AVATAR_MAX_BYTES / 1024 / 1024} MB`);
  const mime = sniffAvatar(upload);
  if (!mime) throw new AvatarError('Choose a PNG, JPEG or WebP picture');
  const s = await sharp();
  let out: { data: Buffer; mime: AvatarMime } = { data: upload, mime };
  if (s) {
    try {
      const data = await s(upload, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
        .rotate()
        .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' })
        .webp({ quality: 82 })
        .toBuffer();
      out = { data, mime: 'image/webp' };
    } catch (err) {
      log.debug(`Unreadable profile picture: ${err instanceof Error ? err.message : String(err)}`);
      throw new AvatarError('The picture cannot be read – it may be damaged or too large');
    }
  }
  return { ...out, hash: createHash('sha256').update(out.data).digest('hex') };
}

/** The address of a user's picture; the version makes browsers fetch a changed one. */
export function avatarUrl(userId: number, updatedAt: number | null): string | null {
  return updatedAt === null ? null : `/api/users/${userId}/avatar?v=${updatedAt}`;
}
