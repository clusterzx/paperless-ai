/**
 * The document backend: where documents and their metadata live. Two implementations:
 * Paperless-ngx (companion mode, backend/paperless.ts) and the built-in archive (archive/backend.ts).
 *
 * The internal document model keeps the shape of the Paperless-ngx API object: numeric ids, tag /
 * correspondent / document type ids, custom field instances and a `modified` timestamp that
 * changes with every write. Processing, OCR and the RAG index detect changes through `modified`.
 */
import type { AccessScope } from '../access/scope.js';
import type { ActivityItem } from '../../shared/api.js';
import type {
  PaperlessCorrespondent,
  PaperlessCustomField,
  PaperlessCustomFieldType,
  PaperlessDocument,
  PaperlessDocumentType,
  PaperlessStoragePath,
  PaperlessTag,
  PaperlessUser,
} from '../paperless/types.js';

export type BackendKind = 'paperless' | 'builtin';

export type ArchiveDocument = PaperlessDocument & {
  /** Built-in archive: the library the document belongs to. */
  library_id?: number | null;
  /** Built-in archive: the version shown, searched and indexed. */
  current_version?: number;
  /** Built-in archive: intake channel. */
  source?: string | null;
};

export type Tag = PaperlessTag & { library_id?: number | null };
export type Correspondent = PaperlessCorrespondent & { library_id?: number | null };
export type DocumentType = PaperlessDocumentType & { library_id?: number | null };
export type CustomField = PaperlessCustomField & { library_id?: number | null };
export type StoragePath = PaperlessStoragePath & { library_id?: number | null; path?: string };
export type ArchiveUser = PaperlessUser;
export type CustomFieldType = PaperlessCustomFieldType;

export type MetadataKind = 'tag' | 'correspondent' | 'documentType' | 'customField';

export interface BackendCapabilities {
  /** 'native' = own intake pipeline, 'forward' = handed to Paperless-ngx. */
  upload: 'native' | 'forward';
  /** Intake channels handled by Paperless-AI itself. */
  intakeChannels: ('folder' | 'mail' | 'webdav')[];
  fileVersions: boolean;
  libraries: boolean;
  /** Every change is logged – not only the ones made through Paperless-AI. */
  fullChangeLog: boolean;
  trash: 'native' | 'external';
  /** Documents can be opened in another application (the Paperless-ngx web UI). */
  externalLink: boolean;
  /** Tags, correspondents, types and custom fields can be renamed / merged / deleted here. */
  manageMetadata: boolean;
}

export type DocumentOrdering = 'added' | '-added' | 'id' | '-id' | 'created' | '-created' | 'modified' | '-modified' | 'title' | '-title';

export interface DocumentListQuery {
  ids?: number[];
  tagsAny?: number[];
  tagsNone?: number[];
  /** Built-in archive only (Paperless-ngx ignores it). */
  libraryIds?: number[];
  ordering?: DocumentOrdering;
  /** Fields to return (`content` is expensive – only ask for it when needed). */
  fields?: string[];
  pageSize?: number;
}

export interface DocumentSearchQuery {
  query?: string;
  page?: number;
  pageSize?: number;
  ordering?: DocumentOrdering;
  fields?: string[];
}

export interface DocumentPage {
  count: number;
  results: ArchiveDocument[];
}

/** Structured filter of the document list (UI, API, workflows). All set criteria must match. */
export interface DocumentFilter {
  ids?: number[];
  libraryIds?: number[];
  query?: string;
  tagsAny?: number[];
  tagsAll?: number[];
  tagsNone?: number[];
  /** null = documents without correspondent */
  correspondent?: number | null;
  correspondents?: number[];
  documentType?: number | null;
  documentTypes?: number[];
  storagePath?: number | null;
  owner?: number | null;
  createdFrom?: string;
  createdTo?: string;
  createdYear?: number;
  createdMonth?: number;
  addedFrom?: string;
  addedTo?: string;
  /** Custom field conditions. */
  customFields?: { field: number; op: 'exists' | 'eq' | 'gte' | 'lte' | 'contains'; value?: string | number | boolean }[];
}

