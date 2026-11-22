/**
 * The built-in archive: documents in SQLite (paperless-ai.db, lib_* tables) and files in the blob
 * store. Implements the same DocumentBackend contract as the Paperless-ngx backend.
 * See docs/standalone/data-model.md.
 */
import path from 'node:path';
import fs from 'node:fs';
import type { ActivityItem } from '../../shared/api.js';
import type { AppContext } from '../context.js';
import type { AppConfig } from '../config/schema.js';
import { canEdit, canRead, readableLibraries, roleIn, userIdOf, type AccessScope } from '../access/scope.js';
import {
  ArchiveError,
  forbidden,
  notFound,
  type ArchiveDocument,
  type BackendCapabilities,
  type BackendInfo,
  type ChangeOrigin,
  type DocumentBackend,
  type DocumentFacets,
  type DocumentFilter,
  type DocumentListQuery,
  type DocumentPage,
  type DocumentPatch,
  type DocumentQuery,
  type DocumentQueryResult,
  type DocumentSearchQuery,
  type DocumentSort,
  type FileData,
  type IngestChannel,
  type IngestFile,
  type IngestHints,
  type IngestResult,
  type MetadataKind,
  type MetadataSource,
  type MetadataUpdate,
} from '../backend/types.js';
import { cleanName, normalizeName } from '../backend/metadata.js';
import { buildFtsQuery, queryTerms, stem } from '../rag/text.js';
import { BlobStore } from './blobs.js';
import { displayValue, fromColumns, parseOptions, toColumns, type FieldColumns } from './fields.js';
import { LibraryMetadataSource, METADATA_TABLE } from './metadataSource.js';
import { PLACEHOLDER_THUMB, renderThumbnail } from './files.js';
import { IngestService } from './ingest.js';
import { ArchiveMaintenance } from './maintenance.js';
import { FolderWatcher } from './folder.js';
import { MailWatcher } from './mail.js';
import { ReadPool } from '../db/readers.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'archive' });

const CAPABILITIES: BackendCapabilities = Object.freeze({
  upload: 'native',
  intakeChannels: ['folder', 'mail', 'webdav'],
  fileVersions: true,
  libraries: true,
  fullChangeLog: true,
  trash: 'native',
  externalLink: false,
  manageMetadata: true,
}) as BackendCapabilities;

export interface DocRow {
  id: number;
  library_id: number;
  title: string;
  created: string | null;
  added: string;
  modified: string;
  correspondent_id: number | null;
  document_type_id: number | null;
  storage_path_id: number | null;
  archive_serial_number: number | null;
  owner_id: number | null;
  current_version: number;
  original_filename: string | null;
  mime_type: string;
  page_count: number | null;
  source: string;
  deleted_at: number | null;
  deleted_by: number | null;
}

interface FieldValueRow extends FieldColumns {
  document_id: number;
  field_id: number;
  data_type: string;
}

/** `modified` must change with every write (callers compare it for equality). */
export function nextModified(prev?: string | null): string {
  let t = Date.now();
  const p = prev ? Date.parse(prev) : NaN;
  if (Number.isFinite(p) && t <= p) t = p + 1;
  return new Date(t).toISOString();
}

const ACTOR: Record<ChangeOrigin['actor'], string> = { user: 'user', ai: 'ai', workflow: 'workflow', system: 'system', import: 'import' };

const json = (v: unknown) => JSON.stringify(v);

/** Documents whose id is in a JSON array parameter. */
const IN_IDS = 'IN (SELECT value FROM json_each(?))';

export class LocalBackend implements DocumentBackend {
  readonly kind = 'builtin' as const;
  readonly label = 'Archive';
  readonly capabilities = CAPABILITIES;
  readonly blobs: BlobStore;
  readonly ingestService: IngestService;
  readonly maintenance: ArchiveMaintenance;
  readonly folders: FolderWatcher;
  readonly mail: MailWatcher;
  /** Heavy reads (lists, full text, counts, facets) in worker threads. */
  readonly reader: ReadPool;
  /** Above this many full text matches only the newest are ranked by bm25 (see queryDocuments). */
  rankCandidates = 5000;
  private readonly sources = new Map<number, LibraryMetadataSource>();

  /**
   * `passive`: the archive is written by the migration assistant while Paperless-ngx is still the
   * archive in use – no default library, no intake, no maintenance timers.
   */
  constructor(
    readonly ctx: AppContext,
    opts: { passive?: boolean } = {},
  ) {
    const dir = ctx.cfg.archive.builtin.storageDir || path.join(ctx.dataDir, 'library');
    this.blobs = new BlobStore(dir);
    this.reader = ReadPool.for(ctx.db);
    this.ingestService = new IngestService(this);
    this.maintenance = new ArchiveMaintenance(this, !opts.passive);
    this.folders = new FolderWatcher(this);
    this.mail = new MailWatcher(this);
    if (opts.passive) return;
    this.ingestService.recoverInterrupted();
    this.ensureDefaultLibrary();
    if (ctx.cfg.archive.builtin.consumeDir || ctx.db.prepare('SELECT 1 FROM intake_folders WHERE enabled = 1 LIMIT 1').get()) this.startIntake();
    if (ctx.db.prepare('SELECT 1 FROM intake_mail_accounts WHERE enabled = 1 LIMIT 1').get()) this.mail.start();
    // A watch folder set later in the settings starts right away.
    ctx.config.on('change', this.onConfig);
    if (ctx.repos.kv.get('archive.fts_rebuild')) void this.rebuildFts();
  }

  /**
   * Fill the full text index from scratch (after a schema change of lib_fts, or as a repair):
   * batches of 500 documents, the event loop free between them. Documents changed meanwhile are
   * indexed by their own write anyway.
   */
  async rebuildFts(): Promise<number> {
    const started = Date.now();
    let done = 0;
    let after = 0;
    log.info('Rebuilding the full text index of the archive …');
    while (!this.closed) {
      const ids = (this.db.prepare('SELECT id FROM lib_documents WHERE id > ? ORDER BY id LIMIT 500').all(after) as { id: number }[]).map((r) => r.id);
      if (!ids.length) break;
      this.db.transaction(() => {
        for (const id of ids) this.refreshFts(id);
      })();
      done += ids.length;
      after = ids[ids.length - 1];
      await new Promise((r) => setImmediate(r));
    }
    if (!this.closed) {
      this.ctx.repos.kv.delete('archive.fts_rebuild');
      log.info(`Full text index rebuilt: ${done} documents in ${((Date.now() - started) / 1000).toFixed(1)} s`);
    }
    return done;
  }

  private readonly onConfig = (next: AppConfig) => {
    if (!this.closed && next.archive.builtin.consumeDir) this.startIntake();
  };
  private closed = false;

  /** Start the background intake channels (watch folders). */
  startIntake(): void {
    if (process.env.PAPERLESS_AI_NO_WATCHERS === '1') return;
    this.folders.start();
  }

  get db() {
    return this.ctx.db;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ctx.config.off('change', this.onConfig);
    this.folders.stop();
    this.mail.stop();
    await this.ingestService.stop();
    this.maintenance.stop();
    await this.reader.close();
  }

  // ---------------------------------------------------------------- libraries

  /** The oldest library; created (owned by the first admin) when there is none. */
  ensureDefaultLibrary(): number {
    const libs = this.ctx.repos.libraries.list();
    if (libs.length) return Math.min(...libs.map((l) => l.id));
    const admin = this.ctx.repos.users.list().find((u) => u.role === 'admin' && !u.disabled_at);
    const id = this.ctx.repos.libraries.create('Archive', admin?.id ?? null, { trashDays: this.ctx.cfg.archive.builtin.trashDays });
    log.info(`Created the library "Archive"${admin ? ` (owner: ${admin.username})` : ''}`);
    return id;
  }

  /** Library ids the scope may read (null = all). */
  private readable(scope: AccessScope): number[] | null {
    return readableLibraries(scope);
  }

  /** Ids of the libraries the scope can add documents to (oldest first); null = all. */
  writableLibraries(scope: AccessScope): number[] | null {
    if (!scope.libraries) return null;
    return [...scope.libraries.entries()]
      .filter(([, role]) => role !== 'viewer')
      .map(([id]) => id)
      .sort((a, b) => a - b);
  }

