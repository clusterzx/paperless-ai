import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from '../../src/server/auth.js';
import { hashRecoveryCode, newTotpSecret, timeStep, totpCode } from '../../src/server/totp.js';
import { resetTwoFactorFromEnv } from '../../src/server/twoFactor.js';
import type { TwoFactorSetup } from '../../src/shared/api.js';
import { createHarness, type Harness } from '../helpers/appHarness.js';

const USER = 'TestUser';
const PASSWORD = 'correct-horse-battery';

let h: Harness | null = null;
afterEach(async () => {
  await h?.close();
  h = null;
});

async function setup() {
  h = await createHarness();
  const cookie = await h.login(USER, PASSWORD);
  const send = (method: 'GET' | 'POST', url: string, payload?: object, cookieValue?: string, headers: Record<string, string> = {}) =>
    h!.inject({ method, url, headers: { ...(cookieValue ? { cookie: cookieValue } : {}), ...headers }, ...(payload ? { payload } : {}) });
  const sessionFrom = (res: { cookies: { name: string; value: string }[] }) => {
    const c = res.cookies.find((x) => x.name === SESSION_COOKIE);
    return c ? `${SESSION_COOKIE}=${c.value}` : null;
  };
  return { hh: h, cookie, send, sessionFrom };
}

describe('two-factor authentication', () => {
  it('is set up with a code, then sign-in needs a second step; codes work once', async () => {
    const { hh, cookie, send, sessionFrom } = await setup();
    expect((await send('GET', '/api/account', undefined, cookie)).json().twoFactor).toEqual({ enabled: false, enabledAt: null, recoveryCodesLeft: 0 });

    // ---- set-up
    const setupRes = (await send('POST', '/api/account/2fa/setup', {}, cookie)).json() as TwoFactorSetup;
    expect(setupRes.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setupRes.otpauthUrl).toBe(`otpauth://totp/Paperless-AI:${USER}?secret=${setupRes.secret}&issuer=Paperless-AI&algorithm=SHA1&digits=6&period=30`);
    expect(setupRes.qrSvg).toMatch(/^<svg /);
    // not enabled before it is confirmed: signing in still works with the password only
    expect((await send('POST', '/api/auth/login', { username: USER, password: PASSWORD })).json()).toMatchObject({ ok: true });

    const code = () => totpCode(setupRes.secret, timeStep());
    expect((await send('POST', '/api/account/2fa/enable', { password: 'wrong-password', code: code() }, cookie)).json().error).toBe('The current password is wrong');
    expect((await send('POST', '/api/account/2fa/enable', { password: PASSWORD, code: '000000' }, cookie)).statusCode).toBe(400);
    const enabled = await send('POST', '/api/account/2fa/enable', { password: PASSWORD, code: code() }, cookie);
    expect(enabled.statusCode).toBe(200);
    const recoveryCodes = enabled.json().recoveryCodes as string[];
    expect(recoveryCodes).toHaveLength(10);
    // other sessions end, this one continues with a new cookie
    const session = sessionFrom(enabled)!;
    expect((await send('GET', '/api/account', undefined, cookie)).statusCode).toBe(401);
    expect((await send('GET', '/api/account', undefined, session)).json().twoFactor).toMatchObject({ enabled: true, recoveryCodesLeft: 10 });
    expect((await send('POST', '/api/account/2fa/setup', {}, session)).statusCode).toBe(409);

    // ---- sign-in: the password gives a ticket, no session
    const first = await send('POST', '/api/auth/login', { username: USER, password: PASSWORD });
    const { ticket, twoFactor, ok } = first.json();
    expect({ ok, twoFactor }).toEqual({ ok: false, twoFactor: true });
    expect(sessionFrom(first)).toBeNull();
    // a ticket is not a session, neither as cookie nor as bearer token
    expect((await send('GET', '/api/account', undefined, `${SESSION_COOKIE}=${ticket}`)).statusCode).toBe(401);
    expect((await send('GET', '/api/account', undefined, undefined, { authorization: `Bearer ${ticket}` })).statusCode).toBe(401);

    expect((await send('POST', '/api/auth/login/2fa', { ticket, code: '123456' })).json().error).toBe('Invalid code');
    // the code of the set-up step cannot be used again; the next one works – once
    const next = totpCode(setupRes.secret, timeStep() + 1);
    const second = await send('POST', '/api/auth/login/2fa', { ticket, code: next });
    expect(second.json()).toMatchObject({ ok: true, user: { username: USER }, usedRecoveryCode: false, recoveryCodesLeft: 10 });
    expect((await send('GET', '/api/account', undefined, sessionFrom(second)!)).statusCode).toBe(200);
    expect((await send('POST', '/api/auth/login/2fa', { ticket, code: next })).json().error).toBe('This code was already used – wait for the next one');

    // ---- recovery codes: any spelling, single use
    const viaRecovery = await send('POST', '/api/auth/login/2fa', { ticket, code: recoveryCodes[0].toUpperCase().replace('-', ' ') });
    expect(viaRecovery.json()).toMatchObject({ ok: true, usedRecoveryCode: true, recoveryCodesLeft: 9 });
    expect((await send('POST', '/api/auth/login/2fa', { ticket, code: recoveryCodes[0] })).statusCode).toBe(401);
    expect((await send('POST', '/api/auth/login/2fa', { ticket: `${ticket}x`, code: recoveryCodes[1] })).json().code).toBe('ticket_expired');

    // the API key is not affected
    expect((await send('GET', '/api/session', undefined, undefined, hh.apiKeyHeaders())).json().authenticated).toBe(true);

    // ---- new recovery codes replace the old ones
    const renewed = await send('POST', '/api/account/2fa/recovery-codes', { password: PASSWORD, code: recoveryCodes[1] }, session);
    const fresh = renewed.json().recoveryCodes as string[];
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(recoveryCodes[2]);
    expect((await send('POST', '/api/auth/login/2fa', { ticket, code: recoveryCodes[2] })).statusCode).toBe(401);

    // ---- switch off: password and a code
    expect((await send('POST', '/api/account/2fa/disable', { password: PASSWORD, code: '999999' }, session)).statusCode).toBe(400);
    expect((await send('POST', '/api/account/2fa/disable', { password: PASSWORD, code: fresh[0] }, session)).json()).toEqual({ ok: true });
    expect((await send('POST', '/api/auth/login', { username: USER, password: PASSWORD })).json()).toMatchObject({ ok: true });
    // tickets issued before are void
    expect((await send('POST', '/api/auth/login/2fa', { ticket, code: fresh[1] })).json().code).toBe('ticket_expired');
  });

  it('makes the account wait after five wrong codes – from any address and on both sign-in routes', async () => {
    const { hh, cookie, send } = await setup();
    const setupRes = (await send('POST', '/api/account/2fa/setup', {}, cookie)).json() as TwoFactorSetup;
    const code = () => totpCode(setupRes.secret, timeStep());
    expect((await send('POST', '/api/account/2fa/enable', { password: PASSWORD, code: code() }, cookie)).statusCode).toBe(200);
    const ticket = (await send('POST', '/api/auth/login', { username: USER, password: PASSWORD })).json().ticket as string;
    const wrong = code() === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) {
      const res = await hh.inject({ method: 'POST', url: '/api/auth/login/2fa', remoteAddress: `198.51.100.${i + 1}`, payload: { ticket, code: wrong } });
      expect(res.json().error).toBe('Invalid code');
    }
    const right = await send('POST', '/api/auth/login/2fa', { ticket, code: code() });
    expect(right.statusCode).toBe(401);
    expect(right.json().error).toMatch(/Too many wrong codes – try again in 15 minute/);
    const app = await send('POST', '/ngx/api/token/', { username: USER, password: PASSWORD, code: code() });
    expect(app.statusCode).toBe(400);
    expect(JSON.stringify(app.json())).toMatch(/Too many wrong codes/);
  });

  it('is only available to logged-in users', async () => {
    const { hh, send } = await setup();
    expect((await send('POST', '/api/account/2fa/setup', {}, undefined, hh.apiKeyHeaders())).statusCode).toBe(403);
    expect((await send('GET', '/api/account/2fa')).statusCode).toBe(401);
  });

  it('can be switched off with PAPERLESS_AI_RESET_2FA when the phone is lost', async () => {
    const { hh, send } = await setup();
    const user = hh.ctx.repos.users.byUsername(USER)!;
    const secret = newTotpSecret();
    hh.ctx.repos.users.setPendingTotp(user.id, secret);
    hh.ctx.repos.users.enableTotp(user.id, timeStep(), [await hashRecoveryCode('abcde-fghjk')]);
    expect((await send('POST', '/api/auth/login', { username: USER, password: PASSWORD })).json().twoFactor).toBe(true);

    resetTwoFactorFromEnv(hh.ctx, { PAPERLESS_AI_RESET_2FA: 'nobody' });
    expect(hh.ctx.repos.users.byId(user.id)!.totp_enabled_at).not.toBeNull();
    resetTwoFactorFromEnv(hh.ctx, { PAPERLESS_AI_RESET_2FA: ' testuser ' });
    const after = hh.ctx.repos.users.byId(user.id)!;
    expect(after).toMatchObject({ totp_secret: null, totp_enabled_at: null });
    expect(hh.ctx.repos.users.unusedRecoveryCodes(user.id)).toEqual([]);
    expect((await send('POST', '/api/auth/login', { username: USER, password: PASSWORD })).json()).toMatchObject({ ok: true });
  });
});