export type DocumentSort = 'created' | '-created' | 'added' | '-added' | 'title' | '-title' | 'modified' | '-modified' | 'relevance';

export interface DocumentQuery {
  filter: DocumentFilter;
  sort?: DocumentSort;
  limit?: number;
  /** Opaque cursor of the previous page (keyset pagination). */
  cursor?: string | null;
  /** Page number (page-based clients, e.g. pickers). Ignored when a cursor is given. */
  page?: number;
  /** Return the total count (costs an extra query). */
  withCount?: boolean;
}

export interface DocumentQueryResult {
  results: ArchiveDocument[];
  nextCursor: string | null;
  count: number | null;
  /** Full text snippets by document id (built-in archive). */
  snippets?: Record<number, string>;
}

export interface FacetCount {
  id: number;
  count: number;
}

export interface DocumentFacets {
  tags: FacetCount[];
  correspondents: FacetCount[];
  documentTypes: FacetCount[];
  libraries?: FacetCount[];
  total: number;
  /** Counts are not limited to the filter (too many matches to count them in Paperless-ngx). */
  approximate?: boolean;
}

export interface DocumentPatch {
  title?: string;
  tags?: number[];
  correspondent?: number | null;
  document_type?: number | null;
  storage_path?: number | null;
  /** Document date YYYY-MM-DD. */
  created?: string;
  custom_fields?: { field: number; value: unknown }[];
  /** Searchable text of the document (replaced by the OCR result). */
  content?: string;
  archive_serial_number?: number | null;
  owner?: number | null;
  /** Built-in archive: move to another library. */
  library_id?: number;
}

export interface FileData {
  data: Uint8Array;
  contentType: string;
  filename?: string | null;
}

export interface BackendInfo {
  kind: BackendKind;
  label: string;
  connected: boolean;
  version?: string | null;
  apiVersion?: number | null;
  user?: { id: number; username: string; isSuperuser: boolean } | null;
  error?: string;
}

/** Who caused a change (written to the change log of the built-in archive). */
export interface ChangeOrigin {
  actor: 'user' | 'ai' | 'workflow' | 'system' | 'import';
  actorId?: number | null;
  /** e.g. 'history:12', 'run:4', 'ocr', 'undo:89', 'bulk:<uuid>' */
  ref?: string | null;
}

export interface IngestFile {
  /** Path of a file on disk (moved or copied by the backend) or the bytes. */
  path?: string;
  data?: Uint8Array;
  filename: string;
  mimeType?: string;
}

export type IngestChannel = 'upload' | 'api' | 'folder' | 'mail' | 'webdav' | 'import' | 'share';

export interface IngestHints {
  libraryId?: number;
  title?: string;
  created?: string;
  tags?: string[];
  correspondent?: string;
  documentType?: string;
  customFields?: Record<string, unknown>;
  archiveSerialNumber?: number;
  /** Add as a new version of this document. */
  replaces?: number;
  /** Store and index, but do not run the AI analysis. */
  skipAnalysis?: boolean;
  /** Library prompt (id or name) for the analysis. */
  prompt?: number | string;
  /** Idempotency key of the channel (message id + attachment index, Idempotency-Key header, path + mtime). */
  channelRef?: string;
  /** Extra context for the AI (mail sender, subject …). */
  context?: Record<string, string>;
}

export interface IngestResult {
  status: 'stored' | 'duplicate' | 'rejected' | 'forwarded';
  documentId?: number;
  intakeId?: number;
  /** Paperless-ngx consumption task (forwarded uploads). */
  taskId?: string;
  reason?: string;
}

/** Lists and creation of tags, correspondents, document types and custom fields (one namespace). */
export interface MetadataSource {
  tags(): Promise<Tag[]>;
  correspondents(): Promise<Correspondent[]>;
  documentTypes(): Promise<DocumentType[]>;
  customFields(): Promise<CustomField[]>;
  storagePaths(): Promise<StoragePath[]>;
  users(): Promise<ArchiveUser[]>;
  createTag(name: string, extra?: Partial<Tag>): Promise<Tag>;
  createCorrespondent(name: string, extra?: Partial<Correspondent>): Promise<Correspondent>;
  createDocumentType(name: string, extra?: Partial<DocumentType>): Promise<DocumentType>;
  createCustomField(name: string, dataType: CustomFieldType, currency?: string): Promise<CustomField>;
}

