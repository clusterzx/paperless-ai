/**
 * Authorization policy of every route: whether it needs an admin, and which API key scope it needs.
 * One table, so it can be reviewed in one place; the permission matrix test fails for routes that
 * are not listed here (docs/standalone/access-control.md §11).
 *
 * Library roles (viewer / editor / owner) are checked by the archive backend for each document –
 * this table only decides who may call a route at all.
 */
import type { ApiScope } from '../access/scope.js';

export interface RoutePolicy {
  /** Only admins (sessions of admins, admin API keys with the `admin` scope, the legacy key). */
  admin: boolean;
  /** API key scope needed (sessions have all scopes). */
  scope: ApiScope;
}

type Entry = [method: string, url: string, policy: RoutePolicy];

const read: RoutePolicy = { admin: false, scope: 'read' };
const write: RoutePolicy = { admin: false, scope: 'write' };
const chat: RoutePolicy = { admin: false, scope: 'chat' };
const upload: RoutePolicy = { admin: false, scope: 'upload' };
const webhook: RoutePolicy = { admin: false, scope: 'webhook' };
const admin: RoutePolicy = { admin: true, scope: 'admin' };

/**
 * `url` is the route pattern as registered (with `:params`); a trailing `*` matches a prefix.
 * Method `*` matches every method. The first matching entry wins.
 */
const ENTRIES: Entry[] = [
  // ---------------------------------------------------------------- own account (session routes)
  ['*', '/api/account*', read],
  ['*', '/api/me/*', read],
  ['GET', '/api/notifications', read],
  ['POST', '/api/notifications/read', read],
  ['GET', '/api/update-check', read],

  // ---------------------------------------------------------------- administration
  // (the setup is open without login only while no account exists – then the policy is not checked)
  ['*', '/api/setup*', admin],
  ['*', '/api/settings*', admin],
  ['POST', '/api/key-regenerate', admin],
  ['*', '/api/logs*', admin],
  ['*', '/api/debug/*', admin],
  ['GET', '/api/usage', admin],
  ['*', '/api/users*', admin],
  ['*', '/api/groups*', admin],
  ['GET', '/api/api-keys', admin],
  ['DELETE', '/api/api-keys/:id', admin],
  ['POST', '/api/processing/pause', admin],
  ['POST', '/api/processing/resume', admin],
  ['POST', '/api/processing/scan', admin],
  ['POST', '/api/processing/retry', admin],
  ['POST', '/api/scan/now', admin],
  ['POST', '/api/reset-all-documents', admin],
  ['POST', '/api/reset-documents', admin],
  ['POST', '/api/history/reset', admin],
  ['POST', '/api/rag/rebuild', admin],
  ['POST', '/api/rag/sync', admin],
  ['POST', '/api/rag/embedding-prompts', admin],
  ['POST', '/api/ocr/assess', admin],
  ['POST', '/api/ocr/run', admin],
  ['POST', '/api/calendar/scan', admin],
  ['POST', '/api/prompts', admin],
  ['PATCH', '/api/prompts/:id', admin],
  ['DELETE', '/api/prompts/:id', admin],
  ['POST', '/api/prompts/:id/activate', admin],
  ['POST', '/api/prompts/:id/ratings', admin],
  ['DELETE', '/api/prompts/:id/ratings/:ratingId', admin],
  ['POST', '/api/prompts/import', admin],
  ['PUT', '/api/prompt-rules', admin],
  ['GET', '/api/migration*', admin],
  ['POST', '/api/migration*', admin],
  ['POST', '/api/archive/*', admin],
  ['GET', '/api/archive/*', admin],

  // ---------------------------------------------------------------- AI chat and search
  ['POST', '/api/rag/ask', chat],
  ['POST', '/api/rag/chat', chat],
  ['POST', '/api/rag/search', chat],
  ['POST', '/api/chat/document/:id', chat],
  ['GET', '/chat/init', chat],
  ['GET', '/chat/init/:id', chat],
  ['POST', '/chat/message', chat],

  // ---------------------------------------------------------------- intake
  ['POST', '/api/documents/upload', upload],
  ['POST', '/api/documents/post_document/', upload],
  ['POST', '/api/documents/post_document', upload],
  ['POST', '/api/documents/:id/versions', upload],
  ['POST', '/share-target', upload],
  ['POST', '/api/webhook/document', webhook],

  // ---------------------------------------------------------------- library administration (owners, checked per library)
  ['GET', '/api/audit-log', read],

  // ---------------------------------------------------------------- everything else: read for GET, write otherwise
  ['GET', '*', read],
  ['HEAD', '*', read],
  ['*', '*', write],
];

function matches(pattern: string, url: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('*')) return url.startsWith(pattern.slice(0, -1));
  return pattern === url;
}

export function policyFor(method: string, url: string): RoutePolicy {
  const m = method.toUpperCase();
  for (const [em, eu, p] of ENTRIES) {
    if ((em === '*' || em === m) && matches(eu, url)) return p;
  }
  return write;
}

/** Explicit entries (without the catch-all defaults) – used by the permission matrix test. */
export function explicitPolicy(method: string, url: string): RoutePolicy | null {
  const m = method.toUpperCase();
  for (const [em, eu, p] of ENTRIES) {
    if (eu === '*') return null;
    if ((em === '*' || em === m) && matches(eu, url)) return p;
  }
  return null;
}
