import { afterEach, describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { SESSION_COOKIE } from '../../src/server/auth.js';
import { OIDC_FLOW_COOKIE, OIDC_ID_TOKEN_COOKIE } from '../../src/server/oidc.js';
import { createHarness, TEST_PASSWORD, TEST_USER, withSetupCode, type Harness, type HarnessOptions } from '../helpers/appHarness.js';
import { MockOidc } from '../helpers/mockOidc.js';

let h: Harness | null = null;
let idp: MockOidc | null = null;
afterEach(async () => {
  await h?.close();
  await idp?.close();
  h = null;
  idp = null;
});

const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const c = res.cookies.find((x) => x.name === name && x.value);
  return c ? `${name}=${c.value}` : null;
};

async function setup(opts: HarnessOptions & { oidc?: Record<string, unknown> } = {}) {
  idp = await new MockOidc().start();
  const oidc = { enabled: true, issuer: idp.url, clientId: idp.clientId, clientSecret: idp.clientSecret, buttonLabel: 'Sign in with Authentik', ...opts.oidc };
  // The first account of an instance with preset credentials needs the setup code (setupCode.test.ts).
  h = withSetupCode(await createHarness({ ...opts, config: { ...opts.config, auth: { oidc } } }));
  return { hh: h, provider: idp };
}

/** Go through the whole redirect dance: Paperless-AI → provider → callback. */
async function sso(hh: Harness, opts: { next?: string; cookie?: string; link?: boolean } = {}) {
  const query = new URLSearchParams({ ...(opts.next ? { next: opts.next } : {}), ...(opts.link ? { link: '1' } : {}) });
  const start = await hh.inject({ method: 'GET', url: `/api/auth/oidc/login?${query}`, headers: opts.cookie ? { cookie: opts.cookie } : {} });
  if (start.statusCode !== 302 || !start.headers.location?.toString().startsWith('http://127.0.0.1')) return { start, done: start };
  const flow = cookieOf(start, OIDC_FLOW_COOKIE)!;
  const atProvider = await fetch(start.headers.location as string, { redirect: 'manual' });
  const back = new URL(atProvider.headers.get('location')!);
  const done = await hh.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: [flow, opts.cookie].filter(Boolean).join('; ') } });
  return { start, done, flow, back };
}

const location = (res: LightMyRequestResponse) => res.headers.location as string;

