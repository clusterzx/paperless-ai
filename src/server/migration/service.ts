/**
 * Migration assistant Paperless-ngx → built-in archive (docs/standalone/migration.md §2).
 *
 * Paperless-ngx is only read. Documents keep their id and their `modified` string, so the
 * processing state, the AI history, OCR results, the calendar and the RAG index stay valid – no
 * re-analysis, no new OCR, no re-embedding. Progress is stored per document (`migration_items`):
 * pause, resume, restart and repeated syncs are possible at any time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { AppContext } from '../context.js';
import { LocalBackend } from '../archive/backend.js';
import { toColumns } from '../archive/fields.js';
import { sniffType } from '../archive/files.js';
import { normalizeName } from '../backend/metadata.js';
import { datePart } from '../processing/dates.js';
import type { PaperlessClient } from '../paperless/client.js';
import type { PaperlessDocument } from '../paperless/types.js';
import type { LibraryRole } from '../access/scope.js';
import type { MigrationOptions, MigrationPlan, MigrationReport, MigrationStatus, MigrationStrategy, MigrationState } from '../../shared/migration.js';
import { describeError } from '../util/http.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'migration' });


const STATE_KEY = 'migration.paperless';

interface StoredState {
  state: MigrationState;
  strategy: MigrationStrategy | null;
  options: MigrationOptions | null;
  startedAt: number | null;
  finishedAt: number | null;
  lastSyncAt: number | null;
  cutoverAt: number | null;
  /** Libraries created by the migration (removed by "discard"). */
  libraries: number[];
  /** ngx user id → Paperless-AI user id. */
  users: Record<string, number>;
}

interface NgxUser {
  id: number;
  username: string;
  is_superuser?: boolean;
  groups?: number[];
}

interface NgxDoc extends PaperlessDocument {
  permissions?: { view: { users: number[]; groups: number[] }; change: { users: number[]; groups: number[] } };
}

interface NgxNamed {
  id: number;
  name: string;
  color?: string;
  is_inbox_tag?: boolean;
  parent?: number | null;
  path?: string;
  matching_algorithm?: number;
  match?: string;
}

interface NgxCustomField {
  id: number;
  name: string;
  data_type: string;
  extra_data?: Record<string, unknown> | null;
}

/** What is read from Paperless-ngx once per analysis / start (names, users, permissions). */
interface Snapshot {
  docs: NgxDoc[];
  tags: Map<number, NgxNamed>;
  correspondents: Map<number, NgxNamed>;
  types: Map<number, NgxNamed>;
  storagePaths: Map<number, NgxNamed>;
  customFields: Map<number, NgxCustomField>;
  users: Map<number, NgxUser> | null;
  groups: number | null;
}

const IGNORED_USERS = new Set(['anonymoususer', 'consumer']);

export class MigrationService {
  private snapshot: Snapshot | null = null;
  private loop: Promise<void> | null = null;
  private pauseRequested = false;
  private local: LocalBackend | null = null;

  constructor(private readonly ctx: AppContext) {}

  private get client(): PaperlessClient {
    return this.ctx.paperless();
  }

  /** The built-in archive to write into: the running one after the cutover, a passive one before. */
  private archive(): LocalBackend {
    const current = this.ctx.archiveMode() === 'builtin' ? this.ctx.archive() : null;
    if (current instanceof LocalBackend) return current;
    this.local ??= new LocalBackend(this.ctx, { passive: true });
    return this.local;
  }

  // ------------------------------------------------------------ state

  private stored(): StoredState {
    return {
      state: 'idle',
      strategy: null,
      options: null,
      startedAt: null,
      finishedAt: null,
      lastSyncAt: null,
      cutoverAt: null,
      libraries: [],
      users: {},
      ...this.ctx.repos.kv.get<Partial<StoredState>>(STATE_KEY),
    };
  }

  private save(patch: Partial<StoredState>): StoredState {
    const next = { ...this.stored(), ...patch };
    this.ctx.repos.kv.set(STATE_KEY, next);
    return next;
  }

  /** Documents of the built-in archive (trash included) that were not imported by this migration. */
  ownDocuments(): number {
    return (
      this.ctx.db
        .prepare('SELECT COUNT(*) AS c FROM lib_documents d WHERE NOT EXISTS (SELECT 1 FROM migration_items m WHERE m.ngx_id = d.id AND m.imported_modified IS NOT NULL)')
        .get() as { c: number }
    ).c;
  }

