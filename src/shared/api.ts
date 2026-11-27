import type { OcrModelChoice } from './ocr.js';
import type { SearchKey } from './searchSyntax.js';
import type { MatchedPromptRule } from './promptRules.js';

/**
 * Types shared between the server and the web UI (API contract).
 * Only types live here so the browser bundle does not pull in server code.
 */

export interface CustomFieldValue {
  field: number;
  value: unknown;
}

/** State of a document before the AI changed it (used for undo). */
export interface DocumentSnapshot {
  title?: string;
  tags?: number[];
  correspondent?: number | null;
  document_type?: number | null;
  created?: string | null;
  custom_fields?: CustomFieldValue[];
}

export interface HistoryItem {
  id: number;
  documentId: number;
  createdAt: number;
  source: string;
  provider: string | null;
  model: string | null;
  title: string | null;
  correspondent: string | null;
  documentType: string | null;
  tags: number[];
  totalTokens: number;
  revertedAt: number | null;
  canRevert: boolean;
  before: DocumentSnapshot;
  after: Record<string, unknown>;
  suggestion: unknown;
  /** Library prompt of the prompt rule the document was processed with (null: system prompt). */
  prompt: { id: number | null; name: string } | null;
}

export interface HistoryQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  tag?: number;
  correspondent?: string;
  source?: string;
  documentId?: number;
  sort?: 'createdAt' | 'documentId' | 'title' | 'correspondent';
  order?: 'asc' | 'desc';
  includeReverted?: boolean;
}

export interface HistoryPage {
  items: (HistoryItem & { tagNames: string[]; url: string })[];
  total: number;
  filtered: number;
  page: number;
  pageSize: number;
}

export interface UsageStats {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  analyses: number;
  avgPromptTokens: number;
  avgCompletionTokens: number;
  avgTotalTokens: number;
  avgDurationMs: number;
  distribution: { range: string; count: number }[];
  byFeature: { feature: string; calls: number; tokens: number }[];
}

/** Result of an AI analysis of one document. */
export interface DocumentSuggestion {
  title: string | null;
  correspondent: string | null;
  tags: string[];
  document_type: string | null;
  document_date: string | null;
  language: string | null;
  custom_fields: { field_name: string; value: string }[];
  /** Appointments, due dates and deadlines (only when the calendar is switched on). */
  events?: SuggestedEvent[];
}

