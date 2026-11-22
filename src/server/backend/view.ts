/**
 * A DocumentBackend bound to one AccessScope. Everything outside the backend works with views:
 * `ctx.backend()` for internal work (system scope), `ctx.backend(req.access)` in routes.
 */
import type { AccessScope } from '../access/scope.js';
import type {
  ArchiveDocument,
  BackendInfo,
  ChangeOrigin,
  DocumentBackend,
  DocumentFacets,
  DocumentFilter,
  DocumentListQuery,
  DocumentPage,
  DocumentPatch,
  DocumentQuery,
  DocumentQueryResult,
  DocumentSearchQuery,
  FileData,
  IngestChannel,
  IngestFile,
  IngestHints,
  IngestResult,
  MetadataKind,
  MetadataUpdate,
} from './types.js';

export class BackendView {
  constructor(
    readonly backend: DocumentBackend,
    readonly scope: AccessScope,
  ) {}

  get kind() {
    return this.backend.kind;
  }

  get label() {
    return this.backend.label;
  }

  get capabilities() {
    return this.backend.capabilities;
  }

  info(): Promise<BackendInfo> {
    return this.backend.info(this.scope);
  }

  listDocuments(q?: DocumentListQuery): Promise<ArchiveDocument[]> {
    return this.backend.listDocuments(this.scope, q);
  }

  searchDocuments(q: DocumentSearchQuery): Promise<DocumentPage> {
    return this.backend.searchDocuments(this.scope, q);
  }

  queryDocuments(q: DocumentQuery): Promise<DocumentQueryResult> {
    return this.backend.queryDocuments(this.scope, q);
  }

  facets(filter: DocumentFilter): Promise<DocumentFacets> {
    return this.backend.facets(this.scope, filter);
  }

  countDocuments(filter?: DocumentFilter): Promise<number> {
    return this.backend.countDocuments(this.scope, filter);
  }

  getDocument(id: number): Promise<ArchiveDocument> {
    return this.backend.getDocument(this.scope, id);
  }

  updateDocument(id: number, patch: DocumentPatch, origin: ChangeOrigin): Promise<ArchiveDocument> {
    return this.backend.updateDocument(this.scope, id, patch, origin);
  }

  deleteDocument(id: number, origin: ChangeOrigin): Promise<void> {
    return this.backend.deleteDocument(this.scope, id, origin);
  }

  download(id: number, opts: { original: boolean; version?: number; signal?: AbortSignal }): Promise<FileData> {
    return this.backend.download(this.scope, id, opts);
  }

  thumbnail(id: number): Promise<FileData> {
    return this.backend.thumbnail(this.scope, id);
  }

  documentLink(id: number): string {
    return this.backend.documentLink(id);
  }

  ingest(file: IngestFile, channel: IngestChannel, hints: IngestHints): Promise<IngestResult> {
    return this.backend.ingest(this.scope, file, channel, hints);
  }

  metadataScopes(): Promise<(number | null)[]> {
    return this.backend.metadataScopes(this.scope);
  }

  updateMetadata(kind: MetadataKind, id: number, update: MetadataUpdate): Promise<void> {
    return this.backend.updateMetadata(this.scope, kind, id, update);
  }

  deleteMetadata(kind: MetadataKind, id: number): Promise<void> {
    return this.backend.deleteMetadata(this.scope, kind, id);
  }
}
