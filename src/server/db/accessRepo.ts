/**
 * Groups, API keys, libraries with their members, audit log, calendar feeds, saved views and
 * in-app notifications.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Db } from './database.js';
import type { ApiScope, LibraryRole } from '../access/scope.js';

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- groups

export interface GroupRow {
  id: number;
  name: string;
  oidc_name: string | null;
  created_at: number;
  members: number;
}

export class GroupsRepo {
  constructor(private readonly db: Db) {}

  list(): GroupRow[] {
    return this.db
      .prepare('SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members FROM groups g ORDER BY g.name COLLATE NOCASE')
      .all() as GroupRow[];
  }

  get(id: number): GroupRow | undefined {
    return this.db.prepare('SELECT g.*, (SELECT COUNT(*) FROM group_members m WHERE m.group_id = g.id) AS members FROM groups g WHERE g.id = ?').get(id) as
      | GroupRow
      | undefined;
  }

  byName(name: string): GroupRow | undefined {
    return this.db.prepare('SELECT *, 0 AS members FROM groups WHERE name = ?').get(name) as GroupRow | undefined;
  }

  create(name: string, oidcName: string | null = null): number {
    return Number(this.db.prepare('INSERT INTO groups (name, oidc_name, created_at) VALUES (?, ?, ?)').run(name, oidcName, Date.now()).lastInsertRowid);
  }

  rename(id: number, name: string): void {
    this.db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(name, id);
  }

  delete(id: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM library_members WHERE principal_type = 'group' AND principal_id = ?").run(id);
      this.db.prepare('DELETE FROM groups WHERE id = ?').run(id);
    })();
  }

  members(groupId: number): number[] {
    return (this.db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY user_id').all(groupId) as { user_id: number }[]).map((r) => r.user_id);
  }

  setMembers(groupId: number, userIds: number[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM group_members WHERE group_id = ?').run(groupId);
      const ins = this.db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
      for (const u of new Set(userIds)) ins.run(groupId, u);
    })();
  }

  groupsOf(userId: number): { id: number; name: string; oidc_name: string | null }[] {
    return this.db
      .prepare('SELECT g.id, g.name, g.oidc_name FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ? ORDER BY g.name')
      .all(userId) as { id: number; name: string; oidc_name: string | null }[];
  }

  /**
   * Make the OIDC-synchronised groups of a user exactly `names` (creating missing groups). Manual
   * groups are not touched.
   */
  syncOidc(userId: number, names: string[]): void {
    this.db.transaction(() => {
      const wanted = new Set(names.map((n) => n.trim()).filter(Boolean));
      const ids: number[] = [];
      for (const name of wanted) {
        let row = this.db.prepare('SELECT id FROM groups WHERE oidc_name = ?').get(name) as { id: number } | undefined;
        if (!row) {
          // A manual group of the same name is taken over (it gets synchronised from now on).
          row = this.db.prepare('SELECT id FROM groups WHERE name = ? COLLATE NOCASE AND oidc_name IS NULL').get(name) as { id: number } | undefined;
          if (row) this.db.prepare('UPDATE groups SET oidc_name = ? WHERE id = ?').run(name, row.id);
          else row = { id: this.create(name, name) };
        }
        ids.push(row.id);
      }
      this.db
        .prepare(
          `DELETE FROM group_members WHERE user_id = ? AND group_id IN (SELECT id FROM groups WHERE oidc_name IS NOT NULL)
           AND group_id NOT IN (SELECT value FROM json_each(?))`,
        )
        .run(userId, JSON.stringify(ids));
      const ins = this.db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
      for (const id of ids) ins.run(id, userId);
    })();
  }
}

// ---------------------------------------------------------------- API keys

export interface ApiKeyRow {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  library_ids: number[] | null;
  created_at: number;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
}

type RawApiKey = Omit<ApiKeyRow, 'scopes' | 'library_ids'> & { scopes: string; library_ids: string | null; hash: string };

const KEY_PATTERN = /^pai_([a-z0-9]{8})_([A-Za-z0-9_-]{20,})$/;

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

function toRow(r: RawApiKey): ApiKeyRow {
  return { ...r, scopes: parseJson<ApiScope[]>(r.scopes, []), library_ids: parseJson<number[] | null>(r.library_ids, null) } as ApiKeyRow & { hash?: string };
}