  /**
   * The library a new document goes to: the requested one (the caller must be allowed to add to it,
   * and it must not be deleted), else the caller's default library, else the oldest one they can add
   * to. An API key limited to libraries only offers those. Unrestricted callers (system tasks such as
   * the main watch folder) get the oldest library.
   */
  targetLibrary(scope: AccessScope, requested?: number): number {
    if (requested !== undefined) {
      const lib = this.ctx.repos.libraries.get(requested);
      if (!lib || lib.deleted_at) throw notFound('Library');
      if (!canEdit(scope, requested)) throw forbidden(canRead(scope, requested) ? `You cannot add documents to the library “${lib.name}”` : 'You cannot add documents to this library');
      return requested;
    }
    const writable = this.writableLibraries(scope);
    if (!writable) return this.ensureDefaultLibrary();
    if (!writable.length) throw forbidden('You are not an editor of any library');
    const userId = userIdOf(scope);
    const preferred = userId != null ? (this.ctx.repos.users.byId(userId)?.default_library_id ?? null) : null;
    return preferred != null && writable.includes(preferred) ? preferred : writable[0];
  }


  // ---------------------------------------------------------------- reading documents

  row(id: number, includeDeleted = false): DocRow | undefined {
    return this.db.prepare(`SELECT * FROM lib_documents WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`).get(id) as DocRow | undefined;
  }

  /** A readable document row of the scope – 404 otherwise (its existence is not revealed). */
  readableRow(scope: AccessScope, id: number, includeDeleted = false): DocRow {
    const r = this.row(id, includeDeleted);
    if (!r || !canRead(scope, r.library_id)) throw notFound();
    return r;
  }

  editableRow(scope: AccessScope, id: number, includeDeleted = false): DocRow {
    const r = this.readableRow(scope, id, includeDeleted);
    if (!canEdit(scope, r.library_id)) throw forbidden('You can view this document, but not change it');
    return r;
  }

  private tagsOf(ids: number[]): Map<number, number[]> {
    const out = new Map<number, number[]>();
    if (!ids.length) return out;
    const rows = this.db.prepare(`SELECT document_id, tag_id FROM lib_document_tags WHERE document_id ${IN_IDS} ORDER BY tag_id`).all(json(ids)) as {
      document_id: number;
      tag_id: number;
    }[];
    for (const r of rows) out.set(r.document_id, [...(out.get(r.document_id) ?? []), r.tag_id]);
    return out;
  }

  private fieldsOf(ids: number[]): Map<number, { field: number; value: unknown }[]> {
    const out = new Map<number, { field: number; value: unknown }[]>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(
        `SELECT v.*, f.data_type FROM lib_custom_field_values v JOIN lib_custom_fields f ON f.id = v.field_id WHERE v.document_id ${IN_IDS} ORDER BY v.field_id`,
      )
      .all(json(ids)) as FieldValueRow[];
    for (const r of rows) out.set(r.document_id, [...(out.get(r.document_id) ?? []), { field: r.field_id, value: fromColumns(r.data_type, r) }]);
    return out;
  }

  contentOf(ids: number[]): Map<number, string> {
    const out = new Map<number, string>();
    if (!ids.length) return out;
    const rows = this.db
      .prepare(`SELECT t.document_id, t.text FROM lib_document_text t JOIN lib_documents d ON d.id = t.document_id AND t.version = d.current_version WHERE t.document_id ${IN_IDS}`)
      .all(json(ids)) as { document_id: number; text: string }[];
    for (const r of rows) out.set(r.document_id, r.text);
    return out;
  }

