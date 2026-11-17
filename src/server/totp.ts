/**
 * Two-factor authentication: time-based one-time passwords (RFC 6238 – SHA-1, 6 digits, 30 s, as
 * used by Aegis, Google Authenticator, 1Password, Bitwarden …) and single-use recovery codes.
 */
import { createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_S = 30;
const DIGITS = 6;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, base32 – the size RFC 4226 recommends for HMAC-SHA-1. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function timeStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_PERIOD_S);
}

export function totpCode(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The time step a code belongs to – within one step before or after now, so a clock that is a bit
 * off still works – or null. Callers reject steps that were already used (no replay).
 */
export function verifyTotp(secret: string, code: string, now = Date.now(), window = 1): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const current = timeStep(now);
  let match: number | null = null;
  // Check every step (constant work) instead of returning at the first match.
  for (let step = current - window; step <= current + window; step++) {
    if (timingSafeEqual(Buffer.from(totpCode(secret, step)), Buffer.from(given)) && match === null) match = step;
  }
  return match;
}

export function otpauthUrl(secret: string, account: string, issuer = 'Paperless-AI'): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_PERIOD_S}`;
}

// ---------------------------------------------------------------- recovery codes

/** Letters and digits that cannot be confused when written down (no 0/o, 1/l/i). */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** Ten codes like "k7m2q-x9p4w" (~49 bits each). */
export function newRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const chars = Array.from({ length: 10 }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join('');
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** Lower case, without spaces and dashes – codes may be typed in any form. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[\s-]/g, '');
}

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number }) => Promise<Buffer>;
const SCRYPT = { N: 2 ** 14, r: 8, p: 1 };

/** Recovery codes are stored like passwords: salted scrypt hashes. */
export async function hashRecoveryCode(code: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(normalizeRecoveryCode(code), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function recoveryCodeMatches(code: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split('$');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(normalizeRecoveryCode(code), Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(actual, expected);
}
