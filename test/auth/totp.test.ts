import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  hashRecoveryCode,
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecoveryCode,
  otpauthUrl,
  recoveryCodeMatches,
  timeStep,
  totpCode,
  verifyTotp,
} from '../../src/server/totp.js';

// RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (the last 6 of the 8 published digits).
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));
const RFC_VECTORS: [number, string][] = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    for (const [seconds, code] of RFC_VECTORS) expect(totpCode(RFC_SECRET, timeStep(seconds * 1000))).toBe(code);
  });

  it('round-trips base32 and creates 160-bit secrets', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255, 128, 7]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode('gezd gnbv-gy3t')).toEqual(base32Decode('GEZDGNBVGY3T'));
    const secret = newTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(newTotpSecret()).not.toBe(secret);
  });

  it('accepts the codes of one step before and after now, nothing else', () => {
    const now = 1_700_000_000_000;
    const step = timeStep(now);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, step - 2), now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBeNull();
    const spaced = totpCode(RFC_SECRET, step).replace(/^(\d{3})/, '$1 ');
    expect(verifyTotp(RFC_SECRET, spaced, now)).toBe(step);
  });

  it('builds an otpauth URL for authenticator apps', () => {
    expect(otpauthUrl('ABC', 'erika@home')).toBe('otpauth://totp/Paperless-AI:erika%40home?secret=ABC&issuer=Paperless-AI&algorithm=SHA1&digits=6&period=30');
  });
});

describe('recovery codes', () => {
  it('creates ten distinct, unambiguous codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/);
  });

  it('stores salted hashes and accepts the code in any spelling', async () => {
    const [code] = newRecoveryCodes(1);
    const hash = await hashRecoveryCode(code);
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(hash).not.toContain(normalizeRecoveryCode(code));
    expect(await hashRecoveryCode(code)).not.toBe(hash);
    expect(await recoveryCodeMatches(code, hash)).toBe(true);
    expect(await recoveryCodeMatches(` ${code.toUpperCase().replace('-', ' ')} `, hash)).toBe(true);
    expect(await recoveryCodeMatches('aaaaa-aaaaa', hash)).toBe(false);
    expect(await recoveryCodeMatches(code, 'bcrypt$whatever')).toBe(false);
  });
});