export class ApiKeysRepo {
  /** Last-used timestamps are written at most once a minute per key. */
  private readonly touched = new Map<number, number>();

  constructor(private readonly db: Db) {}

  /**
   * Create a key; the full key is returned only here. Keys are 256-bit random values, so a fast hash
   * is enough to store them (a slow password hash would add nothing).
   */
  create(userId: number, input: { name: string; scopes: ApiScope[]; libraryIds?: number[] | null; expiresAt?: number | null }): { id: number; key: string } {
    for (;;) {
      const prefix = randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
      if (prefix.length < 8 || this.db.prepare('SELECT 1 FROM api_keys WHERE prefix = ?').get(prefix)) continue;
      const key = `pai_${prefix}_${randomBytes(32).toString('base64url')}`;
      const id = Number(
        this.db
          .prepare('INSERT INTO api_keys (user_id, name, prefix, hash, scopes, library_ids, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(
            userId,
            input.name,
            prefix,
            hashKey(key),
            JSON.stringify([...new Set(input.scopes)]),
            input.libraryIds?.length ? JSON.stringify([...new Set(input.libraryIds)]) : null,
            Date.now(),
            input.expiresAt ?? null,
          ).lastInsertRowid,
      );
      return { id, key };
    }
  }

  list(userId?: number): ApiKeyRow[] {
    const rows = (
      userId === undefined
        ? this.db.prepare('SELECT * FROM api_keys ORDER BY created_at DESC').all()
        : this.db.prepare('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC').all(userId)
    ) as RawApiKey[];
    return rows.map((r) => {
      const { hash: _hash, ...rest } = toRow(r) as ApiKeyRow & { hash?: string };
      return rest;
    });
  }

  get(id: number): ApiKeyRow | undefined {
    const r = this.db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as RawApiKey | undefined;
    if (!r) return undefined;
    const { hash: _hash, ...rest } = toRow(r) as ApiKeyRow & { hash?: string };
    return rest;
  }

  revoke(id: number): void {
    this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(Date.now(), id);
  }

  /** The active key matching `candidate` (constant-time comparison of the hashes). */
  verify(candidate: string): ApiKeyRow | null {
    const m = KEY_PATTERN.exec(candidate.trim());
    if (!m) return null;
    const r = this.db.prepare('SELECT * FROM api_keys WHERE prefix = ?').get(m[1]) as RawApiKey | undefined;
    if (!r || r.revoked_at || (r.expires_at && r.expires_at < Date.now())) return null;
    const a = Buffer.from(r.hash, 'hex');
    const b = Buffer.from(hashKey(candidate.trim()), 'hex');
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const now = Date.now();
    if ((this.touched.get(r.id) ?? 0) < now - 60_000) {
      this.touched.set(r.id, now);
      this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, r.id);
    }
    const { hash: _hash, ...rest } = toRow(r) as ApiKeyRow & { hash?: string };
    return rest;
  }

  static looksLikeKey(candidate: string): boolean {
    return KEY_PATTERN.test(candidate.trim());
  }
}

// ---------------------------------------------------------------- libraries

export interface LibrarySettings {
  /** Days in the trash before documents are purged. */
  trashDays?: number;
  /** Keep at most this many file versions per document (0 / undefined = all). */
  maxVersions?: number;
  /** Delete versions older than this many days (never the current one or version 1). */
  maxVersionAgeDays?: number;
  /** Run the AI analysis again when a new version is added. */
  reanalyzeOnNewVersion?: boolean;
  /** Store identical files again instead of linking to the existing document. */
  allowDuplicates?: boolean;
}

export interface LibraryRow {
  id: number;
  name: string;
  description: string;
  settings: LibrarySettings;
  created_by: number | null;
  created_at: number;
  deleted_at: number | null;
}

export interface LibraryMemberRow {
  library_id: number;
  principal_type: 'user' | 'group';
  principal_id: number;
  role: LibraryRole;
  name: string | null;
}

type RawLibrary = Omit<LibraryRow, 'settings'> & { settings: string };

const RANK: Record<LibraryRole, number> = { viewer: 1, editor: 2, owner: 3 };

export class LibrariesRepo {
  /** Library roles per user (cached; cleared whenever a membership, group or library changes). */
  private roleCache = new Map<number, Map<number, LibraryRole>>();

