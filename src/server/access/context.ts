/**
 * Builds the AccessScope of a caller: instance role, library roles (built-in archive) and API key
 * scopes. See docs/standalone/access-control.md.
 */
import type { AppContext } from '../context.js';
import type { ApiKeyRow } from '../db/accessRepo.js';
import { API_SCOPES, type AccessScope, type ApiScope, type LibraryRole, type Principal } from './scope.js';

/** Whether the archive has libraries (built-in archive); in companion mode there is one shared view. */
function librariesEnabled(ctx: AppContext): boolean {
  if (!ctx.archiveConfigured()) return false;
  try {
    return ctx.archive().capabilities.libraries;
  } catch {
    return false;
  }
}

/** Scopes an API key may carry for its user (admin only for admins). */
export function allowedScopes(role: 'admin' | 'member'): ApiScope[] {
  return API_SCOPES.filter((s) => s !== 'admin' || role === 'admin');
}

export function scopeFor(ctx: AppContext, principal: Principal, key: ApiKeyRow | null = null): AccessScope {
  if (principal.kind !== 'user') return { principal, libraries: null, scopes: null };
  let libraries: Map<number, LibraryRole> | null = null;
  if (librariesEnabled(ctx)) {
    libraries = new Map(ctx.repos.libraries.rolesFor(principal.userId));
    if (key?.library_ids) {
      const allowed = new Set(key.library_ids);
      for (const id of [...libraries.keys()]) if (!allowed.has(id)) libraries.delete(id);
    }
  }
  let scopes: Set<ApiScope> | null = null;
  if (key) {
    const permitted = new Set(allowedScopes(principal.role));
    scopes = new Set(key.scopes.filter((s) => permitted.has(s)));
  }
  return { principal, libraries, scopes };
}

/** Scope of a user acting outside a request (e.g. the calendar feed of that user). */
export function userScope(ctx: AppContext, userId: number): AccessScope | null {
  const user = ctx.repos.users.byId(userId);
  if (!user || user.disabled_at) return null;
  return scopeFor(ctx, { kind: 'user', userId: user.id, username: user.username, role: user.role, via: 'session' });
}

/** Name of the actor for logs and the audit log. */
export function actorName(scope: AccessScope | null | undefined): string {
  const p = scope?.principal;
  if (!p) return 'anonymous';
  switch (p.kind) {
    case 'user':
      return p.via === 'apiKey' ? `${p.username} (API key #${p.apiKeyId})` : p.username;
    case 'legacyApiKey':
      return 'API key';
    case 'workflow':
      return `workflow #${p.workflowId}`;
    default:
      return `system (${p.task})`;
  }
}

/** Write an audit log entry for an action of `scope`. */
export function audit(ctx: AppContext, scope: AccessScope | null | undefined, action: string, target?: string | null, details?: object, libraryId?: number | null): void {
  const p = scope?.principal;
  ctx.repos.audit.add({
    actorType: p?.kind ?? 'anonymous',
    actorId: p?.kind === 'user' ? p.userId : p?.kind === 'workflow' ? p.workflowId : null,
    actorName: actorName(scope),
    action,
    target: target ?? null,
    libraryId: libraryId ?? null,
    details,
  });
}