  status(): MigrationStatus {
    const s = this.stored();
    const rows = this.ctx.db.prepare('SELECT status, COUNT(*) AS c FROM migration_items GROUP BY status').all() as { status: string; c: number }[];
    const counts = { total: 0, pending: 0, imported: 0, failed: 0, skipped: 0, deleted: 0 };
    for (const r of rows) {
      counts[r.status as keyof typeof counts] = r.c;
      counts.total += r.c;
    }
    const errors = (this.ctx.db.prepare("SELECT ngx_id AS id, error FROM migration_items WHERE status = 'failed' ORDER BY ngx_id LIMIT 50").all() as { id: number; error: string }[]).map((e) => ({ id: e.id, error: e.error }));
    return {
      state: s.state,
      mode: this.ctx.archiveMode(),
      running: this.loop !== null,
      strategy: s.strategy,
      options: s.options,
      counts,
      errors,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      lastSyncAt: s.lastSyncAt,
      cutoverAt: s.cutoverAt,
      ownDocuments: this.ownDocuments(),
      libraries: s.libraries,
    };
  }

  // ------------------------------------------------------------ reading Paperless-ngx

  private async optionalList<T>(p: string): Promise<T[] | null> {
    try {
      return await this.client.listAll<T>(p, {}, 100);
    } catch {
      return null;
    }
  }

  private async load(): Promise<Snapshot> {
    const c = this.client;
    const [docs, tags, correspondents, types, storagePaths, customFields, users, groups] = await Promise.all([
      c.listAll<NgxDoc>('/documents/', { full_perms: true, truncate_content: true, ordering: 'id' }, 250),
      c.listAll<NgxNamed>('/tags/', {}, 500),
      c.listAll<NgxNamed>('/correspondents/', {}, 500),
      c.listAll<NgxNamed>('/document_types/', {}, 500),
      this.optionalList<NgxNamed>('/storage_paths/'),
      c.listAll<NgxCustomField>('/custom_fields/', {}, 500).catch(() => [] as NgxCustomField[]),
      this.optionalList<NgxUser>('/users/'),
      this.optionalList<{ id: number }>('/groups/'),
    ]);
    const byId = <T extends { id: number }>(list: T[] | null) => new Map((list ?? []).map((x) => [x.id, x]));
    this.snapshot = {
      docs,
      tags: byId(tags),
      correspondents: byId(correspondents),
      types: byId(types),
      storagePaths: byId(storagePaths),
      customFields: byId(customFields),
      users: users ? byId(users.filter((u) => !IGNORED_USERS.has(u.username.toLowerCase()))) : null,
      groups: groups?.length ?? (groups ? 0 : null),
    };
    return this.snapshot;
  }

