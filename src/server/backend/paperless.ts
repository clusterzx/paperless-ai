/**
 * Companion mode: Paperless-ngx is the archive. Thin adapter from the DocumentBackend interface to
 * the Paperless-ngx REST API (PaperlessClient). Access scopes are not applied here – Paperless-AI
 * sees what its API token sees (one shared view, see docs/standalone/access-control.md §7).
 */
import { documentUrl, PaperlessClient } from '../paperless/client.js';
import type { Paginated } from '../paperless/types.js';
import type { AccessScope } from '../access/scope.js';
import { describeError } from '../util/http.js';
import type { MetadataCache } from './metadata.js';
import {
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
  type FileData,
  type IngestChannel,
  type IngestFile,
  type IngestHints,
  type IngestResult,
  type MetadataKind,
  type MetadataSource,
  type MetadataUpdate,
} from './types.js';
import fs from 'node:fs/promises';

const CAPABILITIES: BackendCapabilities = Object.freeze({
  upload: 'forward',
  intakeChannels: [],
  fileVersions: false,
  libraries: false,
  fullChangeLog: false,
  trash: 'external',
  externalLink: true,
  manageMetadata: true,
}) as BackendCapabilities;

const ENDPOINT: Record<MetadataKind, string> = {
  tag: 'tags',
  correspondent: 'correspondents',
  documentType: 'document_types',
  customField: 'custom_fields',
};

/** Fields of list rows (no content – it is large). */
const LIST_FIELDS = ['id', 'title', 'created', 'modified', 'added', 'tags', 'correspondent', 'document_type', 'storage_path', 'owner', 'archive_serial_number', 'original_file_name', 'mime_type', 'page_count', 'custom_fields', 'notes'];
/** Above this many matches, filtered facets fall back to the unfiltered counts. */
const FACET_LIMIT = 20_000;

export interface PaperlessBackendOptions {
  url: string;
  token: string;
  publicUrl?: string;
  /** Metadata cache of the companion namespace (for names in upload hints). */
  metadata: () => MetadataCache;
}

export class PaperlessBackend implements DocumentBackend {
  readonly kind = 'paperless' as const;
  readonly label = 'Paperless-ngx';
  readonly capabilities = CAPABILITIES;
  readonly client: PaperlessClient;

  constructor(private readonly opts: PaperlessBackendOptions) {
    this.client = new PaperlessClient({ url: opts.url, token: opts.token });
  }

  async info(_scope: AccessScope): Promise<BackendInfo> {
    try {
      const c = await this.client.connect();
      return { kind: this.kind, label: this.label, connected: true, version: c.serverVersion, apiVersion: c.apiVersion, user: c.user };
    } catch (err) {
      return { kind: this.kind, label: this.label, connected: false, error: describeError(err) };
    }
  }

  // ---------------------------------------------------------------- documents

  listDocuments(_scope: AccessScope, q: DocumentListQuery = {}): Promise<ArchiveDocument[]> {
    return this.client.listDocuments({ ids: q.ids, tagsAny: q.tagsAny, tagsNone: q.tagsNone, ordering: q.ordering, fields: q.fields, pageSize: q.pageSize });
  }

  searchDocuments(_scope: AccessScope, q: DocumentSearchQuery): Promise<DocumentPage> {
    return this.client.searchDocuments(q);
  }