export const EVENT_KINDS = ['appointment', 'due', 'deadline', 'expiry', 'other'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export interface SuggestedEvent {
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:MM, null = all day */
  time: string | null;
  kind: EventKind;
}

export interface AnalysisResult {
  suggestion: DocumentSuggestion;
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
  model: string;
  provider: string;
  durationMs: number;
  truncated: boolean;
  /** The prompt rule the analysis used (manual review), null: the system prompt. */
  rule?: MatchedPromptRule | null;
}

export interface NamedItem {
  id: number;
  name: string;
  document_count?: number;
  color?: string;
}

export interface DocumentSummary {
  id: number;
  title: string;
  created: string | null;
  correspondent: number | null;
  document_type: number | null;
  tags: number[];
}

export interface DocumentDetail extends DocumentSummary {
  content: string;
  original_file_name?: string | null;
  custom_fields: CustomFieldValue[];
  user_can_change?: boolean;
  modified?: string;
  added?: string;
  /** Link that opens the document (the Paperless-ngx UI or the document page of the built-in archive). */
  url: string;
  mime_type?: string | null;
  /** There is an archived PDF of the file (shown instead of it: Office documents, e-mails; Paperless-ngx: its archive version). */
  has_archive?: boolean;
  page_count?: number | null;
  archive_serial_number?: number | null;
  storage_path?: number | null;
  owner?: number | null;
  /** Built-in archive. */
  library_id?: number | null;
  current_version?: number;
  /** Processing state in Paperless-AI. */
  status?: DocumentStatus | null;
  /** Role of the caller in the document's library (built-in archive); null = full access (companion mode). */
  role?: LibraryRole | null;
}

export type DocumentStatus = 'processed' | 'failed' | 'skipped';

/** A row of the document list. */
export interface DocumentRow extends DocumentSummary {
  added: string | null;
  modified: string | null;
  original_file_name: string | null;
  mime_type: string | null;
  page_count: number | null;
  archive_serial_number: number | null;
  storage_path: number | null;
  owner: number | null;
  library_id: number | null;
  custom_fields: CustomFieldValue[];
  status: DocumentStatus | null;
  /** Full text search: matching passage with <mark> highlights. */
  snippet?: string;
}

export interface DocumentListResponse {
  /** Total matches (null when not counted). */
  count: number | null;
  page?: number;
  results: DocumentRow[];
  /** Cursor of the next page (null on the last one). */
  nextCursor: string | null;
  /** How the search syntax (tag:, title: …) was understood – shown under the search box. */
  search?: SearchInterpretation[];
}

/** One key:value term of the search and what it matched (names, a date range) or why not. */
export interface SearchInterpretation {
  key: SearchKey;
  value: string;
  negate: boolean;
  matched: string[];
  problem?: string;
}

export interface DocumentFacetsResponse {
  tags: { id: number; count: number }[];
  correspondents: { id: number; count: number }[];
  documentTypes: { id: number; count: number }[];
  libraries?: { id: number; count: number }[];
  total: number;
  approximate?: boolean;
}

export type DocumentSortKey = 'created' | '-created' | 'added' | '-added' | 'title' | '-title' | 'modified' | '-modified' | 'relevance';

/** Query parameters of GET /api/documents and /api/documents/facets. */
export interface DocumentFilterParams {
  q?: string;
  /** Comma-separated ids. */
  tags?: string;
  tagsAll?: string;
  tagsNone?: string;
  /** Id(s), comma-separated, or "none". */
  correspondent?: string;
  documentType?: string;
  storagePath?: string;
  library?: string;
  createdFrom?: string;
  createdTo?: string;
  addedFrom?: string;
  addedTo?: string;
  /** JSON array of custom field conditions: [{ field, op: exists|eq|gte|lte|contains, value }] */
  cf?: string;
}

export interface DocumentUpdateInput {
  title?: string;
  created?: string | null;
  correspondent?: string | null;
  documentType?: string | null;
  /** The complete list of tag names. */
  tags?: string[];
  customFields?: { field_name: string; value: string }[];
  archiveSerialNumber?: number | null;
  /** Built-in archive: move to another library. */
  libraryId?: number;
}

export type BulkAction = 'edit' | 'delete' | 'analyze' | 'ocr' | 'restore';

export interface BulkEditInput {
  /** Documents by id – or all documents matching `filter`. */
  ids?: number[];
  filter?: DocumentFilterParams;
  action: BulkAction;
  edit?: {
    addTags?: string[];
    removeTags?: string[];
    correspondent?: string | null;
    documentType?: string | null;
    customField?: { name: string; value: string };
    libraryId?: number;
  };
}

export interface BulkEditResult {
  ok: number;
  failed: { id: number; error: string }[];
  /** Reference of the change (built-in archive: undo of the whole bulk edit). */
  ref: string;
}

export interface UploadResult {
  filename: string;
  /** queued: received, being stored in the background (`background=true`) – the outcome follows as an intake event. */
  status: 'stored' | 'duplicate' | 'rejected' | 'failed' | 'forwarded' | 'queued';
  documentId?: number;
  taskId?: string;
  intakeId?: number;
  reason?: string;
}

export interface ActivityItem {
  at: number;
  kind: 'ai' | 'ocr' | 'change' | 'workflow' | 'version' | 'created' | 'deleted' | 'restored' | 'moved';
  title: string;
  actor: string | null;
  details?: { field: string; before: unknown; after: unknown }[];
  /** Undo is possible (built-in change log / AI history). */
  undo?: { kind: 'event' | 'history'; id: number } | null;
  reverted?: boolean;
}

export interface MetadataItem {
  id: number;
  name: string;
  library_id?: number | null;
  color?: string | null;
  parent?: number | null;
  document_count: number;
  data_type?: string;
  extra?: Record<string, unknown> | null;
}

export type MetadataKindParam = 'tags' | 'correspondents' | 'document-types' | 'custom-fields';

/** Objects that probably mean the same (Tags & metadata → Find duplicates). */
export interface SimilarMetadataGroup {
  /** The objects, the one to keep first. */
  ids: number[];
  names: string[];
  /** Name of the merged object (may differ from all names for suggestions of the AI). */
  suggested: string;
  keepId: number;
  /** same: same name apart from case, punctuation, legal form …; extends: one continues the other; spelling: typo / plural; ai: found by the AI. */
  reason: 'same' | 'extends' | 'spelling' | 'ai';
  libraryId: number | null;
}

export interface SavedView {
  id: number;
  name: string;
  libraryId: number | null;
  filter: DocumentFilterParams & { sort?: DocumentSortKey };
  columns: string[];
  inNavigation: boolean;
  shared: boolean;
  own: boolean;
}

/** Live events for the UI (GET /api/events). */
export type LiveEvent =
  | { type: 'document.added' | 'document.updated' | 'document.deleted' | 'document.restored' | 'document.processed' | 'document.version_added' | 'document.purged'; id: number }
  | { type: 'processing'; documentId: number; outcome: string }
  | { type: 'intake'; intakeId: number; status: string; documentId?: number | null; filename?: string | null; reason?: string | null };

export interface ProcessingJob {
  documentId: number;
  title: string | null;
  source: string;
  startedAt: number;
  stage: string;
}

export interface ProcessingStatus {
  running: boolean;
  paused: boolean;
  automatic: boolean;
  scanning: boolean;
  current: ProcessingJob[];
  queued: number;
  lastScanAt: number | null;
  nextScanAt: number | null;
  lastError: string | null;
  /** The AI provider rate-limited processing; it continues automatically at this time. */
  rateLimitedUntil: number | null;
  lastProcessed: { documentId: number; title: string | null; processedAt: number } | null;
  processedToday: number;
  counts: { processed: number; failed: number; skipped: number };
}

export interface ArchiveStatus {
  /** 'paperless' = companion mode (Paperless-ngx), 'builtin' = built-in archive. */
  mode: ArchiveMode;
  /** Name of the archive in the UI ("Paperless-ngx", "Archive"). */
  label: string;
  connected: boolean;
  error?: string;
  version?: string | null;
  apiVersion?: number | null;
  documents: number;
  tags: number;
  correspondents: number;
  documentTypes: number;
  /** Built-in archive: bytes of stored files. */
  storageBytes?: number;
  libraries?: number;
}

export interface DashboardData {
  version: string;
  archive: ArchiveStatus;
  /** @deprecated alias of `archive` (API clients of ≤ 4.4) */
  paperless: ArchiveStatus;
  processing: ProcessingStatus;
  usage: UsageStats;
  timeline: { date: string; count: number }[];
  documentTypes: { name: string; count: number }[];
  ai: { provider: string; model: string };
  rag: { enabled: boolean };
}

export interface RagStatus {
  enabled: boolean;
  state: 'disabled' | 'idle' | 'indexing' | 'error';
  documents: number;
  chunks: number;
  embedded: number;
  embeddingProvider: string;
  embeddingModel: string | null;
  lastSyncAt: number | null;
  lastError: string | null;
  progress: { phase: string; done: number; total: number } | null;
  vectorSearch: boolean;
  /** Prompts used when embedding; `upgrade`: the ones the model expects, not used yet by this (older) index. */
  embeddingPrompts: { query: string; document: string; upgrade: { query: string; document: string } | null };
}

export interface RagSource {
  /** Citation number used in the answer, e.g. [1]. */
  n: number;
  documentId: number;
  title: string;
  correspondent: string | null;
  documentType: string | null;
  created: string | null;
  tags: string[];
  snippet: string;
  score: number;
  url: string;
}

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Events sent over the RAG/document chat SSE streams. */
export type ChatStreamEvent =
  | { type: 'sources'; sources: RagSource[] }
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; usage?: { promptTokens: number; completionTokens: number; totalTokens: number }; model?: string }
  | { type: 'error'; message: string };