  /** API objects for rows (tags, custom fields and – when asked for – the text). */
  toDocuments(rows: DocRow[], scope: AccessScope | null, withContent: boolean): ArchiveDocument[] {
    const ids = rows.map((r) => r.id);
    const tags = this.tagsOf(ids);
    const fields = this.fieldsOf(ids);
    const content = withContent ? this.contentOf(ids) : null;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      ...(content ? { content: content.get(r.id) ?? '' } : {}),
      tags: tags.get(r.id) ?? [],
      correspondent: r.correspondent_id,
      document_type: r.document_type_id,
      storage_path: r.storage_path_id,
      created: r.created,
      created_date: r.created,
      modified: r.modified,
      added: r.added,
      archive_serial_number: r.archive_serial_number,
      original_file_name: r.original_filename,
      owner: r.owner_id,
      user_can_change: scope ? canEdit(scope, r.library_id) : true,
      custom_fields: fields.get(r.id) ?? [],
      mime_type: r.mime_type,
      notes: [],
      page_count: r.page_count,
      library_id: r.library_id,
      current_version: r.current_version,
      source: r.source,
    }));
  }

  async info(): Promise<BackendInfo> {
    return { kind: this.kind, label: this.label, connected: true, version: this.ctx.version, apiVersion: null, user: null };
  }

  // ---------------------------------------------------------------- filters → SQL

  /**
   * SQL condition of a filter. Tags: `exists` checks each document (best when the rows come in index
   * order and many match), `in` starts from the tag's documents (best for rare tags and counts).
   */
  private whereOf(scope: AccessScope, f: DocumentFilter, opts: { deleted?: boolean; tags?: 'exists' | 'in' } = {}): { sql: string; params: unknown[] } {
    const conds: string[] = [opts.deleted ? 'd.deleted_at IS NOT NULL' : 'd.deleted_at IS NULL'];
    const params: unknown[] = [];
    const libs = this.readable(scope);
    if (libs) {
      conds.push(`d.library_id ${IN_IDS}`);
      params.push(json(libs));
    }
    if (f.libraryIds?.length) {
      conds.push(`d.library_id ${IN_IDS}`);
      params.push(json(f.libraryIds));
    }
    if (f.ids?.length) {
      conds.push(`d.id ${IN_IDS}`);
      params.push(json(f.ids));
    }
    const viaIn = opts.tags === 'in';
    if (f.tagsAny?.length) {
      conds.push(
        viaIn
          ? `d.id IN (SELECT document_id FROM lib_document_tags WHERE tag_id ${IN_IDS})`
          : `EXISTS (SELECT 1 FROM lib_document_tags t WHERE t.document_id = d.id AND t.tag_id ${IN_IDS})`,
      );
      params.push(json(f.tagsAny));
    }
    for (const tag of f.tagsAll ?? []) {
      conds.push(viaIn ? 'd.id IN (SELECT document_id FROM lib_document_tags WHERE tag_id = ?)' : 'EXISTS (SELECT 1 FROM lib_document_tags t WHERE t.document_id = d.id AND t.tag_id = ?)');
      params.push(tag);
    }
    if (f.tagged !== undefined) conds.push(`${f.tagged ? '' : 'NOT '}EXISTS (SELECT 1 FROM lib_document_tags t WHERE t.document_id = d.id)`);
    if (f.tagsNone?.length) {
      conds.push(`NOT EXISTS (SELECT 1 FROM lib_document_tags t WHERE t.document_id = d.id AND t.tag_id ${IN_IDS})`);
      params.push(json(f.tagsNone));
    }
    const ref = (col: string, one: number | null | undefined, many: number[] | undefined) => {
      if (one === null) conds.push(`d.${col} IS NULL`);
      else if (one !== undefined) {
        conds.push(`d.${col} = ?`);
        params.push(one);
      }
      if (many?.length) {
        conds.push(`d.${col} ${IN_IDS}`);
        params.push(json(many));
      }
    };
    ref('correspondent_id', f.correspondent, f.correspondents);
    ref('document_type_id', f.documentType, f.documentTypes);
    ref('storage_path_id', f.storagePath, undefined);
    ref('owner_id', f.owner, undefined);
    const range = (col: string, from?: string, to?: string) => {
      if (from) {
        conds.push(`d.${col} >= ?`);
        params.push(from);
      }
      if (to) {
        conds.push(`d.${col} < ?`);
        params.push(dayAfter(to));
      }
    };
    range('created', f.createdFrom, f.createdTo);
    range('added', f.addedFrom, f.addedTo);
    if (f.createdYear) {
      const y = f.createdYear;
      const from = f.createdMonth ? `${y}-${String(f.createdMonth).padStart(2, '0')}-01` : `${y}-01-01`;
      const to = f.createdMonth ? (f.createdMonth === 12 ? `${y + 1}-01-01` : `${y}-${String(f.createdMonth + 1).padStart(2, '0')}-01`) : `${y + 1}-01-01`;
      conds.push('d.created >= ? AND d.created < ?');
      params.push(from, to);
    }
    for (const c of f.customFields ?? []) {
      const field = this.db.prepare('SELECT data_type FROM lib_custom_fields WHERE id = ?').get(c.field) as { data_type: string } | undefined;
      if (!field) {
        conds.push('0');
        continue;
      }
      const col = ['integer', 'float', 'monetary', 'boolean'].includes(field.data_type) ? 'value_num' : field.data_type === 'date' ? 'value_date' : 'value_text';
      const base = 'EXISTS (SELECT 1 FROM lib_custom_field_values v WHERE v.document_id = d.id AND v.field_id = ?';
      if (c.op === 'exists') {
        conds.push(`${c.value === false ? 'NOT ' : ''}${base})`);
        params.push(c.field);
      } else if (c.op === 'contains') {
        conds.push(`${base} AND v.${col} LIKE ? ESCAPE '\\')`);
        params.push(c.field, `%${String(c.value ?? '').replace(/[%_\\]/g, (m) => `\\${m}`)}%`);
      } else {
        const op = c.op === 'eq' ? '=' : c.op === 'gte' ? '>=' : '<=';
        let v: unknown = c.value;
        if (col === 'value_num') v = typeof c.value === 'boolean' ? (c.value ? 1 : 0) : Number(String(c.value).replace(/^[A-Z]{3}/, ''));
        conds.push(`${base} AND v.${col} ${op} ?)`);
        params.push(c.field, v);
      }
    }
    const match = f.query ? ftsMatch(f.query) : null;
    if (f.query && !match) conds.push('0');
    if (match) {
      conds.push('d.id IN (SELECT rowid FROM lib_fts WHERE lib_fts MATCH ?)');
      params.push(match);
    }
    // Search syntax: words in one column (all of them), words that leave documents out (any of them).
    const fts = (q: string | undefined, col: 'title' | 'body' | null, mode: 'all' | 'any') => {
      const m = q ? ftsMatch(q) : null;
      if (!m) return q ? '' : null;
      const parts = m.split(' AND ').map((t) => (col ? `${col} : ${t}` : t));
      return parts.join(mode === 'all' ? ' AND ' : ' OR ');
    };
    for (const [q, col] of [
      [f.titleQuery, 'title'],
      [f.contentQuery, 'body'],
    ] as const) {
      const m = fts(q, col, 'all');
      if (m === '') conds.push('0');
      else if (m) {
        conds.push('d.id IN (SELECT rowid FROM lib_fts WHERE lib_fts MATCH ?)');
        params.push(m);
      }
    }
    for (const [q, col] of [
      [f.notQuery, null],
      [f.notTitle, 'title'],
    ] as const) {
      const m = fts(q, col, 'any');
      if (m) {
        conds.push('d.id NOT IN (SELECT rowid FROM lib_fts WHERE lib_fts MATCH ?)');
        params.push(m);
      }
    }
    for (const [col, none] of [
      ['correspondent_id', f.correspondentsNone],
      ['document_type_id', f.documentTypesNone],
    ] as const) {
      if (!none?.length) continue;
      conds.push(`(d.${col} IS NULL OR d.${col} NOT ${IN_IDS})`);
      params.push(json(none));
    }
    if (f.asn !== undefined) {
      conds.push('d.archive_serial_number = ?');
      params.push(f.asn);
    }
    return { sql: conds.join(' AND '), params };
  }

  async listDocuments(scope: AccessScope, q: DocumentListQuery = {}): Promise<ArchiveDocument[]> {
    const w = this.whereOf(scope, { ids: q.ids, tagsAny: q.tagsAny, tagsNone: q.tagsNone, libraryIds: q.libraryIds });
    const order = ORDERING[q.ordering ?? '-added'] ?? ORDERING['-added'];
    const rows = await this.reader.all<DocRow>(`SELECT d.* FROM lib_documents d WHERE ${w.sql} ORDER BY ${order}`, w.params);
    const withContent = Boolean(q.fields?.includes('content'));
    const out: ArchiveDocument[] = [];
    // Content is loaded in batches – the list of a large archive must not hold every text at once.
    for (let i = 0; i < rows.length; i += 500) out.push(...this.toDocuments(rows.slice(i, i + 500), scope, withContent));
    return out;
  }

  async searchDocuments(scope: AccessScope, q: DocumentSearchQuery): Promise<DocumentPage> {
    const res = await this.queryDocuments(scope, {
      filter: q.query?.trim() ? { query: q.query } : {},
      sort: q.query?.trim() ? 'relevance' : sortOf(q.ordering),
      page: q.page ?? 1,
      limit: q.pageSize ?? 25,
      withCount: true,
    });
    return { count: res.count ?? res.results.length, results: res.results };
  }

  async queryDocuments(scope: AccessScope, q: DocumentQuery): Promise<DocumentQueryResult> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 250);
    const sort: DocumentSort = q.sort ?? (q.filter.query ? 'relevance' : '-created');
    const relevance = sort === 'relevance' && Boolean(q.filter.query);
    const w = this.whereOf(scope, q.filter, { tags: !relevance && this.rareTags(scope, q.filter) ? 'in' : 'exists' });
    let rows: DocRow[];
    let nextCursor: string | null = null;
    if (relevance) {
      const match = ftsMatch(q.filter.query!);
      // The full text condition is the ranked join itself.
      const rest = this.whereOf(scope, { ...q.filter, query: undefined });
      // Cursor of relevance pages: `o:<offset>:<bound>` – the bound chosen on the first page.
      const [, cursorOffset, cursorBound] = q.cursor?.startsWith('o:') ? q.cursor.split(':') : [];
      const offset = cursorOffset !== undefined ? Number(cursorOffset) || 0 : ((q.page ?? 1) - 1) * limit;
      const ranked = (bound: number, from: number) =>
        this.reader.all<DocRow>(
          `SELECT d.* FROM lib_documents d
           JOIN (SELECT rowid, bm25(lib_fts, 3.0, 1.0, 2.0) AS rank FROM lib_fts WHERE lib_fts MATCH ? AND rowid >= ? ORDER BY rank LIMIT 1000) r ON r.rowid = d.id
           WHERE ${rest.sql} ORDER BY r.rank, d.id LIMIT ? OFFSET ?`,
          [match, bound, ...rest.params, limit + 1, from],
        );
      // Rank only the best candidates: bm25 over a stop-word-like term that matches most of the
      // archive costs ~0.7 µs per match. Above `rankCandidates` matches only the newest ones are
      // ranked – unless the other conditions leave less than a page of them, then all are. The
      // choice depends on the first page only, so all pages of a search use the same ranking.
      let bound = 0;
      if (cursorBound !== undefined) bound = Number(cursorBound) || 0;
      else if (match) bound = (await this.reader.get<{ rowid: number }>('SELECT rowid FROM lib_fts WHERE lib_fts MATCH ? ORDER BY rowid DESC LIMIT 1 OFFSET ?', [match, this.rankCandidates - 1]))?.rowid ?? 0;
      rows = match ? await ranked(bound, offset) : [];
      if (match && cursorBound === undefined && bound > 0 && rows.length <= limit) {
        const first = offset === 0 ? rows : await ranked(bound, 0);
        if (first.length <= limit) {
          bound = 0;
          rows = await ranked(0, offset);
        }
      }
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        nextCursor = `o:${offset + limit}:${bound}`;
      }
    } else {
      const key = SORT_KEYS[sort === 'relevance' ? '-created' : sort];
      const conds = [w.sql];
      const params = [...w.params];
      let offset = 0;
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        if (!c || c.s !== sort) throw new ArchiveError('Invalid cursor', 400, 'invalid_cursor');
        conds.push(key.after);
        params.push(c.v, c.v, c.id);
      } else if (q.page && q.page > 1) offset = (q.page - 1) * limit;
      rows = await this.reader.all<DocRow>(`SELECT d.* FROM lib_documents d WHERE ${conds.join(' AND ')} ORDER BY ${key.order} LIMIT ? OFFSET ?`, [...params, limit + 1, offset]);
      if (rows.length > limit) {
        rows = rows.slice(0, limit);
        const last = rows[rows.length - 1];
        nextCursor = encodeCursor({ s: sort, v: key.value(last), id: last.id });
      }
    }
    const counted = q.withCount ? this.whereOf(scope, q.filter, { tags: 'in' }) : null;
    const count = counted ? ((await this.reader.get<{ c: number }>(`SELECT COUNT(*) AS c FROM lib_documents d WHERE ${counted.sql}`, counted.params))?.c ?? 0) : null;
    const results = this.toDocuments(rows, scope, false);
    const snippets = q.filter.query ? this.snippets(rows.map((r) => r.id), q.filter.query) : undefined;
    return { results, nextCursor, count, snippets };
  }

  /** Short passages around the first match, with <mark> highlights (the FTS table keeps no text). */
  private snippets(ids: number[], query: string): Record<number, string> {
    const terms = queryTerms(query).map((t) => stem(t).toLowerCase());
    if (!terms.length) return {};
    const out: Record<number, string> = {};
    for (const [id, text] of this.contentOf(ids)) {
      const lower = text.toLowerCase();
      let pos = -1;
      for (const t of terms) {
        const p = lower.indexOf(t);
        if (p >= 0 && (pos < 0 || p < pos)) pos = p;
      }
      if (pos < 0) continue;
      const start = Math.max(0, pos - 60);
      let snippet = text.slice(start, start + 200).replace(/\s+/g, ' ').trim();
      const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      snippet = snippet.replace(/<|>/g, ' ').replace(new RegExp(`(${terms.map(esc).join('|')})[\\p{L}\\p{N}]*`, 'giu'), '<mark>$&</mark>');
      out[id] = `${start > 0 ? '…' : ''}${snippet}${start + 200 < text.length ? '…' : ''}`;
    }
    return out;
  }

  async facets(scope: AccessScope, filter: DocumentFilter): Promise<DocumentFacets> {
    if (isUnfiltered(filter)) return this.counterFacets(scope, filter.libraryIds);
    const w = this.whereOf(scope, filter, { tags: 'in' });
    // One pass over the matching documents (materialized once), all groups in one statement.
    const rows = await this.reader.all<{ k: 't' | 'c' | 'y' | 'l'; id: number; count: number }>(
      `WITH base AS MATERIALIZED (SELECT d.id, d.library_id, d.correspondent_id, d.document_type_id FROM lib_documents d WHERE ${w.sql})
       SELECT 't' AS k, t.tag_id AS id, COUNT(*) AS count FROM base b JOIN lib_document_tags t ON t.document_id = b.id GROUP BY t.tag_id
       UNION ALL SELECT 'c', correspondent_id, COUNT(*) FROM base WHERE correspondent_id IS NOT NULL GROUP BY correspondent_id
       UNION ALL SELECT 'y', document_type_id, COUNT(*) FROM base WHERE document_type_id IS NOT NULL GROUP BY document_type_id
       UNION ALL SELECT 'l', library_id, COUNT(*) FROM base GROUP BY library_id`,
      w.params,
    );
    const pick = (k: string) => rows.filter((r) => r.k === k).map((r) => ({ id: r.id, count: r.count }));
    const libraries = pick('l');
    return { tags: pick('t'), correspondents: pick('c'), documentTypes: pick('y'), libraries, total: libraries.reduce((n, r) => n + r.count, 0) };
  }

  async countDocuments(scope: AccessScope, filter: DocumentFilter = {}): Promise<number> {
    if (isUnfiltered(filter)) return (await this.counterFacets(scope, filter.libraryIds)).total;
    const w = this.whereOf(scope, filter, { tags: 'in' });
    return (await this.reader.get<{ c: number }>(`SELECT COUNT(*) AS c FROM lib_documents d WHERE ${w.sql}`, w.params))?.c ?? 0;
  }

  /**
   * Whether a list sorted by an index should start from the tag's documents: walking the index and
   * checking each document costs ~limit·total/matches probes, starting from the tag ~matches row
   * reads plus a sort – equal at about √(30·total) (measured with 200k documents).
   */
  private rareTags(scope: AccessScope, f: DocumentFilter): boolean {
    const tags = f.tagsAll?.length ? f.tagsAll : f.tagsAny;
    if (!tags?.length) return false;
    const counts = this.db.prepare(`SELECT item_id, SUM(count) AS c FROM lib_counters WHERE kind = 'tag' AND item_id ${IN_IDS} GROUP BY item_id`).all(json(tags)) as { item_id: number; c: number }[];
    const byTag = new Map(counts.map((r) => [r.item_id, r.c]));
    const matches = f.tagsAll?.length ? Math.min(...tags.map((t) => byTag.get(t) ?? 0)) : tags.reduce((n, t) => n + (byTag.get(t) ?? 0), 0);
    const libs = this.readable(scope);
    const total = (
      this.db.prepare(`SELECT COALESCE(SUM(count), 0) AS c FROM lib_counters WHERE kind = 'documents' AND item_id = 0${libs ? ` AND library_id ${IN_IDS}` : ''}`).get(...(libs ? [json(libs)] : [])) as {
        c: number;
      }
    ).c;
    return matches < Math.sqrt(30 * Math.max(total, 1));
  }

  /**
   * Facets without filter from the counters (maintained by triggers in the write transactions) –
   * no scan over the library, whatever its size.
   */
  async counterFacets(scope: AccessScope, libraryIds?: number[]): Promise<DocumentFacets> {
    let libs = this.readable(scope) ?? this.ctx.repos.libraries.list().map((l) => l.id);
    if (libraryIds?.length) libs = libs.filter((l) => libraryIds.includes(l));
    const rows = this.db
      .prepare(`SELECT kind, item_id AS id, library_id, count FROM lib_counters WHERE library_id ${IN_IDS} AND count > 0`)
      .all(json(libs)) as { kind: string; id: number; library_id: number; count: number }[];
    const pick = (kind: string) => rows.filter((r) => r.kind === kind).map((r) => ({ id: r.id, count: r.count }));
    const docs = rows.filter((r) => r.kind === 'documents');
    return {
      tags: pick('tag'),
      correspondents: pick('correspondent'),
      documentTypes: pick('document_type'),
      libraries: docs.map((r) => ({ id: r.library_id, count: r.count })),
      total: docs.reduce((n, r) => n + r.count, 0),
    };
  }

  async getDocument(scope: AccessScope, id: number): Promise<ArchiveDocument> {
    return this.toDocuments([this.readableRow(scope, id)], scope, true)[0];
  }

  // ---------------------------------------------------------------- writing documents

  /** Names of metadata ids (for the change log and the full text metadata line). */
  names(kind: MetadataKind, ids: (number | null | undefined)[]): string[] {
    const list = ids.filter((x): x is number => x != null);
    if (!list.length) return [];
    const rows = this.db.prepare(`SELECT id, name FROM ${METADATA_TABLE[kind]} WHERE id ${IN_IDS}`).all(json(list)) as { id: number; name: string }[];
    const byId = new Map(rows.map((r) => [r.id, r.name]));
    return list.map((x) => byId.get(x) ?? `#${x}`);
  }

  private fieldDefs(libraryId: number): Map<number, { id: number; name: string; data_type: string; options: ReturnType<typeof parseOptions> }> {
    const rows = this.db.prepare('SELECT id, name, data_type, extra FROM lib_custom_fields WHERE library_id = ?').all(libraryId) as {
      id: number;
      name: string;
      data_type: string;
      extra: string;
    }[];
    return new Map(rows.map((r) => [r.id, { id: r.id, name: r.name, data_type: r.data_type, options: parseOptions(r.extra) }]));
  }

  private assertInLibrary(kind: MetadataKind, ids: number[], libraryId: number): void {
    if (!ids.length) return;
    const ok = (this.db.prepare(`SELECT COUNT(*) AS c FROM ${METADATA_TABLE[kind]} WHERE library_id = ? AND id ${IN_IDS}`).get(libraryId, json([...new Set(ids)])) as { c: number }).c;
    if (ok !== new Set(ids).size) throw new ArchiveError(`Unknown ${kind} for this library`, 400, 'invalid_reference');
  }

  /** Rebuild the full text entry of a document (title, current text, metadata line). */
  refreshFts(id: number): void {
    const r = this.row(id, true);
    this.db.prepare('DELETE FROM lib_fts WHERE rowid = ?').run(id);
    if (!r) return;
    const text = this.contentOf([id]).get(id) ?? '';
    const tags = this.names('tag', this.tagsOf([id]).get(id) ?? []);
    const fields = (this.fieldsOf([id]).get(id) ?? []).map((f) => String(f.value ?? ''));
    const meta = [
      ...this.names('correspondent', [r.correspondent_id]),
      ...this.names('documentType', [r.document_type_id]),
      ...tags,
      r.original_filename ?? '',
      r.archive_serial_number != null ? `ASN ${r.archive_serial_number}` : '',
      ...fields,
    ]
      .filter(Boolean)
      .join(' · ');
    this.db.prepare('INSERT INTO lib_fts (rowid, title, body, meta) VALUES (?, ?, ?, ?)').run(id, r.title, text.slice(0, 2_000_000), meta);
  }

  /** Append a change log entry. */
  logEvent(doc: { id: number; library_id: number }, kind: string, origin: ChangeOrigin, changes: Record<string, [unknown, unknown]> = {}): number {
    return Number(
      this.db
        .prepare('INSERT INTO lib_document_events (document_id, library_id, at, kind, actor_type, actor_id, ref, changes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(doc.id, doc.library_id, Date.now(), kind, ACTOR[origin.actor] ?? 'system', origin.actorId ?? null, origin.ref ?? null, json(changes)).lastInsertRowid,
    );
  }

  /** Text of the current version (OCR, manual edits). */
  setText(id: number, version: number, text: string, source: 'text_layer' | 'ocr' | 'manual' | 'import', quality: number | null = null): void {
    this.db
      .prepare(
        `INSERT INTO lib_document_text (document_id, version, text, source, quality, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id, version) DO UPDATE SET text = excluded.text, source = excluded.source, quality = excluded.quality, updated_at = excluded.updated_at`,
      )
      .run(id, version, text, source, quality, Date.now());
  }

  setTags(id: number, libraryId: number, created: string | null, tags: number[]): void {
    this.db.prepare('DELETE FROM lib_document_tags WHERE document_id = ?').run(id);
    const ins = this.db.prepare('INSERT OR IGNORE INTO lib_document_tags (tag_id, document_id, library_id, created) VALUES (?, ?, ?, ?)');
    for (const t of new Set(tags)) ins.run(t, id, libraryId, created);
  }

  setFields(id: number, libraryId: number, fields: { field: number; value: unknown }[]): void {
    const defs = this.fieldDefs(libraryId);
    this.db.prepare('DELETE FROM lib_custom_field_values WHERE document_id = ?').run(id);
    const ins = this.db.prepare('INSERT INTO lib_custom_field_values (document_id, field_id, value_text, value_num, value_date, value_json) VALUES (?, ?, ?, ?, ?, ?)');
    for (const f of fields) {
      const def = defs.get(f.field);
      if (!def) throw new ArchiveError(`Unknown custom field ${f.field} for this library`, 400, 'invalid_reference');
      const c = toColumns({ name: def.name, data_type: def.data_type, options: def.options }, f.value);
      // A field without value is still attached to the document (like Paperless-ngx).
      ins.run(id, f.field, c?.value_text ?? null, c?.value_num ?? null, c?.value_date ?? null, c?.value_json ?? null);
    }
  }

  /** Map metadata of a document to another library by name (created there when missing). */
  private async remap(doc: ArchiveDocument, from: number, to: number): Promise<DocumentPatch> {
    const target = this.ctx.metadata(to);
    await target.snapshot(true);
    const tagNames = this.names('tag', doc.tags);
    const out: DocumentPatch = { tags: (await target.resolveTags(tagNames, true)).ids };
    const [corr] = this.names('correspondent', [doc.correspondent]);
    out.correspondent = corr ? (await target.resolveCorrespondent(corr, true)).id : null;
    const [type] = this.names('documentType', [doc.document_type]);
    out.document_type = type ? (await target.resolveDocumentType(type, true)).id : null;
    const defs = this.fieldDefs(from);
    const fields: { field: number; value: unknown }[] = [];
    for (const f of doc.custom_fields ?? []) {
      const def = defs.get(f.field);
      if (!def) continue;
      const res = await target.resolveCustomField(def.name, true, def.data_type as never);
      if (res.id != null) fields.push({ field: res.id, value: def.data_type === 'select' ? null : f.value });
    }
    out.custom_fields = fields;
    out.storage_path = null;
    return out;
  }

  async updateDocument(scope: AccessScope, id: number, patch: DocumentPatch, origin: ChangeOrigin): Promise<ArchiveDocument> {
    const row = this.editableRow(scope, id);
    let p: DocumentPatch = { ...patch };
    let lib = row.library_id;
    if (p.library_id !== undefined && p.library_id !== row.library_id) {
      const target = this.ctx.repos.libraries.get(p.library_id);
      // Never into a deleted library (a workflow may still name it): the documents would vanish.
      if (!target || target.deleted_at || !canEdit(scope, p.library_id)) throw forbidden('You cannot move documents into this library');
      const current = this.toDocuments([row], scope, false)[0];
      p = { ...p, ...(await this.remap({ ...current, ...pick(p) }, row.library_id, p.library_id)) };
      lib = p.library_id!;
    }
    // References must belong to the library of the document.
    if (p.tags) this.assertInLibrary('tag', p.tags, lib);
    if (p.correspondent != null) this.assertInLibrary('correspondent', [p.correspondent], lib);
    if (p.document_type != null) this.assertInLibrary('documentType', [p.document_type], lib);
    if (p.custom_fields) this.assertInLibrary('customField', p.custom_fields.map((f) => f.field), lib);
    if (p.created !== undefined && p.created !== null && !/^\d{4}-\d{2}-\d{2}$/.test(p.created)) throw new ArchiveError('The date must be YYYY-MM-DD', 400, 'invalid_date');

    const before = this.toDocuments([row], scope, p.content !== undefined)[0];
    const changes: Record<string, [unknown, unknown]> = {};
    const fieldDefs = this.fieldDefs(lib);
    // Custom fields by name; select fields with their label (both readable and reversible).
    const cfDisplay = (list: { field: number; value: unknown }[] | undefined, defs: typeof fieldDefs) =>
      Object.fromEntries(
        (list ?? []).map((f) => {
          const def = defs.get(f.field);
          return [def?.name ?? `#${f.field}`, def?.data_type === 'select' ? displayValue('select', f.value, def.options) : (f.value ?? null)];
        }),
      );

    const tx = this.db.transaction(() => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, value: unknown, label: string, beforeV: unknown, afterV: unknown = value) => {
        sets.push(`${col} = ?`);
        params.push(value);
        changes[label] = [beforeV, afterV];
      };
      if (p.title !== undefined && p.title !== row.title) set('title', p.title.slice(0, 512), 'title', row.title);
      if (p.created !== undefined && p.created !== row.created) set('created', p.created, 'created', row.created);
      if (p.correspondent !== undefined && p.correspondent !== row.correspondent_id)
        set('correspondent_id', p.correspondent, 'correspondent', this.names('correspondent', [row.correspondent_id])[0] ?? null, this.names('correspondent', [p.correspondent])[0] ?? null);
      if (p.document_type !== undefined && p.document_type !== row.document_type_id)
        set('document_type_id', p.document_type, 'document_type', this.names('documentType', [row.document_type_id])[0] ?? null, this.names('documentType', [p.document_type])[0] ?? null);
      if (p.storage_path !== undefined && p.storage_path !== row.storage_path_id) set('storage_path_id', p.storage_path, 'storage_path', row.storage_path_id);
      if (p.archive_serial_number !== undefined && p.archive_serial_number !== row.archive_serial_number) set('archive_serial_number', p.archive_serial_number, 'archive_serial_number', row.archive_serial_number);
      if (p.owner !== undefined && p.owner !== row.owner_id) set('owner_id', p.owner, 'owner', row.owner_id);
      if (lib !== row.library_id) set('library_id', lib, 'library_id', row.library_id, lib);
      const tagsChanged = p.tags !== undefined && !sameSet(p.tags, before.tags);
      if (tagsChanged) changes.tags = [this.names('tag', before.tags), this.names('tag', p.tags!)];
      const fieldsChanged = p.custom_fields !== undefined && json(normFields(p.custom_fields)) !== json(normFields(before.custom_fields ?? []));
      if (fieldsChanged) changes.custom_fields = [cfDisplay(before.custom_fields, this.fieldDefs(row.library_id)), cfDisplay(p.custom_fields, fieldDefs)];
      const textChanged = p.content !== undefined && p.content !== (before.content ?? '');
      if (textChanged) changes.content = [`${(before.content ?? '').length} characters`, `${p.content!.length} characters`];
      if (!Object.keys(changes).length) return false;

      sets.push('modified = ?');
      params.push(nextModified(row.modified));
      this.db.prepare(`UPDATE lib_documents SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
      const created = p.created !== undefined ? p.created : row.created;
      if (tagsChanged || lib !== row.library_id || p.created !== undefined) this.setTags(id, lib, created ?? null, p.tags ?? before.tags);
      if (fieldsChanged) this.setFields(id, lib, p.custom_fields!);
      if (textChanged) this.setText(id, row.current_version, p.content!, origin.ref?.startsWith('ocr') ? 'ocr' : origin.actor === 'import' ? 'import' : 'manual');
      this.logEvent({ id, library_id: lib }, lib !== row.library_id ? 'moved' : 'updated', origin, changes);
      this.refreshFts(id);
      return true;
    });
    try {
      tx();
    } catch (err) {
      if (err instanceof Error && /UNIQUE constraint failed: lib_documents.library_id, lib_documents.archive_serial_number/.test(err.message)) {
        throw new ArchiveError(`The archive serial number ${p.archive_serial_number} is used by another document`, 409, 'asn_taken');
      }
      throw err;
    }
    return this.getDocument(scope, id);
  }

  async deleteDocument(scope: AccessScope, id: number, origin: ChangeOrigin): Promise<void> {
    const row = this.editableRow(scope, id);
    this.db.transaction(() => {
      this.db.prepare('UPDATE lib_documents SET deleted_at = ?, deleted_by = ? WHERE id = ?').run(Date.now(), origin.actorId ?? null, id);
      this.logEvent(row, 'deleted', origin);
    })();
  }

  async nextAsn(libraryId: number | null): Promise<number> {
    const lib = libraryId ?? this.ensureDefaultLibrary();
    return ((this.db.prepare('SELECT MAX(archive_serial_number) AS m FROM lib_documents WHERE library_id = ?').get(lib) as { m: number | null }).m ?? 0) + 1;
  }

  async restoreDocument(scope: AccessScope, id: number, origin: ChangeOrigin): Promise<void> {
    const row = this.editableRow(scope, id, true);
    if (row.deleted_at === null) return;
    this.db.transaction(() => {
      this.db.prepare('UPDATE lib_documents SET deleted_at = NULL, deleted_by = NULL, modified = ? WHERE id = ?').run(nextModified(row.modified), id);
      this.logEvent(row, 'restored', origin);
    })();
  }

  /** Remove a document from the trash for good (rows of all tables; the files are collected by the GC). */
  purge(scope: AccessScope, id: number, origin: ChangeOrigin): void {
    const row = this.readableRow(scope, id, true);
    if (row.deleted_at === null) throw new ArchiveError('Only documents in the trash can be deleted for good', 409, 'not_in_trash');
    if (!this.ctx.repos.libraries.get(row.library_id) || roleIn(scope, row.library_id) !== 'owner') throw forbidden('Only library owners can empty the trash');
    this.purgeRow(row, origin);
  }

  purgeRow(row: DocRow, origin: ChangeOrigin): void {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM lib_fts WHERE rowid = ?').run(row.id);
      this.db.prepare('DELETE FROM lib_documents WHERE id = ?').run(row.id);
      for (const sql of [
        'DELETE FROM documents WHERE id = ?',
        'DELETE FROM ocr_documents WHERE id = ?',
        'DELETE FROM ocr_results WHERE document_id = ?',
        'DELETE FROM calendar_events WHERE document_id = ?',
        'DELETE FROM calendar_scans WHERE document_id = ?',
      ])
        this.db.prepare(sql).run(row.id);
      this.logEvent(row, 'purged', origin);
    })();
    void this.blobs.removeThumbs(row.id);
  }

  // ---------------------------------------------------------------- files

  fileRow(id: number, version: number, kind: 'original' | 'archive') {
    return this.db.prepare('SELECT * FROM lib_document_files WHERE document_id = ? AND version = ? AND kind = ?').get(id, version, kind) as
      | { blob_sha256: string; mime_type: string; original_filename: string | null; size: number; page_count: number | null }
      | undefined;
  }

  async download(scope: AccessScope, id: number, opts: { original: boolean; version?: number }): Promise<FileData> {
    const row = this.readableRow(scope, id);
    const version = opts.version ?? row.current_version;
    const file = (!opts.original ? this.fileRow(id, version, 'archive') : undefined) ?? this.fileRow(id, version, 'original');
    if (!file) throw notFound('File');
    const data = await this.blobs.read(file.blob_sha256);
    return { data, contentType: file.mime_type, filename: file.original_filename ?? row.original_filename ?? `document-${id}` };
  }

  async thumbnail(scope: AccessScope, id: number): Promise<FileData> {
    const row = this.readableRow(scope, id);
    const cached = this.blobs.thumbPath(id, row.current_version);
    if (fs.existsSync(cached)) return { data: fs.readFileSync(cached), contentType: 'image/webp' };
    const file = this.fileRow(id, row.current_version, 'original');
    if (file) {
      const thumb = await renderThumbnail(await this.blobs.read(file.blob_sha256), file.mime_type);
      if (thumb) {
        fs.writeFileSync(cached, thumb);
        return { data: thumb, contentType: 'image/webp' };
      }
    }
    return { data: PLACEHOLDER_THUMB, contentType: 'image/svg+xml' };
  }

  documentLink(id: number): string {
    const base = this.ctx.cfg.auth.publicUrl;
    return `${base || ''}/documents/${id}`;
  }

  ingest(scope: AccessScope, file: IngestFile, channel: IngestChannel, hints: IngestHints): Promise<IngestResult> {
    return this.ingestService.ingest(scope, file, channel, hints);
  }

  // ---------------------------------------------------------------- versions

  versions(scope: AccessScope, id: number) {
    this.readableRow(scope, id);
    return this.db
      .prepare(
        `SELECT f.version, f.kind, f.original_filename, f.mime_type, f.size, f.page_count, f.comment, f.created_at, f.created_by,
                (SELECT username FROM users WHERE id = f.created_by) AS created_by_name,
                (SELECT LENGTH(text) FROM lib_document_text t WHERE t.document_id = f.document_id AND t.version = f.version) AS text_length,
                (SELECT source FROM lib_document_text t WHERE t.document_id = f.document_id AND t.version = f.version) AS text_source
         FROM lib_document_files f WHERE f.document_id = ? ORDER BY f.version DESC, f.kind`,
      )
      .all(id) as {
      version: number;
      kind: 'original' | 'archive';
      original_filename: string | null;
      mime_type: string;
      size: number;
      page_count: number | null;
      comment: string;
      created_at: number;
      created_by: number | null;
      created_by_name: string | null;
      text_length: number | null;
      text_source: string | null;
    }[];
  }

  /** Make another version the current one (shown, searched and indexed). */
  activateVersion(scope: AccessScope, id: number, version: number, origin: ChangeOrigin): void {
    const row = this.editableRow(scope, id);
    const file = this.fileRow(id, version, 'original');
    if (!file) throw notFound('Version');
    if (row.current_version === version) return;
    this.db.transaction(() => {
      this.db
        .prepare('UPDATE lib_documents SET current_version = ?, mime_type = ?, page_count = ?, original_filename = ?, modified = ? WHERE id = ?')
        .run(version, file.mime_type, file.page_count, file.original_filename, nextModified(row.modified), id);
      this.logEvent(row, 'version_switched', origin, { version: [row.current_version, version] });
      this.refreshFts(id);
    })();
  }

  /** Delete a version that is not the current one. */
  removeVersion(row: { id: number; library_id: number; current_version: number }, version: number, origin: ChangeOrigin): void {
    if (version === row.current_version) throw new ArchiveError('The current version cannot be deleted – make another one current first', 409, 'current_version');
    const count = (this.db.prepare('SELECT COUNT(DISTINCT version) AS c FROM lib_document_files WHERE document_id = ?').get(row.id) as { c: number }).c;
    if (count <= 1) throw new ArchiveError('The only version of a document cannot be deleted', 409, 'only_version');
    this.db.transaction(() => {
      const res = this.db.prepare('DELETE FROM lib_document_files WHERE document_id = ? AND version = ?').run(row.id, version);
      if (!res.changes) throw notFound('Version');
      this.db.prepare('DELETE FROM lib_document_text WHERE document_id = ? AND version = ?').run(row.id, version);
      this.logEvent(row, 'version_deleted', origin, { version: [version, null] });
    })();
  }

  /** Text of a version (diffs between versions). */
  versionText(scope: AccessScope, id: number, version: number): string {
    this.readableRow(scope, id);
    return (this.db.prepare('SELECT text FROM lib_document_text WHERE document_id = ? AND version = ?').get(id, version) as { text: string } | undefined)?.text ?? '';
  }

  // ---------------------------------------------------------------- change log

  changeLog = async (documentId: number): Promise<ActivityItem[]> => {
    const rows = this.db.prepare('SELECT * FROM lib_document_events WHERE document_id = ? ORDER BY id DESC LIMIT 500').all(documentId) as {
      id: number;
      at: number;
      kind: string;
      actor_type: string;
      actor_id: number | null;
      ref: string | null;
      changes: string;
      reverted_by: number | null;
    }[];
    const users = new Map(this.ctx.repos.users.list().map((u) => [u.id, u.display_name ?? u.username]));
    const libName = (v: unknown) => (typeof v === 'number' ? (this.ctx.repos.libraries.get(v)?.name ?? `#${v}`) : v);
    const titles: Record<string, string> = {
      created: 'Added to the archive',
      updated: 'Changed',
      moved: 'Moved to another library',
      deleted: 'Moved to the trash',
      restored: 'Restored from the trash',
      version_added: 'New version',
      version_switched: 'Version switched',
      version_deleted: 'Version deleted',
      purged: 'Deleted for good',
    };
    // AI changes are shown from the AI history (model, prompt, undo) and OCR text from the OCR
    // results – their change log entries would be duplicates in the activity.
    return rows
      .filter((r) => !(r.kind === 'updated' && (r.actor_type === 'ai' || r.ref?.startsWith('ocr'))))
      .map((r) => {
        const changes = JSON.parse(r.changes || '{}') as Record<string, [unknown, unknown]>;
        const actor =
          r.actor_type === 'user'
            ? (users.get(r.actor_id ?? -1) ?? 'a user')
            : r.actor_type === 'ai'
              ? 'AI'
              : r.actor_type === 'workflow'
                ? `Workflow #${r.actor_id}`
                : r.actor_type === 'import'
                  ? 'Import'
                  : r.ref?.startsWith('ocr')
                    ? 'OCR'
                    : 'System';
        const kind: ActivityItem['kind'] = r.kind === 'created' ? 'created' : r.kind.startsWith('version') ? 'version' : r.kind === 'deleted' ? 'deleted' : r.kind === 'restored' ? 'restored' : r.kind === 'moved' ? 'moved' : r.actor_type === 'ai' ? 'ai' : 'change';
        const undoable = UNDOABLE_KINDS.has(r.kind) && !r.reverted_by && !r.ref?.startsWith('undo:');
        return {
          at: r.at,
          kind,
          title: titles[r.kind] ?? r.kind,
          actor,
          details: Object.entries(changes).map(([field, [before, after]]) =>
            field === 'library_id' ? { field: 'Library', before: libName(before), after: libName(after) } : { field: FIELD_LABELS[field] ?? field, before, after },
          ),
          // Metadata changes need a field that can be set back; version and trash events always can.
          undo: undoable && (!['updated', 'moved'].includes(r.kind) || Object.keys(changes).some((f) => UNDOABLE.has(f))) ? { kind: 'event' as const, id: r.id } : null,
          reverted: Boolean(r.reverted_by),
        };
      });
  };

  /**
   * Undo one change log entry: the previous values are written back as a new change. Fields that
   * were changed again later need `force` (no silent overwrite). The text is not part of an undo
   * (OCR text has its own undo on the OCR page).
   */
  async undoEvent(
    scope: AccessScope,
    id: number,
    eventId: number,
    origin: ChangeOrigin,
    force = false,
  ): Promise<{ fields: string[]; libraryId: number; effect: 'updated' | 'deleted' | 'restored' }> {
    const row = this.editableRow(scope, id, true);
    const ev = this.db.prepare('SELECT * FROM lib_document_events WHERE id = ? AND document_id = ?').get(eventId, id) as
      | { id: number; kind: string; changes: string; reverted_by: number | null }
      | undefined;
    if (!ev || !UNDOABLE_KINDS.has(ev.kind)) throw notFound('Change');
    if (ev.reverted_by) throw new ArchiveError('This change was undone already', 409, 'already_undone');
    const changes = JSON.parse(ev.changes || '{}') as Record<string, [unknown, unknown]>;
    const markReverted = () => {
      const undo = this.db.prepare('SELECT MAX(id) AS id FROM lib_document_events WHERE document_id = ?').get(id) as { id: number };
      this.db.prepare('UPDATE lib_document_events SET reverted_by = ? WHERE id = ?').run(undo.id, eventId);
    };
    // Trash: moving to the trash is undone by restoring, restoring by moving back.
    if (ev.kind === 'deleted' || ev.kind === 'restored') {
      const inTrash = row.deleted_at !== null;
      if ((ev.kind === 'deleted') !== inTrash) throw new ArchiveError(inTrash ? 'The document is in the trash again' : 'The document is no longer in the trash', 409, 'undo_conflict');
      if (ev.kind === 'deleted') await this.restoreDocument(scope, id, origin);
      else await this.deleteDocument(scope, id, origin);
      markReverted();
      return { fields: [], libraryId: row.library_id, effect: ev.kind === 'deleted' ? 'restored' : 'deleted' };
    }
    if (row.deleted_at !== null) throw new ArchiveError('Restore the document from the trash first', 409, 'in_trash');
    // Versions: a new version or a switch is undone by making the version before current again.
    // The added file stays in the version list (it can be deleted there).
    if (ev.kind === 'version_added' || ev.kind === 'version_switched') {
      const [previous, made] = (changes.version ?? []) as [number | null, number | null];
      if (previous == null || !this.fileRow(id, previous, 'original')) throw new ArchiveError('The previous version does not exist any more', 409, 'not_undoable');
      if (!force && row.current_version !== made) throw new ArchiveError(`Version ${row.current_version} was made current since then – undo anyway to switch to version ${previous}`, 409, 'undo_conflict');
      this.activateVersion(scope, id, previous, origin);
      markReverted();
      return { fields: ['version'], libraryId: row.library_id, effect: 'updated' };
    }
    const fields = Object.keys(changes).filter((f) => UNDOABLE.has(f));
    if (!fields.length) throw new ArchiveError('This change cannot be undone here', 409, 'not_undoable');
    if (!force) {
      const later = this.db.prepare("SELECT changes FROM lib_document_events WHERE document_id = ? AND id > ? AND kind IN ('updated', 'moved')").all(id, eventId) as { changes: string }[];
      const touched = new Set(later.flatMap((l) => Object.keys(JSON.parse(l.changes || '{}') as object)));
      const conflicts = fields.filter((f) => touched.has(f));
      if (conflicts.length) throw new ArchiveError(`Changed again since then: ${conflicts.map((f) => FIELD_LABELS[f] ?? f).join(', ')} – undo anyway to overwrite`, 409, 'undo_conflict');
    }
    // Back into the library first, then the values (names are resolved in that library).
    const targetLib = changes.library_id ? Number(changes.library_id[0]) : row.library_id;
    const meta = this.ctx.metadata(targetLib);
    await meta.snapshot(true);
    const patch: DocumentPatch = {};
    if (changes.library_id && targetLib !== row.library_id) patch.library_id = targetLib;
    const before = (f: string) => changes[f][0];
    if (changes.title) patch.title = String(before('title') ?? '');
    if (changes.created) patch.created = (before('created') as string | null) ?? undefined;
    if (changes.archive_serial_number) patch.archive_serial_number = (before('archive_serial_number') as number | null) ?? null;
    if (changes.correspondent) patch.correspondent = before('correspondent') ? (await meta.resolveCorrespondent(String(before('correspondent')), true)).id : null;
    if (changes.document_type) patch.document_type = before('document_type') ? (await meta.resolveDocumentType(String(before('document_type')), true)).id : null;
    if (changes.tags) patch.tags = (await meta.resolveTags((before('tags') as string[]) ?? [], true)).ids;
    if (changes.custom_fields) {
      const values = (before('custom_fields') as Record<string, unknown>) ?? {};
      const out: { field: number; value: unknown }[] = [];
      for (const [name, value] of Object.entries(values)) {
        const res = await meta.resolveCustomField(name, false);
        if (res.id != null) out.push({ field: res.id, value });
      }
      patch.custom_fields = out;
    }
    await this.updateDocument(scope, id, patch, origin);
    markReverted();
    return { fields: Object.keys(patch), libraryId: this.row(id)!.library_id, effect: 'updated' };
  }

  // ---------------------------------------------------------------- metadata

  async metadataScopes(scope: AccessScope): Promise<(number | null)[]> {
    const libs = this.ctx.repos.libraries.list().map((l) => l.id);
    if (!libs.length) return [this.ensureDefaultLibrary()];
    return libs.filter((l) => canRead(scope, l));
  }

  metadataSource(libraryId: number | null): MetadataSource {
    const lib = libraryId ?? this.ensureDefaultLibrary();
    let s = this.sources.get(lib);
    if (!s) {
      s = new LibraryMetadataSource(this.db, lib);
      this.sources.set(lib, s);
    }
    return s;
  }

  metadataLibrary(kind: MetadataKind, id: number): number | null {
    const r = this.db.prepare(`SELECT library_id FROM ${METADATA_TABLE[kind]} WHERE id = ?`).get(id) as { library_id: number } | undefined;
    if (!r) throw notFound('Not found');
    return r.library_id;
  }

  private metadataRow(scope: AccessScope, kind: MetadataKind, id: number) {
    const r = this.db.prepare(`SELECT * FROM ${METADATA_TABLE[kind]} WHERE id = ?`).get(id) as { id: number; library_id: number; name: string; extra?: string } | undefined;
    if (!r || !canRead(scope, r.library_id)) throw notFound('Not found');
    if (!canEdit(scope, r.library_id)) throw forbidden('You cannot change this');
    return r;
  }

  /** Documents that use a metadata object (their full text metadata line changes with its name). */
  private documentsUsing(kind: MetadataKind, id: number): number[] {
    const sql: Record<MetadataKind, string> = {
      tag: 'SELECT document_id AS id FROM lib_document_tags WHERE tag_id = ?',
      correspondent: 'SELECT id FROM lib_documents WHERE correspondent_id = ?',
      documentType: 'SELECT id FROM lib_documents WHERE document_type_id = ?',
      customField: 'SELECT document_id AS id FROM lib_custom_field_values WHERE field_id = ?',
    };
    return (this.db.prepare(sql[kind]).all(id) as { id: number }[]).map((r) => r.id);
  }

  async updateMetadata(scope: AccessScope, kind: MetadataKind, id: number, update: MetadataUpdate): Promise<void> {
    const r = this.metadataRow(scope, kind, id);
    const table = METADATA_TABLE[kind];
    this.db.transaction(() => {
      if (update.name !== undefined) {
        const name = cleanName(update.name);
        if (!name) throw new ArchiveError('The name is empty', 400, 'invalid_name');
        try {
          this.db.prepare(`UPDATE ${table} SET name = ?, name_norm = ? WHERE id = ?`).run(name, normalizeName(name), id);
        } catch (err) {
          if (err instanceof Error && /UNIQUE/.test(err.message)) throw new ArchiveError(`"${name}" exists already`, 409, 'exists');
          throw err;
        }
      }
      if (kind === 'tag' && update.color !== undefined) this.db.prepare('UPDATE lib_tags SET color = ? WHERE id = ?').run(update.color, id);
      if (kind === 'tag' && update.parent !== undefined) {
        if (update.parent === id) throw new ArchiveError('A tag cannot be its own parent', 400, 'invalid_parent');
        if (update.parent !== null) this.assertInLibrary('tag', [update.parent], r.library_id);
        this.db.prepare('UPDATE lib_tags SET parent_id = ? WHERE id = ?').run(update.parent, id);
      }
      if (kind === 'customField' && update.selectOptions) {
        const extra = JSON.parse(r.extra || '{}') as { select_options?: { id: string; label: string }[] };
        const old = extra.select_options ?? [];
        extra.select_options = update.selectOptions.map((label) => old.find((o) => o.label === label) ?? { id: Math.random().toString(36).slice(2, 10), label });
        this.db.prepare('UPDATE lib_custom_fields SET extra = ? WHERE id = ?').run(json(extra), id);
      }
      if (update.name !== undefined) for (const doc of this.documentsUsing(kind, id)) this.refreshFts(doc);
    })();
  }

  async deleteMetadata(scope: AccessScope, kind: MetadataKind, id: number): Promise<void> {
    this.metadataRow(scope, kind, id);
    const docs = this.documentsUsing(kind, id);
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM ${METADATA_TABLE[kind]} WHERE id = ?`).run(id);
      for (const doc of docs) this.refreshFts(doc);
    })();
  }
}

// ---------------------------------------------------------------- helpers

/** Fields the change log can undo (the text has its own undo). */
const UNDOABLE = new Set(['title', 'created', 'correspondent', 'document_type', 'tags', 'custom_fields', 'archive_serial_number', 'library_id']);

const FIELD_LABELS: Record<string, string> = {
  title: 'Title',
  created: 'Date',
  correspondent: 'Correspondent',
  document_type: 'Document type',
  tags: 'Tags',
  custom_fields: 'Custom fields',
  content: 'Text',
  archive_serial_number: 'ASN',
  owner: 'Owner',
  storage_path: 'Storage path',
  library_id: 'Library',
};

const ORDERING: Record<string, string> = {
  added: 'd.added, d.id',
  '-added': 'd.added DESC, d.id DESC',
  id: 'd.id',
  '-id': 'd.id DESC',
  created: 'd.created, d.id',
  '-created': 'd.created DESC, d.id DESC',
  modified: 'd.modified, d.id',
  '-modified': 'd.modified DESC, d.id DESC',
  title: 'd.title COLLATE NOCASE, d.id',
  '-title': 'd.title COLLATE NOCASE DESC, d.id DESC',
};

function sortOf(ordering: string | undefined): DocumentSort {
  return (ordering && ['created', '-created', 'added', '-added', 'title', '-title', 'modified', '-modified'].includes(ordering) ? ordering : '-added') as DocumentSort;
}

/** Order and keyset condition per sort (NULL dates sort as '' so the keyset stays total). */
/** Change log entries that can be undone from the activity (docs/standalone/data-model.md §4). */
const UNDOABLE_KINDS = new Set(['updated', 'moved', 'version_added', 'version_switched', 'deleted', 'restored']);

const SORT_KEYS: Record<Exclude<DocumentSort, 'relevance'>, { order: string; after: string; value: (r: DocRow) => string }> = {
  created: { order: "COALESCE(d.created, '') ASC, d.id ASC", after: "(COALESCE(d.created, '') > ? OR (COALESCE(d.created, '') = ? AND d.id > ?))", value: (r) => r.created ?? '' },
  '-created': { order: "COALESCE(d.created, '') DESC, d.id DESC", after: "(COALESCE(d.created, '') < ? OR (COALESCE(d.created, '') = ? AND d.id < ?))", value: (r) => r.created ?? '' },
  added: { order: 'd.added ASC, d.id ASC', after: '(d.added > ? OR (d.added = ? AND d.id > ?))', value: (r) => r.added },
  '-added': { order: 'd.added DESC, d.id DESC', after: '(d.added < ? OR (d.added = ? AND d.id < ?))', value: (r) => r.added },
  modified: { order: 'd.modified ASC, d.id ASC', after: '(d.modified > ? OR (d.modified = ? AND d.id > ?))', value: (r) => r.modified },
  '-modified': { order: 'd.modified DESC, d.id DESC', after: '(d.modified < ? OR (d.modified = ? AND d.id < ?))', value: (r) => r.modified },
  title: {
    order: 'd.title COLLATE NOCASE ASC, d.id ASC',
    after: '(d.title COLLATE NOCASE > ? OR (d.title COLLATE NOCASE = ? AND d.id > ?))',
    value: (r) => r.title,
  },
  '-title': {
    order: 'd.title COLLATE NOCASE DESC, d.id DESC',
    after: '(d.title COLLATE NOCASE < ? OR (d.title COLLATE NOCASE = ? AND d.id < ?))',
    value: (r) => r.title,
  },
};

function encodeCursor(c: { s: string; v: string; id: number }): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}

function decodeCursor(cursor: string): { s: string; v: string; id: number } | null {
  try {
    const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s: string; v: string; id: number };
    return typeof c.s === 'string' && typeof c.v === 'string' && Number.isInteger(c.id) ? c : null;
  } catch {
    return null;
  }
}

/** FTS MATCH expression: all terms must match (prefix search for longer words). */
export function ftsMatch(query: string): string | null {
  const terms = queryTerms(query);
  const q = buildFtsQuery(terms.length ? terms : query.toLowerCase().split(/\s+/).filter(Boolean));
  return q ? q.split(' OR ').join(' AND ') : null;
}

/** No condition except (perhaps) the libraries – the counters answer it. */
function isUnfiltered(f: DocumentFilter): boolean {
  return !Object.entries(f).some(([k, v]) => k !== 'libraryIds' && v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
}

function dayAfter(day: string): string {
  const d = new Date(`${day.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function sameSet(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function normFields(f: { field: number; value: unknown }[]): [number, unknown][] {
  return [...f].sort((a, b) => a.field - b.field).map((x) => [x.field, x.value ?? null]);
}

function pick(p: DocumentPatch): Partial<ArchiveDocument> {
  const out: Partial<ArchiveDocument> = {};
  if (p.tags) out.tags = p.tags;
  if (p.correspondent !== undefined) out.correspondent = p.correspondent;
  if (p.document_type !== undefined) out.document_type = p.document_type;
  if (p.custom_fields) out.custom_fields = p.custom_fields;
  return out;
}