  async queryDocuments(_scope: AccessScope, q: DocumentQuery): Promise<DocumentQueryResult> {
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 250);
    const page = q.cursor && /^p\d+$/.test(q.cursor) ? Number(q.cursor.slice(1)) : (q.page ?? 1);
    const query: Record<string, string | number | boolean> = {
      ...(await this.filterQuery(q.filter)),
      page,
      page_size: limit,
      fields: LIST_FIELDS.join(','),
    };
    const sort = q.sort ?? (q.filter.query ? 'relevance' : '-created');
    if (sort !== 'relevance') query.ordering = sort;
    const res = await this.client.req<Paginated<ArchiveDocument & { __search_hit__?: { highlights?: string } }>>('/documents/', { query });
    const snippets: Record<number, string> = {};
    for (const d of res.results) {
      const h = d.__search_hit__?.highlights;
      if (h) snippets[d.id] = h.replace(/<\/?span[^>]*>/g, (m) => (m.startsWith('</') ? '</mark>' : '<mark>'));
      delete d.__search_hit__;
    }
    return { results: res.results, nextCursor: res.next ? `p${page + 1}` : null, count: res.count, snippets };
  }

  async facets(scope: AccessScope, filter: DocumentFilter): Promise<DocumentFacets> {
    const meta = this.opts.metadata();
    const snap = await meta.snapshot();
    const unfiltered = (total: number, approximate: boolean): DocumentFacets => ({
      tags: snap.tags.map((t) => ({ id: t.id, count: t.document_count ?? 0 })),
      correspondents: snap.correspondents.map((c) => ({ id: c.id, count: c.document_count ?? 0 })),
      documentTypes: snap.documentTypes.map((d) => ({ id: d.id, count: d.document_count ?? 0 })),
      total,
      ...(approximate ? { approximate: true } : {}),
    });
    const total = await this.countDocuments(scope, filter);
    if (isEmptyFilter(filter)) return unfiltered(total, false);
    if (total > FACET_LIMIT || total === 0) {
      return total === 0 ? { tags: [], correspondents: [], documentTypes: [], total: 0 } : unfiltered(total, true);
    }
    const ids = (
      await this.client.listAll<{ id: number }>('/documents/', { ...(await this.filterQuery(filter)), fields: 'id' }, 1000)
    ).map((d) => d.id);
    type Sel = { id: number; document_count: number }[];
    const sel = await this.client.req<{ selected_tags?: Sel; selected_correspondents?: Sel; selected_document_types?: Sel }>('/documents/selection_data/', {
      method: 'POST',
      body: { documents: ids },
    });
    const conv = (s: Sel | undefined) => (s ?? []).filter((x) => x.document_count > 0).map((x) => ({ id: x.id, count: x.document_count }));
    return { tags: conv(sel.selected_tags), correspondents: conv(sel.selected_correspondents), documentTypes: conv(sel.selected_document_types), total };
  }

  async countDocuments(_scope: AccessScope, filter: DocumentFilter = {}): Promise<number> {
    return this.client.count('/documents/', await this.filterQuery(filter));
  }

  getDocument(_scope: AccessScope, id: number): Promise<ArchiveDocument> {
    return this.client.getDocument(id);
  }

  /** Paperless-ngx ≥ 1.13 answers the next free ASN; older versions: the highest one plus one. */
  async nextAsn(): Promise<number> {
    try {
      const n = await this.client.req<number>('/documents/next_asn/');
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    } catch {
      /* fall back below */
    }
    const res = await this.client.req<Paginated<{ archive_serial_number: number | null }>>('/documents/', {
      query: { ordering: '-archive_serial_number', page_size: 1, fields: 'archive_serial_number', archive_serial_number__isnull: 0 },
    });
    return (res.results[0]?.archive_serial_number ?? 0) + 1;
  }

  updateDocument(_scope: AccessScope, id: number, patch: DocumentPatch, _origin: ChangeOrigin): Promise<ArchiveDocument> {
    const { library_id: _library, ...rest } = patch;
    return this.client.updateDocument(id, rest);
  }

  async deleteDocument(_scope: AccessScope, id: number, _origin: ChangeOrigin): Promise<void> {
    await this.client.req(`/documents/${id}/`, { method: 'DELETE', responseType: 'text' });
  }

  async download(_scope: AccessScope, id: number, opts: { original: boolean; version?: number; signal?: AbortSignal }): Promise<FileData> {
    const res = await this.client.download(id, opts.original, opts.signal);
    return { data: res.data, contentType: res.contentType, filename: res.filename ?? null };
  }

  thumbnail(_scope: AccessScope, id: number): Promise<FileData> {
    return this.client.thumbnail(id);
  }

  documentLink(id: number): string {
    return documentUrl(this.opts.publicUrl || this.opts.url, id);
  }

  /** Upload to Paperless-ngx (post_document); the document arrives later through the webhook or the scan. */
  async ingest(_scope: AccessScope, file: IngestFile, _channel: IngestChannel, hints: IngestHints): Promise<IngestResult> {
    const data = file.data ?? (file.path ? await fs.readFile(file.path) : null);
    if (!data) return { status: 'rejected', reason: 'No file content' };
    const meta = this.opts.metadata();
    const form = new FormData();
    form.append('document', new Blob([data], { type: file.mimeType || 'application/octet-stream' }), file.filename);
    if (hints.title) form.append('title', hints.title);
    if (hints.created) form.append('created', hints.created);
    if (hints.archiveSerialNumber != null) form.append('archive_serial_number', String(hints.archiveSerialNumber));
    if (hints.correspondent) {
      const r = await meta.resolveCorrespondent(hints.correspondent, true);
      if (r.id != null) form.append('correspondent', String(r.id));
    }
    if (hints.documentType) {
      const r = await meta.resolveDocumentType(hints.documentType, true);
      if (r.id != null) form.append('document_type', String(r.id));
    }
    if (hints.tags?.length) {
      const r = await meta.resolveTags(hints.tags, true);
      for (const id of r.ids) form.append('tags', String(id));
    }
    const res = await this.client.req<unknown>('/documents/post_document/', { method: 'POST', body: form, timeoutMs: 300_000 });
    const taskId = typeof res === 'string' ? res : typeof (res as { task_id?: unknown })?.task_id === 'string' ? (res as { task_id: string }).task_id : undefined;
    return { status: 'forwarded', taskId };
  }

  // ---------------------------------------------------------------- metadata

  async metadataScopes(): Promise<(number | null)[]> {
    return [null];
  }

  metadataSource(): MetadataSource {
    return this.client;
  }

  async updateMetadata(_scope: AccessScope, kind: MetadataKind, id: number, update: MetadataUpdate): Promise<void> {
    const body: Record<string, unknown> = {};
    if (update.name !== undefined) body.name = update.name;
    if (kind === 'tag' && update.color !== undefined && update.color !== null) body.color = update.color;
    if (kind === 'tag' && update.parent !== undefined) body.parent = update.parent;
    if (!Object.keys(body).length) return;
    await this.client.req(`/${ENDPOINT[kind]}/${id}/`, { method: 'PATCH', body });
    this.opts.metadata().invalidate();
  }

  async deleteMetadata(_scope: AccessScope, kind: MetadataKind, id: number): Promise<void> {
    await this.client.req(`/${ENDPOINT[kind]}/${id}/`, { method: 'DELETE', responseType: 'text' });
    this.opts.metadata().invalidate();
  }

  metadataLibrary(): number | null {
    return null;
  }

  // ---------------------------------------------------------------- helpers

  /** Paperless-ngx query parameters for a structured filter. */
  async filterQuery(f: DocumentFilter): Promise<Record<string, string | number | boolean>> {
    const q: Record<string, string | number | boolean> = {};
    const list = (v: number[]) => v.join(',');
    if (f.ids?.length) q.id__in = list(f.ids);
    if (f.tagsAny?.length) q.tags__id__in = list(f.tagsAny);
    if (f.tagsAll?.length) q.tags__id__all = list(f.tagsAll);
    if (f.tagsNone?.length) q.tags__id__none = list(f.tagsNone);
    if (f.correspondent === null) q.correspondent__isnull = true;
    else if (f.correspondent !== undefined) q.correspondent__id = f.correspondent;
    if (f.correspondents?.length) q.correspondent__id__in = list(f.correspondents);
    if (f.documentType === null) q.document_type__isnull = true;
    else if (f.documentType !== undefined) q.document_type__id = f.documentType;
    if (f.documentTypes?.length) q.document_type__id__in = list(f.documentTypes);
    if (f.storagePath === null) q.storage_path__isnull = true;
    else if (f.storagePath !== undefined) q.storage_path__id = f.storagePath;
    if (f.owner === null) q.owner__isnull = true;
    else if (f.owner !== undefined) q.owner__id = f.owner;
    const v = this.client.negotiatedVersion ?? 9;
    const createdKey = v >= 9 ? 'created' : 'created__date';
    if (f.createdFrom) q[`${createdKey}__gte`] = f.createdFrom;
    if (f.createdTo) q[`${createdKey}__lte`] = f.createdTo;
    if (f.createdYear) q.created__year = f.createdYear;
    if (f.createdMonth) q.created__month = f.createdMonth;
    if (f.addedFrom) q.added__date__gte = f.addedFrom;
    if (f.addedTo) q.added__date__lte = f.addedTo;
    if (f.query?.trim()) q.query = f.query.trim();
    if (f.customFields?.length) {
      const op = { exists: 'exists', eq: 'exact', gte: 'gte', lte: 'lte', contains: 'icontains' } as const;
      const parts = f.customFields.map((c) => [c.field, op[c.op], c.op === 'exists' ? true : c.value]);
      q.custom_field_query = JSON.stringify(parts.length === 1 ? parts[0] : ['AND', parts]);
    }
    return q;
  }
}

export function isEmptyFilter(f: DocumentFilter): boolean {
  return !Object.values(f).some((v) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0));
}