export type ArchiveMode = 'paperless' | 'builtin';

/** What the archive backend can do – the UI shows features by these flags. */
export interface BackendCapabilities {
  upload: 'native' | 'forward';
  intakeChannels: ('folder' | 'mail' | 'webdav')[];
  fileVersions: boolean;
  libraries: boolean;
  fullChangeLog: boolean;
  trash: 'native' | 'external';
  externalLink: boolean;
  manageMetadata: boolean;
}

export interface ArchiveInfo {
  mode: ArchiveMode;
  label: string;
  capabilities: BackendCapabilities;
  /** The trash page of an external archive (Paperless-ngx), for the menu. */
  trashUrl?: string | null;
  /** Office documents can be added (built-in archive: the Office converter is on; Paperless-ngx decides itself). */
  officeDocuments?: boolean;
}

export interface SessionInfo {
  authenticated: boolean;
  setupRequired: boolean;
  /** No user account exists yet (first start). */
  needsUser: boolean;
  /** The setup asks for the code from the log (credentials were configured before the first account). */
  setupCode: boolean;
  /** displayName is null when the account has none – show the username then. */
  user?: { id: number; username: string; role: InstanceRole; displayName: string | null };
  version: string;
  features: { rag: boolean; calendar: boolean };
  /** The archive backend (null while it is not configured). */
  archive: ArchiveInfo | null;
  /** How to sign in: with a password, and/or with single sign-on (its button label). */
  login: { password: boolean; sso: string | null };
}

