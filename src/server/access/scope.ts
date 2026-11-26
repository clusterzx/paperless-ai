/**
 * Who performs an action and what they may access. Every document access goes through a
 * `BackendView` bound to one scope (see backend/view.ts); there is no implicit "current user".
 */

export type InstanceRole = 'admin' | 'member';
export type LibraryRole = 'owner' | 'editor' | 'viewer';
export const LIBRARY_ROLES: readonly LibraryRole[] = ['viewer', 'editor', 'owner'];

/**
 * Scopes of API keys. Sessions have all of them (limited by the user's role).
 * - read: see documents, their text and files, labels and libraries
 * - write: change documents (title, date, labels, fields, text), restore them from the trash
 * - delete: move documents to the trash, delete them for good, delete file versions
 * - metadata: manage tags, correspondents, document types and custom fields (create, rename, merge, delete)
 * - upload: add documents and file versions
 * - chat: ask the AI about documents
 * - mcp: use the MCP server (/mcp) – what its tools may do follows the other scopes
 * - webhook: the document webhook
 * - ocr: the OCR API server – files sent to be read (Paperless-ngx remote OCR, /api/ocr/read)
 * - admin: administration (admins only)
 */
export const API_SCOPES = ['read', 'write', 'delete', 'metadata', 'upload', 'chat', 'mcp', 'webhook', 'ocr', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export type Principal =
  | { kind: 'user'; userId: number; username: string; role: InstanceRole; via: 'session' | 'apiKey'; apiKeyId?: number }
  /** The global API key of Paperless-AI ≤ 4.x (security.apiKey): acts as an admin. */
  | { kind: 'legacyApiKey' }
  | { kind: 'workflow'; workflowId: number; libraryId: number | null }
  | { kind: 'system'; task: string };

export interface AccessScope {
  readonly principal: Principal;
  /**
   * Libraries the scope may access and the role in each. `null` = no restriction (system tasks,
   * admins in companion mode, where there are no libraries).
   */
  readonly libraries: ReadonlyMap<number, LibraryRole> | null;
  /** API key scopes; `null` = all (sessions, system). */
  readonly scopes: ReadonlySet<ApiScope> | null;
}

export function systemScope(task = 'system'): AccessScope {
  return { principal: { kind: 'system', task }, libraries: null, scopes: null };
}

/** Shared instance for internal work (processing, OCR, RAG sync …). */
export const SYSTEM_SCOPE: AccessScope = Object.freeze(systemScope());

const RANK: Record<LibraryRole, number> = { viewer: 1, editor: 2, owner: 3 };

/** The higher of two roles (null = none). */
export function maxRole(a: LibraryRole | null | undefined, b: LibraryRole | null | undefined): LibraryRole | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return RANK[a] >= RANK[b] ? a : b;
}

export function roleAtLeast(role: LibraryRole | null | undefined, needed: LibraryRole): boolean {
  return Boolean(role) && RANK[role!] >= RANK[needed];
}

/** Library ids the scope may read, `null` = all. */
export function readableLibraries(scope: AccessScope): number[] | null {
  return scope.libraries ? [...scope.libraries.keys()] : null;
}

/** The role of the scope in a library (`owner` for unrestricted scopes). */
export function roleIn(scope: AccessScope, libraryId: number | null | undefined): LibraryRole | null {
  if (!scope.libraries) return 'owner';
  if (libraryId == null) return null;
  return scope.libraries.get(libraryId) ?? null;
}

export function canRead(scope: AccessScope, libraryId: number | null | undefined): boolean {
  return roleAtLeast(roleIn(scope, libraryId), 'viewer');
}

export function canEdit(scope: AccessScope, libraryId: number | null | undefined): boolean {
  return roleAtLeast(roleIn(scope, libraryId), 'editor');
}

export function canOwn(scope: AccessScope, libraryId: number | null | undefined): boolean {
  return roleAtLeast(roleIn(scope, libraryId), 'owner');
}

export function hasScope(scope: AccessScope, needed: ApiScope): boolean {
  return !scope.scopes || scope.scopes.has(needed);
}

/**
 * Administrator powers: system tasks, the legacy key, and admin users – through an API key only
 * when the key has the `admin` scope (a document key of an admin must not manage libraries, watch
 * folders or mail accounts).
 */
export function isAdmin(scope: AccessScope): boolean {
  const p = scope.principal;
  return p.kind === 'system' || p.kind === 'legacyApiKey' || (p.kind === 'user' && p.role === 'admin' && hasScope(scope, 'admin'));
}

export function userIdOf(scope: AccessScope): number | null {
  return scope.principal.kind === 'user' ? scope.principal.userId : null;
}