export interface MetadataUpdate {
  name?: string;
  color?: string | null;
  parent?: number | null;
  /** Custom fields: select options. */
  selectOptions?: string[];
}

export interface DocumentBackend {
  readonly kind: BackendKind;
  /** Name shown in the UI ("Paperless-ngx", "Archive"). */
  readonly label: string;
  readonly capabilities: BackendCapabilities;

  info(scope: AccessScope): Promise<BackendInfo>;

  // ---------------------------------------------------------------- documents
  listDocuments(scope: AccessScope, q?: DocumentListQuery): Promise<ArchiveDocument[]>;
  /** One page of documents with an optional full text query (pickers, playground). */
  searchDocuments(scope: AccessScope, q: DocumentSearchQuery): Promise<DocumentPage>;
  /** Document list with structured filters, sort and keyset pagination (Documents page, API). */
  queryDocuments(scope: AccessScope, q: DocumentQuery): Promise<DocumentQueryResult>;
  facets(scope: AccessScope, filter: DocumentFilter): Promise<DocumentFacets>;
  countDocuments(scope: AccessScope, filter?: DocumentFilter): Promise<number>;
  getDocument(scope: AccessScope, id: number): Promise<ArchiveDocument>;
  updateDocument(scope: AccessScope, id: number, patch: DocumentPatch, origin: ChangeOrigin): Promise<ArchiveDocument>;
  /** Move to the trash (built-in) / delete (Paperless-ngx moves it to its trash). */
  deleteDocument(scope: AccessScope, id: number, origin: ChangeOrigin): Promise<void>;
  download(scope: AccessScope, id: number, opts: { original: boolean; version?: number; signal?: AbortSignal }): Promise<FileData>;
  thumbnail(scope: AccessScope, id: number): Promise<FileData>;
  /** Link that opens the document in the browser. */
  documentLink(id: number): string;
  ingest(scope: AccessScope, file: IngestFile, channel: IngestChannel, hints: IngestHints): Promise<IngestResult>;

  // ---------------------------------------------------------------- metadata
  /** Metadata namespaces the scope can see: [null] for Paperless-ngx, the library ids for the built-in archive. */
  metadataScopes(scope: AccessScope): Promise<(number | null)[]>;
  /** Metadata lists and creation within one namespace (library). */
  metadataSource(libraryId: number | null): MetadataSource;
  updateMetadata(scope: AccessScope, kind: MetadataKind, id: number, update: MetadataUpdate): Promise<void>;
  deleteMetadata(scope: AccessScope, kind: MetadataKind, id: number): Promise<void>;
  /** Library a metadata object belongs to (built-in); null for Paperless-ngx. */
  metadataLibrary(kind: MetadataKind, id: number): number | null;

  /** Built-in archive: take a document back out of the trash. */
  restoreDocument?(scope: AccessScope, id: number, origin: ChangeOrigin): Promise<void>;
  /** Built-in archive: the change log of a document as activity items. */
  changeLog?: (documentId: number, libraryId: number | null) => Promise<ActivityItem[]>;

  /** Release resources (watchers, workers). */
  close?(): Promise<void>;
}

/** Errors with an HTTP status (PaperlessError, ArchiveError). */
export function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === 'number' ? s : undefined;
}

export class ArchiveError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string = 'archive_error',
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export function notFound(what = 'Document'): ArchiveError {
  return new ArchiveError(`${what} not found`, 404, 'not_found');
}

export function forbidden(message = 'Not allowed'): ArchiveError {
  return new ArchiveError(message, 403, 'forbidden');
}

export function notSupported(what: string): ArchiveError {
  return new ArchiveError(`${what} is not supported by this archive backend`, 409, 'not_supported_by_backend');
}