  constructor(private readonly db: Db) {}

  invalidate(): void {
    this.roleCache.clear();
  }

  list(includeDeleted = false): LibraryRow[] {
    const rows = this.db.prepare(`SELECT * FROM libraries ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY name COLLATE NOCASE, id`).all() as RawLibrary[];
    return rows.map((r) => ({ ...r, settings: parseJson<LibrarySettings>(r.settings, {}) }));
  }

  get(id: number): LibraryRow | undefined {
    const r = this.db.prepare('SELECT * FROM libraries WHERE id = ?').get(id) as RawLibrary | undefined;
    return r ? { ...r, settings: parseJson<LibrarySettings>(r.settings, {}) } : undefined;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM libraries WHERE deleted_at IS NULL').get() as { c: number }).c;
  }

  /** A library (not deleted) with this name, case ignored – names are unique, they address libraries in paths (WebDAV, watch folders). */
  byName(name: string, exceptId?: number): LibraryRow | undefined {
    return this.list().find((l) => l.name.trim().toLowerCase() === name.trim().toLowerCase() && l.id !== exceptId);
  }

  create(name: string, createdBy: number | null, settings: LibrarySettings = {}, description = ''): number {
    const id = Number(
      this.db
        .prepare('INSERT INTO libraries (name, description, settings, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, description, JSON.stringify(settings), createdBy, Date.now()).lastInsertRowid,
    );
    if (createdBy != null) this.setMember(id, 'user', createdBy, 'owner');
    this.invalidate();
    return id;
  }

  update(id: number, patch: { name?: string; description?: string; settings?: LibrarySettings }): void {
    const cur = this.get(id);
    if (!cur) return;
    this.db
      .prepare('UPDATE libraries SET name = ?, description = ?, settings = ? WHERE id = ?')
      .run(patch.name ?? cur.name, patch.description ?? cur.description, JSON.stringify({ ...cur.settings, ...(patch.settings ?? {}) }), id);
  }

  markDeleted(id: number): void {
    this.db.prepare('UPDATE libraries SET deleted_at = ? WHERE id = ?').run(Date.now(), id);
    this.invalidate();
  }

  members(libraryId: number): LibraryMemberRow[] {
    return this.db
      .prepare(
        `SELECT m.library_id, m.principal_type, m.principal_id, m.role,
                CASE m.principal_type WHEN 'user' THEN (SELECT username FROM users WHERE id = m.principal_id)
                                      ELSE (SELECT name FROM groups WHERE id = m.principal_id) END AS name
         FROM library_members m WHERE m.library_id = ? ORDER BY m.principal_type DESC, name COLLATE NOCASE`,
      )
      .all(libraryId) as LibraryMemberRow[];
  }

  setMember(libraryId: number, type: 'user' | 'group', principalId: number, role: LibraryRole | null): void {
    if (role) {
      this.db
        .prepare(
          `INSERT INTO library_members (library_id, principal_type, principal_id, role) VALUES (?, ?, ?, ?)
           ON CONFLICT (library_id, principal_type, principal_id) DO UPDATE SET role = excluded.role`,
        )
        .run(libraryId, type, principalId, role);
    } else {
      this.db.prepare('DELETE FROM library_members WHERE library_id = ? AND principal_type = ? AND principal_id = ?').run(libraryId, type, principalId);
    }
    this.invalidate();
  }

  setMembers(libraryId: number, members: { type: 'user' | 'group'; id: number; role: LibraryRole }[]): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM library_members WHERE library_id = ?').run(libraryId);
      for (const m of members) this.setMember(libraryId, m.type, m.id, m.role);
    })();
    this.invalidate();
  }

  /** Owners of a library (direct user memberships). */
  owners(libraryId: number): number[] {
    return (
      this.db.prepare("SELECT principal_id FROM library_members WHERE library_id = ? AND principal_type = 'user' AND role = 'owner'").all(libraryId) as {
        principal_id: number;
      }[]
    ).map((r) => r.principal_id);
  }

  /** Active users who own a library with these members – directly or through a group – optionally without one user. */
  activeOwnerIds(members: { type: 'user' | 'group'; id: number; role: LibraryRole }[], withoutUser?: number): number[] {
    const active = this.db.prepare('SELECT 1 FROM users WHERE id = ? AND disabled_at IS NULL');
    const inGroup = this.db.prepare('SELECT gm.user_id FROM group_members gm JOIN users u ON u.id = gm.user_id AND u.disabled_at IS NULL WHERE gm.group_id = ?');
    const out = new Set<number>();
    for (const m of members) {
      if (m.role !== 'owner') continue;
      if (m.type === 'user') {
        if (m.id !== withoutUser && active.get(m.id)) out.add(m.id);
      } else {
        for (const r of inGroup.all(m.id) as { user_id: number }[]) if (r.user_id !== withoutUser) out.add(r.user_id);
      }
    }
    return [...out];
  }

  /** Libraries that have an active owner now and would have none without this user or group. */
  orphanedWithout(principal: { type: 'user' | 'group'; id: number }): LibraryRow[] {
    return this.list().filter((l) => {
      const members = this.members(l.id).map((m) => ({ type: m.principal_type, id: m.principal_id, role: m.role }));
      if (!this.activeOwnerIds(members).length) return false;
      const rest = principal.type === 'user' ? this.activeOwnerIds(members, principal.id) : this.activeOwnerIds(members.filter((m) => !(m.type === 'group' && m.id === principal.id)));
      return rest.length === 0;
    });
  }

  /** The effective role of a user in each library: the highest of direct and group memberships. */
  rolesFor(userId: number): Map<number, LibraryRole> {
    const cached = this.roleCache.get(userId);
    if (cached) return cached;
    const rows = this.db
      .prepare(
        `SELECT m.library_id, m.role FROM library_members m JOIN libraries l ON l.id = m.library_id AND l.deleted_at IS NULL
         WHERE (m.principal_type = 'user' AND m.principal_id = ?)
            OR (m.principal_type = 'group' AND m.principal_id IN (SELECT group_id FROM group_members WHERE user_id = ?))`,
      )
      .all(userId, userId) as { library_id: number; role: LibraryRole }[];
    const map = new Map<number, LibraryRole>();
    for (const r of rows) {
      const cur = map.get(r.library_id);
      if (!cur || RANK[r.role] > RANK[cur]) map.set(r.library_id, r.role);
    }
    if (this.roleCache.size > 1000) this.roleCache.clear();
    this.roleCache.set(userId, map);
    return map;
  }
}