// ---------------------------------------------------------------- calendar

export interface CalendarEvent extends SuggestedEvent {
  id: number;
  documentId: number;
  documentTitle: string | null;
  /** Link to the document in Paperless. */
  url: string;
  dismissed: boolean;
}

export interface CalendarScanStatus {
  running: boolean;
  done: number;
  total: number;
  /** Dates found by this scan. */
  found: number;
  failed: number;
  error: string | null;
}

export interface CalendarResponse {
  /** Date recognition is switched on (Settings → Processing → Functions). */
  enabled: boolean;
  events: CalendarEvent[];
  /** Documents searched for dates so far. */
  scannedDocuments: number;
  scan: CalendarScanStatus;
}

// ---------------------------------------------------------------- two-factor authentication

/** Answer of /api/auth/login when the account uses 2FA: no session yet, continue with /api/auth/login/2fa. */
export interface LoginTwoFactorRequired {
  ok: false;
  twoFactor: true;
  ticket: string;
}

export interface TwoFactorStatus {
  enabled: boolean;
  enabledAt: number | null;
  recoveryCodesLeft: number;
}

/** Answer of /api/account. */
export type InstanceRole = 'admin' | 'member';
export type LibraryRole = 'owner' | 'editor' | 'viewer';
export const API_SCOPES = ['read', 'write', 'delete', 'metadata', 'upload', 'chat', 'mcp', 'webhook', 'ocr', 'admin'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface UserInfo {
  id: number;
  username: string;
  role: InstanceRole;
  displayName: string | null;
  email: string | null;
  disabled: boolean;
  createdAt: number;
  sso: boolean;
  password: boolean;
  twoFactor: boolean;
  groups: { id: number; name: string }[];
}

export interface GroupInfo {
  id: number;
  name: string;
  /** Synchronised from single sign-on (name and members are read-only). */
  sso: boolean;
  members: number[];
  createdAt: number;
}

export interface ApiKeyInfo {
  id: number;
  name: string;
  prefix: string;
  scopes: ApiScope[];
  libraryIds: number[] | null;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  /** Requests per minute; null = no limit. */
  rateLimit: number | null;
  revoked: boolean;
  /** Admin listing: the owner of the key. */
  user?: { id: number; username: string };
}

export interface AuditEntryInfo {
  id: number;
  at: number;
  actor: string;
  actorType: string;
  action: string;
  target: string | null;
  libraryId: number | null;
  details: Record<string, unknown>;
}

export interface NotificationInfo {
  id: number;
  at: number;
  title: string;
  body: string;
  link: string | null;
  read: boolean;
}

export interface AccountInfo {
  user: { id: number; username: string; role: InstanceRole; displayName: string | null; email: string | null } | null;
  groups: { id: number; name: string }[];
  users: { id: number; username: string; createdAt: number }[];
  twoFactor: TwoFactorStatus | null;
  /** Accounts created by single sign-on have no password (and no local two-factor authentication). */
  hasPassword: boolean;
  sso: { available: boolean; linked: boolean; passwordLogin: boolean };
  /** Built-in archive: the library of uploads without a chosen one (null = the oldest one the user can add to). */
  defaultLibraryId: number | null;
}

export interface TwoFactorSetup {
  /** Base32 secret for manual entry. */
  secret: string;
  otpauthUrl: string;
  /** QR code of otpauthUrl as SVG markup. */
  qrSvg: string;
}

export interface ConnectionTestResult {
  ok: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface LogEntryDto {
  id: number;
  time: number;
  level: string;
  module?: string;
  msg: string;
  data?: Record<string, unknown>;
}

// ------------------------------------------------------------------ OCR

// ---------------------------------------------------------------- prompt library

export interface PromptRating {
  id: number;
  provider: string;
  model: string;
  /** 1–10 */
  score: number;
  note: string;
  /** Documents of the test run. */
  documents: number[];
  createdAt: number;
}

export interface LibraryPrompt {
  id: number;
  name: string;
  useCase: string;
  prompt: string;
  /** Made with the prompt wizard – activating it restores the wizard answers. */
  fromWizard: boolean;
  /** The prompt is the system prompt used for automatic processing. */
  active: boolean;
  createdAt: number;
  updatedAt: number;
  ratings: PromptRating[];
  /** Mean score of all ratings, null without ratings. */
  score: number | null;
  /** Mean score per model, best first. */
  models: { provider: string; model: string; score: number; count: number }[];
  /** Documents processed with the prompt through a prompt rule. */
  documents: number;
  /** Prompt rules that use the prompt (their labels). */
  rules: string[];
}

export interface PromptLibrary {
  prompts: LibraryPrompt[];
  /** Use cases in use plus common suggestions. */
  useCases: string[];
  /** The model used now – default for new ratings. */
  current: { provider: string; model: string };
  /** The system prompt in use is not in the library yet (it can be saved). */
  currentMissing: boolean;
  /** SYSTEM_PROMPT is set in the environment: activating a prompt is not possible. */
  locked: boolean;
}

export type TextQualityLevel = 'missing' | 'poor' | 'fair' | 'good';

/** Heuristic assessment of a document's text (0–100). */
export interface TextQuality {
  score: number;
  level: TextQualityLevel;
  reasons: string[];
  chars: number;
  words: number;
}

export type OcrFilter = 'all' | 'needs' | 'missing' | 'poor' | 'fair' | 'good' | 'done' | 'failed';

export interface OcrResultInfo {
  status: 'done' | 'failed';
  at: number;
  chars: number | null;
  /** Mean recognition confidence 0…1. */
  meanScore: number | null;
  pages: number | null;
  totalPages: number | null;
  provider: string | null;
  durationMs: number | null;
  writtenBack: boolean;
  revertedAt: number | null;
  error: string | null;
  /** Text-quality scores (0–100) of the Paperless text before the OCR and of the OCR text. */
  scoreBefore: number | null;
  scoreAfter: number | null;
  /** The OCR text did not score better than the existing text – Paperless kept its text. */
  keptOriginal: boolean;
  /** The OCR text was laid into the PDF: as its archive PDF (built-in archive) or as a new version in Paperless-ngx. */
  pdf: 'archive' | 'version' | null;
  /** Making or storing the searchable PDF failed. */
  pdfError: string | null;
}

export interface OcrDocumentItem {
  id: number;
  title: string;
  url: string;
  created: string | null;
  pages: number | null;
  quality: TextQuality;
  ocr: OcrResultInfo | null;
  /** An OCR run requested for this document: `reading` while PaddleOCR reads it, afterwards the AI analysis runs. */
  job: { state: 'queued' | 'running'; reading?: boolean; page?: number; pages?: number } | null;
}

export interface OcrListResponse {
  items: OcrDocumentItem[];
  total: number;
  page: number;
  pageSize: number;
  counts: Record<OcrFilter, number>;
}

export interface OcrStatus {
  enabled: boolean;
  /** The OCR libraries are installed. */
  available: boolean;
  mode: string;
  writeBack: boolean;
  /** The OCR text is laid into the PDF (archive PDF / new Paperless-ngx version). */
  searchablePdf: boolean;
  /** Execution provider of the loaded models (cpu, cuda, dml) – null while not loaded. */
  provider: string | null;
  /** The OCR models used with the settings (PP-OCRv6 falls back to v5 for languages it cannot read). */
  model: OcrModelChoice;
  analysis: { running: boolean; done: number; total: number; lastAt: number | null; error: string | null };
  queue: number;
  /** The file being read: a document, or (documentId null) a file sent to the OCR API server. */
  active: { documentId: number | null; title: string | null; page: number; pages: number } | null;
  /** OCR API server: files other applications (Paperless-ngx …) sent to be read. */
  api: { enabled: boolean; readToday: number; lastAt: number | null };
}

export interface OcrDocumentText {
  id: number;
  title: string;
  /** The text Paperless had before the OCR – or has now, when the OCR text was not saved there. */
  originalText: string;
  originalQuality: TextQuality;
  ocrText: string | null;
  ocrQuality: TextQuality | null;
  /** The OCR text is what Paperless holds now. */
  inPaperless: boolean;
  ocr: OcrResultInfo | null;
}

// ---------------------------------------------------------------- libraries and versions (built-in archive)

export interface LibrarySettings {
  trashDays?: number;
  maxVersions?: number;
  maxVersionAgeDays?: number;
  reanalyzeOnNewVersion?: boolean;
  allowDuplicates?: boolean;
}

export interface LibraryInfo {
  id: number;
  name: string;
  description: string;
  /** Role of the caller (null: an admin who is no member). */
  role: LibraryRole | null;
  documents: number;
  settings: LibrarySettings;
  createdAt: number;
}

export interface LibraryMember {
  type: 'user' | 'group';
  id: number;
  name: string;
  role: LibraryRole;
}

export interface LibraryCandidates {
  users: { id: number; name: string }[];
  groups: { id: number; name: string }[];
}

export interface WatchFolder {
  id: number;
  libraryId: number;
  path: string;
  subfolders: 'ignore' | 'tags' | 'library';
  after: 'delete' | 'move';
  tags: string[];
  skipAnalysis: boolean;
  enabled: boolean;
  /** What keeps the folder from working (missing, not mounted, files not readable …), from the last poll. */
  problem: string | null;
}

export interface DocumentVersionInfo {
  version: number;
  kind: 'original' | 'archive';
  filename: string | null;
  mimeType: string;
  size: number;
  pages: number | null;
  comment: string;
  createdAt: number;
  createdBy: string | null;
  textLength: number | null;
  textSource: string | null;
  current: boolean;
}

export interface TextDiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface MailRuleInfo {
  from?: string;
  subject?: string;
  tags?: string[];
  skipAnalysis?: boolean;
  ignore?: boolean;
  /** Store into this library instead of the account's. */
  libraryId?: number;
  /** Store the e-mail itself as a document: never (default), only when it has no attachment that is one, or always. */
  storeMail?: 'never' | 'no_attachments' | 'always';
}

export interface MailAccountInfo {
  id: number;
  libraryId: number;
  name: string;
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username: string;
  folders: string[];
  rules: MailRuleInfo[];
  after: 'seen' | 'move' | 'delete';
  afterFolder: string | null;
  enabled: boolean;
  /** The first check skips the messages already in the folders. */
  skipExisting: boolean;
  lastError: string | null;
  lastCheckedAt: number | null;
}

export type OfficeState = 'off' | 'not_installed' | 'downloading' | 'installing' | 'ready' | 'failed';

/** The Office converter of the built-in archive (Settings → Archive). */
export interface OfficeStatus {
  enabled: boolean;
  state: OfficeState;
  version: string;
  /** Download progress (bytes). */
  received: number | null;
  total: number | null;
  error: string | null;
  /** LibreOffice is loaded right now (and holds memory). */
  loaded: boolean;
  /** LibreOffice is being started. */
  starting: boolean;
  /** Memory LibreOffice holds right now (MB), null when not loaded. */
  memoryMb: number | null;
  /** Memory it held the last time it was loaded (MB). */
  lastMemoryMb: number | null;
  /** How long its last start took (ms). */
  lastStartMs: number | null;
  /** It is kept loaded (idle minutes 0). */
  keepLoaded: boolean;
  conversions: number;
  failures: number;
  lastMs: number | null;
  dir: string;
}