  /** Dry run: what there is, what it needs, what cannot be moved. */
  async analyse(): Promise<MigrationReport> {
    const snap = await this.load();
    const info = await this.client.connect();
    const c = this.client;
    const [workflows, mailAccounts, mailRules, savedViews, shareLinks] = await Promise.all(
      ['/workflows/', '/mail_accounts/', '/mail_rules/', '/saved_views/', '/share_links/'].map((p) => this.optionalList<unknown>(p).then((l) => (l ? l.length : null))),
    );
    // Storage: a sample of the original sizes, extrapolated.
    const sample = snap.docs.filter((_, i) => i % Math.max(1, Math.floor(snap.docs.length / 25)) === 0).slice(0, 25);
    let sampled = 0;
    let sampleBytes = 0;
    for (const d of sample) {
      try {
        const meta = await c.req<{ original_size?: number; archive_size?: number | null }>(`/documents/${d.id}/metadata/`);
        sampleBytes += meta.original_size ?? 0;
        sampled++;
      } catch {
        /* skip */
      }
    }
    const storageDir = this.archive().blobs.root;
    let freeBytes: number | null = null;
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      const st = fs.statfsSync(storageDir);
      freeBytes = st.bavail * st.bsize;
    } catch {
      /* unknown */
    }
    const matchingRules = [...snap.tags.values(), ...snap.correspondents.values(), ...snap.types.values()].filter((x) => x.matching_algorithm && x.matching_algorithm !== 0 && x.matching_algorithm !== 6 && (x.match ?? '') !== '').length;
    const owners = new Map<string, number>();
    for (const d of snap.docs) {
      const name = d.owner == null ? '(no owner)' : (snap.users?.get(d.owner)?.username ?? `user #${d.owner}`);
      owners.set(name, (owners.get(name) ?? 0) + 1);
    }
    const fieldProblems: MigrationReport['fieldProblems'] = [];
    for (const d of snap.docs) {
      for (const f of d.custom_fields ?? []) {
        const def = snap.customFields.get(f.field);
        if (!def || fieldProblems.length >= 50) continue;
        try {
          toColumns({ name: def.name, data_type: def.data_type, options: selectOptions(def) }, f.value);
        } catch {
          fieldProblems.push({ documentId: d.id, field: def.name, value: String(f.value).slice(0, 100) });
        }
      }
    }
    return {
      serverVersion: info.serverVersion ?? null,
      superuser: Boolean(info.user?.isSuperuser),
      counts: {
        documents: snap.docs.length,
        pages: snap.docs.reduce((n, d) => n + (d.page_count ?? 0), 0),
        tags: snap.tags.size,
        correspondents: snap.correspondents.size,
        documentTypes: snap.types.size,
        customFields: snap.customFields.size,
        storagePaths: snap.storagePaths.size,
        users: snap.users?.size ?? null,
        groups: snap.groups,
        notes: snap.docs.reduce((n, d) => n + (Array.isArray(d.notes) ? d.notes.length : 0), 0),
      },
      storage: { estimatedBytes: sampled ? Math.round((sampleBytes / sampled) * snap.docs.length) : 0, sampled, freeBytes },
      notTransferred: { workflows, mailAccounts, mailRules, savedViews, shareLinks, matchingRules, notes: snap.docs.reduce((n, d) => n + (Array.isArray(d.notes) ? d.notes.length : 0), 0) },
      fieldProblems,
      owners: [...owners].map(([name, documents]) => ({ name, documents })).sort((a, b) => b.documents - a.documents),
    };
  }

  // ------------------------------------------------------------ mapping

  private userName(snap: Snapshot, id: number | null | undefined): string | null {
    if (id == null) return null;
    return snap.users?.get(id)?.username ?? null;
  }

  /** The library a document goes to. */
  private target(snap: Snapshot, strategy: MigrationStrategy, d: NgxDoc): string {
    if (strategy.kind === 'single') return strategy.libraryName;
    if (strategy.kind === 'owner') return this.userName(snap, d.owner) ?? strategy.sharedName;
    for (const r of strategy.rules) {
      if (r.owner && normalizeName(this.userName(snap, d.owner) ?? '') !== normalizeName(r.owner)) continue;
      if (r.tag && !d.tags.some((t) => normalizeName(snap.tags.get(t)?.name ?? '') === normalizeName(r.tag!))) continue;
      if (r.storagePath && normalizeName(snap.storagePaths.get(d.storage_path ?? -1)?.name ?? '') !== normalizeName(r.storagePath)) continue;
      if (r.customField) {
        const def = [...snap.customFields.values()].find((f) => normalizeName(f.name) === normalizeName(r.customField!.name));
        const v = def ? (d.custom_fields ?? []).find((f) => f.field === def.id)?.value : undefined;
        if (v === undefined || normalizeName(String(v)) !== normalizeName(r.customField.value)) continue;
      }
      return r.library;
    }
    return strategy.defaultLibrary;
  }

  /** Can this Paperless-ngx user see / change the document in Paperless-ngx? */
  private access(d: NgxDoc, u: NgxUser): 'change' | 'view' | null {
    if (u.is_superuser || d.owner == null || d.owner === u.id) return 'change';
    const groups = new Set(u.groups ?? []);
    const p = d.permissions;
    if (!p) return null;
    if (p.change.users.includes(u.id) || p.change.groups.some((g) => groups.has(g))) return 'change';
    if (p.view.users.includes(u.id) || p.view.groups.some((g) => groups.has(g))) return 'view';
    return null;
  }

  /** "Who will see what": libraries, their members and where access becomes wider than in Paperless-ngx. */
  async plan(strategy: MigrationStrategy, options: MigrationOptions, snapshot?: Snapshot): Promise<MigrationPlan & { assignments: Map<number, string>; members: Map<string, Map<number, LibraryRole>>; userMap: Map<number, { local: number | null; action: 'match' | 'create' | 'skip' }> }> {
    const snap = snapshot ?? this.snapshot ?? (await this.load());
    const localUsers = this.ctx.repos.users.list();
    const userMap = new Map<number, { local: number | null; action: 'match' | 'create' | 'skip' }>();
    for (const u of snap.users?.values() ?? []) {
      const local = localUsers.find((l) => l.username.toLowerCase() === u.username.toLowerCase());
      userMap.set(u.id, local ? { local: local.id, action: 'match' } : { local: null, action: options.createUsers ? 'create' : 'skip' });
    }
    const assignments = new Map<number, string>();
    const docsOf = new Map<string, NgxDoc[]>();
    for (const d of snap.docs) {
      const lib = this.target(snap, strategy, d);
      assignments.set(d.id, lib);
      docsOf.set(lib, [...(docsOf.get(lib) ?? []), d]);
    }
    const RANK: Record<LibraryRole, number> = { viewer: 1, editor: 2, owner: 3 };
    const members = new Map<string, Map<number, LibraryRole>>();
    const widened: MigrationPlan['widened'] = [];
    for (const [lib, docs] of docsOf) {
      const m = new Map<number, LibraryRole>();
      for (const u of snap.users?.values() ?? []) {
        if (userMap.get(u.id)?.action === 'skip') continue;
        let role: LibraryRole | null = null;
        if (u.is_superuser) role = 'owner';
        else if (strategy.kind === 'single') role = 'editor';
        else {
          for (const d of docs) {
            const a = this.access(d, u);
            const r: LibraryRole | null = a === 'change' ? (strategy.kind === 'owner' && d.owner === u.id ? 'owner' : 'editor') : a === 'view' ? 'viewer' : null;
            if (r && (!role || RANK[r] > RANK[role])) role = r;
          }
        }
        if (!role) continue;
        m.set(u.id, role);
        const hidden = docs.filter((d) => !this.access(d, u)).length;
        if (hidden) widened.push({ user: u.username, library: lib, documents: hidden });
      }
      members.set(lib, m);
    }
    return {
      libraries: [...docsOf].map(([name, docs]) => ({
        name,
        documents: docs.length,
        members: [...(members.get(name) ?? [])].map(([uid, role]) => ({ user: snap.users?.get(uid)?.username ?? `#${uid}`, role })),
      })),
      users: [...(snap.users?.values() ?? [])].map((u) => ({ ngx: u.username, local: localUsers.find((l) => l.id === userMap.get(u.id)?.local)?.username ?? null, action: userMap.get(u.id)!.action })),
      widened,
      assignments,
      members,
      userMap,
    };
  }

  // ------------------------------------------------------------ import

  /** Create the libraries, members and users of the plan, queue every document and start. */
  async start(strategy: MigrationStrategy, options: MigrationOptions): Promise<MigrationStatus> {
    if (this.loop) throw new Error('The migration is running already');
    if (this.ctx.archiveMode() === 'builtin' && this.stored().state === 'cutover') throw new Error('The archive was switched already – use the sync');
    // The documents keep their Paperless-ngx ids: next to documents added in the built-in archive
    // itself they would collide (and must never replace them).
    const own = this.ownDocuments();
    if (own) {
      throw new Error(
        `The built-in archive has ${own} document(s) of its own. The migration keeps the document ids of Paperless-ngx and needs an archive without them: ` +
          'run it from companion mode (Paperless-ngx connected) into a new installation, or empty the built-in archive first.',
      );
    }
    const snap = await this.load();
    const plan = await this.plan(strategy, options, snap);
    const repo = this.ctx.repos.libraries;
    const stored = this.stored();
    // Users first (disabled, no password – activated by an admin or linked to SSO).
    const users: Record<string, number> = { ...stored.users };
    for (const [ngxId, m] of plan.userMap) {
      if (m.action === 'match') users[ngxId] = m.local!;
      else if (m.action === 'create' && !users[ngxId]) {
        const name = snap.users!.get(ngxId)!.username;
        const id = this.ctx.repos.users.create(name, '!', 'member');
        this.ctx.repos.users.setDisabled(id, true);
        users[ngxId] = id;
        log.info(`Created the account "${name}" (disabled) for the Paperless-ngx user`);
      }
    }
    const libraries = new Set(stored.libraries);
    const libIds = new Map<string, number>();
    const admins = this.ctx.repos.users.list().filter((u) => u.role === 'admin' && !u.disabled_at);
    for (const l of plan.libraries) {
      let lib = repo.list().find((x) => x.name.toLowerCase() === l.name.toLowerCase());
      if (!lib) {
        const id = repo.create(l.name, null, { trashDays: this.ctx.cfg.archive.builtin.trashDays });
        libraries.add(id);
        lib = repo.get(id)!;
      }
      libIds.set(l.name, lib.id);
      // Administrators of Paperless-AI see every library they migrated.
      for (const a of admins) repo.setMember(lib.id, 'user', a.id, 'owner');
      for (const [ngxId, role] of plan.members.get(l.name) ?? []) if (users[ngxId]) repo.setMember(lib.id, 'user', users[ngxId], role);
    }
    const now = Date.now();
    const ins = this.ctx.db.prepare("INSERT OR IGNORE INTO migration_items (ngx_id, status, updated_at) VALUES (?, 'pending', ?)");
    this.ctx.db.transaction(() => {
      for (const d of snap.docs) ins.run(d.id, now);
    })();
    this.save({ state: 'importing', strategy, options, startedAt: stored.startedAt ?? now, finishedAt: null, libraries: [...libraries], users });
    this.assignments = new Map([...plan.assignments].map(([id, name]) => [id, libIds.get(name)!]));
    this.run();
    return this.status();
  }

  /** ngx document id → library id (from the plan; documents added later go by the strategy). */
  private assignments = new Map<number, number>();

  private libraryFor(d: NgxDoc): number {
    const known = this.assignments.get(d.id);
    if (known) return known;
    const s = this.stored();
    const name = this.snapshot && s.strategy ? this.target(this.snapshot, s.strategy, d) : null;
    const lib = name ? this.ctx.repos.libraries.list().find((l) => l.name.toLowerCase() === name.toLowerCase()) : undefined;
    return lib?.id ?? s.libraries[0] ?? this.archive().ensureDefaultLibrary();
  }

  pause(): void {
    this.pauseRequested = true;
  }

  resume(): MigrationStatus {
    if (!this.loop && this.stored().state !== 'cutover') {
      this.save({ state: 'importing' });
      this.run();
    }
    return this.status();
  }

  /** Wait for the running import (tests, CLI). */
  async wait(): Promise<void> {
    await this.loop;
  }

  private run(): void {
    if (this.loop) return;
    this.pauseRequested = false;
    this.loop = this.work()
      .catch((err) => {
        log.error(`Migration stopped: ${describeError(err)}`);
        this.save({ state: 'failed' });
      })
      .finally(() => {
        this.loop = null;
      });
  }

  private async work(): Promise<void> {
    const concurrency = Math.max(1, Math.min(16, this.stored().options?.concurrency ?? 4));
    const notes: { documentId: number; notes: unknown[] }[] = [];
    let done = 0;
    for (;;) {
      if (this.pauseRequested) {
        this.save({ state: 'paused' });
        log.info('Migration paused');
        return;
      }
      // Oldest first; failed ones are retried up to three times.
      const batch = (this.ctx.db.prepare("SELECT ngx_id FROM migration_items WHERE status = 'pending' OR (status = 'failed' AND attempts < 3) ORDER BY attempts, ngx_id LIMIT ?").all(concurrency * 4) as { ngx_id: number }[]).map(
        (r) => r.ngx_id,
      );
      if (!batch.length) break;
      for (let i = 0; i < batch.length; i += concurrency) {
        await Promise.all(
          batch.slice(i, i + concurrency).map(async (id) => {
            try {
              const n = await this.importDocument(id);
              if (n) notes.push(n);
            } catch (err) {
              this.ctx.db.prepare("UPDATE migration_items SET status = 'failed', error = ?, attempts = attempts + 1, updated_at = ? WHERE ngx_id = ?").run(describeError(err), Date.now(), id);
              log.warn(`Migration of document ${id} failed: ${describeError(err)}`);
            }
          }),
        );
        done += Math.min(concurrency, batch.length - i);
        if (done % 200 < concurrency) log.info(`Migration: ${done} document(s) handled`);
      }
    }
    if (notes.length) this.writeNotes(notes);
    this.save({ state: this.stored().state === 'cutover' ? 'cutover' : 'imported', finishedAt: Date.now(), lastSyncAt: Date.now() });
    log.info('Migration: all documents handled');
  }

  /** Notes are not in the model yet: kept in data/migration/notes.json. */
  private writeNotes(add: { documentId: number; notes: unknown[] }[]): void {
    const file = path.join(this.ctx.dataDir, 'migration', 'notes.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { documentId: number; notes: unknown[] }[]) : [];
    const byDoc = new Map(prev.map((p) => [p.documentId, p]));
    for (const n of add) byDoc.set(n.documentId, n);
    fs.writeFileSync(file, JSON.stringify([...byDoc.values()], null, 2));
  }

  /** Name → id in a library (created when missing). */
  private named(table: 'lib_tags' | 'lib_correspondents' | 'lib_document_types' | 'lib_storage_paths', lib: number, item: NgxNamed): number {
    const db = this.ctx.db;
    const norm = normalizeName(item.name);
    const row = db.prepare(`SELECT id FROM ${table} WHERE library_id = ? AND name_norm = ?`).get(lib, norm) as { id: number } | undefined;
    if (row) return row.id;
    if (table === 'lib_tags') {
      return Number(db.prepare('INSERT INTO lib_tags (library_id, name, name_norm, color, is_inbox, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(lib, item.name, norm, item.color ?? null, item.is_inbox_tag ? 1 : 0, Date.now()).lastInsertRowid);
    }
    if (table === 'lib_storage_paths') return Number(db.prepare('INSERT INTO lib_storage_paths (library_id, name, name_norm, template) VALUES (?, ?, ?, ?)').run(lib, item.name, norm, item.path ?? '').lastInsertRowid);
    return Number(db.prepare(`INSERT INTO ${table} (library_id, name, name_norm, created_at) VALUES (?, ?, ?, ?)`).run(lib, item.name, norm, Date.now()).lastInsertRowid);
  }

  private fieldId(lib: number, def: NgxCustomField): number {
    const db = this.ctx.db;
    const norm = normalizeName(def.name);
    const row = db.prepare('SELECT id FROM lib_custom_fields WHERE library_id = ? AND name_norm = ?').get(lib, norm) as { id: number } | undefined;
    if (row) return row.id;
    return Number(
      db.prepare('INSERT INTO lib_custom_fields (library_id, name, name_norm, data_type, extra, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(lib, def.name, norm, def.data_type, JSON.stringify(def.extra_data ?? {}), Date.now()).lastInsertRowid,
    );
  }

  /** Import (or update) one document. Returns its notes, if any. */
  async importDocument(id: number): Promise<{ documentId: number; notes: unknown[] } | null> {
    const snap = this.snapshot ?? (await this.load());
    const c = this.client;
    const local = this.archive();
    const db = this.ctx.db;
    const d = (await c.req<NgxDoc>(`/documents/${id}/`, { query: { full_perms: true } })) as NgxDoc;
    const item = db.prepare('SELECT * FROM migration_items WHERE ngx_id = ?').get(id) as { status: string; imported_modified: string | null; checksum: string | null } | undefined;
    const existing = local.row(id, true);
    // Never overwrite a document that this migration did not import (same id, added in the built-in archive).
    if (existing && !item?.imported_modified) throw new Error(`The built-in archive has its own document ${id} – it is not replaced`);
    if (existing && item?.status === 'imported' && item.imported_modified === d.modified) {
      db.prepare("UPDATE migration_items SET status = 'imported', updated_at = ? WHERE ngx_id = ?").run(Date.now(), id);
      return null;
    }
    const meta = await c.req<{ original_checksum?: string; has_archive_version?: boolean; archive_checksum?: string | null }>(`/documents/${id}/metadata/`);
    const opts = this.stored().options;
    const fileChanged = !existing || item?.checksum !== (meta.original_checksum ?? null);
    let original: { sha256: string; size: number; mime: string; filename: string } | null = null;
    let archived: { sha256: string; size: number } | null = null;
    if (fileChanged) {
      const file = await c.download(id, true);
      if (meta.original_checksum && createHash('md5').update(file.data).digest('hex') !== meta.original_checksum) {
        throw new Error('The downloaded file does not match the checksum Paperless-ngx reports');
      }
      const blob = await local.blobs.putBytes(file.data);
      const mime = sniffType(file.data) ?? d.mime_type ?? file.contentType;
      db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)').run(blob.sha256, blob.size, mime, Date.now());
      original = { sha256: blob.sha256, size: blob.size, mime, filename: d.original_file_name ?? file.filename ?? `document-${id}` };
      if (opts?.archived && meta.has_archive_version) {
        const a = await c.download(id, false);
        const ab = await local.blobs.putBytes(a.data);
        db.prepare('INSERT OR IGNORE INTO blobs (sha256, size, mime_type, created_at) VALUES (?, ?, ?, ?)').run(ab.sha256, ab.size, 'application/pdf', Date.now());
        archived = { sha256: ab.sha256, size: ab.size };
      }
    }
    const lib = existing ? existing.library_id : this.libraryFor(d);
    const users = this.stored().users;
    // A better OCR text Paperless-AI kept for itself (not written back) wins over the Paperless text.
    const ocr = this.ctx.repos.ocr.result(id);
    const ocrText = ocr && ocr.status === 'done' && !ocr.written_back && !ocr.kept_original && !ocr.reverted_at ? ocr.text : null;
    const text = ocrText ?? d.content ?? '';
    const created = datePart(d.created_date ?? d.created) ?? null;
    const now = Date.now();

    db.transaction(() => {
      const tagIds = d.tags.map((t) => snap.tags.get(t)).filter((t): t is NgxNamed => Boolean(t)).map((t) => this.named('lib_tags', lib, t));
      const corr = d.correspondent != null && snap.correspondents.get(d.correspondent) ? this.named('lib_correspondents', lib, snap.correspondents.get(d.correspondent)!) : null;
      const type = d.document_type != null && snap.types.get(d.document_type) ? this.named('lib_document_types', lib, snap.types.get(d.document_type)!) : null;
      const sp = d.storage_path != null && snap.storagePaths.get(d.storage_path) ? this.named('lib_storage_paths', lib, snap.storagePaths.get(d.storage_path)!) : null;
      const owner = d.owner != null ? (users[d.owner] ?? null) : null;
      let version = existing?.current_version ?? 1;
      if (!existing) {
        db.prepare(
          `INSERT INTO lib_documents (id, library_id, title, created, added, modified, correspondent_id, document_type_id, storage_path_id, archive_serial_number, owner_id,
             current_version, original_filename, mime_type, page_count, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'import')`,
        ).run(id, lib, d.title, created, d.added ?? new Date(now).toISOString(), d.modified ?? new Date(now).toISOString(), corr, type, sp, d.archive_serial_number ?? null, owner, original!.filename, original!.mime, d.page_count ?? null);
      } else {
        if (original) version = ((db.prepare('SELECT MAX(version) AS v FROM lib_document_files WHERE document_id = ?').get(id) as { v: number }).v ?? 0) + 1;
        db.prepare(
          `UPDATE lib_documents SET title = ?, created = ?, modified = ?, correspondent_id = ?, document_type_id = ?, storage_path_id = ?, archive_serial_number = ?, owner_id = ?,
             current_version = ?, page_count = COALESCE(?, page_count), deleted_at = NULL WHERE id = ?`,
        ).run(d.title, created, d.modified ?? existing.modified, corr, type, sp, d.archive_serial_number ?? null, owner, version, d.page_count ?? null, id);
      }
      if (original) {
        db.prepare(
          "INSERT INTO lib_document_files (document_id, version, kind, blob_sha256, original_filename, mime_type, size, page_count, comment, created_at) VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?, ?)",
        ).run(id, version, original.sha256, original.filename, original.mime, original.size, d.page_count ?? null, existing ? 'Changed in Paperless-ngx' : '', now);
        if (archived) {
          db.prepare("INSERT INTO lib_document_files (document_id, version, kind, blob_sha256, original_filename, mime_type, size, created_at) VALUES (?, ?, 'archive', ?, ?, 'application/pdf', ?, ?)").run(
            id,
            version,
            archived.sha256,
            `${path.parse(original.filename).name}.pdf`,
            archived.size,
            now,
          );
        }
      }
      local.setText(id, version, text, ocrText ? 'ocr' : 'import');
      local.setTags(id, lib, created, tagIds);
      // Custom fields: values that do not fit their type are kept as text.
      db.prepare('DELETE FROM lib_custom_field_values WHERE document_id = ?').run(id);
      const insField = db.prepare('INSERT INTO lib_custom_field_values (document_id, field_id, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?)');
      for (const f of d.custom_fields ?? []) {
        const def = snap.customFields.get(f.field);
        if (!def) continue;
        const fid = this.fieldId(lib, def);
        let cols: ReturnType<typeof toColumns>;
        try {
          cols = toColumns({ name: def.name, data_type: def.data_type, options: selectOptions(def) }, f.value);
        } catch {
          cols = { value_text: String(f.value), value_num: null, value_date: null, value_json: null };
        }
        insField.run(id, fid, cols?.value_text ?? null, cols?.value_num ?? null, cols?.value_date ?? null, cols?.value_json ?? null);
      }
      local.refreshFts(id);
      local.logEvent({ id, library_id: lib }, existing ? (original ? 'version_added' : 'updated') : 'created', { actor: 'import', ref: `ngx:${id}` });
      db.prepare("UPDATE migration_items SET status = 'imported', imported_modified = ?, checksum = COALESCE(?, checksum), error = NULL, attempts = attempts + 1, updated_at = ? WHERE ngx_id = ?").run(
        d.modified ?? null,
        meta.original_checksum ?? null,
        now,
        id,
      );
    })();
    return Array.isArray(d.notes) && d.notes.length ? { documentId: id, notes: d.notes } : null;
  }

  // ------------------------------------------------------------ sync, cutover, rollback

  /** New → import, changed → update (new file version when the file changed), gone → trash. */
  async sync(): Promise<{ added: number; updated: number; deleted: number }> {
    if (this.loop) throw new Error('The migration is running – wait for it to finish');
    if (!this.stored().strategy) throw new Error('Start the migration first');
    const snap = await this.load();
    const db = this.ctx.db;
    const items = new Map((db.prepare('SELECT ngx_id, status, imported_modified FROM migration_items').all() as { ngx_id: number; status: string; imported_modified: string | null }[]).map((r) => [r.ngx_id, r]));
    const present = new Set(snap.docs.map((d) => d.id));
    let added = 0;
    let updated = 0;
    let deleted = 0;
    const now = Date.now();
    db.transaction(() => {
      for (const d of snap.docs) {
        const it = items.get(d.id);
        if (!it) {
          db.prepare("INSERT INTO migration_items (ngx_id, status, updated_at) VALUES (?, 'pending', ?)").run(d.id, now);
          added++;
        } else if (it.status === 'deleted' || (it.status === 'imported' && it.imported_modified !== d.modified)) {
          db.prepare("UPDATE migration_items SET status = 'pending', attempts = 0, updated_at = ? WHERE ngx_id = ?").run(now, d.id);
          updated++;
        }
      }
      for (const [id, it] of items) {
        if (present.has(id) || it.status === 'deleted') continue;
        db.prepare('UPDATE lib_documents SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id);
        db.prepare("UPDATE migration_items SET status = 'deleted', updated_at = ? WHERE ngx_id = ?").run(now, id);
        this.archive().logEvent({ id, library_id: (this.archive().row(id, true)?.library_id ?? 0) }, 'deleted', { actor: 'import', ref: `ngx:${id}` });
        deleted++;
      }
    })();
    this.save({ lastSyncAt: now });
    if (added || updated) {
      this.save({ state: this.stored().state === 'cutover' ? 'cutover' : 'importing' });
      this.run();
      await this.loop;
    }
    log.info(`Migration sync: ${added} new, ${updated} changed, ${deleted} deleted in Paperless-ngx`);
    return { added, updated, deleted };
  }

  /** Pause, final sync, switch to the built-in archive, resume. */
  async cutover(hooks: { pause?: () => void; resume?: () => void }): Promise<MigrationStatus> {
    if (this.ctx.archiveMode() === 'builtin') throw new Error('The built-in archive is in use already');
    const st = this.status();
    if (!st.strategy || st.counts.imported === 0) throw new Error('Import the documents first');
    hooks.pause?.();
    try {
      await this.sync();
      const failed = this.status().counts.failed;
      if (failed) log.warn(`Cutover with ${failed} document(s) that could not be imported – they stay in Paperless-ngx`);
      await this.local?.close();
      this.local = null;
      this.ctx.config.update({ archive: { mode: 'builtin' } });
      this.save({ state: 'cutover', cutoverAt: Date.now() });
      log.info('Switched to the built-in archive');
    } finally {
      hooks.resume?.();
    }
    return this.status();
  }

  /** Before the cutover: remove everything the migration imported. */
  async discard(): Promise<void> {
    if (this.ctx.archiveMode() === 'builtin') throw new Error('The built-in archive is in use – switch back to Paperless-ngx first');
    if (this.loop) {
      this.pause();
      await this.loop;
    }
    const db = this.ctx.db;
    const s = this.stored();
    db.transaction(() => {
      const ids = (db.prepare('SELECT ngx_id FROM migration_items').all() as { ngx_id: number }[]).map((r) => r.ngx_id);
      const del = db.prepare('DELETE FROM lib_documents WHERE id = ?');
      const delEvents = db.prepare('DELETE FROM lib_document_events WHERE document_id = ?');
      const delFts = db.prepare('DELETE FROM lib_fts WHERE rowid = ?');
      for (const id of ids) {
        delFts.run(id);
        delEvents.run(id);
        del.run(id);
      }
      for (const lib of s.libraries) {
        if ((db.prepare('SELECT COUNT(*) AS c FROM lib_documents WHERE library_id = ?').get(lib) as { c: number }).c) continue;
        db.prepare('DELETE FROM library_members WHERE library_id = ?').run(lib);
        db.prepare('DELETE FROM libraries WHERE id = ?').run(lib);
      }
      db.exec("DELETE FROM migration_items; DELETE FROM blobs WHERE sha256 NOT IN (SELECT blob_sha256 FROM lib_document_files)");
    })();
    this.ctx.repos.libraries.invalidate();
    const archive = this.archive();
    await archive.blobs.gc((sha) => Boolean(db.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha)), 0);
    this.ctx.repos.kv.delete(STATE_KEY);
    this.snapshot = null;
    this.assignments.clear();
    log.info('Migration discarded');
  }

  /** After the cutover: back to Paperless-ngx (it must still exist). Changes since then are listed. */
  rollback(): { changes: number } {
    if (this.ctx.archiveMode() !== 'builtin') throw new Error('Paperless-ngx is in use already');
    const s = this.stored();
    if (s.state !== 'cutover') throw new Error('This installation was not switched by the migration – there is no Paperless-ngx to switch back to');
    const changes = s.cutoverAt ? (this.ctx.db.prepare("SELECT COUNT(*) AS c FROM lib_document_events WHERE at > ? AND actor_type != 'import'").get(s.cutoverAt) as { c: number }).c : 0;
    this.ctx.config.update({ archive: { mode: 'paperless' } });
    this.save({ state: 'imported', cutoverAt: null });
    log.warn(`Switched back to Paperless-ngx – ${changes} change(s) made in the built-in archive since the switch are not in Paperless-ngx`);
    return { changes };
  }

  async close(): Promise<void> {
    this.pause();
    await this.loop;
    await this.local?.close();
    this.local = null;
  }
}

/** Select options of Paperless-ngx (objects with id since 2.x, plain strings before). */
function selectOptions(def: NgxCustomField): { id: string; label: string }[] {
  const raw = (def.extra_data?.select_options ?? []) as (string | { id: string; label: string })[];
  return raw.map((o, i) => (typeof o === 'string' ? { id: String(i), label: o } : { id: String(o.id), label: o.label }));
}
