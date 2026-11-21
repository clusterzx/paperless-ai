/**
 * Encryption of stored secrets (e-mail passwords): AES-256-GCM with a key derived from the
 * instance secret (`security.jwtSecret`). A new instance secret makes the stored values unreadable –
 * they have to be entered again.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

function key(secret: string, purpose: string): Buffer {
  return createHash('sha256').update(`${purpose}\u0000${secret}`).digest();
}

export function seal(plain: string, secret: string, purpose = 'stored-secret'): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(secret, purpose), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

/** null when the value cannot be read (other instance secret, damaged). */
export function open(sealed: string, secret: string, purpose = 'stored-secret'): string | null {
  const [v, iv, tag, ct] = sealed.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(secret, purpose), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
