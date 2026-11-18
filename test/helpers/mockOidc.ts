/**
 * A small OpenID Connect provider for tests and the demo: discovery, authorize (signs the
 * configured user in at once), token endpoint with PKCE and client authentication, RS256-signed ID
 * tokens, userinfo and end-session.
 */
import http from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';

export interface MockOidcUser {
  sub: string;
  claims: Record<string, unknown>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  nonce: string | null;
  user: MockOidcUser;
  used: boolean;
}

export class MockOidc {
  url = '';
  clientId = 'paperless-ai';
  clientSecret = 'oidc-secret';
  /** Who signs in at the next authorize request. */
  user: MockOidcUser = { sub: 'sub-erika', claims: { preferred_username: 'erika', email: 'erika@example.com', name: 'Erika Musterfrau', groups: ['paperless'] } };
  /** The user cancels at the provider. */
  deny = false;
  /** Leave the groups out of the ID token (only the userinfo answer has them). */
  groupsOnlyInUserinfo = false;
  readonly authorizeRequests: URLSearchParams[] = [];
  readonly tokenRequests: { auth: string | undefined; params: URLSearchParams }[] = [];
  readonly endSessionRequests: URLSearchParams[] = [];
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<string, MockOidcUser>();
  private server: http.Server | null = null;
  private privateKey!: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  private jwk!: JWK;

  async start(): Promise<this> {
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    this.privateKey = privateKey;
    this.jwk = { ...(await exportJWK(publicKey)), kid: 'mock-key', alg: 'RS256', use: 'sig' };
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private redirect(res: http.ServerResponse, location: string) {
    res.writeHead(302, { Location: location });
    res.end();
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url ?? '/', this.url);
    const q = url.searchParams;
    if (url.pathname === '/.well-known/openid-configuration') {
      return this.json(res, 200, {
        issuer: this.url,
        authorization_endpoint: `${this.url}/authorize`,
        token_endpoint: `${this.url}/token`,
        userinfo_endpoint: `${this.url}/userinfo`,
        jwks_uri: `${this.url}/jwks`,
        end_session_endpoint: `${this.url}/logout`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'profile', 'email', 'groups'],
      });
    }
    if (url.pathname === '/jwks') return this.json(res, 200, { keys: [this.jwk] });
    if (url.pathname === '/authorize') {
      this.authorizeRequests.push(q);
      const redirectUri = q.get('redirect_uri') ?? '';
      const back = new URL(redirectUri);
      if (q.get('state')) back.searchParams.set('state', q.get('state')!);
      if (this.deny) {
        back.searchParams.set('error', 'access_denied');
        back.searchParams.set('error_description', 'The user cancelled');
        return this.redirect(res, back.href);
      }
      if (q.get('response_type') !== 'code' || q.get('client_id') !== this.clientId || q.get('code_challenge_method') !== 'S256') {
        return this.json(res, 400, { error: 'invalid_request' });
      }
      const code = randomBytes(16).toString('hex');
      this.codes.set(code, { clientId: this.clientId, redirectUri, challenge: q.get('code_challenge') ?? '', nonce: q.get('nonce'), user: structuredClone(this.user), used: false });
      back.searchParams.set('code', code);
      return this.redirect(res, back.href);
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const body = new URLSearchParams(await readBody(req));
      this.tokenRequests.push({ auth: req.headers.authorization, params: body });
      const [id, secret] = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent)
        : [body.get('client_id'), body.get('client_secret')];
      if (id !== this.clientId || secret !== this.clientSecret) return this.json(res, 401, { error: 'invalid_client' });
      const pending = this.codes.get(body.get('code') ?? '');
      if (!pending || pending.used || pending.redirectUri !== body.get('redirect_uri')) return this.json(res, 400, { error: 'invalid_grant' });
      pending.used = true;
      const challenge = createHash('sha256')
        .update(body.get('code_verifier') ?? '')
        .digest('base64url');
      if (challenge !== pending.challenge) return this.json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      const claims = { ...pending.user.claims };
      if (this.groupsOnlyInUserinfo) delete claims.groups;
      const idToken = await new SignJWT({ ...claims, ...(pending.nonce ? { nonce: pending.nonce } : {}) })
        .setProtectedHeader({ alg: 'RS256', kid: 'mock-key' })
        .setIssuer(this.url)
        .setAudience(this.clientId)
        .setSubject(pending.user.sub)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(this.privateKey);
      const accessToken = randomBytes(16).toString('hex');
      this.tokens.set(accessToken, pending.user);
      return this.json(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 300, id_token: idToken });
    }
    if (url.pathname === '/userinfo') {
      const user = this.tokens.get(req.headers.authorization?.replace(/^Bearer /, '') ?? '');
      if (!user) return this.json(res, 401, { error: 'invalid_token' });
      return this.json(res, 200, { sub: user.sub, ...user.claims });
    }
    if (url.pathname === '/logout') {
      this.endSessionRequests.push(q);
      const back = q.get('post_logout_redirect_uri');
      return back ? this.redirect(res, back) : this.json(res, 200, { ok: true });
    }
    return this.json(res, 404, { error: 'not_found' });
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => (data += c.toString()));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