// ---------------------------------------------------------------- audit log

export interface AuditEntry {
  id: number;
  at: number;
  actor_type: string;
  actor_id: number | null;
  actor_name: string | null;
  action: string;
  target: string | null;
  library_id: number | null;
  details: Record<string, unknown>;
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  add(e: { actorType: string; actorId?: number | null; actorName?: string | null; action: string; target?: string | null; libraryId?: number | null; details?: object }): void {
    this.db
      .prepare('INSERT INTO audit_log (at, actor_type, actor_id, actor_name, action, target, library_id, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), e.actorType, e.actorId ?? null, e.actorName ?? null, e.action, e.target ?? null, e.libraryId ?? null, JSON.stringify(e.details ?? {}));
  }

  list(q: { libraryIds?: number[] | null; limit?: number; before?: number | null } = {}): AuditEntry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.libraryIds) {
      where.push(`library_id IN (SELECT value FROM json_each(?))`);
      params.push(JSON.stringify(q.libraryIds));
    }
    if (q.before) {
      where.push('id < ?');
      params.push(q.before);
    }
    const rows = this.db
      .prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`)
      .all(...params, Math.min(q.limit ?? 100, 500)) as (Omit<AuditEntry, 'details'> & { details: string })[];
    return rows.map((r) => ({ ...r, details: parseJson<Record<string, unknown>>(r.details, {}) }));
  }
}

// ---------------------------------------------------------------- calendar feeds

export class CalendarFeedsRepo {
  constructor(private readonly db: Db) {}

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** The user of a feed token. */
  userFor(token: string): number | null {
    const r = this.db.prepare('SELECT user_id FROM calendar_feeds WHERE token_hash = ?').get(CalendarFeedsRepo.hash(token)) as { user_id: number } | undefined;
    return r?.user_id ?? null;
  }

  /** The token of the user's feed (null before it was created). */
  tokenOf(userId: number): string | null {
    return (this.db.prepare('SELECT token FROM calendar_feeds WHERE user_id = ?').get(userId) as { token: string } | undefined)?.token ?? null;
  }

  /** Store a token for the user (replaces the previous one). */
  set(userId: number, token: string): void {
    this.db
      .prepare(
        `INSERT INTO calendar_feeds (user_id, token, token_hash, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET token = excluded.token, token_hash = excluded.token_hash, created_at = excluded.created_at`,
      )
      .run(userId, token, CalendarFeedsRepo.hash(token), Date.now());
  }
}

// ---------------------------------------------------------------- saved views

export interface SavedViewRow {
  id: number;
  user_id: number;
  library_id: number | null;
  name: string;
  filter: Record<string, unknown>;
  columns: string[];
  sort: string | null;
  position: number;
  in_navigation: boolean;
}

type RawView = Omit<SavedViewRow, 'filter' | 'columns' | 'in_navigation'> & { filter: string; columns: string; in_navigation: number };

export class SavedViewsRepo {
  constructor(private readonly db: Db) {}

  private static conv(r: RawView): SavedViewRow {
    return { ...r, filter: parseJson(r.filter, {}), columns: parseJson(r.columns, []), in_navigation: Boolean(r.in_navigation) };
  }

  /** Own views and views shared with one of the libraries. */
  list(userId: number, libraryIds: number[] | null): SavedViewRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM saved_views WHERE user_id = ? OR (library_id IS NOT NULL AND (? IS NULL OR library_id IN (SELECT value FROM json_each(?))))
         ORDER BY position, name COLLATE NOCASE`,
      )
      .all(userId, libraryIds ? 1 : null, JSON.stringify(libraryIds ?? [])) as RawView[];
    return rows.map(SavedViewsRepo.conv);
  }

  get(id: number): SavedViewRow | undefined {
    const r = this.db.prepare('SELECT * FROM saved_views WHERE id = ?').get(id) as RawView | undefined;
    return r ? SavedViewsRepo.conv(r) : undefined;
  }

  save(userId: number, v: { id?: number; libraryId?: number | null; name: string; filter: object; columns?: string[]; sort?: string | null; position?: number; inNavigation?: boolean }): number {
    if (v.id) {
      this.db
        .prepare('UPDATE saved_views SET library_id = ?, name = ?, filter = ?, columns = ?, sort = ?, position = ?, in_navigation = ? WHERE id = ?')
        .run(v.libraryId ?? null, v.name, JSON.stringify(v.filter), JSON.stringify(v.columns ?? []), v.sort ?? null, v.position ?? 0, v.inNavigation ? 1 : 0, v.id);
      return v.id;
    }
    return Number(
      this.db
        .prepare('INSERT INTO saved_views (user_id, library_id, name, filter, columns, sort, position, in_navigation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(userId, v.libraryId ?? null, v.name, JSON.stringify(v.filter), JSON.stringify(v.columns ?? []), v.sort ?? null, v.position ?? 0, v.inNavigation ? 1 : 0)
        .lastInsertRowid,
    );
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM saved_views WHERE id = ?').run(id);
  }
}

// ---------------------------------------------------------------- notifications

export interface NotificationRow {
  id: number;
  user_id: number;
  at: number;
  title: string;
  body: string;
  link: string | null;
  read_at: number | null;
}

export class NotificationsRepo {
  constructor(private readonly db: Db) {}

  add(userId: number, n: { title: string; body?: string; link?: string | null }): number {
    return Number(
      this.db.prepare('INSERT INTO notifications (user_id, at, title, body, link) VALUES (?, ?, ?, ?, ?)').run(userId, Date.now(), n.title, n.body ?? '', n.link ?? null)
        .lastInsertRowid,
    );
  }

  list(userId: number, limit = 50): NotificationRow[] {
    return this.db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit) as NotificationRow[];
  }

  unread(userId: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read_at IS NULL').get(userId) as { c: number }).c;
  }

  markRead(userId: number, ids?: number[]): void {
    if (ids?.length) {
      this.db
        .prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))')
        .run(Date.now(), userId, JSON.stringify(ids));
    } else this.db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), userId);
  }

  /** Remove notifications older than `days`. */
  prune(days = 90): void {
    this.db.prepare('DELETE FROM notifications WHERE at < ?').run(Date.now() - days * 86_400_000);
  }
}