describe('single sign-on (OIDC)', () => {
  it('signs in with PKCE, creates the account once and ends the session at the provider', async () => {
    const { hh, provider } = await setup();
    expect((await hh.inject({ method: 'GET', url: '/api/session' })).json().login).toEqual({ password: true, sso: 'Sign in with Authentik' });

    const { start, done } = await sso(hh, { next: '/calendar' });
    const auth = provider.authorizeRequests[0];
    expect(auth.get('redirect_uri')).toBe('http://localhost/api/auth/oidc/callback');
    expect(auth.get('scope')).toBe('openid profile email');
    expect(auth.get('code_challenge_method')).toBe('S256');
    expect(auth.get('state')).toBeTruthy();
    expect(auth.get('nonce')).toBeTruthy();
    expect(start.cookies.find((c) => c.name === OIDC_FLOW_COOKIE)).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/api/auth/oidc' });
    // client_secret_basic, the code verifier was checked by the provider
    expect(provider.tokenRequests[0].auth).toMatch(/^Basic /);
    expect(provider.tokenRequests[0].params.get('code_verifier')).toBeTruthy();

    expect(done.statusCode).toBe(302);
    expect(location(done)).toBe('/calendar');
    const session = cookieOf(done, SESSION_COOKIE)!;
    const account = (await hh.inject({ method: 'GET', url: '/api/account', headers: { cookie: session } })).json();
    expect(account).toMatchObject({ user: { username: 'erika' }, hasPassword: false, sso: { available: true, linked: true, passwordLogin: true } });

    // The same person again: the same account
    const again = await sso(hh);
    expect(location(again.done)).toBe('/');
    expect(hh.ctx.repos.users.list().map((u) => u.username).sort()).toEqual(['erika']);
    // Another person with the same user name gets a free one
    provider.user = { sub: 'sub-other', claims: { preferred_username: 'erika' } };
    await sso(hh);
    expect(hh.ctx.repos.users.list().map((u) => u.username).sort()).toEqual(['erika', 'erika-2']);

    // An SSO account has no password to sign in with
    expect((await hh.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'erika', password: 'anything-at-all' } })).statusCode).toBe(401);

    // Signing out ends the session at the provider too
    const idToken = cookieOf(done, OIDC_ID_TOKEN_COOKIE)!;
    const out = await hh.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: `${session}; ${idToken}` } });
    const redirect = new URL(out.json().redirect);
    expect(redirect.href.startsWith(`${provider.url}/logout?`)).toBe(true);
    expect(redirect.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost/login');
    expect(redirect.searchParams.get('id_token_hint')).toBe(idToken.split('=')[1]);
    // a password session stays local
    const local = await hh.login();
    expect((await hh.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie: local } })).json()).toEqual({ ok: true, redirect: null });
  });

  it('only lets members of the allowed groups in – also when the groups come from userinfo', async () => {
    const { hh, provider } = await setup({ oidc: { allowedGroups: ['Paperless-Admins'] } });
    const refused = await sso(hh);
    // a fresh installation (no account yet) shows the error in the setup wizard
    expect(location(refused.done)).toBe(`/setup?sso_error=${encodeURIComponent('Your account is not in a group that may use Paperless-AI')}`);
    expect(cookieOf(refused.done, SESSION_COOKIE)).toBeNull();

    provider.user.claims.groups = ['users', 'paperless-admins'];
    provider.groupsOnlyInUserinfo = true;
    const ok = await sso(hh);
    expect(location(ok.done)).toBe('/');
    expect(cookieOf(ok.done, SESSION_COOKIE)).not.toBeNull();
  });

  it('maps provider groups to admins and Paperless-AI groups', async () => {
    const { hh, provider } = await setup({ oidc: { adminGroups: ['pai-admins'] } });
    // an existing admin, so that the SSO account is not the first one (the first one is always admin)
    await hh.login();
    provider.user = { sub: 'sub-anna', claims: { preferred_username: 'anna', groups: ['family'] } };
    await sso(hh);
    const anna = hh.ctx.repos.users.byUsername('anna')!;
    expect(anna.role).toBe('member');
    expect(hh.ctx.repos.groups.groupsOf(anna.id).map((g) => g.name)).toEqual(['family']);

    provider.user.claims.groups = ['family', 'pai-admins'];
    await sso(hh);
    expect(hh.ctx.repos.users.byUsername('anna')!.role).toBe('admin');
    expect(hh.ctx.repos.groups.groupsOf(anna.id).map((g) => g.name)).toEqual(['family', 'pai-admins']);

    provider.user.claims.groups = [];
    await sso(hh);
    expect(hh.ctx.repos.users.byUsername('anna')!.role).toBe('member');
    expect(hh.ctx.repos.groups.groupsOf(anna.id)).toEqual([]);

    // disabled accounts cannot sign in with SSO either
    hh.ctx.repos.users.setDisabled(anna.id, true);
    const refused = await sso(hh);
    expect(location(refused.done)).toContain('sso_error=');
    expect(cookieOf(refused.done, SESSION_COOKIE)).toBeNull();
  });

  it('reports cancelled, expired and replayed sign-ins on the login page', async () => {
    const { hh, provider } = await setup();
    await hh.login(); // an account exists – errors go to the login page
    provider.deny = true;
    expect(location((await sso(hh)).done)).toBe(`/login?sso_error=${encodeURIComponent('The sign-in was cancelled or denied by the provider')}`);
    provider.deny = false;

    // without the flow cookie (other browser, expired)
    const start = await hh.inject({ method: 'GET', url: '/api/auth/oidc/login' });
    const back = new URL((await fetch(start.headers.location as string, { redirect: 'manual' })).headers.get('location')!);
    const noCookie = await hh.inject({ method: 'GET', url: back.pathname + back.search });
    expect(location(noCookie)).toMatch(/^\/login\?sso_error=The%20sign-in%20took%20too%20long/);
    // a forged state
    const forged = back.search.replace(/state=[^&]+/, 'state=forged');
    const wrongState = await hh.inject({ method: 'GET', url: back.pathname + forged, headers: { cookie: cookieOf(start, OIDC_FLOW_COOKIE)! } });
    expect(location(wrongState)).toMatch(/^\/login\?sso_error=The%20provider%20did%20not%20confirm/);
    expect(cookieOf(wrongState, SESSION_COOKIE)).toBeNull();

    // only paths on this server are followed after signing in
    expect(location((await sso(hh, { next: '//evil.example/x' })).done)).toBe('/');
  });

  it('links an existing account, which then signs in with SSO', async () => {
    const { hh, provider } = await setup({ oidc: { autoCreate: false } });
    const cookie = await hh.login();
    // not linked and no automatic accounts: refused
    expect(location((await sso(hh)).done)).toMatch(/sso_error=There%20is%20no%20Paperless-AI%20account/);

    const linked = await sso(hh, { cookie, link: true });
    expect(location(linked.done)).toBe('/settings?tab=account&sso=linked');
    expect(hh.ctx.repos.users.byUsername(TEST_USER)).toMatchObject({ oidc_issuer: provider.url, oidc_subject: 'sub-erika' });
    // now SSO signs in as that account
    const signedIn = await sso(hh);
    const session = cookieOf(signedIn.done, SESSION_COOKIE)!;
    expect((await hh.inject({ method: 'GET', url: '/api/account', headers: { cookie: session } })).json()).toMatchObject({ user: { username: TEST_USER }, hasPassword: true });

    // the same sign-in cannot be linked to a second account
    hh.ctx.repos.users.create('second', hh.ctx.repos.users.byUsername(TEST_USER)!.password_hash);
    const second = await hh.login('second', TEST_PASSWORD);
    expect(location((await sso(hh, { cookie: second, link: true })).done)).toBe(
      `/settings?tab=account&sso_error=${encodeURIComponent(`This sign-in is already linked to the account "${TEST_USER}"`)}`,
    );
    // linking needs a signed-in user
    expect(location(await hh.inject({ method: 'GET', url: '/api/auth/oidc/login?link=1' }))).toBe('/login');
    // … in the browser: an API key of the user (whatever its scope) cannot start a link – it would become a sign-in
    const admin = hh.ctx.repos.users.byUsername(TEST_USER)!;
    const ocrKey = hh.ctx.repos.apiKeys.create(admin.id, { name: 'ocr', scopes: ['ocr'] }).key;
    expect(location(await hh.inject({ method: 'GET', url: '/api/auth/oidc/login?link=1', headers: { 'x-api-key': ocrKey } }))).toBe('/login');
    // … and the browser that started it has to come back signed in
    const started = await hh.inject({ method: 'GET', url: '/api/auth/oidc/login?link=1', headers: { cookie: second } });
    const atProvider = await fetch(started.headers.location as string, { redirect: 'manual' });
    const back = new URL(atProvider.headers.get('location')!);
    const foreignCallback = await hh.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: cookieOf(started, OIDC_FLOW_COOKIE)! } });
    expect(location(foreignCallback)).toMatch(/sso_error=Sign%20in%20to%20Paperless-AI%20in%20this%20browser/);

    // unlinking works while the password login is on
    expect((await hh.inject({ method: 'POST', url: '/api/account/sso/unlink', headers: { cookie } })).json()).toEqual({ ok: true });
    expect(hh.ctx.repos.users.byUsername(TEST_USER)!.oidc_subject).toBeNull();
  });

  it('switches the password login off only when that cannot lock everybody out', async () => {
    const { hh } = await setup();
    const cookie = await hh.login();
    const put = (auth: Record<string, unknown>, c = cookie) => hh.inject({ method: 'PUT', url: '/api/settings', headers: { cookie: c }, payload: { config: { auth } } });

    // the signed-in account has to be linked first
    const refused = await put({ passwordLogin: false });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toContain('Link your account with single sign-on first');

    await sso(hh, { cookie, link: true });
    expect((await put({ passwordLogin: false })).statusCode).toBe(200);
    expect((await hh.inject({ method: 'GET', url: '/api/session' })).json().login).toEqual({ password: false, sso: 'Sign in with Authentik' });
    const login = await hh.inject({ method: 'POST', url: '/api/auth/login', payload: { username: TEST_USER, password: TEST_PASSWORD } });
    expect(login.statusCode).toBe(403);
    expect(login.json().code).toBe('password_login_disabled');
    // the account cannot lose its only way in
    expect((await hh.inject({ method: 'POST', url: '/api/account/sso/unlink', headers: { cookie } })).statusCode).toBe(409);
    // switching SSO off again brings the password login back
    expect((await put({ passwordLogin: false, oidc: { enabled: false } })).statusCode).toBe(400);
  });

  it('comes back to the address the browser used behind a reverse proxy (X-Forwarded-*), also without TRUST_PROXY', async () => {
    const { hh, provider } = await setup();
    const proxied = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'paperless-ai.example.com' };
    const start = await hh.inject({ method: 'GET', url: '/api/auth/oidc/login', headers: proxied });
    expect(new URL(location(start)).searchParams.get('redirect_uri')).toBe('https://paperless-ai.example.com/api/auth/oidc/callback');
    // The sign-in completes with that redirect URI (the token request repeats it).
    const flow = cookieOf(start, OIDC_FLOW_COOKIE)!;
    const atProvider = await fetch(location(start), { redirect: 'manual' });
    const back = new URL(atProvider.headers.get('location')!);
    expect(back.origin).toBe('https://paperless-ai.example.com');
    const done = await hh.inject({ method: 'GET', url: back.pathname + back.search, headers: { cookie: flow, ...proxied } });
    expect(done.statusCode).toBe(302);
    expect(cookieOf(done, SESSION_COOKIE)).toBeTruthy();
    expect(provider.tokenRequests[0].params.get('redirect_uri')).toBe('https://paperless-ai.example.com/api/auth/oidc/callback');

    // The settings page shows exactly that address.
    const cookie = await hh.login();
    expect((await hh.inject({ method: 'GET', url: '/api/settings/oidc-urls', headers: { cookie, ...proxied } })).json()).toEqual({
      callbackUrl: 'https://paperless-ai.example.com/api/auth/oidc/callback',
      postLogoutUrl: 'https://paperless-ai.example.com/login',
    });
    // Nonsense in the headers is ignored; a configured public address wins.
    const odd = await hh.inject({ method: 'GET', url: '/api/auth/oidc/login', headers: { 'x-forwarded-proto': 'gopher', 'x-forwarded-host': 'evil.example/x' } });
    expect(new URL(location(odd)).searchParams.get('redirect_uri')).toBe('http://localhost/api/auth/oidc/callback');
    hh.ctx.config.update({ auth: { publicUrl: 'https://docs.example.org' } });
    const configured = await hh.inject({ method: 'GET', url: '/api/auth/oidc/login', headers: proxied });
    expect(new URL(location(configured)).searchParams.get('redirect_uri')).toBe('https://docs.example.org/api/auth/oidc/callback');
  });

  it('checks the provider before saving, and the test button finds it', async () => {
    const { hh, provider } = await setup();
    const cookie = await hh.login();
    const test = await hh.inject({ method: 'POST', url: '/api/settings/test-oidc', headers: { cookie }, payload: { issuer: provider.url, clientId: 'x' } });
    expect(test.json()).toEqual({ ok: true, message: `Found ${provider.url}`, issuer: provider.url, endSession: true, callbackUrl: 'http://localhost/api/auth/oidc/callback' });
    const bad = await hh.inject({ method: 'POST', url: '/api/settings/test-oidc', headers: { cookie }, payload: { issuer: 'http://127.0.0.1:1/' } });
    expect(bad.json()).toMatchObject({ ok: false, message: expect.stringContaining('No OpenID Connect provider found') });

    const unreachable = await hh.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { config: { auth: { oidc: { issuer: 'http://127.0.0.1:1/' } } } } });
    expect(unreachable.statusCode).toBe(400);
    expect(unreachable.json()).toMatchObject({ step: 'oidc', canForce: true });
    const forced = await hh.inject({ method: 'PUT', url: '/api/settings', headers: { cookie }, payload: { force: true, config: { auth: { oidc: { issuer: 'http://127.0.0.1:1/' } } } } });
    expect(forced.statusCode).toBe(200);
    // an unreachable provider: the login page sends you back with a message
    expect(location(await hh.inject({ method: 'GET', url: '/api/auth/oidc/login' }))).toMatch(/sso_error=The%20sign-in%20provider%20could%20not%20be%20reached/);
    // the secret is never sent to the browser
    expect(JSON.stringify((await hh.inject({ method: 'GET', url: '/api/settings', headers: { cookie } })).json())).not.toContain(provider.clientSecret);
  });

  it('creates the first account during setup when the password login is off', async () => {
    idp = await new MockOidc().start();
    h = withSetupCode(
      await createHarness({
        configured: false,
        env: { OIDC_ENABLED: 'true', OIDC_ISSUER: idp.url, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, PASSWORD_LOGIN: 'false', OIDC_AUTO_CREATE: 'false' },
      }),
    );
    expect((await h.inject({ method: 'GET', url: '/api/session' })).json()).toMatchObject({ needsUser: true, login: { password: false, sso: 'Sign in with SSO' } });
    const local = await h.inject({ method: 'POST', url: '/api/setup', payload: { username: 'admin', password: 'long enough password', config: {} } });
    expect(local.statusCode).toBe(400);
    expect(local.json().error).toContain('Sign in with single sign-on first');

    // the very first account is created by SSO even without automatic accounts
    const { done } = await sso(h, { next: '/setup' });
    expect(location(done)).toBe('/setup');
    const session = cookieOf(done, SESSION_COOKIE)!;
    expect((await h.inject({ method: 'GET', url: '/api/session', headers: { cookie: session } })).json()).toMatchObject({ authenticated: true, needsUser: false, setupRequired: true });
    expect((await h.inject({ method: 'GET', url: '/api/setup/defaults', headers: { cookie: session } })).statusCode).toBe(200);
    // a second person needs automatic accounts
    idp.user = { sub: 'sub-2', claims: { preferred_username: 'max' } };
    expect(location((await sso(h)).done)).toMatch(/sso_error=There%20is%20no%20Paperless-AI%20account/);
  });

  it('keeps the password login when SSO is not set up, whatever PASSWORD_LOGIN says', async () => {
    h = await createHarness({ env: { PASSWORD_LOGIN: 'false' } });
    expect((await h.inject({ method: 'GET', url: '/api/session' })).json().login).toEqual({ password: true, sso: null });
    expect(await h.login()).toContain(SESSION_COOKIE);
    expect(location(await h.inject({ method: 'GET', url: '/api/auth/oidc/login' }))).toBe(`/login?sso_error=${encodeURIComponent('Single sign-on is not set up')}`);
  });
});
